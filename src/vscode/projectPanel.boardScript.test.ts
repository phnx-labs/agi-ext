// The Sessions tab (⌘⇧K, the approved prototype of 2026-11-26): the panel's real script and
// patch in happy-dom, drawn in board mode. One click on a card goes to its session, the pointer
// on a card shows it in the panel's pinned card; each card carries its last three steps; the four
// views filter by what each card carries; a PR or page opened from a Made row is reported seen;
// a ready PR's ring starts Review's merge flow without going to the session.
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { DEFAULT_SESSION_PREFS, renderSessions, prFacts, parsePrs } = await import('../core/projectPanel');
const { madeItems } = await import('../core/madeRow');
type Row = import('../core/projectPanel').SessionLike;

const NOW = Date.parse('2026-11-27T02:00:00Z');
const HERE = { device: 'zion', localHost: 'this-mac', workspace: 'agi-ext', editor: 'vscodium' as const, editorName: 'VSCodium', icons: {} };
const url = (n: number) => `https://github.com/me/x/pull/${n}`;
const facts = prFacts(parsePrs(JSON.stringify({ repositories: [{ slug: 'me/x', pullRequests: [
  { number: 7, title: 'ready one', url: url(7), ciState: 'SUCCESS', headSha: 'abc1234', createdAt: new Date(NOW - 60_000).toISOString() },
] }] })).repos);
const row = (id: string, i: number, o: Partial<Row> = {}): Row => ({
  sessionId: id, host: 'this-mac', title: `Task ${id}`, label: '', topic: '', phase: 'idle', liveStatus: 'idle', lastResponse: `Done with ${id}.`, agentType: 'claude',
  activity: '', ticket: null, lastActivityMs: NOW - i * 60_000, confirmedProject: 'agi', tabHere: false, ...o,
});
const rows: Row[] = [
  row('a', 0, { phase: 'idle', liveStatus: 'waiting', attention: { key: 'k-a', kind: 'question', state: 'open', openedAt: new Date(NOW - 120_000).toISOString(), question: { text: 'Ship it?', options: [{ label: 'Yes' }] } } }),
  row('b', 1, { timeline: { steps: [
    { text: 'Read the plan', at: new Date(NOW - 240_000).toISOString() },
    { text: 'Ran 4 commands', at: new Date(NOW - 180_000).toISOString() },
    { text: 'Ship it?', at: new Date(NOW - 150_000).toISOString(), source: 'user' },
    { text: 'Recap: you asked to ship it, and it is merged.', at: new Date(NOW - 120_000).toISOString() },
  ] } }),
  row('c', 2),
];
const madeFor = (s: Row) => ({
  prs: [], ticket: null, folders: [],
  items: madeItems({
    prs: s.sessionId === 'b' ? [{ url: url(7), ownerRepo: 'me/x', number: 7 }] : [], touched: [],
    files: s.sessionId === 'c' ? [{ path: '/home/me/.agents/artifacts/p/index.html', name: 'index.html', title: 'A page', editedAtMs: NOW - 60_000 }] : [],
    said: s.sessionId === 'a' ? 'Waiting on you before #7 can go in.' : '', fact: (k) => facts.find((f) => f.url.toLowerCase() === k), known: facts, opened: () => undefined, since: NOW - 86_400_000,
  }),
});
const draw = () => renderSessions(rows, NOW, { selectedId: null, frontId: 'a', here: HERE, prefs: DEFAULT_SESSION_PREFS, madeFor, board: true, mergeWith: 'squash' });

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:', '', true);
document.body.innerHTML = page.slice(page.indexOf('<body class="board">') + 20, page.indexOf('<script'));
document.body.className = 'board';
const sent: { type: string; sessionId?: string; host?: string; key?: string; path?: string; url?: string }[] = [];
const script = page.match(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/i)![1];
const main = document.querySelector('main') as unknown as HTMLElement;
(window.HTMLElement.prototype as unknown as { animate(): unknown }).animate = function () { return {}; };
new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: { type: string }) => sent.push(m), getState: () => ({}), setState: () => undefined }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* the thumbnails are not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 1200, 800,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
const $$ = (sel: string) => [...main.querySelectorAll(sel)] as unknown as HTMLElement[];
const shown = () => $$('.grp .items .card').filter((c) => c.style.display !== 'none').map((c) => c.dataset.session);

deliver({ type: 'tab', tab: 'sessions' });
deliver({ type: 'html', tab: 'sessions', html: draw() });

test('the Sessions tab pins nothing and always shows its filter with four counted views', () => {
  expect($$('.front-pin')).toHaveLength(0);
  expect(($('.frow') as unknown as { hidden: boolean }).hidden).toBe(false);
  expect([...document.querySelectorAll('.bseg [data-seg]')].map((b) => `${b.getAttribute('data-seg')} ${b.querySelector('.n')!.textContent}`))
    .toEqual(['all 3', 'need 1', 'ready 2', 'unread 3']);
});

test('each view keeps only the cards that carry it', () => {
  ($('.bseg [data-seg="need"]')).click();
  expect(shown()).toEqual(['a']);
  ($('.bseg [data-seg="ready"]')).click();
  expect(shown().sort()).toEqual(['a', 'b']);
  ($('.bseg [data-seg="unread"]')).click();
  expect(shown().sort()).toEqual(['a', 'b', 'c']);
  ($('.bseg [data-seg="all"]')).click();
  expect(shown().sort()).toEqual(['a', 'b', 'c']);
});

test('one click on a card goes to its session', () => {
  sent.length = 0;
  $$('.card[data-session="c"]')[0]!.click();
  expect(sent).toEqual([{ type: 'focus', sessionId: 'c', host: 'this-mac' }]);
});

test('the pointer on a card shows it in the panel, and leaving the page gives the front tab back', async () => {
  sent.length = 0;
  $$('.card[data-session="b"] .top')[0]!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }) as unknown as Event);
  await new Promise((r) => setTimeout(r, 200));
  expect(sent).toEqual([{ type: 'peek', sessionId: 'b', host: 'this-mac' }]);
  document.documentElement.dispatchEvent(new window.MouseEvent('mouseleave') as unknown as Event);
  await new Promise((r) => setTimeout(r, 20));
  expect(sent).toEqual([{ type: 'peek', sessionId: 'b', host: 'this-mac' }, { type: 'peek' }]);
});

test('a card shows its last three steps, a recap without its label', () => {
  const steps = $$('.card[data-session="b"] .bsteps li').map((li) => li.querySelector('.fc-at')!.textContent);
  expect(steps).toEqual(['Ran 4 commands', 'You Ship it?', 'you asked to ship it, and it is merged.']);
});

test('a page on a card opens as that session’s and is reported seen', () => {
  sent.length = 0;
  $('.card[data-session="c"] [data-artifact]').click();
  expect(sent).toEqual([
    { type: 'seen', key: '/home/me/.agents/artifacts/p/index.html' },
    { type: 'artifact', sessionId: 'c', host: 'this-mac', path: '/home/me/.agents/artifacts/p/index.html' },
  ]);
});

test('the panel pins the session under the pointer in place of the front tab’s', () => {
  const panel = renderSessions(rows, NOW, { selectedId: null, frontId: null, here: HERE, prefs: DEFAULT_SESSION_PREFS, madeFor, peek: { sessionId: 'c', host: 'this-mac' } });
  expect(panel).toMatch(/<div class="front-pin"><div class="card [^"]*front[^"]*"[^>]*data-session="c"/);
  expect(renderSessions(rows, NOW, { selectedId: null, frontId: null, here: HERE, prefs: DEFAULT_SESSION_PREFS, madeFor, board: true, peek: { sessionId: 'c', host: 'this-mac' } })).not.toContain('front-pin');
});

test('a ready PR’s ring arms Review’s merge (Undo first) and goes nowhere', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  sent.length = 0;
  const ring = $$('.card[data-session="b"] .mi-pr .pring')[0]!;
  ring.click();
  expect(ring.classList.contains('armed')).toBe(true);
  expect(sent).toEqual([]);
  ring.click();
  expect(ring.classList.contains('armed')).toBe(false);
  sent.length = 0;
  $$('.card[data-session="b"] .chip.mi.pr')[0]!.click();
  expect(sent).toEqual([{ type: 'seen', key: url(7) }, { type: 'open', url: url(7), external: false }]);
});

test('one PR’s ring on two cards counts down, stops and lands as one (review on #229)', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  const rings = () => $$('.pring[data-merge-number="7"]');
  expect(rings()).toHaveLength(2);
  rings()[1]!.click();
  expect(rings().every((r) => r.classList.contains('armed'))).toBe(true);
  rings()[0]!.click();
  expect(rings().some((r) => r.classList.contains('armed'))).toBe(false);
  deliver({ type: 'merged', repo: 'me/x', number: 7, error: '', merged: true });
  expect(rings().every((r) => r.classList.contains('v-merged'))).toBe(true);
});
