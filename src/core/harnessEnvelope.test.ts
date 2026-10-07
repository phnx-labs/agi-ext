import { test, expect } from 'bun:test';
import { isHarnessEnvelope } from './harnessEnvelope';

test('harness-written turns are envelopes; your words and the agent’s are not', () => {
  // The exact shape the sidebar printed as the "working" line (owner video, 2026-10-06).
  expect(isHarnessEnvelope('<task-notification><task-id>bw39xxns6</task-id><status>completed</status>')).toBe(true);
  expect(isHarnessEnvelope('  \n<system-reminder>Whenever you read a file…</system-reminder>')).toBe(true);
  expect(isHarnessEnvelope('<local-command-stdout>Session renamed</local-command-stdout>')).toBe(true);
  expect(isHarnessEnvelope('Check the <task-notification> handling in the panel')).toBe(false);
  expect(isHarnessEnvelope('All done??')).toBe(false);
  expect(isHarnessEnvelope('<task-notifications-are-not-a-tag>')).toBe(false);
  expect(isHarnessEnvelope('')).toBe(false);
});
