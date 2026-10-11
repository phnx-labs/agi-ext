import { expect, test } from 'bun:test';
import { sessionStateOf } from './sessionState';

test('a waiting phase is Needs you, not Working: input_required is a question or permission pending', () => {
  expect(sessionStateOf({ phase: 'waiting', liveStatus: 'input_required' })).toBe('asks');
  expect(sessionStateOf({ phase: 'running', attention: { kind: 'permission', state: 'open' } })).toBe('asks');
  expect(sessionStateOf({ phase: 'running', attention: { kind: 'question', state: 'answered' } })).toBe('working');
});

test('a closed process is Ended, never Done: exiting says nothing about the work', () => {
  expect(sessionStateOf({ phase: 'done', liveStatus: 'closed' })).toBe('ended');
});

test('idle is Your turn and an unreadable live process is Unknown', () => {
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle' })).toBe('yours');
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'unknown' })).toBe('unknown');
});

test('orphaned, crashed, abandoned, failed and an open stall are Stopped', () => {
  for (const liveStatus of ['orphaned', 'crashed', 'abandoned']) expect(sessionStateOf({ phase: 'failed', liveStatus })).toBe('stopped');
  expect(sessionStateOf({ phase: 'idle', attention: { kind: 'stall', state: 'open' } })).toBe('stopped');
});
