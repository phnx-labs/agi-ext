// The TRANSPORT half of the session stream: which command runs, and how its
// envelope maps onto the presentation store's vocabulary.
// `sessionCliStream.test.ts` beside this covers the other half — the process
// lifecycle (generation, reap, group teardown, restart backoff) — and
// `host.test.ts` covers the per-device scope set.
//
// The argv assertions are the load-bearing ones. 0.9.361 (e0f4831) deleted this
// producer because it ran `agents feed watch --json`, whose 500 ms interval
// re-reads every session file on disk. If `feed` ever reappears in these args, or
// `--local` is dropped so the CLI fans out over the whole fleet, this file fails.

import { expect, test } from 'bun:test';
import { spawn } from 'child_process';
import {
  LOCAL_SCOPE_KEY,
  SessionCliReplay,
  SessionCliStream,
  adaptSessionWatchEnvelope,
  sessionWatchArgs,
  type SessionCliEvent,
} from './sessionCliStream';

// ── The command ──────────────────────────────────────────────────────────────

test('the watch child runs `sessions watch --json --local` and never `feed`', () => {
  expect(sessionWatchArgs()).toEqual(['sessions', 'watch', '--json', '--local']);
  expect(sessionWatchArgs()).not.toContain('feed');
});

test('a remote device scope adds -D <device> and nothing else', () => {
  expect(sessionWatchArgs('yosemite-m2')).toEqual([
    'sessions', 'watch', '--json', '--local', '-D', 'yosemite-m2',
  ]);
  expect(sessionWatchArgs('yosemite-m2')).not.toContain('feed');
});

test('a stream instance reports the scope it produces for', () => {
  const local = new SessionCliStream({ emit: () => { /* unused */ } });
  const remote = new SessionCliStream({ emit: () => { /* unused */ }, device: 'mac-mini' });
  expect(local.scopeKey).toBe(LOCAL_SCOPE_KEY);
  expect(remote.scopeKey).toBe('mac-mini');
});

// ── Envelope bridging ────────────────────────────────────────────────────────
// `sessions watch` says reset/upsert/remove with rows/row; the store says
// reset/agent.upsert/agent.remove with agents/agent, and additionally understands
// attention.* and activity.append (which only `feed watch` produces). The adapter
// renames the first vocabulary and passes the second through — a bridge, not a
// filter, so which facts exist is decided by the argv above and nowhere else.

test('a reset maps rows -> agents without renaming the row itself', () => {
  expect(adaptSessionWatchEnvelope({
    version: 1, type: 'reset', streamId: 'cli', sequence: 1, capturedAt: 5, scope: 'zion',
    rows: [{ rowKey: 'a', sessionId: 's1', sourceDevice: 'zion' }],
  })).toEqual({
    v: 1, type: 'reset', streamId: 'cli', sequence: 1, capturedAt: 5, scope: 'zion',
    agents: [{ rowKey: 'a', sessionId: 's1', sourceDevice: 'zion' }], attention: [],
  });
});

test('upsert and remove map onto the store’s agent.* event names', () => {
  expect(adaptSessionWatchEnvelope({
    version: 1, type: 'upsert', streamId: 'cli', sequence: 2, capturedAt: 6, scope: 'zion',
    rowKey: 'a', row: { rowKey: 'a', sessionId: 's1' },
  })).toEqual({
    v: 1, type: 'agent.upsert', streamId: 'cli', sequence: 2, capturedAt: 6, scope: 'zion',
    rowKey: 'a', agent: { rowKey: 'a', sessionId: 's1' },
  });
  expect(adaptSessionWatchEnvelope({
    version: 1, type: 'remove', streamId: 'cli', sequence: 3, capturedAt: 7, scope: 'zion', rowKey: 'a',
  })).toEqual({
    v: 1, type: 'agent.remove', streamId: 'cli', sequence: 3, capturedAt: 7, scope: 'zion', rowKey: 'a',
  });
});

test('store-vocabulary events pass through verbatim', () => {
  // A reset already in the store's shape keeps its rows AND its attention lane.
  const storeReset = {
    v: 1, type: 'reset', streamId: 'cli', sequence: 1, capturedAt: 1, scope: 'local',
    agents: [{ rowKey: 'r1', sessionId: 's1' }],
    attention: [{ key: 'kA', sessionId: 's1', state: 'open' }],
  };
  expect(adaptSessionWatchEnvelope(storeReset)).toEqual(storeReset);

  for (const event of [
    { v: 1, type: 'agent.upsert', streamId: 'cli', sequence: 2, capturedAt: 2, scope: 'local', rowKey: 'r1', agent: { rowKey: 'r1' } },
    { v: 1, type: 'attention.upsert', streamId: 'cli', sequence: 3, capturedAt: 3, scope: 'local', rowKey: 'kA', attention: { key: 'kA' } },
    { v: 1, type: 'attention.remove', streamId: 'cli', sequence: 4, capturedAt: 4, scope: 'local', rowKey: 'kA', resolution: { state: 'answered' } },
    { v: 1, type: 'activity.append', streamId: 'cli', sequence: 5, capturedAt: 5, scope: 'local', event: { ts: '2026-09-06T00:00:00Z' } },
    { v: 1, type: 'scope', streamId: 'cli', sequence: 6, capturedAt: 6, scope: 'local', status: 'available' },
    { v: 1, type: 'heartbeat', streamId: 'cli', sequence: 7, capturedAt: 7, scope: 'local' },
  ]) {
    expect(adaptSessionWatchEnvelope(event)).toEqual(event);
  }
});

test('a malformed or unknown envelope is dropped, not half-applied', () => {
  expect(adaptSessionWatchEnvelope({ version: 2, type: 'reset', streamId: 'x', sequence: 1, scope: 'z' })).toBeUndefined();
  expect(adaptSessionWatchEnvelope({ version: 1, type: 'reset', sequence: 1, scope: 'z' })).toBeUndefined();
  expect(adaptSessionWatchEnvelope({ version: 1, type: 'upsert', streamId: 'x', sequence: 1, scope: 'z' })).toBeUndefined();
  expect(adaptSessionWatchEnvelope({ version: 1, type: 'future-thing', streamId: 'x', sequence: 1, scope: 'z' })).toBeUndefined();
  expect(adaptSessionWatchEnvelope('not an object')).toBeUndefined();
});

// ── A real child, over a real pipe ───────────────────────────────────────────

test('a real child’s sessions-watch NDJSON reaches emit as an adapted store event', async () => {
  const line = JSON.stringify({
    version: 1, type: 'reset', streamId: 'stream-1', sequence: 1, capturedAt: 10, scope: 'zion',
    rows: [{ rowKey: 'row-1', sourceDevice: 'zion', sessionId: 'session-1' }],
  });
  const stream = new SessionCliStream({
    emit: () => { /* replaced below */ },
    spawnWatch: () => spawn(process.execPath, [
      '-e', `process.stdout.write(${JSON.stringify(`${line}\n`)}); setInterval(() => {}, 1000)`,
    ], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }),
  });
  const received = await new Promise<SessionCliEvent>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).options.emit = resolve;
    stream.start();
    setTimeout(() => reject(new Error('no event from the child')), 4_000);
  });
  await stream.stop();
  expect(received).toEqual({
    v: 1, type: 'reset', streamId: 'stream-1', sequence: 1, capturedAt: 10, scope: 'zion',
    agents: [{ rowKey: 'row-1', sourceDevice: 'zion', sessionId: 'session-1' }], attention: [],
  });
});

test('stderr is surfaced as it arrives, never discarded, and names its scope', async () => {
  // onStderr, NOT onError: a healthy child talks on stderr, and routing that to
  // the fault channel turned a clean leader handoff into three reported errors
  // (leader.handoff.test.ts). Diagnostics and faults are different channels; the
  // extension points both at the "Agents: Monitor" output channel.
  let stream!: SessionCliStream;
  const message = await new Promise<string>((resolve, reject) => {
    stream = new SessionCliStream({
      device: 'yosemite-m2',
      restartMs: 50_000, // never restart inside this test
      emit: () => { /* no rows */ },
      onStderr: resolve,
      spawnWatch: () => spawn(process.execPath, [
        '-e', "process.stderr.write(\"error: unknown option '-D'\\n\"); setInterval(() => {}, 1000)",
      ], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }),
    });
    stream.start();
    setTimeout(() => reject(new Error('stderr was swallowed')), 4_000);
  });
  await stream.stop();
  expect(message).toContain("unknown option '-D'");
  // The scope AND the exact command are in the line, so the output channel says
  // which child is unhappy rather than just that something is.
  expect(message).toContain('[yosemite-m2]');
  expect(message).toContain('agents sessions watch --json --local -D yosemite-m2');
});

// ── Replay ───────────────────────────────────────────────────────────────────

test('SessionCliReplay gives a late window the current rows, and drops a dead scope', () => {
  const replay = new SessionCliReplay();
  replay.ingest({ v: 1, type: 'reset', streamId: 'cli', sequence: 1, capturedAt: 1, scope: 'zion', agents: [
    { rowKey: 'a', sourceDevice: 'zion', sessionId: 'old' },
  ], attention: [] });
  replay.ingest({ v: 1, type: 'agent.upsert', streamId: 'cli', sequence: 3, capturedAt: 3, scope: 'zion', rowKey: 'b', agent:
    { rowKey: 'b', sourceDevice: 'zion', sessionId: 'current' },
  });
  replay.ingest({ v: 1, type: 'agent.remove', streamId: 'cli', sequence: 4, capturedAt: 4, scope: 'zion', rowKey: 'a' });
  replay.ingest({ v: 1, type: 'scope', streamId: 'cli', sequence: 5, capturedAt: 5, scope: 'zion', status: 'available' });
  const first = replay.envelopes('late-window');
  expect(first).toEqual([
    { v: 1, type: 'reset', streamId: 'replay:late-window:zion:1', sequence: 1, capturedAt: 5, scope: 'zion', agents: [
      { rowKey: 'b', sourceDevice: 'zion', sessionId: 'current' },
    ], attention: [] },
    { v: 1, type: 'scope', streamId: 'replay:late-window:zion:1', sequence: 2, capturedAt: 5, scope: 'zion', status: 'available' },
  ]);
  expect(replay.envelopes('late-window')[0].streamId).not.toBe(first[0].streamId);

  // A device whose last tab closed stops being replayed to new windows: nothing
  // is producing those rows any more, so handing them out would be a lie.
  replay.drop('zion');
  expect(replay.envelopes('another-window')).toEqual([]);
  expect(replay.hasState).toBe(false);
});
