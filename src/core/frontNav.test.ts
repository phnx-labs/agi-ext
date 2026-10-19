// Next that needs you (owner video, 2026-10-19 1:32 AM; the catch-up prototype's
// planNext/nextForYou): an unseen ask first, by the CLI's urgency then the longest
// wait; then a turn that finished since you last had it in front, newest first; then
// the other asking and idle tabs round-robin; never a working or waiting one. ‹ is Back.
import { expect, test } from 'bun:test';
import { FrontHistory, frontNav, nextNeedsYou } from './frontNav';
import { DEFAULT_SESSION_PREFS, nextThatNeedsYou, renderSessions, type SessionLike } from './projectPanel';
import { DEFAULT_CARD_SETTINGS } from './settings';

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

test('‹ goes back through the tabs you had in front, like Back in a browser, and going back is not a new step', () => {
  const h = new FrontHistory();
  const s = (n: number) => n * 2000;
  h.front('a', s(1)); h.front('b', s(2)); h.front(undefined, s(3)); h.front('c', s(4));
  expect(h.backTrail()).toEqual(['b', 'a']);
  h.goBack('b'); h.front('b', s(5));
  expect(h.backTrail()).toEqual(['a']);
  h.goBack('a'); h.front('a', s(6));
  expect(h.backTrail()).toEqual([]);
  // The arrow names where it goes, skipping a session whose tab is gone.
  h.front('b', s(7)); h.front('gone', s(8)); h.front('c', s(9));
  const nav = frontNav('needs', [tab('a', 1), tab('b', 2), tab('c', 3)], tab('c', 3), h, (r) => r.title);
  expect(nav.prev).toEqual({ sessionId: 'b', host: 'zion', tip: 'Back: tab 2 · Task b' });
  expect(frontNav('needs', [tab('c', 3)], tab('c', 3), new FrontHistory(), (r) => r.title).prev).toEqual({ tip: 'Nothing to go back to' });
});

test('a tab passed through for under 1.5 s (restoring tabs at startup, a quick switch) is neither seen nor a step back', () => {
  const h = new FrontHistory();
  const tabs = [tab('a', 1, asking(min(-5))), tab('b', 2, { lastActivityMs: min(-3) }), tab('c', 3)];
  // The editor restores three tabs, each in front for a moment.
  h.front('a', min(0)); h.front('b', min(0) + 200); h.front('c', min(0) + 400);
  expect(h.backTrail()).toEqual([]);
  expect(nextNeedsYou(tabs, 'c', h)?.row.sessionId).toBe('a');
  h.front('a', min(1)); h.front('c', min(2));
  expect(h.backTrail()).toEqual(['a', 'c']);
  expect(nextNeedsYou(tabs, 'c', h)?.row.sessionId).toBe('b');
});

test('the pinned card draws each Settings mode: Tab order, Next that needs you (with Back), Off (no arrows)', () => {
  const h = new FrontHistory();
  h.front('a', min(0)); h.front('b', min(1));
  const rows = [tab('a', 1), tab('b', 2), tab('c', 3, asking(min(2)))];
  const draw = (arrows: 'tabs' | 'needs' | 'off') => { const html = renderSessions(rows, min(5), { selectedId: 'b', frontId: 'b', here: HERE, prefs: DEFAULT_SESSION_PREFS, cards: { ...DEFAULT_CARD_SETTINGS, arrows }, memory: h }); return html.slice(html.indexOf('<div class="front-pin">'), html.indexOf('data-group=')); };
  expect(draw('tabs')).toContain('data-front-step="next" data-session="c" data-host="zion" title="Next tab: tab 3 · Task c"');
  expect(draw('tabs')).toContain('data-front-step="prev" data-session="a" data-host="zion" title="Previous tab: tab 1 · Task a"');
  expect(draw('needs')).toContain('data-front-step="next" data-session="c" data-host="zion" title="Next that needs you: tab 3 · Task c"');
  expect(draw('needs')).toContain('data-front-step="prev" data-back data-session="a" data-host="zion" title="Back: tab 1 · Task a"');
  expect(draw('off')).not.toContain('fc-step');
  expect(draw('off')).toContain('<div class="fc-nav bare"><span class="thistab"');
  // The command picks what › names, from a shell or editor in front too.
  expect(nextThatNeedsYou(rows, { selectedId: null, frontId: null, here: HERE, prefs: DEFAULT_SESSION_PREFS, memory: h })?.row.sessionId).toBe('c');
});
