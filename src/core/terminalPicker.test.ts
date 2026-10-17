import { describe, expect, test } from 'bun:test';
import { SessionPresentationStore } from './sessionPresentationStore';
import { terminalPickFace } from './terminalPicker';

const ASK = 'Ship the fix for the stalled resume picker and add a regression test beside it, then open the PR';

function storeRow(sessionId: string, row: Record<string, unknown>) {
  const store = new SessionPresentationStore();
  store.apply({
    v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'zion',
    agents: [{ rowKey: 'r1', kind: 'claude', status: 'idle', sessionId, sourceDevice: 'zion', ...row }],
    attention: [],
  });
  return store.presentedSessions('zion', 'this-mac').find((s) => s.sessionId === sessionId);
}

describe('terminalPickFace', () => {
  test('draws the detail line and the activity time from the stream row', () => {
    const now = Date.now();
    const face = terminalPickFace(storeRow('s1', { firstUserMessage: ASK, lastActivityMs: now - 5 * 60_000 }), now);
    expect(face).toEqual({
      description: '5m ago',
      detail: 'Ship the fix for the stalled resume picker and add a regression test beside i...',
      lastActivityMs: now - 5 * 60_000,
    });
  });

  test('says Just now within a minute of the last activity', () => {
    const now = Date.now();
    expect(terminalPickFace(storeRow('s1', { firstUserMessage: 'Ship the fix', lastActivityMs: now - 10_000 }), now))
      .toEqual({ description: 'Just now', detail: 'Ship the fix', lastActivityMs: now - 10_000 });
  });

  test('a row without activity or a first ask leaves those parts empty', () => {
    expect(terminalPickFace(storeRow('s1', {}))).toEqual({ description: '', detail: '' });
  });

  test('a tab the stream has not named shows neither part', () => {
    expect(terminalPickFace(undefined)).toEqual({ description: '', detail: '' });
  });
});
