import { afterEach, describe, expect, test } from 'bun:test';
import { activeMapCacheKey, fetchTerminalIdSessionMap, needsSessionIdHydrate } from './sessionIdHydrate';
import { sessionPresentationStore } from './sessionPresentationStore';

afterEach(() => sessionPresentationStore.clear());

describe('session id hydration from the canonical CLI stream', () => {
  test('a local session (owner is this desktop) maps its top-level terminal id', async () => {
    sessionPresentationStore.apply({
      v: 1,
      type: 'reset',
      streamId: 'stream-a', sequence: 1, capturedAt: 1, scope: 'desktop',
      agents: [{ rowKey: 'one', sourceDevice: 'desktop', sessionId: 'session-1', terminalId: 'CX-1', machine: 'desktop' }], attention: [],
    });
    expect(await fetchTerminalIdSessionMap('desktop', { localHostname: 'desktop' })).toEqual(new Map([['CX-1', 'session-1']]));
  });

  test('a worker session maps through THIS desktop\'s observerTerminals binding, scoped by host (PHNX-3939)', async () => {
    sessionPresentationStore.apply({
      v: 1,
      type: 'reset',
      streamId: 'stream-b', sequence: 1, capturedAt: 1, scope: 'workers',
      agents: [
        { rowKey: 'one', sourceDevice: 'box-a', sessionId: 'one', machine: 'box-a', observerTerminals: [{ device: 'desktop', terminalId: 'T-1' }] },
        { rowKey: 'two', sourceDevice: 'box-b', sessionId: 'two', machine: 'box-b', observerTerminals: [{ device: 'desktop', terminalId: 'T-2' }] },
      ], attention: [],
    });
    expect(await fetchTerminalIdSessionMap('box-a', { localHostname: 'desktop' })).toEqual(new Map([['T-1', 'one']]));
    expect((await fetchTerminalIdSessionMap('box-a', { localHostname: 'other-desktop' })).size).toBe(0);
  });
});

describe('session id hydration helpers', () => {
  test('same-machine placement collapses to the local key', () => {
    expect(activeMapCacheKey('zion.tailnet', 'zion', 'zion')).toBe('__local__');
  });
  test('dirty or absent ids still need hydration', () => {
    expect(needsSessionIdHydrate(undefined)).toBe(true);
    expect(needsSessionIdHydrate('rollout-2026-session')).toBe(true);
  });
});
