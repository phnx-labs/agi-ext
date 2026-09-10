import { afterEach, describe, expect, test } from 'bun:test';
import { activeMapCacheKey, fetchTerminalIdSessionMap, needsSessionIdHydrate, planSessionStreamRebinds, resolveSessionIdForTerminal } from './sessionIdHydrate';
import { sessionPresentationStore } from './sessionPresentationStore';

afterEach(() => sessionPresentationStore.clear());

describe('session id hydration from the canonical CLI stream', () => {
  test('plans A -> B for one observed terminal and ignores a late stale-A upsert', () => {
    const sessionA = '11111111-1111-4111-8111-111111111111';
    const sessionB = '22222222-2222-4222-8222-222222222222';
    const observerTerminals = [{ device: 'desktop', terminalId: 'CX-reused' }];
    sessionPresentationStore.apply({
      v: 1,
      type: 'reset',
      streamId: 'rebind', sequence: 1, capturedAt: 300, scope: 'worker', attention: [],
      agents: [
        { rowKey: 'a', sourceDevice: 'worker', machine: 'worker', sessionId: sessionA, startedAtMs: 100, observerTerminals },
        { rowKey: 'b', sourceDevice: 'worker', machine: 'worker', sessionId: sessionB, startedAtMs: 200, observerTerminals },
      ],
    });
    const tab = { id: 'CX-reused', host: 'worker', sessionId: sessionA };

    expect(planSessionStreamRebinds([tab], 'desktop', { localHostname: 'desktop' }))
      .toEqual([{ id: 'CX-reused', canonicalId: sessionB }]);
    tab.sessionId = sessionB;

    sessionPresentationStore.apply({
      v: 1,
      type: 'agent.upsert',
      streamId: 'rebind', sequence: 2, capturedAt: 400, scope: 'worker', rowKey: 'a',
      agent: { rowKey: 'a', sourceDevice: 'worker', machine: 'worker', sessionId: sessionA, startedAtMs: 100, lastActivityMs: 390, observerTerminals },
    });
    expect(planSessionStreamRebinds([tab], 'desktop', { localHostname: 'desktop' })).toEqual([]);
  });

  test('a local session (owner is this desktop) maps its top-level terminal id', async () => {
    sessionPresentationStore.apply({
      v: 1,
      type: 'reset',
      streamId: 'stream-a', sequence: 1, capturedAt: 1, scope: 'desktop',
      agents: [{ rowKey: 'one', sourceDevice: 'desktop', sessionId: 'session-1', terminalId: 'CX-1', machine: 'desktop' }], attention: [],
    });
    expect(await fetchTerminalIdSessionMap('desktop', { localHostname: 'desktop' })).toEqual(new Map([['CX-1', 'session-1']]));
    expect(await resolveSessionIdForTerminal('CX-1', 'desktop', { localHostname: 'desktop' })).toBe('session-1');
  });

  test('a worker session observed from a desktop resolves via its observerTerminals binding (PHNX-3939)', async () => {
    // The agent runs on box-a; its live terminal is a tab on THIS desktop. The
    // owner may carry no top-level terminalId — the desktop binding rides in
    // observerTerminals. resolveSessionIdForTerminal must still find it.
    sessionPresentationStore.apply({
      v: 1,
      type: 'reset',
      streamId: 'stream-a', sequence: 1, capturedAt: 1, scope: 'box-a',
      agents: [{ rowKey: 'one', sourceDevice: 'box-a', sessionId: 'session-1', machine: 'box-a', observerTerminals: [{ device: 'desktop', terminalId: 'CX-1' }] }], attention: [],
    });
    expect(await resolveSessionIdForTerminal('CX-1', 'box-a', { localHostname: 'desktop' })).toBe('session-1');
    // A remote owner's absence of an observer binding for THIS desktop yields nothing.
    expect(await resolveSessionIdForTerminal('CX-1', 'box-a', { localHostname: 'other-desktop' })).toBeUndefined();
  });

  test('scopes remote rows by host via observer bindings', async () => {
    sessionPresentationStore.apply({
      v: 1,
      type: 'reset',
      streamId: 'stream-b', sequence: 1, capturedAt: 1, scope: 'fleet',
      agents: [
        { rowKey: 'one', sourceDevice: 'box-a', sessionId: 'one', machine: 'box-a', observerTerminals: [{ device: 'desktop', terminalId: 'T-1' }] },
        { rowKey: 'two', sourceDevice: 'box-b', sessionId: 'two', machine: 'box-b', observerTerminals: [{ device: 'desktop', terminalId: 'T-2' }] },
      ], attention: [],
    });
    expect(await fetchTerminalIdSessionMap('box-a', { localHostname: 'desktop' })).toEqual(new Map([['T-1', 'one']]));
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
