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

test('⇅ sits on the first group header; a click in its menu never folds the group, and the menu survives a redraw', () => {
  expect(el('.tabs .sctl [data-menu]')).toBeNull();
  expect(el('.grp[data-group="here"] .gh [data-menu]')).not.toBeNull();
  click('.grp .gh [data-menu]');
  expect(el('.grp .gh .menu').hidden).toBe(false);
  sent.length = 0;
  click('.grp .gh .menu .sec');
  expect(sent.filter((m) => m.type === 'fold')).toEqual([]);
  expect(el('.grp .gh .menu').hidden).toBe(false);
  // A stream tick redraws the list; the open menu stays open.
  deliver({ type: 'html', tab: 'sessions', html: draw({}, [row('a', 1), row('b', 2), row('c', 3)]) });
  expect(el('.grp .gh .menu').hidden).toBe(false);
  click('.grp .gh .menu [data-pref="sort"][data-value="name"]');
  expect(sent).toContainEqual({ type: 'prefs', key: 'sort', value: 'name' });
  expect(sent.filter((m) => m.type === 'fold')).toEqual([]);
  // A click outside closes it; a click on the header itself still folds.
  click('.grp .gh .gname');
  expect(el('.grp .gh .menu').hidden).toBe(true);
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
