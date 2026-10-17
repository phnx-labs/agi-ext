// Startup ownership across real window processes (PHNX-3939): each window is
// testdata/monitor-window.ts running the production elector, gate, and
// `runMonitorHostOnLeader` over real files, Unix sockets, and producer children.
import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import { MonitorBroadcastClient } from './broadcast';
import { MONITOR_OP, isSessionCliFact } from './protocol';

interface WindowEvent { type: string; selfId: string; at: number; pid?: number; overlap?: boolean }

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = (child: ChildProcessWithoutNullStreams) => child.exitCode !== null || child.signalCode !== null;
async function until(predicate: () => boolean, label: string, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await pause(10);
  }
}

/** Close a test server after destroying every connection it accepted, within a bound. */
function closeServer(server: net.Server, accepted: Set<net.Socket>): Promise<void> {
  for (const socket of accepted) socket.destroy();
  accepted.clear();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not close within 2s')), 2000);
    server.close(() => { clearTimeout(timer); resolve(); });
  });
}

const windows: ChildProcessWithoutNullStreams[] = [];
const clients: MonitorBroadcastClient[] = [];
const servers: { server: net.Server; accepted: Set<net.Socket> }[] = [];
const dirs: string[] = [];

function scenario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-bootstrap-'));
  dirs.push(dir);
  const events: WindowEvent[] = [];
  const stderr: string[] = [];
  const logs: string[] = [];
  const socketPath = path.join(dir, 'feed.sock');
  const launch = (selfId: string, startAt?: number) => {
    const args = [path.join(import.meta.dir, 'testdata/monitor-window.ts'), dir, selfId];
    if (startAt) args.push(String(startAt));
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    windows.push(child);
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.startsWith('{')) events.push(JSON.parse(line));
      else logs.push(line);
    });
    child.stderr.on('data', (data) => stderr.push(String(data)));
    return child;
  };
  const producers = () => {
    const log = path.join(dir, 'producers.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  };
  // Bun throws a missing-path connect synchronously, so connect once it exists.
  const follower = async (demand: boolean) => {
    await until(() => fs.existsSync(socketPath), 'the published socket');
    const resets: unknown[] = [];
    const client = new MonitorBroadcastClient({ socketPath, minReconnectDelayMs: 20, maxReconnectDelayMs: 50,
      // A report still in flight when the test closes the client rejects; that is expected.
      onStateChange: (state) => { if (state === 'connected') report(demand).catch(() => {}); },
    });
    const report = (sessionDemand: boolean) => client.request({
      op: MONITOR_OP.reportTuples, windowId: `follower-${clients.length}`, tuples: [], sessionDemand,
    });
    client.subscribe((event) => { if (isSessionCliFact(event) && event.payload.type === 'reset') resets.push(event.payload); });
    clients.push(client);
    client.connect();
    return { client, resets, report };
  };
  return { dir, events, stderr, logs, socketPath, launch, producers, follower };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.allSettled(servers.splice(0).map(({ server, accepted }) => closeServer(server, accepted)));
  for (const child of windows) if (!exited(child)) child.stdin.write('exit\n');
  try { await until(() => windows.every(exited), 'windows to exit'); }
  finally {
    for (const child of windows.splice(0)) if (alive(child.pid!)) child.kill('SIGKILL');
    for (const dir of dirs.splice(0)) {
      for (const pid of fs.existsSync(path.join(dir, 'producers.log'))
        ? fs.readFileSync(path.join(dir, 'producers.log'), 'utf8').split('\n').filter(Boolean).map(Number) : []) {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test.skipIf(process.platform === 'win32')('windows starting in the same millisecond elect one leader that alone binds and spawns one producer', async () => {
  for (let trial = 0; trial < 4; trial++) {
    const s = scenario();
    const startAt = Date.now() + 400;
    for (const id of ['a', 'b', 'c']) s.launch(`${trial}-${id}`, startAt);
    await until(() => s.events.filter((e) => e.type === 'window').length === 3, 'windows to start');
    await pause(250); // many 10ms heartbeats past the shared first tick
    // Not merely converged: no second window was ever leader, even transiently.
    const leaders = s.events.filter((e) => e.type === 'leader');
    expect(leaders.length).toBe(1);
    expect(s.stderr.join('')).toBe('');

    const quiet = await s.follower(false);
    const demanding = await s.follower(true);
    await until(() => quiet.resets.length > 0 && demanding.resets.length > 0, 'a reset at every follower');
    expect(s.producers().length).toBe(1);
    expect(s.events.find((e) => e.type === 'producer')!.overlap).toBe(false);

    // Re-reporting the same demand is the 60s follower heartbeat: no respawn.
    for (let i = 0; i < 5; i++) await demanding.report(true);
    await pause(100);
    expect(s.producers().length).toBe(1);

    // Zero demand reaps the producer after the debounce, and nothing restarts it.
    await demanding.report(false);
    await until(() => s.events.some((e) => e.type === 'reaped'), 'the producer reap');
    await pause(200);
    expect(s.producers().length).toBe(1);
    expect(s.producers().filter(alive)).toEqual([]);
    for (const client of clients.splice(0)) client.close();
    for (const child of windows) if (!exited(child)) child.stdin.write('exit\n');
    await until(() => windows.every(exited), 'windows to exit');
    windows.splice(0);
  }
}, 40_000);

test.skipIf(process.platform === 'win32')('a leader whose bind fails keeps the foreign endpoint, retries quietly, and serves once the path frees', async () => {
  const s = scenario();
  // Another process already serves the path (an older installed version's leader).
  // Every connection it accepts is tracked so closing it never waits on a peer.
  const accepted = new Set<net.Socket>();
  const foreign = net.createServer((socket) => {
    accepted.add(socket);
    socket.on('error', () => {}); // a window that probes and hangs up first makes the reply EPIPE
    socket.once('close', () => accepted.delete(socket));
    socket.end('foreign\n');
  });
  servers.push({ server: foreign, accepted });
  await new Promise<void>((resolve) => foreign.listen(s.socketPath, resolve));
  const readForeign = () => new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(s.socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('foreign read timed out')); }, 2000);
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => { clearTimeout(timer); socket.destroy(); resolve(data); });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  s.launch('stuck');
  await until(() => s.events.some((e) => e.type === 'leader'), 'leadership');
  await pause(1500); // the first attempt and the 1s retry both fail
  expect(await readForeign()).toBe('foreign\n');
  const log = s.stderr.join('');
  expect(log.split('leader-only start failed').length - 1).toBe(1);
  expect(log).toContain('EADDRINUSE');
  expect(s.producers()).toEqual([]);

  servers.splice(servers.findIndex((entry) => entry.server === foreign), 1);
  await closeServer(foreign, accepted);
  const follower = await s.follower(true);
  await until(() => follower.resets.length > 0, 'a reset after recovery', 8000);
  expect(s.producers().length).toBe(1);
  expect(s.events.filter((e) => e.type === 'leader').length).toBe(1);
  expect(s.logs.filter((line) => line.includes('leader-only work started after')).length).toBe(1);
}, 20_000);

test.skipIf(process.platform === 'win32')('after the leader is SIGKILLed, a new window takes over its stale lease and socket path', async () => {
  const s = scenario();
  const first = s.launch('crashed');
  const before = await s.follower(true);
  await until(() => before.resets.length > 0, 'the first leader serving');
  before.client.close();
  first.kill('SIGKILL');
  await until(() => exited(first), 'the crash');
  expect(fs.existsSync(s.socketPath)).toBe(true); // nothing cleaned up after the crash

  s.launch('successor');
  await until(() => s.events.some((e) => e.selfId === 'successor' && e.type === 'leader'), 'takeover');
  const after = await s.follower(false);
  await until(() => after.client.connected, 'the successor socket');
  expect(fs.readdirSync(`${path.join(s.dir, 'lease.json')}.claims`)).toEqual(['2.json']);
  expect(s.stderr.join('')).toBe('');
}, 20_000);
