// isLeader() gate — real-elector tests (no mocks).
//
// Drives `runOnLeaderOnly` with the ACTUAL `MonitorLeader` elector against a
// real lease file in a temp dir (same style as leader.test.ts). Proves the seam
// migrations #68-71 depend on: heavy work starts when this window is leader and
// is torn down the instant leadership is lost.

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { electLeader, disposeLeader, isLeader } from './leader';
import { runOnLeaderOnly } from './gate';

const dirs: string[] = [];

function tempLeaseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gate-'));
  dirs.push(dir);
  return path.join(dir, 'monitor-lease.json');
}

afterEach(async () => {
  await disposeLeader();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('runOnLeaderOnly', () => {
  test('starts immediately when already leader, stops when leadership is lost', () => {
    const leaseFile = tempLeaseFile();
    // Single elector -> wins on the synchronous first tick in start().
    electLeader({
      selfId: 'win-gate',
      pid: process.pid,
      heartbeatMs: 50,
      ttlMs: 150,
      leaseFile,
    });
    expect(isLeader()).toBe(true);

    let started = 0;
    let stopped = 0;
    const gate = runOnLeaderOnly(() => {
      started++;
      return { dispose: () => { stopped++; } };
    });

    // Already leader at wire-up time -> started once, not yet stopped.
    expect(started).toBe(1);
    expect(stopped).toBe(0);

    // Releasing the lease flips leadership to false and tears the work down.
    disposeLeader();
    expect(isLeader()).toBe(false);
    expect(started).toBe(1);
    expect(stopped).toBe(1);

    gate.dispose();
  });

  test('does not start when this window is not the leader', () => {
    const leaseFile = tempLeaseFile();
    // A live peer already holds a valid lease; our elector must not claim it.
    fs.writeFileSync(
      leaseFile,
      JSON.stringify({ leaderId: 'peer', pid: process.pid, expiresAt: Date.now() + 60_000 }),
    );
    electLeader({
      selfId: 'win-loser',
      pid: process.pid,
      heartbeatMs: 50,
      ttlMs: 150,
      leaseFile,
    });
    expect(isLeader()).toBe(false);

    let started = 0;
    const gate = runOnLeaderOnly(() => {
      started++;
      return { dispose: () => {} };
    });
    expect(started).toBe(0);

    gate.dispose();
  });
});

// Real elector + host + socket + Node subprocess: exercise the production gate,
// including an old host still reaping when the same elector regains leadership.
test('gate awaits host shutdown before leadership regain can spawn a replacement', async () => {
  const { MonitorHost } = await import('./host');
  const { MonitorBroadcastClient } = await import('./broadcast');
  const { MONITOR_OP } = await import('./protocol');
  const { spawn } = await import('child_process');
  const leaseFile = tempLeaseFile();
  const socketPath = path.join(path.dirname(leaseFile), 'feed.sock');
  const alive = (pid: number | undefined) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('gate lifecycle deadline exceeded');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const children: import('child_process').ChildProcessWithoutNullStreams[] = [];
  let starts = 0;
  let ready = false;
  let overlap = false;
  let startError: unknown;
  electLeader({ selfId: 'gate-reap', pid: process.pid, heartbeatMs: 10, ttlMs: 100, leaseFile });
  const gate = runOnLeaderOnly(() => {
    starts++;
    overlap ||= children.some((child) => alive(child.pid));
    const host = new MonitorHost({ socketPath, sessionStream: { enabled: true, spawnWatch: () => {
      overlap ||= children.some((child) => alive(child.pid));
      const child = spawn('node', [path.join(import.meta.dir, 'testdata/fake-watch.mjs')], {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FAKE_WATCH_SIGTERM_DELAY_MS: '250' },
      });
      child.stderr.on('data', (data) => { if (String(data).includes('READY')) ready = true; });
      children.push(child);
      return child;
    } } });
    void host.start().catch((error) => { startError = error; });
    return { dispose: () => host.stop() };
  });
  const client = new MonitorBroadcastClient({ socketPath, minReconnectDelayMs: 10, maxReconnectDelayMs: 20 });
  try {
    client.connect();
    await waitFor(() => client.connected);
    await client.request({ op: MONITOR_OP.reportTuples, windowId: 'gate-client', tuples: [], sessionDemand: true });
    await waitFor(() => ready);
    fs.writeFileSync(leaseFile, JSON.stringify({ leaderId: 'peer', pid: process.pid, expiresAt: Date.now() + 60_000 }));
    await waitFor(() => !isLeader());
    expect(alive(children[0].pid)).toBe(true);
    fs.rmSync(leaseFile);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isLeader()).toBe(false); // elector also waits for the pending reap
    expect(starts).toBe(1);
    await waitFor(() => starts === 2 && client.connected);
    await client.request({ op: MONITOR_OP.reportTuples, windowId: 'gate-client', tuples: [], sessionDemand: true });
    await waitFor(() => children.length === 2);
    expect(alive(children[0].pid)).toBe(false);
    expect(overlap).toBe(false);
    expect(startError).toBeUndefined();
    await gate.dispose();
    expect(children.every((child) => !alive(child.pid))).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(false);
  } finally {
    client.close();
    await gate.dispose();
    for (const child of children) if (alive(child.pid)) child.kill('SIGKILL');
  }
});
