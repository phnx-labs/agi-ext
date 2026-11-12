// The Project panel's real webview script, in happy-dom: a two-finger sideways swipe over the
// pinned card moves to another session (owner video, 2026-11-07 5:56 AM, 3:37; owner,
// 2026-11-12). Forward posts swipe 1 (Next Agent That Needs You), back swipe -1; a mostly
// vertical scroll, a swipe outside the pinned card and one a sideways-scrolling row inside can
// still take are left alone, and one swipe is one message.
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { DEFAULT_SESSION_PREFS, renderSessions } = await import('../core/projectPanel');
type Row = import('../core/projectPanel').SessionLike;

const NOW = Date.parse('2026-11-12T06:00:00Z');
const HERE = { device: 'zion', localHost: 'this-mac', workspace: 'agi-ext', editor: 'vscodium' as const, editorName: 'VSCodium', icons: {} };
const row = (id: string, i: number): Row => ({
  sessionId: id, host: 'this-mac', title: `Task ${id}`, label: '', topic: '', phase: 'idle', liveStatus: 'idle', lastResponse: `Done with ${id}.`, agentType: 'claude',
  activity: '', ticket: null, lastActivityMs: NOW - i * 60_000, confirmedProject: 'agi', tabHere: true, tabIndex: i + 1,
});
const rows: Row[] = [row('a', 0), row('b', 1), row('c', 2)];
const draw = (front: string) => renderSessions(rows, NOW, { selectedId: front, frontId: front, here: HERE, prefs: DEFAULT_SESSION_PREFS });

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:');
document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
const sent: { type: string; dir?: number }[] = [];
const script = page.match(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/i)![1];
const main = document.querySelector('main') as unknown as HTMLElement;
const rang: Element[] = [];
(window.HTMLElement.prototype as unknown as { animate(): unknown }).animate = function (this: Element) { rang.push(this); return {}; };
new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: { type: string }) => sent.push(m), getState: () => ({}), setState: () => undefined }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* the thumbnails are not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 800, 600,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const $ = (sel: string) => main.querySelector(sel) as unknown as HTMLElement;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const swipes = () => sent.filter((m) => m.type === 'swipe');
/** One wheel event on `el`; true when the script held it (preventDefault). */
const wheel = (el: Element, deltaX: number, deltaY = 0) => {
  const e = new window.WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
};
/** Give `el` a sideways overflow, as a scrolling chip row has in the editor. */
const overflow = (el: HTMLElement, style: string, scrollLeft: number) => {
  el.setAttribute('style', style);
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 600 });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 300 });
  el.scrollLeft = scrollLeft;
  Object.defineProperty(el, 'scrollLeft', { configurable: true, writable: true, value: scrollLeft });
};

deliver({ type: 'tab', tab: 'sessions' });
deliver({ type: 'html', tab: 'sessions', html: draw('a') });

test('a sideways swipe on the pinned card posts one swipe past 60 px, held so the editor does not go back a page; then it locks', async () => {
  const pin = $('.front-pin .card');
  sent.length = 0;
  expect(wheel(pin, 30)).toBe(true);
  expect(wheel(pin, 30)).toBe(true);
  expect(swipes()).toEqual([]);
  wheel(pin, 5);
  expect(swipes()).toEqual([{ type: 'swipe', dir: 1 }]);
  // The rest of the same gesture (the trackpad's momentum) does nothing more, even as it
  // decays past the 450 ms lock.
  for (let i = 0; i < 6; i++) expect(wheel(pin, 40)).toBe(true);
  for (let i = 0; i < 9; i++) { await settle(100); expect(wheel(pin, 30)).toBe(true); }
  expect(swipes()).toHaveLength(1);
  await settle(500);
  for (let i = 0; i < 3; i++) wheel(pin, -25);
  expect(swipes()).toEqual([{ type: 'swipe', dir: 1 }, { type: 'swipe', dir: -1 }]);
  await settle(500);
});

test('the new front card slides in from the side the swipe went to, once', async () => {
  sent.length = 0; rang.length = 0;
  for (let i = 0; i < 3; i++) wheel($('.front-pin .card'), 25);
  expect(swipes()).toEqual([{ type: 'swipe', dir: 1 }]);
  // A stream tick before the tab changed draws the same card: nothing moves.
  deliver({ type: 'html', tab: 'sessions', html: draw('a') });
  expect(rang).toEqual([]);
  deliver({ type: 'html', tab: 'sessions', html: draw('b') });
  expect(rang).toEqual([$('.front-pin .card')]);
  deliver({ type: 'html', tab: 'sessions', html: draw('c') });
  expect(rang).toHaveLength(1);
  await settle(500);
});

test('a mostly vertical scroll and a swipe over a listed card are left alone', () => {
  sent.length = 0;
  const pin = $('.front-pin .card');
  for (let i = 0; i < 5; i++) expect(wheel(pin, 40, 41)).toBe(false);
  const listed = main.querySelector('.grp .card:not(.front)') as unknown as HTMLElement;
  expect(listed).toBeTruthy();
  for (let i = 0; i < 5; i++) expect(wheel(listed, 40)).toBe(false);
  expect(swipes()).toEqual([]);
});

test('a row inside the pinned card that can still scroll that way takes the swipe; at its end, or clipped, the card does', async () => {
  const pin = $('.front-pin .card');
  const shelf = document.createElement('div') as unknown as HTMLElement;
  const chip = document.createElement('span') as unknown as HTMLElement;
  shelf.appendChild(chip);
  pin.appendChild(shelf);
  sent.length = 0;
  overflow(shelf, 'overflow-x: auto', 0);
  for (let i = 0; i < 5; i++) expect(wheel(chip, 40)).toBe(false);
  expect(swipes()).toEqual([]);
  // Scrolled to its right end: forward is the card's, back is still the row's.
  overflow(shelf, 'overflow-x: auto', 300);
  for (let i = 0; i < 5; i++) expect(wheel(chip, -40)).toBe(false);
  expect(swipes()).toEqual([]);
  for (let i = 0; i < 2; i++) expect(wheel(chip, 40)).toBe(true);
  expect(swipes()).toEqual([{ type: 'swipe', dir: 1 }]);
  await settle(500);
  // A clipped title overflows too but cannot scroll: the swipe is the card's.
  overflow(shelf, 'overflow: hidden', 0);
  for (let i = 0; i < 2; i++) expect(wheel(chip, 40)).toBe(true);
  expect(swipes()).toHaveLength(2);
  shelf.remove();
  await settle(500);
});
