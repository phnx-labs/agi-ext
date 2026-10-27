// The Project panel's real webview script, run in happy-dom against the real Issues
// markup: a row unfolds its peek and a second click folds it, ↗ opens its Linear page,
// a redraw keeps the peek, and the agent's logo sends one start.
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { parseTickets, renderTickets } = await import('../core/projectPanel');
const { renderTicketPeek } = await import('../core/ticketPeek');

const issue = (id: string, description: string) => ({ identifier: id, title: `t ${id}`, url: `https://linear.app/x/issue/${id}`, description, priority: 2, state: { type: 'started', name: 'Doing' } });
const groups = parseTickets(JSON.stringify({ issues: [issue('A-1', '## Outcome\nSign-up works.'), issue('A-2', '')] }));
const draw = () => renderTickets(groups, (t) => ({ agentName: 'Claude', peek: renderTicketPeek(t.identifier, t.description), avatar: null, agentKey: 'claude', onIt: [] }));

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

test('a row unfolds its peek and opens nothing; a second click folds it; ↗ opens its page', () => {
  sent.length = 0;
  el('.trow[data-ticket="A-1"]').click();
  expect(sent).toEqual([]);
  expect(peek('A-1').hidden).toBe(false);
  expect(peek('A-1').textContent).toContain('Sign-up works.');
  expect(peek('A-2').hidden).toBe(true);
  el('.trow[data-ticket="A-2"]').click();
  expect(peek('A-1').hidden).toBe(true);
  expect(peek('A-2').hidden).toBe(false);
  el('.trow[data-ticket="A-2"]').click();
  expect(peek('A-2').hidden).toBe(true);
  expect(sent).toEqual([]);
  el('.tli .pro[data-url="https://linear.app/x/issue/A-2"]').click();
  expect(sent.filter((m) => m.type === 'open').map((m) => m.url)).toEqual(['https://linear.app/x/issue/A-2']);
});

test('a redraw keeps the open peek; a tile asks for its row by message', () => {
  el('.trow[data-ticket="A-1"]').click();
  deliver({ type: 'html', tab: 'tickets', html: draw() });
  expect(peek('A-1').hidden).toBe(false);
  deliver({ type: 'peek', id: 'A-2' });
  expect(peek('A-2').hidden).toBe(false);
  expect(peek('A-1').hidden).toBe(true);
});

test('the agent logo and an agent in ▾ each send one start; a second click, even after a redraw, sends none', () => {
  sent.length = 0;
  el('.tli .tag[data-start-ticket="A-1"]').click();
  deliver({ type: 'html', tab: 'tickets', html: draw() });
  el('.tli .tag[data-start-ticket="A-1"]').click();
  el('.tli:nth-child(2) .menu [data-agent="codex"]').click();
  expect(sent).toEqual([{ type: 'startTicket', id: 'A-1' }, { type: 'startTicket', id: 'A-2', agent: 'codex', where: 'auto' }]);
});

test('Settings > Tabs hides Review and Issues; Sessions stays as the way back from the Lead tab and Settings', () => {
  const hidden = () => [...document.querySelectorAll('.tabs .tab')].map((t) => `${(t as unknown as HTMLElement).dataset.tab}:${(t as unknown as HTMLElement).hidden}`).join(' ');
  sent.length = 0;
  deliver({ type: 'tabs', prs: false, tickets: false });
  // Issues was showing and is gone: the panel goes back to Sessions.
  expect(sent).toContainEqual({ type: 'tab', tab: 'sessions' });
  expect(hidden()).toBe('lead:false sessions:false prs:true tickets:true');
  deliver({ type: 'choose', tab: 'settings' });
  expect(hidden()).toBe('lead:false sessions:false prs:true tickets:true');
  deliver({ type: 'tabs', prs: true, tickets: false });
  expect(hidden()).toBe('lead:false sessions:false prs:false tickets:true');
  // ⌃3 to Issues, which is off, lands on Sessions.
  sent.length = 0;
  deliver({ type: 'choose', tab: 'tickets' });
  expect(sent).toContainEqual({ type: 'tab', tab: 'sessions' });
});

test('a ticket tag colors its session dot for every state tone but the quiet one', async () => {
  const { STATE_TONE } = await import('../shared/sessionState');
  for (const tone of new Set(Object.values(STATE_TONE))) {
    if (tone === 'quiet') continue;
    expect(page).toMatch(new RegExp(`\\.tag \\.d-${tone} \\{ background: var\\(--r-`));
  }
});
