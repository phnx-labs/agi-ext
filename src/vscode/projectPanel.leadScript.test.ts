// The Project panel's ✳ Lead tab: the real webview script in happy-dom, drawing
// renderLeadTab's markup. Enter asks, the mic talks, each held action's ✓ and
// ✓ Confirm all post one message each, a ref opens through the host, and a redraw
// never wipes what you are typing (the box is data-keep; its mic state is copied in).
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';
import type { LeadTabModel, TabTurn } from '../core/leadView';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { renderLeadTab } = await import('../core/leadView');

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:');
document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
const sent: Record<string, unknown>[] = [];
const script = page.match(/<script[^>]*>([\s\S]*?)<\/script\s*>/i)![1];
new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: Record<string, unknown>) => sent.push(m) }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 800, 600,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const el = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;

const held: TabTurn = {
  key: 't_3', ask: 'Tell the Automations tab to skip drafts, close 4281, start a Codex tab', voiceSecs: 12.6, at: Date.parse('2026-10-19T07:48:00Z'),
  segments: [{ kind: 'text', text: "I've queued all three, and none has run yet." }],
  confirms: [
    { token: 'c_a', action: 'send', label: 'Message “Automations”', detail: 'From now on, skip draft PRs.', state: 'open' },
    { token: 'c_b', action: 'pr', label: 'Close phnx-labs/agents#4281', detail: 'WIP: blog draft', state: 'open' },
    { token: 'c_c', action: 'start', label: 'Start codex', detail: 'Fix the flaky console test', state: 'open' },
  ],
  refs: [{ kind: 'session', id: 'c106a56b-2ccb', title: 'Rush account creation' }], live: false,
};
const model = (over: Partial<LeadTabModel> = {}): LeadTabModel => ({ project: 'agents', turns: [held], busy: false, mic: 'idle', model: 'opus', state: 'warm', host: 'yosemite-s0', loading: false, now: Date.now(), ...over });

deliver({ type: 'tab', tab: 'lead' });
deliver({ type: 'html', tab: 'lead', html: renderLeadTab(model()) });

test('the Lead tab sits after Issues and is always shown', () => {
  const tabs = [...document.querySelectorAll('.tabs .tab')].map((t) => (t as unknown as HTMLElement).dataset.tab);
  expect(tabs).toEqual(['sessions', 'prs', 'tickets', 'lead']);
  deliver({ type: 'tabs', prs: false, tickets: false });
  expect(el('.tab[data-tab="lead"]').hidden).toBe(false);
  expect(el('.tab[data-tab="lead"]').getAttribute('aria-selected')).toBe('true');
});

test('Enter in the Lead box asks once with the trimmed words; Shift+Enter does not', () => {
  const input = el('#lead-input') as unknown as HTMLTextAreaElement;
  input.value = '  what is blocked on me?  ';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }) as unknown as Event);
  expect(sent.filter((m) => m.type === 'leadAsk')).toEqual([]);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event);
  expect(sent.filter((m) => m.type === 'leadAsk')).toEqual([{ type: 'leadAsk', text: 'what is blocked on me?' }]);
  expect(input.value).toBe('');
});

test('a redraw keeps the words being typed, and the mic state reaches the kept box', () => {
  const input = el('#lead-input') as unknown as HTMLTextAreaElement;
  input.value = 'half a thought';
  deliver({ type: 'html', tab: 'lead', html: renderLeadTab(model({ mic: 'listening' })) });
  expect((el('#lead-input') as unknown as HTMLTextAreaElement).value).toBe('half a thought');
  expect(el('.lead-ask .reply-box').classList.contains('listening')).toBe(true);
  expect(el('.lead-ask .dictation').hidden).toBe(false);
  deliver({ type: 'html', tab: 'lead', html: renderLeadTab(model()) });
  expect(el('.lead-ask .reply-box').classList.contains('listening')).toBe(false);
});

test('the mic posts leadTalk', () => {
  el('#lead-mic').click();
  expect(sent.filter((m) => m.type === 'leadTalk').length).toBe(1);
});

test('one action’s ✓ confirms only that token; ✓ Confirm all sends every open token', () => {
  el('[data-lead-confirm="c_b"]').click();
  expect(sent.filter((m) => m.type === 'leadConfirm')).toEqual([{ type: 'leadConfirm', key: 'c_b' }]);
  el('[data-lead-confirm-all]').click();
  expect(sent.filter((m) => m.type === 'leadConfirmAll')).toEqual([{ type: 'leadConfirmAll', tokens: 'c_a c_b c_c' }]);
});

test('a session the Lead named opens through the host', () => {
  el('[data-lead-ref]').click();
  expect(sent.filter((m) => m.type === 'leadRef')).toEqual([{ type: 'leadRef', ref: { kind: 'session', id: 'c106a56b-2ccb', title: 'Rush account creation' }, external: false }]);
});
