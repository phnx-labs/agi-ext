// The Project panel's real webview script and real patch, in happy-dom (owner video,
// 2026-10-19 1:32 AM: "when I do go here, it completely changes my view, it just goes
// to the top"). happy-dom lays nothing out, so this file gives each card a height and
// the panel a scroll position; everything else is the page's own code. A clicked card
// stays where it was on screen while the pinned card above it changes; an arrow or the
// command keeps the scroll unless the session's card is off screen.
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { DEFAULT_SESSION_PREFS, renderSessions } = await import('../core/projectPanel');
type Row = import('../core/projectPanel').SessionLike;

const NOW = Date.parse('2026-10-19T01:32:00Z');
const HERE = { device: 'zion', localHost: 'this-mac', workspace: 'agi-ext', editor: 'vscodium' as const, editorName: 'VSCodium', icons: {} };
const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const ROWS: Row[] = IDS.map((id, i) => ({
  sessionId: id, host: 'zion', title: `Task ${id}`, label: '', topic: '', phase: 'idle', liveStatus: 'idle', lastResponse: `Done with ${id}.`,
  activity: '', ticket: null, lastActivityMs: NOW - i * 60_000, confirmedProject: 'agi', tabHere: true, tabIndex: i + 1,
}));
const draw = (front: string) => renderSessions(ROWS, NOW, { selectedId: front, frontId: front, here: HERE, prefs: DEFAULT_SESSION_PREFS });

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:');
document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
const sent: { type: string; sessionId?: string }[] = [];
const script = page.match(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/i)![1];
const main = document.querySelector('main') as unknown as HTMLElement;

// The geometry happy-dom lacks: a 600 px panel; a listed card is 80 px, the pinned
// card's height depends on the session (its recap, steps and reply box differ).
const PINNED: Record<string, number> = { a: 200, g: 460 };
let scroll = 0;
Object.defineProperty(main, 'scrollTop', { get: () => scroll, set: (v: number) => { scroll = Math.max(0, v); } });
const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON() { return this; } });
function placeOf(el: Element): { top: number; height: number } | undefined {
  let y = 0;
  for (const c of main.querySelectorAll('.card')) {
    const h = c.closest('.front-pin') ? PINNED[(c as HTMLElement).dataset.session!] ?? 300 : 80;
    if (c === el) return { top: y, height: h };
    y += h + 8;
  }
  return undefined;
}
const proto = window.HTMLElement.prototype as unknown as { getBoundingClientRect(): unknown; scrollIntoView(o?: unknown): void };
proto.getBoundingClientRect = function (this: Element) {
  if (this === (main as unknown)) return box(0, 600);
  const p = placeOf(this);
  return p ? box(p.top - scroll, p.height) : box(0, 0);
};
proto.scrollIntoView = function (this: Element) {
  const p = placeOf(this)!;
  scroll = p.top < scroll ? p.top : p.top + p.height > scroll + 600 ? p.top + p.height - 600 : scroll;
};

new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: { type: string }) => sent.push(m), getState: () => ({}), setState: () => undefined }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* the thumbnails are not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 800, 600,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const listed = (id: string) => [...main.querySelectorAll(`.card[data-session="${id}"]`)].find((c) => !c.closest('.front-pin')) as unknown as HTMLElement;
const pinnedId = () => (main.querySelector('.front-pin .card') as unknown as HTMLElement | null)?.dataset.session;

deliver({ type: 'tab', tab: 'sessions' });
deliver({ type: 'html', tab: 'sessions', html: draw('a') });

test('a click on a lower card keeps that card where it was while its tab comes forward, and it stays listed', () => {
  scroll = 400;
  const before = (listed('g').getBoundingClientRect() as DOMRect).top;
  listed('g').click();
  expect(sent.at(-1)).toMatchObject({ type: 'select', sessionId: 'g' });
  // The sidebar's subject redraw, then the front tab's: the pinned card grows by 260 px.
  deliver({ type: 'html', tab: 'sessions', html: renderSessions(ROWS, NOW, { selectedId: 'g', frontId: 'a', here: HERE, prefs: DEFAULT_SESSION_PREFS }) });
  deliver({ type: 'html', tab: 'sessions', html: draw('g') });
  deliver({ type: 'reveal', sessionId: 'g', flash: false });
  expect(pinnedId()).toBe('g');
  expect((listed('g').getBoundingClientRect() as DOMRect).top).toBe(before);
  expect(scroll).toBe(400 + 260);
  // Open tabs still lists every tab, in tab order, the front one with the selected rail.
  expect([...main.querySelectorAll('[data-group="here"] .card')].map((c) => (c as HTMLElement).dataset.session)).toEqual(IDS);
  expect(listed('g').classList.contains('sel')).toBe(true);
});

test('an arrow or the command fronting a tab keeps the scroll while a card of it shows; one off screen scrolls to the nearest edge', () => {
  // At the top, looking at the pinned card: › fronts a; the view does not move.
  scroll = 0;
  deliver({ type: 'html', tab: 'sessions', html: draw('a') });
  deliver({ type: 'reveal', sessionId: 'a', flash: false });
  expect(scroll).toBe(0);
  // Scrolled down to the end of the list: h's listed card shows, so nothing moves.
  scroll = 420;
  deliver({ type: 'html', tab: 'sessions', html: draw('h') });
  deliver({ type: 'reveal', sessionId: 'h', flash: false });
  expect(scroll).toBe(420);
  // Only 4 px of c's listed card and none of the pinned card show: c scrolls in, at the nearest edge.
  scroll = 560;
  deliver({ type: 'html', tab: 'sessions', html: draw('c') });
  deliver({ type: 'reveal', sessionId: 'c', flash: false });
  const top = (listed('c').getBoundingClientRect() as DOMRect).top;
  expect(top).toBe(0);
});

test('scrolling yourself right after a click ends the anchor: a redraw never undoes it', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw('a') });
  scroll = 400;
  listed('g').click();
  main.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 120 }) as unknown as Event);
  scroll = 520;
  deliver({ type: 'html', tab: 'sessions', html: draw('g') });
  expect(scroll).toBe(520);
});
