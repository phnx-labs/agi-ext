// The Sessions ⇅ menu on the list's first group header, and the ⋯ menu's quiet copy
// (owner video, 2026-10-22 6:42 AM), run through the Project panel's real page script
// in happy-dom: a click in the menu never folds its group, the menu stays open across
// a stream redraw, Show can always be turned back on, and a copied value leaves ⋯ open.
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { DEFAULT_SESSION_PREFS, renderSessions } = await import('../core/projectPanel');
type Row = import('../core/projectPanel').SessionLike;
type Prefs = import('../core/projectPanel').SessionListPrefs;

const NOW = Date.parse('2026-10-22T06:42:00Z');
const HERE = { device: 'zion', localHost: 'this-mac', workspace: 'agi-ext', editor: 'vscodium' as const, editorName: 'VSCodium', icons: {} };
const row = (id: string, n: number): Row => ({
  sessionId: id, host: 'zion', title: `Task ${id}`, label: '', topic: '', phase: 'running', liveStatus: 'running', lastResponse: `On ${id}.`,
  activity: '', ticket: null, lastActivityMs: NOW - n * 60_000, confirmedProject: 'agi', tabHere: true, tabIndex: n, model: 'claude-opus-5-5',
});
const draw = (prefs: Partial<Prefs> = {}, rows = [row('a', 1), row('b', 2)]) => renderSessions(rows, NOW, { selectedId: null, frontId: null, here: HERE, prefs: { ...DEFAULT_SESSION_PREFS, ...prefs } });

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:');
document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
const sent: { type: string; [k: string]: unknown }[] = [];
const script = page.match(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/i)![1];
new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: { type: string }) => sent.push(m), getState: () => ({}), setState: () => undefined }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* thumbnails are not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 800, 600,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const el = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
const click = (sel: string) => el(sel).dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event);

deliver({ type: 'tab', tab: 'sessions' });
deliver({ type: 'html', tab: 'sessions', html: draw() });

test('⇅ sits in the tab row on every tab (owner video, 2026-10-27 1:19 PM); a click in its menu never folds a group, and the menu survives a redraw', () => {
  expect(el('.grp .gh [data-menu]')).toBeNull();
  expect(el('.tabs .sctl [data-menu]')).not.toBeNull();
  click('.tabs .sctl [data-menu]');
  expect(el('.tabs .sctl .menu').hidden).toBe(false);
  sent.length = 0;
  click('.tabs .sctl .menu .sec');
  expect(sent.filter((m) => m.type === 'fold')).toEqual([]);
  expect(el('.tabs .sctl .menu').hidden).toBe(false);
  // A stream tick redraws the list; the open menu stays open.
  deliver({ type: 'html', tab: 'sessions', html: draw({}, [row('a', 1), row('b', 2), row('c', 3)]) });
  expect(el('.tabs .sctl .menu').hidden).toBe(false);
  click('.tabs .sctl .menu [data-pref="sort"][data-value="name"]');
  expect(sent).toContainEqual({ type: 'prefs', key: 'sort', value: 'name' });
  expect(sent.filter((m) => m.type === 'fold')).toEqual([]);
  // A click outside closes it; a click on a group header still folds.
  click('.grp .gh .gname');
  expect(el('.tabs .sctl .menu').hidden).toBe(true);
  expect(sent.at(-1)).toEqual({ type: 'fold', group: 'here' });
});

test('with nothing to list, ⇅ is in the header so Show can be turned back on', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw({ showOpen: false }, [row('a', 1)]) });
  expect(el('main .grp')).toBeNull();
  sent.length = 0;
  click('.tabs .sctl [data-menu]');
  click('.tabs .sctl .menu [data-pref="showOpen"]');
  expect(sent).toContainEqual({ type: 'prefs', key: 'showOpen', value: 'true' });
});

test('a value in ⋯ copies quietly: the host gets it, "copied" shows on it, and ⋯ stays open', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  const more = document.querySelector('.card .cmore') as unknown as HTMLDetailsElement;
  more.open = true;
  sent.length = 0;
  click('.card .cmore .cpv[data-copy="claude-opus-5-5"]');
  expect(sent).toEqual([{ type: 'copy', text: 'claude-opus-5-5' }]);
  expect(el('.card .cmore .cpv[data-copy="claude-opus-5-5"]').classList.contains('copied')).toBe(true);
  expect(more.open).toBe(true);
  expect(el('.toast').hidden).toBe(true);
});

test('the filter bar keeps only the listed cards that match every word typed, survives a redraw, and Esc clears it (owner video, 2026-10-22 8:50 AM)', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw({}, [row('a', 1), row('b', 2)]) });
  const box = el('[data-find]') as unknown as HTMLInputElement;
  const shown = () => [...document.querySelectorAll('main .grp .items .card')].filter((c) => (c as unknown as HTMLElement).style.display !== 'none').map((c) => (c as unknown as HTMLElement).dataset.session);
  box.value = 'task b';
  box.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
  expect(shown()).toEqual(['b']);
  // A stream tick redraws the list; what was typed still filters it.
  deliver({ type: 'html', tab: 'sessions', html: draw({}, [row('a', 1), row('b', 2), row('c', 3)]) });
  expect((el('[data-find]') as unknown as HTMLInputElement).value).toBe('task b');
  expect(shown()).toEqual(['b']);
  box.value = 'nothing like this';
  box.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
  expect(el('.nofind').hidden).toBe(false);
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
  expect(box.value).toBe('');
  expect(shown()).toEqual(['a', 'b', 'c']);
});

test('the tab row is the same on every tab (owner video, 2026-10-27 1:19 PM): 🔍 opens the filter in the row, Esc gives the tabs back, and a tab with nothing to sort keeps a dimmed ⇅ in place', () => {
  const box = el('.tabs .hfind [data-find]') as unknown as HTMLInputElement;
  box.focus();
  expect(el('.tabs').classList.contains('finding')).toBe(true);
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
  expect(el('.tabs').classList.contains('finding')).toBe(false);
  // Issues and Lead send no controls of their own: the row still ends in ⇅, dimmed.
  deliver({ type: 'tab', tab: 'tickets' });
  deliver({ type: 'html', tab: 'tickets', html: '<div class="empty">No open tickets in this project.</div>' });
  expect(el('.tabs .sctl [disabled]')).not.toBeNull();
  expect(el('.tabs .hfind [data-find]')).toBe(box as unknown as HTMLElement);
  expect(box.placeholder).toBe('Filter');
  deliver({ type: 'tab', tab: 'sessions' });
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  expect(el('.tabs .sctl [data-menu]')).not.toBeNull();
  expect(box.placeholder).toBe('Filter · ⌘K all');
});

test("filtering hides cards, never a matching card's ⋯; each tab's words come back with it and decide whether the row shows the field", () => {
  deliver({ type: 'tab', tab: 'sessions' });
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  const box = el('.tabs .hfind [data-find]') as unknown as HTMLInputElement;
  box.value = 'a';
  box.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
  const drawer = el('.card[data-session="a"] details.cmore');
  expect(drawer.style.display).toBe('');
  // Review has no words: its row shows the tabs; back on Sessions the words and the field return.
  click('.tab[data-tab="prs"]');
  expect(box.value).toBe('');
  expect(el('.tabs').classList.contains('finding')).toBe(false);
  click('.tab[data-tab="sessions"]');
  expect(box.value).toBe('a');
  expect(el('.tabs').classList.contains('finding')).toBe(true);
  box.value = '';
  box.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
});
