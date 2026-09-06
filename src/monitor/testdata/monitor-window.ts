// One actual extension-host process: real elector, gate, host, socket, producer.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { electLeader, disposeLeader } from '../leader';
import { runOnLeaderOnly } from '../gate';
import { MonitorHost } from '../host';

const [dir, selfId] = process.argv.slice(2);
const emit = (event: object) => process.stdout.write(JSON.stringify({ selfId, ...event }) + '\n');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
electLeader({ selfId, pid: process.pid, leaseFile: path.join(dir, 'lease.json'), heartbeatMs: 10, ttlMs: 60 });
const gate = runOnLeaderOnly(() => {
  emit({ type: 'leader' });
  const host = new MonitorHost({ socketPath: path.join(dir, 'feed.sock'), sessionStream: {
    enabled: true,
    spawnWatch: () => {
      const marker = path.join(dir, 'producer.pid');
      const previous = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
      const overlap = previous > 0 && alive(previous);
      const child = spawn('node', [path.join(__dirname, 'fake-watch.mjs')], {
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FAKE_WATCH_IGNORE_SIGTERM: '1' },
      });
      fs.writeFileSync(marker, String(child.pid));
      child.stderr.on('data', (data) => {
        if (String(data).includes('READY')) emit({ type: 'producer', pid: child.pid, overlap });
      });
      child.once('exit', () => emit({ type: 'reaped', pid: child.pid }));
      return child;
    },
  } });
  void host.start().then(() => emit({ type: 'bound' }), (error) => emit({ type: 'error', message: String(error) }));
  return { dispose: () => host.stop() };
});
emit({ type: 'window', pid: process.pid });
let disposal: Promise<void> | undefined;
const drain = (gateFirst: boolean) => {
  if (!disposal) {
    emit({ type: 'draining' });
    if (gateFirst) void gate.dispose();
    disposal = disposeLeader();
    void disposal.then(() => emit({ type: 'disposed' }), (error) => emit({ type: 'error', message: String(error) }));
  }
  return disposal;
};
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.startsWith('drain')) void drain(line === 'drain gate-first');
  if (line === 'exit') void drain(false).then(() => process.exit(0));
});
process.on('SIGTERM', () => { void drain(false).then(() => process.exit(0)); });
setTimeout(() => { void drain(false).finally(() => process.exit(99)); }, 12_000).unref();
