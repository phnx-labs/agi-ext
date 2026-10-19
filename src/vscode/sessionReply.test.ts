// The one terminal-reply rail: a prompt goes into a TUI typed, then Enter as its own
// keystroke after the paste is in; a rename is Claude's own /rename through it.
import { expect, test } from 'bun:test';
import { renameSession, submitToTui } from './sessionReply';

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
