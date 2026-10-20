// ⌘K drawn by the Project panel's own page, in happy-dom with the real script: the host's
// rows open the overlay, typing filters them in place (an exact id leads), ↑↓ and Enter
// pick one, a thumbnail opens a quick look, and Esc closes it all.
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { renderPalette } = await import('../core/projectPanel');
type Row = import('../core/projectPanel').SessionLike;

const NOW = Date.parse('2026-10-19T02:00:00Z');
const row = (id: string, o: Partial<Row> = {}): Row => ({
  sessionId: id, host: 'zion', title: `Task ${id}`, label: '', topic: '', phase: 'idle', liveStatus: 'idle', lastResponse: '', agentType: 'claude',
  activity: '', ticket: null, lastActivityMs: NOW - 60_000, confirmedProject: 'agi', ...o,
});
const HTML = renderPalette([
  { row: row('aaaaaaaa-1', { title: 'Body alignment', tabHere: true, tabIndex: 2 }), made: null, images: [{ uri: 'vscode-resource:/a.png', path: '/h/.agents/.history/attachments/a.png', label: 'a.png' }] },
  { row: row('bbbbbbbb-2', { title: 'MCP server plan', phase: 'running', liveStatus: 'running' }), made: null, images: [] },
  { row: row('cccccccc-3', { title: 'Old ended', phase: 'done', liveStatus: 'closed', recap: { text: 'Shipped it.', at: '' }, lastResponse: 'The Apps tab says none, so trying Intuit\'s older app dashboard.' }), made: null, images: [] },
], NOW, new Set(), { device: 'zion', localHost: 'this-mac', workspace: 'agi-ext', editor: 'vscodium', editorName: 'VSCodium', icons: {} });

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:');
document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
const sent: { type: string; sessionId?: string; here?: boolean }[] = [];
const script = page.match(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/i)![1];
new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: { type: string }) => sent.push(m), getState: () => ({}), setState: () => undefined }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* the thumbnails are not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 800, 600,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
const input = () => $('#kq') as HTMLInputElement;
const key = (k: string) => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }) as unknown as Event);
const shown = () => [...document.querySelectorAll('.krow:not([hidden])')].sort((a, b) => Number((a as HTMLElement).style.order) - Number((b as HTMLElement).style.order)).map((r) => (r as HTMLElement).dataset.title);
const picked = () => ($('.krow[aria-selected="true"]') as HTMLElement | null)?.dataset.title;
const type = (q: string) => { input().value = q; input().dispatchEvent(new window.Event('input') as unknown as Event); };

deliver({ type: 'tab', tab: 'sessions' });

test('the host\'s rows open the overlay with the first selected and the box focused', () => {
  expect($('.kscrim').hidden).toBe(true);
  deliver({ type: 'palette', html: HTML, waiting: false });
  expect($('.kscrim').hidden).toBe(false);
  // What runs comes before an idle turn; an ended session is last.
  expect(shown()).toEqual(['MCP server plan', 'Body alignment', 'Old ended']);
  expect(picked()).toBe('MCP server plan');
  expect(document.activeElement).toBe(input() as unknown as Element);
});

test('typing filters in place; an exact id leads; nothing matching says so', () => {
  type('mcp');
  expect(shown()).toEqual(['MCP server plan']);
  expect(picked()).toBe('MCP server plan');
  type('cccccccc');
  expect(shown()).toEqual(['Old ended']);
  type('zzz');
  expect(shown()).toEqual([]);
  expect($('.kempty').textContent).toBe('Nothing matches “zzz”');
  type('');
  expect(shown()).toHaveLength(3);
});

test('a stream update keeps what you typed and selected', () => {
  type('a');
  key('ArrowDown');
  const before = picked();
  deliver({ type: 'palette', html: HTML, waiting: false });
  expect(input().value).toBe('a');
  expect(picked()).toBe(before);
});

test('↑↓ then Enter goes to that session and closes; Esc closes without going', () => {
  type('');
  key('ArrowDown'); key('ArrowDown'); key('ArrowUp');
  expect(picked()).toBe('Body alignment');
  sent.length = 0;
  key('Enter');
  expect(sent).toEqual([{ type: 'paletteClosed' }, { type: 'paletteGo', sessionId: 'aaaaaaaa-1', host: 'zion', here: true }]);
  expect($('.kscrim').hidden).toBe(true);
  deliver({ type: 'palette', html: HTML, waiting: false });
  sent.length = 0;
  key('Escape');
  expect(sent).toEqual([{ type: 'paletteClosed' }]);
  expect($('.kscrim').hidden).toBe(true);
});

test('a session with a tab here says so; a thumbnail opens a quick look that space closes', () => {
  deliver({ type: 'palette', html: HTML, waiting: false });
  const th = $('.krow[data-title="Body alignment"] .kth');
  th.click();
  expect($('.kql').hidden).toBe(false);
  expect(($('.kql img') as HTMLImageElement).getAttribute('src')).toBe('vscode-resource:/a.png');
  expect($('.kscrim').hidden).toBe(false);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }) as unknown as Event);
  expect($('.kql').hidden).toBe(true);
  sent.length = 0;
  $('.krow[data-title="Body alignment"] .kt').click();
  expect(sent.at(-1)).toEqual({ type: 'paletteGo', sessionId: 'aaaaaaaa-1', host: 'zion', here: true });
});

test('before the stream has spoken it says so instead of an empty list', () => {
  deliver({ type: 'palette', html: '', waiting: true });
  expect($('.klist').textContent).toBe('Waiting for the session stream…');
  key('Escape');
});

test('⌘K or Ctrl+K inside the panel asks the host to open it, and goes no further', () => {
  sent.length = 0;
  const e = new window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
  let reached = false;
  window.addEventListener('keydown', () => { reached = true; });
  document.body.dispatchEvent(e as unknown as Event);
  expect(sent).toEqual([{ type: 'search' }]);
  expect(e.defaultPrevented).toBe(true);
  expect(reached).toBe(false);
});

test('a title that starts with the words outranks one that only holds them elsewhere', () => {
  deliver({ type: 'palette', html: HTML, waiting: false });
  type('task');
  // "Old ended" etc. carry "Task" nowhere in the title; a title prefix leads whatever the host order.
  type('body');
  expect(shown()[0]).toBe('Body alignment');
  type('plan');
  expect(shown()).toEqual(['MCP server plan']);
  key('Escape');
});

// Owner screenshot, 2026-10-19 11:32 PM: a word the agent said finds its session, and the
// row shows those words with the match marked in place of its recap line until they change.
test('a word only said in the session finds it and shows where; clearing gives the row its line back', () => {
  deliver({ type: 'palette', html: HTML, waiting: false });
  type('intuit');
  expect(shown()).toEqual(['Old ended']);
  const note = $('.krow[data-title="Old ended"] .knote');
  expect(note.textContent).toBe('The Apps tab says none, so trying Intuit\'s older app dashboard.');
  expect(note.querySelector('mark')!.textContent).toBe('Intuit');
  type('mcp');
  type('');
  expect($('.krow[data-title="Old ended"] .knote').textContent).toBe('Shipped it.');
  expect($('.krow[data-title="Old ended"] mark')).toBeNull();
  key('Escape');
});
