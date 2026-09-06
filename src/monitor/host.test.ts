// The PER-DEVICE scope set of the leader's session stream (PHNX-3939).
//
// `host.demand.test.ts` beside this covers the demand gate and real process
// lifecycle for the local producer. This file covers the other axis: a REMOTE
// device earns its own `-D <device>` child by owning an open agent tab, and loses
// it — child and replay scope together — with its last tab. That bound is what
// keeps the fleet-wide ssh fan-out e0f4831 removed from ever coming back: the set
// of remote producers is the set of tabs the user actually has open, not the size
// of the fleet.
//
// Real MonitorHost over a real Unix socket, real MonitorBroadcastClient, real
// child processes (the bounded testdata/fake-watch.mjs fixture).

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { MonitorBroadcastClient } from './broadcast';
import { MonitorHost } from './host';
import { MONITOR_OP, isSessionCliFact, type TerminalTuple } from './protocol';
import type { MonitorEvent } from './broadcastTypes';
import { disposeFixture, observeFixture } from './testdata/fixture-lifecycle';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'fake-watch.mjs');

const tmpPaths: string[] = [];
const clients: MonitorBroadcastClient[] = [];
const hosts: MonitorHost[] = [];
const spawnedChildren: ChildProcess[] = [];
let counter = 0;

function tempSocketPath(): string {
  const p = path.join(os.tmpdir(), `monitor-scope-${process.pid}-${counter++}.sock`);
  tmpPaths.push(p);
  return p;
}

function spawnFixture(): ChildProcessWithoutNullStreams {
  const child = spawn('node', [FIXTURE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  observeFixture(child);
  spawnedChildren.push(child);
  return child;
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

function tuple(over: Partial<TerminalTuple>): TerminalTuple {
  return {
    windowId: 'win',
    terminalId: 'CC-1',
    pid: null,
    sessionId: 'session-1',
    workspacePath: null,
    agentType: 'claude',
    device: null,
    ...over,
  };
}

function report(c: MonitorBroadcastClient, windowId: string, tuples: TerminalTuple[], sessionDemand = true) {
  return c.request({ op: MONITOR_OP.reportTuples, windowId, tuples, sessionDemand });
}

/** One reset envelope in the `sessions watch` shape, for a given scope. */
function resetLine(scope: string, sessionId: string): string {
  return `emit ${JSON.stringify({
    version: 1, type: 'reset', streamId: `stream-${scope}`, sequence: 1, capturedAt: 1, scope,
    rows: [{ rowKey: `row-${scope}`, sourceDevice: scope, sessionId }],
  })}\n`;
}

afterEach(async () => {
  for (const c of clients.splice(0)) { try { c.close(); } catch { /* gone */ } }
  try {
    await Promise.all(hosts.splice(0).map((host) => host.stop()));
  } finally {
    await Promise.all(spawnedChildren.splice(0).map(disposeFixture));
    for (const p of tmpPaths.splice(0)) fs.rmSync(p, { force: true });
  }
});

describe('per-device session-stream scopes (real subprocess)', () => {
  test('only the local scope runs when no tab names a remote device', async () => {
    const socketPath = tempSocketPath();
    const devices: (string | undefined)[] = [];
    const host = new MonitorHost({
      socketPath,
      sessionStream: {
        enabled: true,
        log: () => { /* the fixture chats on stderr; not this test's subject */ },
        spawnWatch: (device) => { devices.push(device); return spawnFixture(); },
      },
    });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', [tuple({})]);

    await waitFor(() => host.sessionStreamRunning, 2000, 'the local producer');
    expect(host.sessionStreamScopes).toEqual(['local']);
    expect(devices).toEqual([undefined]);
  });

  test('a tab on a remote device earns that device its own child, and its rows arrive', async () => {
    const socketPath = tempSocketPath();
    const byDevice = new Map<string, ChildProcessWithoutNullStreams>();
    const host = new MonitorHost({
      socketPath,
      sessionStream: {
        enabled: true,
        log: () => { /* the fixture chats on stderr; not this test's subject */ },
        spawnWatch: (device) => {
          const child = spawnFixture();
          byDevice.set(device ?? 'local', child);
          return child;
        },
      },
    });
    hosts.push(host);
    await host.start();

    const seen: MonitorEvent[] = [];
    const a = connect(socketPath);
    a.subscribe((e) => { if (isSessionCliFact(e)) seen.push(e); });
    await waitConnected(a);

    // One local tab and one tab running on mac-mini.
    await report(a, 'winA', [
      tuple({}),
      tuple({ terminalId: 'CC-2', sessionId: 'session-2', device: 'mac-mini' }),
    ]);

    await waitFor(() => byDevice.has('mac-mini'), 2000, 'a mac-mini child');
    expect(host.sessionStreamScopes.sort()).toEqual(['local', 'mac-mini']);

    // The remote child's rows reach the follower under that device's own scope.
    byDevice.get('mac-mini')!.stdin.write(resetLine('mac-mini', 'session-2'));
    await waitFor(
      () => seen.some((e) => (e.payload as { scope?: string; type?: string }).scope === 'mac-mini'
        && (e.payload as { type?: string }).type === 'reset'),
      2000,
      'a mac-mini reset',
    );
    const reset = seen.find((e) => (e.payload as { scope?: string }).scope === 'mac-mini')!;
    expect((reset.payload as { agents?: unknown[] }).agents).toEqual([
      { rowKey: 'row-mac-mini', sourceDevice: 'mac-mini', sessionId: 'session-2' },
    ]);
  });

  test('closing the device’s last tab reaps its child and drops its replay scope', async () => {
    const socketPath = tempSocketPath();
    const byDevice = new Map<string, ChildProcessWithoutNullStreams>();
    const spawns: (string | undefined)[] = [];
    const host = new MonitorHost({
      socketPath,
      sessionStream: {
        enabled: true,
        log: () => { /* the fixture chats on stderr; not this test's subject */ },
        spawnWatch: (device) => {
          spawns.push(device);
          const child = spawnFixture();
          byDevice.set(device ?? 'local', child);
          return child;
        },
      },
    });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', [tuple({}), tuple({ terminalId: 'CC-2', device: 'mac-mini' })]);
    await waitFor(() => byDevice.has('mac-mini'), 2000, 'a mac-mini child');
    const remoteChild = byDevice.get('mac-mini')!;
    // Give it state, so a stale replay would be visible if the scope survived.
    remoteChild.stdin.write(resetLine('mac-mini', 'session-2'));
    byDevice.get('local')!.stdin.write(resetLine('local', 'session-1'));
    await new Promise((r) => setTimeout(r, 80));

    // The mac-mini tab closes. Its producer must be reaped, not left running.
    await report(a, 'winA', [tuple({})]);
    await waitFor(() => host.sessionStreamScopes.length === 1, 2000, 'the mac-mini scope to go');
    expect(host.sessionStreamScopes).toEqual(['local']);
    await waitFor(() => remoteChild.exitCode !== null || remoteChild.signalCode !== null, 3000, 'the mac-mini child to exit');

    // A window joining now must NOT be replayed rows nothing produces any more.
    const late: MonitorEvent[] = [];
    const b = connect(socketPath);
    b.subscribe((e) => { if (isSessionCliFact(e)) late.push(e); });
    await waitConnected(b);
    await report(b, 'winB', [tuple({ windowId: 'winB' })]);
    await waitFor(() => late.length > 0, 2000, 'a replay for the late window');
    expect(late.some((e) => (e.payload as { scope?: string }).scope === 'local')).toBe(true);
    expect(late.some((e) => (e.payload as { scope?: string }).scope === 'mac-mini')).toBe(false);

    // And the device is not respawned behind our back.
    expect(spawns.filter((d) => d === 'mac-mini')).toHaveLength(1);
  });

  test('a device with a tab in ANOTHER window keeps its child when this window closes its own', async () => {
    const socketPath = tempSocketPath();
    const spawns: (string | undefined)[] = [];
    const host = new MonitorHost({
      socketPath,
      sessionStream: {
        enabled: true,
        log: () => { /* the fixture chats on stderr; not this test's subject */ },
        spawnWatch: (device) => { spawns.push(device); return spawnFixture(); },
      },
    });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    const b = connect(socketPath);
    await waitConnected(a);
    await waitConnected(b);
    await report(a, 'winA', [tuple({ device: 'mac-mini' })]);
    await report(b, 'winB', [tuple({ windowId: 'winB', terminalId: 'CC-9', device: 'mac-mini' })]);
    await waitFor(() => host.sessionStreamScopes.includes('mac-mini'), 2000, 'a mac-mini child');

    // Window A closes its mac-mini tab; window B still has one. The union is what
    // decides, so the child stays up and is never respawned.
    await report(a, 'winA', []);
    await new Promise((r) => setTimeout(r, 80));
    expect(host.sessionStreamScopes.sort()).toEqual(['local', 'mac-mini']);
    expect(spawns.filter((d) => d === 'mac-mini')).toHaveLength(1);
  });

  test('a tuple naming the local scope is never treated as a remote device', async () => {
    const socketPath = tempSocketPath();
    const spawns: (string | undefined)[] = [];
    const host = new MonitorHost({
      socketPath,
      sessionStream: {
        enabled: true,
        log: () => { /* the fixture chats on stderr; not this test's subject */ },
        spawnWatch: (device) => { spawns.push(device); return spawnFixture(); },
      },
    });
    hosts.push(host);
    await host.start();

    const a = connect(socketPath);
    await waitConnected(a);
    await report(a, 'winA', [
      tuple({ device: 'local' }),
      tuple({ terminalId: 'CC-2', device: '  ' }),
      tuple({ terminalId: 'CC-3', device: null }),
    ]);
    await waitFor(() => host.sessionStreamRunning, 2000, 'the local producer');
    await new Promise((r) => setTimeout(r, 80));

    expect(host.sessionStreamScopes).toEqual(['local']);
    expect(spawns).toEqual([undefined]);
  });
});
