// The Project panel's real webview script, run in happy-dom against the real Issues
// markup: a row opens its Linear page once and unfolds its peek, a second click folds
// it without opening the page again, a redraw keeps the peek, and ▶ sends one start.
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { parseTickets, renderTickets } = await import('../core/projectPanel');
const { renderTicketPeek } = await import('../core/ticketPeek');

const issue = (id: string, description: string) => ({ identifier: id, title: `t ${id}`, url: `https://linear.app/x/issue/${id}`, description, priority: 2, state: { type: 'started', name: 'Doing' } });
const groups = parseTickets(JSON.stringify({ issues: [issue('A-1', '## Outcome\nSign-up works.'), issue('A-2', '')] }));
const draw = () => renderTickets(groups, (t) => ({ agentName: 'Claude', peek: renderTicketPeek(t.identifier, t.description, { agentName: 'Claude', delegated: false }) }));

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:');
document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
const sent: { type: string; url?: string; id?: string; external?: boolean }[] = [];
const open = page.indexOf('<script');
const script = page.slice(page.indexOf('>', open) + 1, page.lastIndexOf('</script'));
new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: { type: string }) => sent.push(m) }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* the thumbnails are not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 800, 600,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const el = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
const peek = (id: string) => el(`.tpeek[data-peek="${id}"]`);

deliver({ type: 'tab', tab: 'tickets' });
deliver({ type: 'html', tab: 'tickets', html: draw() });

test('a row opens its page and unfolds its peek; a second click folds it without opening again', () => {
  sent.length = 0;
  el('.trow[data-ticket="A-1"]').click();
  expect(sent).toEqual([{ type: 'open', url: 'https://linear.app/x/issue/A-1', external: false }]);
  expect(peek('A-1').hidden).toBe(false);
  expect(peek('A-1').textContent).toContain('Sign-up works.');
  expect(peek('A-2').hidden).toBe(true);
  el('.trow[data-ticket="A-2"]').click();
  expect(peek('A-1').hidden).toBe(true);
  expect(peek('A-2').hidden).toBe(false);
  el('.trow[data-ticket="A-2"]').click();
  expect(peek('A-2').hidden).toBe(true);
  expect(sent.filter((m) => m.type === 'open').map((m) => m.url)).toEqual(['https://linear.app/x/issue/A-1', 'https://linear.app/x/issue/A-2']);
});

test('a redraw keeps the open peek; a tile asks for its row by message', () => {
  el('.trow[data-ticket="A-1"]').click();
  deliver({ type: 'html', tab: 'tickets', html: draw() });
  expect(peek('A-1').hidden).toBe(false);
  deliver({ type: 'peek', id: 'A-2' });
  expect(peek('A-2').hidden).toBe(false);
  expect(peek('A-1').hidden).toBe(true);
});

test('▶ on the row and Start in the peek each send one start; a second click, even after a redraw, sends none', () => {
  sent.length = 0;
  el('.tli .tgo[data-start-ticket="A-1"]').click();
  deliver({ type: 'html', tab: 'tickets', html: draw() });
  el('.tli .tgo[data-start-ticket="A-1"]').click();
  el('.tpeek[data-peek="A-2"] [data-start-ticket="A-2"]').click();
  expect(sent).toEqual([{ type: 'startTicket', id: 'A-1' }, { type: 'startTicket', id: 'A-2' }]);
});

test('Settings > Tabs hides Review and Issues; Sessions hides only while it shows, so Settings keeps a way back', () => {
  const hidden = () => [...document.querySelectorAll('.tabs .tab')].map((t) => `${(t as unknown as HTMLElement).dataset.tab}:${(t as unknown as HTMLElement).hidden}`).join(' ');
  sent.length = 0;
  deliver({ type: 'tabs', prs: false, tickets: false });
  // Issues was showing and is gone: the panel goes back to Sessions, and Sessions needs no tab.
  expect(sent).toContainEqual({ type: 'tab', tab: 'sessions' });
  expect(hidden()).toBe('sessions:true prs:true tickets:true');
  deliver({ type: 'choose', tab: 'settings' });
  expect(hidden()).toBe('sessions:false prs:true tickets:true');
  deliver({ type: 'tabs', prs: true, tickets: false });
  expect(hidden()).toBe('sessions:false prs:false tickets:true');
  // ⌃3 to Issues, which is off, lands on Sessions.
  sent.length = 0;
  deliver({ type: 'choose', tab: 'tickets' });
  expect(sent).toContainEqual({ type: 'tab', tab: 'sessions' });
});
