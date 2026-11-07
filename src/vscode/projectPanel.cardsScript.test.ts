// The Project panel's real webview script and real patch, in happy-dom, for the cards
// after the owner's 2026-10-19 videos: ☆/★ turns every copy of a card at once, the
// pinned title is an inline rename that a stream update never takes away, and a click
// that opens something rings and stays busy until the host has acted, with no toast.
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { DEFAULT_SESSION_PREFS, renderSessions } = await import('../core/projectPanel');
const { cardSettings } = await import('../core/settings');
type Row = import('../core/projectPanel').SessionLike;

const NOW = Date.parse('2026-10-19T02:00:00Z');
const HERE = { device: 'zion', localHost: 'this-mac', workspace: 'agi-ext', editor: 'vscodium' as const, editorName: 'VSCodium', icons: {} };
const row = (id: string, i: number, o: Partial<Row> = {}): Row => ({
  sessionId: id, host: 'this-mac', title: `Task ${id}`, label: '', topic: '', phase: 'idle', liveStatus: 'idle', lastResponse: `Done with ${id}.`, agentType: 'claude',
  activity: '', ticket: null, lastActivityMs: NOW - i * 60_000, confirmedProject: 'agi', tabHere: true, tabIndex: i + 1, ...o,
});
const rows: Row[] = [row('a', 0), row('b', 1), row('c', 2)];
// b made a PR and a page: a chip that opens on GitHub, a folder chip that opens the file.
const madeFor = (s: Row) => s.sessionId === 'b'
  ? { prs: [{ label: '#12', url: 'https://github.com/me/x/pull/12' }], ticket: null, folders: [{ name: 'plan', display: '~/.agents/artifacts/plan', files: [{ name: 'plan.html', path: '/home/me/.agents/artifacts/plan/plan.html' }], images: [] }] }
  : null;
const draw = (favs: string[] = [], extra: Partial<Row> = {}) => renderSessions(rows.map((r) => (r.sessionId === 'a' ? { ...r, ...extra } : r)), NOW, { selectedId: 'a', frontId: 'a', here: HERE, prefs: DEFAULT_SESSION_PREFS, favorites: new Set(favs), madeFor });

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:');
document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
const sent: { type: string; sessionId?: string; name?: string; value?: boolean; url?: string }[] = [];
const script = page.match(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/i)![1];
const main = document.querySelector('main') as unknown as HTMLElement;
// The ring is a Web Animation; happy-dom has none, so record which element rang.
const rang: Element[] = [];
(window.HTMLElement.prototype as unknown as { animate(): unknown }).animate = function (this: Element) { rang.push(this); return {}; };
new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: { type: string }) => sent.push(m), getState: () => ({}), setState: () => undefined }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* the thumbnails are not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 800, 600,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const $ = (sel: string) => main.querySelector(sel) as unknown as HTMLElement;
const $$ = (sel: string) => [...main.querySelectorAll(sel)] as unknown as HTMLElement[];
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

deliver({ type: 'tab', tab: 'sessions' });
deliver({ type: 'html', tab: 'sessions', html: draw() });

test('a click on the agent\'s logo posts one favorite and turns every copy of that card at once, without selecting it (owner video, 2026-11-07 7:19 AM)', () => {
  sent.length = 0;
  ($$('.lg[data-favlogo="b"]')[0]).click();
  expect(sent).toEqual([{ type: 'favorite', sessionId: 'b', value: true }]);
  expect($$('[data-favlogo="b"]').every((b) => b.getAttribute('aria-pressed') === 'true')).toBe(true);
  expect($$('.lg[data-favlogo="b"]').every((b) => b.classList.contains('on'))).toBe(true);
  // The host redraws with the Favorites group; b now shows twice, both starred.
  deliver({ type: 'html', tab: 'sessions', html: draw(['b']) });
  expect($$('[data-group="favorites"] .card').map((c) => c.dataset.session)).toEqual(['b']);
  expect($$('.card[data-session="b"] .star.on')).toHaveLength(2);
  // ⋯ > Remove from Favorites does the same.
  $$('.cmenu [data-favlogo="b"]')[0].click();
  expect(sent.at(-1)).toEqual({ type: 'favorite', sessionId: 'b', value: false });
});

test('the pinned title copies the session; ⋯ > Rename opens a rename box; a stream update keeps what is typed; Enter sends it once', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  sent.length = 0;
  $('.front-pin .ttl').click();
  expect(sent.map((m) => m.type)).toEqual(['copy']);
  expect($('.front-pin .ttl input')).toBeNull();
  sent.length = 0;
  $('.front-pin [data-act="rename"]').click();
  const input = $('.front-pin .ttl input.ttl-edit') as HTMLInputElement;
  expect(input.value).toBe('Task a');
  expect(sent).toEqual([]);
  input.value = 'Body alignment';
  // The agent keeps working while you type: its card redraws, the box stays with your words.
  deliver({ type: 'html', tab: 'sessions', html: draw([], { lastResponse: 'Still going.', lastActivityMs: NOW }) });
  expect($('.front-pin .ttl input.ttl-edit')).toBe(input);
  expect(input.value).toBe('Body alignment');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event);
  expect(sent).toEqual([{ type: 'rename', sessionId: 'a', name: 'Body alignment' }]);
  // Nothing is shown as renamed until the stream reports it.
  expect($('.front-pin .ttl').textContent).toBe('Task a');
  deliver({ type: 'html', tab: 'sessions', html: draw([], { title: 'Body alignment' }) });
  expect($('.front-pin .ttl').textContent).toBe('Body alignment');
  deliver({ type: 'html', tab: 'sessions', html: draw([], { title: 'Renamed again elsewhere' }) });
  expect($('.front-pin .ttl').textContent).toBe('Renamed again elsewhere');
});

test('Esc or leaving the box cancels; a harness without /rename never opens one', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  sent.length = 0;
  $('.front-pin [data-act="rename"]').click();
  const input = $('.front-pin .ttl input.ttl-edit') as HTMLInputElement;
  input.value = 'Not this';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
  expect($('.front-pin .ttl input')).toBeNull();
  expect($('.front-pin .ttl').textContent).toBe('Task a');
  $('.front-pin [data-act="rename"]').click();
  ($('.front-pin .ttl input') as HTMLInputElement).blur();
  expect($('.front-pin .ttl input')).toBeNull();
  expect(sent).toEqual([]);
  // Another harness has no /rename: ⋯ offers none, and its title only copies.
  deliver({ type: 'html', tab: 'sessions', html: draw([], { agentType: 'codex' }) });
  expect($('.front-pin [data-act="rename"]')).toBeNull();
  $('.front-pin .ttl').click();
  expect($('.front-pin .ttl input')).toBeNull();
});

test('a PR chip or a card rings and stays busy until the host\'s answer, with no toast (owner, 2026-11-04 9:42 PM)', async () => {
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  sent.length = 0;
  const card = $$('[data-group="here"] .card[data-session="c"]')[0];
  card.click();
  expect(sent.at(-1)).toMatchObject({ type: 'select', sessionId: 'c' });
  expect(rang.at(-1)).toBe(card);
  expect(card.getAttribute('aria-busy')).toBe('true');
  expect($('.toast')).toBeNull();
  expect((document.querySelector('.hnote') as unknown as HTMLElement).hidden).toBe(true);
  deliver({ type: 'opened' });
  expect(card.getAttribute('aria-busy')).toBeNull();
  const pr = $$('[data-group="here"] .card[data-session="b"] [data-url]')[0];
  sent.length = 0;
  pr.click();
  expect(sent).toEqual([{ type: 'open', url: 'https://github.com/me/x/pull/12', external: false }]);
  expect(rang.at(-1)).toBe(pr);
  const page = $$('[data-group="here"] .card[data-session="b"] [data-artifact]')[0];
  page.click();
  expect(sent.at(-1)).toMatchObject({ type: 'artifact', sessionId: 'b', path: '/home/me/.agents/artifacts/plan/plan.html' });
  expect(rang.at(-1)).toBe(page);
  // With no answer from the host it stays busy: nothing silently waits.
  await settle(750);
  expect(page.getAttribute('aria-busy')).toBe('true');
  // Copy answers on its own icon.
  const copy = $$('[data-group="here"] .card[data-session="b"] .acts [data-copy]')[0];
  copy.click();
  expect(copy.classList.contains('copied')).toBe(true);
  expect((document.querySelector('.hnote') as unknown as HTMLElement).hidden).toBe(true);
});

test('a card click moves the selected rail at once; the host\'s redraw of the same selection keeps it', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  const listed = (id: string) => $$(`[data-group="here"] .card[data-session="${id}"]`)[0];
  expect(listed('a').classList.contains('sel')).toBe(true);
  listed('c').click();
  // Before any host message: only c carries the rail; a lost it in the list and on the pinned card, so 1-9 cannot answer a.
  expect($$('.card.sel').map((c) => c.dataset.session)).toEqual(['c']);
  deliver({ type: 'html', tab: 'sessions', html: renderSessions(rows, NOW, { selectedId: 'c', frontId: 'c', here: HERE, prefs: DEFAULT_SESSION_PREFS, madeFor }) });
  expect($$('.card.sel').filter((c) => !c.closest('.front-pin')).map((c) => c.dataset.session)).toEqual(['c']);
  // When the host still holds the old selection, its unchanged draw puts the rail back, pinned copy included.
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  listed('c').click();
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  expect($$('.card.sel').map((c) => c.dataset.session)).toEqual(['a', 'a']);
});

test('1-9 answers a selected starred session that asks, whose Favorites copy shows only the question', () => {
  const asking = (r: Row) => (r.sessionId === 'c' ? { ...r, phase: 'waiting' as const, liveStatus: 'waiting', attention: { key: 'k-c', kind: 'question', state: 'open', openedAt: new Date(NOW - 30_000).toISOString(), question: { text: 'Ship it?' }, choices: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] } } : r);
  deliver({ type: 'html', tab: 'sessions', html: renderSessions(rows.map(asking), NOW, { selectedId: 'c', frontId: 'a', here: HERE, prefs: DEFAULT_SESSION_PREFS, favorites: new Set(['c']), cards: cardSettings({ asks: 'answers' }) }) });
  expect($$('[data-group="favorites"] .card.sel[data-session="c"]')).toHaveLength(1);
  sent.length = 0;
  (document.activeElement as unknown as HTMLElement | null)?.blur?.();
  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '2', bubbles: true }) as unknown as Event);
  expect(sent).toContainEqual({ type: 'answer', key: 'k-c', choice: 'n', text: undefined });
});
