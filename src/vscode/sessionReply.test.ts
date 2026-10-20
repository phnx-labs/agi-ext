// The one terminal-reply rail: a prompt goes into a TUI typed, then Enter as its own
// keystroke after the paste is in; a rename is Claude's own /rename through it.
import { expect, test } from 'bun:test';
import { deliverReply, renameSession, submitToTui, typeDelivery } from './sessionReply';

const tab = () => { const sent: [string, boolean | undefined][] = []; return { sent, sendText: (t: string, nl?: boolean) => { sent.push([t, nl]); } }; };
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('each prompt is typed without a newline, then \\r alone, one after another', async () => {
  const t = tab();
  submitToTui(t, ['first line', 'second']);
  await settle(1100);
  expect(t.sent).toEqual([['first line', false], ['\r', false], ['second', false], ['\r', false]]);
});

test('renameSession types /rename with the cleaned name, and nothing for an empty one', async () => {
  const t = tab();
  expect(renameSession(t, '  "Body" alignment  ')).toBe('Body alignment');
  expect(renameSession(t, '   ')).toBeNull();
  await settle(400);
  expect(t.sent).toEqual([['/rename Body alignment', false], ['\r', false]]);
});

test('deliveries to one tab go in order, text then its own Enter, or left in the prompt when they ask for no Enter', async () => {
  const t = tab();
  typeDelivery(t, { id: 'a', sessionId: 's', text: 'Merge when green', enter: true, at: new Date().toISOString() });
  await typeDelivery(t, { id: 'b', sessionId: 's', text: '2', enter: false, at: new Date().toISOString() });
  expect(t.sent).toEqual([['Merge when green', false], ['\r', false], ['2', false]]);
});

test('a reply box reply to Claude goes through submitToTui: Enter only after the text is in', async () => {
  const t = { ...tab(), show: () => {} };
  expect(deliverReply({ terminal: t, agentType: 'claude' }, ' yes ')).toBeNull();
  expect(t.sent).toEqual([]);
  await settle(400);
  expect(t.sent).toEqual([['yes', false], ['\r', false]]);
});
