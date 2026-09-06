// Demand-gated session-CLI stream — real host, real Unix sockets, and a REAL
// bounded fixture subprocess (testdata/fake-watch.mjs) driven over stdin
// (PHNX-3939). Exercises the actual MonitorHost<->client boundary AND real OS
// process lifecycle: one producer for many followers, socket-scoped demand
// leases, late-join replay via sendTo, stop/start race with a delayed SIGTERM,
// spawn-error (ENOENT) retry + stop cancellation, and no orphaned children.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { MonitorHost } from './host';
import { MonitorBroadcastClient } from './broadcast';
import { MONITOR_OP, isSessionCliFact } from './protocol';
import type { MonitorEvent } from './broadcastTypes';
import { SessionPresentationStore } from '../core/sessionPresentationStore';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'fake-watch.mjs');

const tmpPaths: string[] = [];
const clients: MonitorBroadcastClient[] = [];
const hosts: MonitorHost[] = [];
const spawnedChildren: ChildProcess[] = [];
let counter = 0;

function tempSocketPath(): string {
  const p = path.join(os.tmpdir(), `monitor-demand-${process.pid}-${counter++}.sock`);
  tmpPaths.push(p);
  return p;
}

/** Spawn the real fixture; env can set FAKE_WATCH_SIGTERM_DELAY_MS. Marks the
 *  child `__ready` once its SIGTERM handler is installed (fixture prints READY). */
function spawnFixture(env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const child = spawn('node', [FIXTURE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: { ...process.env, ...env },
  });
  child.stderr.on('data', (d) => { if (String(d).includes('READY')) (child as unknown as { __ready?: boolean }).__ready = true; });
  spawnedChildren.push(child);
  return child;
}

/** Resolve once the fixture's SIGTERM handler is installed (so a delayed exit is honored). */
function ready(child: ChildProcessWithoutNullStreams): Promise<void> {
  return waitFor(() => (child as unknown as { __ready?: boolean }).__ready === true, 2000, 'fixture READY');
}

/** A spawn that fails: no such binary -> the child emits an ENOENT 'error'. */
function spawnMissing(): ChildProcessWithoutNullStreams {
  const child = spawn(path.join(os.tmpdir(), `no-such-bin-${counter++}`), [], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  spawnedChildren.push(child);
  return child;
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function connect(socketPath: string): MonitorBroadcastClient {
  const c = new MonitorBroadcastClient({ socketPath, minReconnectDelayMs: 20, maxReconnectDelayMs: 60 });
  clients.push(c);
  return c;
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function waitConnected(c: MonitorBroadcastClient): Promise<void> {
  c.connect();
  await waitFor(() => c.connected, 4000, 'client connected');
}

function report(c: MonitorBroadcastClient, windowId: string, sessionDemand: boolean) {
  return c.request({ op: MONITOR_OP.reportTuples, windowId, tuples: [], sessionDemand });
}

function resetEvent(scope = 'local', agents: unknown[] = []) {
  return JSON.stringify({ v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope, agents, attention: [] });
}

afterEach(async () => {
  for (const c of clients.splice(0)) { try { c.close(); } catch { /* gone */ } }
  for (const h of hosts.splice(0)) { try { await h.stop(); } catch { /* gone */ } }
  for (const child of spawnedChildren.splice(0)) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  for (const p of tmpPaths.splice(0)) { try { fs.rmSync(p, { force: true }); } catch { /* gone */ } }
});

describe('demand-gated session-CLI stream (real subprocess)', () => {
  test('no demand -> the producer never spawns', async () => {
    const socketPath = tempSocketPath();
    let spawns = 0;
    const host = new MonitorHost({ socketPath, sessionStream: { enabled: true, spawnWatch: () => { spawns++; return spawnFixture(); } } });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', false);

    expect(host.sessionStreamRunning).toBe(false);
    expect(spawns).toBe(0);
  });

  test('visible UI with zero terminals starts exactly ONE producer for two followers', async () => {
    const socketPath = tempSocketPath();
    const children: ChildProcessWithoutNullStreams[] = [];
    const host = new MonitorHost({ socketPath, sessionStream: { enabled: true, spawnWatch: () => { const c = spawnFixture(); children.push(c); return c; } } });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    const b = connect(socketPath);
    await waitConnected(a);
    await waitConnected(b);
    await report(a, 'winA', true);  // zero tuples; demand comes from a visible panel
    await report(b, 'winB', true);

    expect(host.sessionStreamRunning).toBe(true);
    expect(children.length).toBe(1);          // ONE elected producer, not one per follower
    expect(isAlive(children[0].pid)).toBe(true);
  });

  test('an OLD socket disconnect must not cancel a SAME-window replacement demand', async () => {
    const socketPath = tempSocketPath();
    const host = new MonitorHost({ socketPath, sessionStream: { enabled: true, stopDebounceMs: 40, spawnWatch: () => spawnFixture() } });
    hosts.push(host);
    await host.start();

    // Same window reloads: a new socket reports the SAME windowId before the old
    // one's disconnect is observed. Leases are socket-scoped, so the stale socket
    // dropping must not cancel the replacement's demand.
    const oldSock = connect(socketPath);
    const newSock = connect(socketPath);
    await waitConnected(oldSock);
    await waitConnected(newSock);
    await report(oldSock, 'winA', true);
    await report(newSock, 'winA', true);
    expect(host.sessionStreamRunning).toBe(true);

    oldSock.close();
    await new Promise((r) => setTimeout(r, 100)); // past the debounce
    expect(host.sessionStreamRunning).toBe(true);
  });

  test('last demanding socket disconnect stops the producer and reaps the child', async () => {
    const socketPath = tempSocketPath();
    let child: ChildProcessWithoutNullStreams | undefined;
    const host = new MonitorHost({ socketPath, sessionStream: { enabled: true, stopDebounceMs: 20, spawnWatch: () => { child = spawnFixture(); return child; } } });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', true);
    expect(host.sessionStreamRunning).toBe(true);
    await waitFor(() => isAlive(child?.pid), 2000, 'child alive');

    a.close();
    await waitFor(() => host.sessionStreamRunning === false, 2000, 'stream stopped');
    await waitFor(() => !isAlive(child?.pid), 2000, 'child reaped (no orphan)');
  });

  test('delayed SIGTERM + immediate renewed demand: exactly one live child, no orphan', async () => {
    const socketPath = tempSocketPath();
    const children: ChildProcessWithoutNullStreams[] = [];
    const host = new MonitorHost({
      socketPath,
      sessionStream: {
        enabled: true,
        stopDebounceMs: 5,
        // The first child ignores SIGTERM for 150ms; the renewed-demand spawn must
        // wait it out (serialize) rather than run a second child alongside it.
        spawnWatch: () => { const c = spawnFixture({ FAKE_WATCH_SIGTERM_DELAY_MS: '150' }); children.push(c); return c; },
      },
    });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', true);
    await waitFor(() => isAlive(children[0]?.pid), 2000, 'first child alive');
    await ready(children[0]); // SIGTERM handler must be installed for the delay to apply

    await report(a, 'winA', false);                                  // demand drops
    await waitFor(() => host.sessionStreamRunning === false, 2000, 'stop fired');
    // child[0] is now SIGTERM'd but ignores it for 150ms — still alive here.
    expect(isAlive(children[0].pid)).toBe(true);
    await report(a, 'winA', true);                                   // renew while it's still exiting

    // The renewed spawn must SERIALIZE behind the dying child, not run alongside it.
    await waitFor(() => children.length >= 2 && isAlive(children[1]?.pid), 3000, 'second child spawned after exit');
    // By the time child[1] is up, child[0] must already be gone (never two at once).
    expect(isAlive(children[0].pid)).toBe(false);
    expect(isAlive(children[1].pid)).toBe(true);
    expect(host.sessionStreamRunning).toBe(true);
  });

  test('a stale KILLED child exit never resurrects a stopped stream', async () => {
    const socketPath = tempSocketPath();
    const children: ChildProcessWithoutNullStreams[] = [];
    const host = new MonitorHost({
      socketPath,
      sessionStream: { enabled: true, stopDebounceMs: 5, restartMs: 10, spawnWatch: () => { const c = spawnFixture({ FAKE_WATCH_SIGTERM_DELAY_MS: '120' }); children.push(c); return c; } },
    });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', true);
    await waitFor(() => isAlive(children[0]?.pid), 2000, 'child alive');
    await ready(children[0]); // handler installed so the exit is genuinely delayed

    a.close(); // last demand gone -> stop (SIGTERM, child exits ~120ms later)
    await waitFor(() => host.sessionStreamRunning === false, 2000, 'stopped');
    // Wait past the delayed exit + any errant restart window.
    await new Promise((r) => setTimeout(r, 300));
    expect(host.sessionStreamRunning).toBe(false);
    expect(children.length).toBe(1); // the late exit did NOT spawn a phantom child
  });

  test('spawn error (ENOENT) reports, retries, and stop cancels the retry', async () => {
    const socketPath = tempSocketPath();
    let attempts = 0;
    const host = new MonitorHost({
      socketPath,
      // Short debounce so a.close() reaches stop() (and cancels the retry) quickly.
      sessionStream: { enabled: true, restartMs: 15, stopDebounceMs: 10, spawnWatch: () => { attempts++; return spawnMissing(); } },
    });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', true);

    // The missing binary fires 'error' (ENOENT) -> settle -> bounded retry (not an
    // unhandled throw, which is what the pre-fix code did).
    await waitFor(() => attempts >= 2, 2000, 'retried after ENOENT (no unhandled throw)');

    a.close(); // demand gone -> stop() cancels the pending retry timer
    await waitFor(() => host.sessionStreamRunning === false, 2000, 'stopped');
    const settled = attempts;
    await new Promise((r) => setTimeout(r, 120));
    expect(attempts).toBe(settled); // no further respawns once stopped
    expect(host.sessionStreamRunning).toBe(false);
  });

  test('a follower that gains demand after state exists is replayed via sendTo', async () => {
    const socketPath = tempSocketPath();
    const child = spawnFixture();
    const host = new MonitorHost({ socketPath, sessionStream: { enabled: true, spawnWatch: () => child } });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', true);                 // starts the producer
    child.stdin.write('emit ' + resetEvent('local', [{ rowKey: 'r1' }]) + '\n'); // real state over the pipe
    await new Promise((r) => setTimeout(r, 60));

    const b = connect(socketPath);
    const seen: MonitorEvent[] = [];
    b.subscribe((e) => { if (isSessionCliFact(e)) seen.push(e); });
    await waitConnected(b);
    await report(b, 'winB', true);

    await waitFor(() => seen.some((e) => (e.payload as { type?: string }).type === 'reset'), 2000, 'late-join replay reset');
  });

  test('late follower replay + subsequent live events reconcile in a real SessionPresentationStore; stop clears the snapshot', async () => {
    const socketPath = tempSocketPath();
    const children: ChildProcessWithoutNullStreams[] = [];
    const host = new MonitorHost({ socketPath, sessionStream: { enabled: true, stopDebounceMs: 10, spawnWatch: () => { const c = spawnFixture(); children.push(c); return c; } } });
    hosts.push(host);
    await host.start();

    const emit = (obj: unknown) => children[children.length - 1].stdin.write('emit ' + JSON.stringify(obj) + '\n');

    // Producer up (via A's demand); build state BEFORE the late follower joins.
    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', true);
    emit({ v: 1, type: 'reset', streamId: 'live', sequence: 1, capturedAt: 1, scope: 'local', agents: [{ rowKey: 'r1', sessionId: 's1' }], attention: [] });
    emit({ v: 1, type: 'agent.upsert', streamId: 'live', sequence: 2, capturedAt: 2, scope: 'local', rowKey: 'r2', agent: { rowKey: 'r2', sessionId: 's2' } });
    emit({ v: 1, type: 'attention.upsert', streamId: 'live', sequence: 3, capturedAt: 3, scope: 'local', rowKey: 'kA', attention: { key: 'kA', sessionId: 's1', state: 'open', openedAt: 100 } });
    await new Promise((r) => setTimeout(r, 60));

    // A LATE follower joins, feeding everything it hears into a real store.
    const b = connect(socketPath);
    const store = new SessionPresentationStore();
    b.subscribe((e) => { if (isSessionCliFact(e)) store.apply(e.payload); });
    await waitConnected(b);
    await report(b, 'winB', true);                       // -> replay via sendTo
    await waitFor(() => store.hasSeenReset('local'), 2000, 'replay reset applied');

    // The replay reconstructed the pre-join state: both rows, open attention on s1.
    let rows = store.sessions() as Array<{ rowKey?: string; attention?: { key?: string } }>;
    expect(rows.map((r) => r.rowKey).sort()).toEqual(['r1', 'r2']);
    expect(rows.find((r) => r.rowKey === 'r1')?.attention?.key).toBe('kA');

    // Subsequent LIVE events must land on top of the replay without duplication:
    // resolve A, then a NEW open question B for the same session.
    emit({ v: 1, type: 'attention.remove', streamId: 'live', sequence: 4, capturedAt: 4, scope: 'local', rowKey: 'kA', resolution: { key: 'kA', state: 'answered' } });
    emit({ v: 1, type: 'attention.upsert', streamId: 'live', sequence: 5, capturedAt: 5, scope: 'local', rowKey: 'kB', attention: { key: 'kB', sessionId: 's1', state: 'open', openedAt: 200 } });
    await waitFor(() => {
      const r1 = (store.sessions() as Array<{ rowKey?: string; attention?: { key?: string } }>).find((r) => r.rowKey === 'r1');
      return r1?.attention?.key === 'kB';
    }, 2000, 'live attention lifecycle applied over replay');

    rows = store.sessions() as Array<{ rowKey?: string; attention?: { key?: string } }>;
    expect(rows.map((r) => r.rowKey).sort()).toEqual(['r1', 'r2']); // no duplicate rows
    expect(rows.find((r) => r.rowKey === 'r1')?.attention?.key).toBe('kB'); // NEW question, not stale A

    // Drop all demand -> producer stops -> replay cache cleared. A follower that
    // gains demand AFTER the stop must NOT be handed the dead stream's snapshot.
    a.close();
    b.close();
    await waitFor(() => host.sessionStreamRunning === false, 2000, 'producer stopped');

    const c = connect(socketPath);
    const freshStore = new SessionPresentationStore();
    c.subscribe((e) => { if (isSessionCliFact(e)) freshStore.apply(e.payload); });
    await waitConnected(c);
    await report(c, 'winC', true); // restarts a NEW (empty) producer; no stale replay
    await new Promise((r) => setTimeout(r, 120));
    expect(freshStore.hasSeenReset('local')).toBe(false); // no stale snapshot replayed
    expect(freshStore.sessions()).toEqual([]);
  });

  test('leadership loss (host.stop) disposes the producer and reaps the child', async () => {
    const socketPath = tempSocketPath();
    const child = spawnFixture();
    const host = new MonitorHost({ socketPath, sessionStream: { enabled: true, spawnWatch: () => child } });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', true);
    await waitFor(() => isAlive(child.pid), 2000, 'child alive');

    await host.stop();  // awaits the real exit
    expect(host.sessionStreamRunning).toBe(false);
    expect(isAlive(child.pid)).toBe(false);
  });
});


test('host shutdown refuses renewed real-socket demand while SIGTERM is delayed', async () => {
  const socketPath = tempSocketPath();
  const children: ChildProcessWithoutNullStreams[] = [];
  const host = new MonitorHost({ socketPath, sessionStream: { enabled: true,
    spawnWatch: () => { const child = spawnFixture({ FAKE_WATCH_SIGTERM_DELAY_MS: '200' }); children.push(child); return child; },
  } });
  hosts.push(host);
  await host.start();
  const client = connect(socketPath);
  await waitConnected(client);
  await report(client, 'shutdown-race', true);
  await ready(children[0]);
  const stopped = host.stop();
  // Queue bytes on the established socket in the same turn as shutdown.
  const renewed = report(client, 'shutdown-race', true).catch(() => undefined);
  expect(isAlive(children[0].pid)).toBe(true);
  await Promise.all([stopped, host.stop(), renewed]);
  expect(host.sessionStreamRunning).toBe(false);
  expect(children.length).toBe(1);
  expect(isAlive(children[0].pid)).toBe(false);
  expect(fs.existsSync(socketPath)).toBe(false);
});

test('stop owns an in-flight real socket bind and allows clean replacement', async () => {
  const socketPath = tempSocketPath();
  let spawns = 0;
  const host = new MonitorHost({ socketPath, sessionStream: { enabled: true,
    spawnWatch: () => { spawns++; return spawnFixture(); },
  } });
  hosts.push(host);
  const starting = host.start();
  const stopping = host.stop();
  await Promise.all([starting, stopping, host.stop()]);
  expect(fs.existsSync(socketPath)).toBe(false);
  expect(spawns).toBe(0);
  const replacement = new MonitorHost({ socketPath });
  hosts.push(replacement);
  await replacement.start();
  const client = connect(socketPath);
  await waitConnected(client);
  expect(replacement.clientCount).toBe(1);
});
