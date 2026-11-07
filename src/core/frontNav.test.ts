// Next that needs you (owner video, 2026-10-19 1:32 AM; the catch-up prototype's
// planNext/nextForYou): an unseen ask first, by the CLI's urgency then the longest
// wait; then a turn that finished since you last had it in front, newest first; then
// the other asking and idle tabs round-robin; never a working or waiting one. The pinned
// card has no ‹ ›: it follows the front tab (owner video, 2026-11-07 0:04).
import { expect, test } from 'bun:test';
import { FrontHistory, nextNeedsYou } from './frontNav';
import { DEFAULT_SESSION_PREFS, nextThatNeedsYou, renderSessions, type SessionLike } from './projectPanel';

const T = Date.parse('2026-10-19T01:00:00Z');
const min = (m: number) => T + m * 60_000;
const tab = (id: string, n: number, o: Partial<SessionLike> = {}): SessionLike => ({
  sessionId: id, host: 'zion', title: `Task ${id}`, label: '', topic: '', phase: 'idle', liveStatus: 'idle',
  lastResponse: '', activity: '', ticket: null, lastActivityMs: min(0), confirmedProject: 'agi', tabHere: true, tabIndex: n, ...o,
});
const asking = (at: number, urgency?: string) => ({ phase: 'waiting', liveStatus: 'input_required', lastActivityMs: at, attention: { key: `k${at}`, kind: 'question', state: 'open', openedAt: new Date(at).toISOString(), urgency } }) as Partial<SessionLike>;
const working = { phase: 'running', liveStatus: 'running' } as Partial<SessionLike>;
const HERE = { device: 'zion', localHost: 'this-mac', workspace: 'agents', editor: 'vscodium' as const, editorName: 'VSCodium', icons: {} };

test('an ask you have not had in front since it asked comes first: urgency, then the longest wait', () => {
  const h = new FrontHistory();
  const tabs = [tab('front', 1), tab('idle', 2, { lastActivityMs: min(9) }), tab('old', 3, asking(min(1))), tab('urgent', 4, asking(min(5), 'urgent')), tab('run', 5, working)];
  h.front('front', min(10));
  expect(nextNeedsYou(tabs, 'front', h)).toMatchObject({ row: { sessionId: 'urgent' }, why: 'asks you' });
  // Seen since it asked: the next ask.
  h.front('urgent', min(11)); h.front('front', min(12));
  expect(nextNeedsYou(tabs, 'front', h)?.row.sessionId).toBe('old');
  // It asks again later: unseen again.
  const again = tabs.map((t) => (t.sessionId === 'urgent' ? tab('urgent', 4, asking(min(13), 'urgent')) : t));
  expect(nextNeedsYou(again, 'front', h)?.row.sessionId).toBe('urgent');
});

test('then a turn that finished after you last had it in front, newest first; then the rest round-robin; never a working one', () => {
  const h = new FrontHistory();
  const tabs = [tab('a', 1), tab('b', 2, { lastActivityMs: min(3) }), tab('c', 3, { lastActivityMs: min(7) }), tab('w', 4, { ...working, lastActivityMs: min(20) }), tab('wait', 5, { pending: { subagents: [{ id: 'x' }] } as never })];
  h.front('a', min(0));
  expect(nextNeedsYou(tabs, 'a', h)).toMatchObject({ row: { sessionId: 'c' }, why: 'finished since you looked' });
  h.front('c', min(8));
  expect(nextNeedsYou(tabs, 'c', h)?.row.sessionId).toBe('b');
  h.front('b', min(9));
  // Everything seen: the one you saw longest ago (a, at 8), then c, then b again.
  expect(nextNeedsYou(tabs, 'b', h)).toMatchObject({ row: { sessionId: 'a' }, why: 'next in turn' });
  h.front('a', min(10));
  expect(nextNeedsYou(tabs, 'a', h)?.row.sessionId).toBe('c');
  // c finishes another turn after you left it: fresh again.
  const later = tabs.map((t) => (t.sessionId === 'b' ? tab('b', 2, { lastActivityMs: min(11) }) : t));
  expect(nextNeedsYou(later, 'a', h)?.row.sessionId).toBe('b');
  // Only working tabs besides the front one: nowhere to go.
  expect(nextNeedsYou([tab('a', 1), tab('w', 2, working)], 'a', h)).toBeUndefined();
});

test('a tab passed through for under 1.5 s (restoring tabs at startup, a quick switch) is not seen', () => {
  const h = new FrontHistory();
  const tabs = [tab('a', 1, asking(min(-5))), tab('b', 2, { lastActivityMs: min(-3) }), tab('c', 3)];
  // The editor restores three tabs, each in front for a moment.
  h.front('a', min(0)); h.front('b', min(0) + 200); h.front('c', min(0) + 400);
  expect(h.seenAt('a')).toBeUndefined();
  expect(nextNeedsYou(tabs, 'c', h)?.row.sessionId).toBe('a');
  h.front('a', min(1)); h.front('c', min(2));
  expect(nextNeedsYou(tabs, 'c', h)?.row.sessionId).toBe('b');
});

test('the pinned card draws no arrows and no place among the tabs; the command still picks the next that needs you', () => {
  const h = new FrontHistory();
  h.front('a', min(0)); h.front('b', min(1));
  const rows = [tab('a', 1), tab('b', 2), tab('c', 3, asking(min(2)))];
  const html = renderSessions(rows, min(5), { selectedId: 'b', frontId: 'b', here: HERE, prefs: DEFAULT_SESSION_PREFS, memory: h });
  const pin = html.slice(html.indexOf('<div class="front-pin">'), html.indexOf('data-group='));
  expect(pin).not.toContain('data-front-step');
  expect(pin).not.toContain('Tab 2 of 3');
  // The command picks what needs you, from a shell or editor in front too.
  expect(nextThatNeedsYou(rows, { selectedId: null, frontId: null, here: HERE, prefs: DEFAULT_SESSION_PREFS, memory: h })?.row.sessionId).toBe('c');
});
