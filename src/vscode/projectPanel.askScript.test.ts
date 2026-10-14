// The Project panel's real webview script, run in happy-dom against the real card
// markup (testdata/session-rows.asks.json): an answer waits 5 s with Undo before
// its one `answer` message, a key 1-9 answers the selected card, a redraw keeps
// the countdown, and the CLI's error lands on the card.
import { afterAll, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { DEFAULT_SESSION_PREFS, renderSessions } = await import('../core/projectPanel');

const ROWS = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'core', 'testdata', 'session-rows.asks.json'), 'utf8'));
const NOW = Date.parse('2026-10-14T01:37:00Z');
const HERE = { device: 'zion', localHost: 'this-mac', workspace: 'agents', editor: 'vscodium' as const, editorName: 'VSCodium', icons: {} };
const draw = (selectedId: string | null) => renderSessions(ROWS, NOW, { selectedId, here: HERE, prefs: DEFAULT_SESSION_PREFS });
const KEY = 'yosemite-m5/9b1f0c2e-publish/b-7f3a';

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:');
document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
const sent: { type: string; key?: string; choice?: string; text?: string }[] = [];
const script = page.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: { type: string }) => sent.push(m) }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* the thumbnails are not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 800, 600,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const ask = () => document.querySelector(`.ask[data-ask="${KEY}"]`)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

deliver({ type: 'tab', tab: 'sessions' });
deliver({ type: 'html', tab: 'sessions', html: draw(null) });

test('a click holds the answer 5 s with Undo; Undo sends nothing', async () => {
  (ask().querySelector('[data-choice="yes-publish-from-zion"]') as unknown as HTMLElement).click();
  expect(ask().querySelector('.asend')!.textContent).toBe('Sending “Yes, publish from zion” in 5s · Undo');
  expect((ask().querySelector('.opts') as unknown as HTMLElement).hidden).toBe(true);
  (ask().querySelector('[data-ask-undo]') as unknown as HTMLElement).click();
  expect((ask().querySelector('.asend') as unknown as HTMLElement).hidden).toBe(true);
  expect((ask().querySelector('.opts') as unknown as HTMLElement).hidden).toBe(false);
  await sleep(1100);
  expect(sent.filter((m) => m.type === 'answer')).toEqual([]);
});

test('key 2 answers the selected card; a redraw keeps the countdown; after 5 s one answer message goes; the CLI error shows on the card', async () => {
  deliver({ type: 'html', tab: 'sessions', html: draw('9b1f0c2e-publish') });
  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '2', bubbles: true }));
  expect(ask().querySelector('.asend')!.textContent).toBe('Sending “Copy the token to m5” in 5s · Undo');
  await sleep(1100);
  deliver({ type: 'html', tab: 'sessions', html: draw('9b1f0c2e-publish') });
  expect(ask().querySelector('.asend')!.textContent).toBe('Sending “Copy the token to m5” in 4s · Undo');
  await sleep(4100);
  expect(sent.filter((m) => m.type === 'answer')).toEqual([{ type: 'answer', key: KEY, choice: 'copy-the-token-to-m5', text: undefined }]);
  expect(ask().querySelector('.asend')!.textContent).toBe('Sending “Copy the token to m5”…');
  deliver({ type: 'answered', key: KEY, error: 'Not delivered: the terminal is gone' });
  expect(ask().querySelector('.asend')!.className).toBe('asend err');
  expect(ask().querySelector('.asend')!.textContent).toBe('Not sent: Not delivered: the terminal is gone');
  // The answers come back so it can be tried again.
  expect((ask().querySelector('.opts') as unknown as HTMLElement).hidden).toBe(false);
}, 15_000);

test('Other… opens a reply box; Enter holds the typed words like any answer', () => {
  const card = document.querySelector('.ask[data-ask="yosemite-m6/e4d2a913-cards/b-5a01"]')!;
  (card.querySelector('[data-ask-other]') as unknown as HTMLElement).click();
  const input = card.querySelector('[data-ask-input]') as unknown as HTMLInputElement;
  expect((card.querySelector('.aother') as unknown as HTMLElement).hidden).toBe(false);
  input.value = 'Longest wait, but blocked agents first';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event);
  expect(card.querySelector('.asend')!.textContent).toBe('Sending “Longest wait, but blocked agents first” in 5s · Undo');
  (card.querySelector('[data-ask-undo]') as unknown as HTMLElement).click();
});

test('an answer whose card leaves the list before its 5 s is not sent', async () => {
  const before = sent.filter((m) => m.type === 'answer').length;
  deliver({ type: 'html', tab: 'sessions', html: draw(null) });
  (ask().querySelector('[data-choice="wait-until-morning"]') as unknown as HTMLElement).click();
  const without = renderSessions(ROWS.filter((r: { sessionId: string }) => r.sessionId !== '9b1f0c2e-publish'), NOW, { selectedId: null, here: HERE, prefs: DEFAULT_SESSION_PREFS });
  deliver({ type: 'html', tab: 'sessions', html: without });
  await sleep(5300);
  expect(sent.filter((m) => m.type === 'answer').length).toBe(before);
  expect(document.querySelector('.toast')!.textContent).toContain('Answer not sent: its card left the list before it went.');
}, 15_000);
