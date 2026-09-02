import { expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { SessionCliReplay, SessionCliStream, type SessionCliEvent } from './sessionCliStream';

test('SessionCliStream forwards the canonical CLI envelope without renaming fields', async () => {
  const expected: SessionCliEvent = {
    v: 1,
    type: 'reset',
    streamId: 'stream-1',
    sequence: 1,
    capturedAt: 10,
    scope: 'zion',
    agents: [{ rowKey: 'row-1', sourceDevice: 'zion', sessionId: 'session-1' }], attention: [],
  };
  const received = await new Promise<SessionCliEvent>((resolve, reject) => {
    const stream = new SessionCliStream({
      emit: (event) => { stream.stop(); resolve(event); },
      onError: reject,
      spawnWatch: () => spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify(expected)}\n`)})`]),
    });
    stream.start();
  });
  expect(received).toEqual(expected);
});

test('SessionCliReplay gives a late window the current rows without another CLI process', () => {
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
});

test('SessionCliStream restarts after the CLI child exits unexpectedly', async () => {
  let spawns = 0;
  const event: SessionCliEvent = {
    v: 1,
    type: 'heartbeat',
    streamId: 'stream-restart',
    sequence: 1,
    capturedAt: 20,
    scope: 'local',
  };
  const received = await new Promise<SessionCliEvent>((resolve, reject) => {
    const stream = new SessionCliStream({
      restartMs: 20,
      emit: (ev) => { stream.stop(); resolve(ev); },
      onError: () => { /* exit of first child is expected */ },
      spawnWatch: () => {
        spawns += 1;
        if (spawns === 1) {
          // Exit immediately without output — stream must restart.
          return spawn(process.execPath, ['-e', 'process.exit(0)']);
        }
        return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)})`]);
      },
    });
    stream.start();
    setTimeout(() => reject(new Error('stream did not restart with an event')), 2_000);
  });
  expect(spawns).toBeGreaterThanOrEqual(2);
  expect(received).toEqual(event);
});

test('SessionCliStream backs off exponentially when the child keeps dying (PHNX-3818)', async () => {
  // A child that always exits immediately. With the old fixed 10ms restart this
  // would respawn ~25 times in 300ms (the 1-spawn/sec drip class); with backoff
  // (10, 20, 40, 80, 160, …) the count stays small. Assert the rate is bounded.
  let spawns = 0;
  const stream = new SessionCliStream({
    restartMs: 10,
    emit: () => { /* never emits — child dies before output */ },
    onError: () => { /* expected on every exit */ },
    spawnWatch: () => {
      spawns += 1;
      return spawn(process.execPath, ['-e', 'process.exit(1)']);
    },
  });
  stream.start();
  await new Promise((r) => setTimeout(r, 300));
  stream.stop();
  const backoffCount = spawns;

  // It kept trying (not stuck), but far fewer than a fixed-interval drip would.
  expect(backoffCount).toBeGreaterThanOrEqual(2);
  expect(backoffCount).toBeLessThanOrEqual(8);
});
