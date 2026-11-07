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

test('⇅ in VS Code\'s row or ⋯ opens the list\'s menu from the panel\'s corner; a click in it never folds a group, and the menu survives a redraw', () => {
  expect(el('.grp .gh [data-menu]')).toBeNull();
  expect(el('.sctl [data-menu]')).not.toBeNull();
  deliver({ type: 'menu' });
  expect(el('.sctl .menu').hidden).toBe(false);
  sent.length = 0;
  click('.sctl .menu .sec');
  expect(sent.filter((m) => m.type === 'fold')).toEqual([]);
  expect(el('.sctl .menu').hidden).toBe(false);
  // A stream tick redraws the list; the open menu stays open.
  deliver({ type: 'html', tab: 'sessions', html: draw({}, [row('a', 1), row('b', 2), row('c', 3)]) });
  expect(el('.sctl .menu').hidden).toBe(false);
  click('.sctl .menu [data-pref="sort"][data-value="name"]');
  expect(sent).toContainEqual({ type: 'prefs', key: 'sort', value: 'name' });
  expect(sent.filter((m) => m.type === 'fold')).toEqual([]);
  // A click outside closes it; a click on a group header still folds.
  click('.grp .gh .gname');
  expect(el('.sctl .menu').hidden).toBe(true);
  expect(sent.at(-1)).toEqual({ type: 'fold', group: 'here' });
});

test('with nothing to list, ⇅ is in the header so Show can be turned back on', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw({ showOpen: false }, [row('a', 1)]) });
  expect(el('main .grp')).toBeNull();
  sent.length = 0;
  deliver({ type: 'menu' });
  click('.sctl .menu [data-pref="showOpen"]');
  expect(sent).toContainEqual({ type: 'prefs', key: 'showOpen', value: 'true' });
});

test('⋯ holds actions only: Copy session id copies it, marks itself ✓ and closes ⋯, with no toast (owner video, 2026-11-07 5:42 AM)', () => {
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  const more = document.querySelector('.card .cmore') as unknown as HTMLDetailsElement;
  more.open = true;
  sent.length = 0;
  expect(el('.card .cmore .cmenu').querySelector('dl')).toBeNull();
  click('.card .cmore [data-copy="a"]');
  expect(sent).toEqual([{ type: 'copy', text: 'a' }]);
  expect(el('.card .cmore [data-copy="a"]').classList.contains('copied')).toBe(true);
  expect(more.open).toBe(false);
  expect(el('.hnote').hidden).toBe(true);
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
  expect(shown()).toEqual([]);
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
  expect(box.value).toBe('');
  expect(shown()).toEqual(['a', 'b', 'c']);
});

test('⌘K is the one search (owner, 2026-11-05 2:21 AM): the session palette on Sessions; on Review the filter field, shown only while it filters; ⇅ on a tab with nothing to sort says so', () => {
  const box = el('.hfind [data-find]') as unknown as HTMLInputElement;
  sent.length = 0;
  deliver({ type: 'find' });
  expect(sent).toContainEqual({ type: 'search' });
  expect(el('.frow').hidden).toBe(true);
  deliver({ type: 'choose', tab: 'prs' });
  sent.length = 0;
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }) as unknown as Event);
  expect(sent).not.toContainEqual({ type: 'search' });
  expect(el('.frow').hidden).toBe(false);
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
  expect(el('.frow').hidden).toBe(true);
  // Issues sends nothing to sort: ⇅ answers in the note at the panel's foot.
  deliver({ type: 'tab', tab: 'tickets' });
  deliver({ type: 'html', tab: 'tickets', html: '<div class="empty">No open tickets in this project.</div>' });
  deliver({ type: 'menu' });
  expect(el('.hnote').hidden).toBe(false);
  expect(el('.hnote').textContent).toBe('Nothing to sort on this tab.');
  deliver({ type: 'tab', tab: 'sessions' });
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  expect(el('.sctl [data-menu]')).not.toBeNull();
});

test("filtering hides cards, never a matching card's ⋯; each tab's words come back with it and decide whether the field shows", () => {
  deliver({ type: 'tab', tab: 'sessions' });
  deliver({ type: 'html', tab: 'sessions', html: draw() });
  const box = el('.hfind [data-find]') as unknown as HTMLInputElement;
  box.value = 'a';
  box.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
  const drawer = el('.card[data-session="a"] details.cmore');
  expect(drawer.style.display).toBe('');
  // Review has no words: no field; back on Sessions the words and the field return.
  deliver({ type: 'choose', tab: 'prs' });
  expect(box.value).toBe('');
  expect(el('.frow').hidden).toBe(true);
  deliver({ type: 'choose', tab: 'sessions' });
  expect(box.value).toBe('a');
  expect(el('.frow').hidden).toBe(false);
  box.value = '';
  box.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
});
