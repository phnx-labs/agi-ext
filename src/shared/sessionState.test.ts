import { expect, test } from 'bun:test';
import { BALL_WORD, SESSION_STATE_WORD, ballOf, moveRank, sessionStateOf } from './sessionState';

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

test('a gone process is Ended (no claim it succeeded); a live stall is idle, your move', () => {
  for (const liveStatus of ['orphaned', 'crashed', 'abandoned']) expect(sessionStateOf({ phase: 'failed', liveStatus })).toBe('ended');
  expect(sessionStateOf({ phase: 'idle', attention: { kind: 'stall', state: 'open' } })).toBe('yours');
  expect(sessionStateOf({ phase: 'running', attention: { kind: 'failure', state: 'open' } })).toBe('yours');
});

test('three states on screen, by who has the ball: asks and idle are both Your move', () => {
  expect(ballOf('asks')).toBe('move');
  expect(ballOf('yours')).toBe('move');
  expect(ballOf('working')).toBe('running');
  expect(ballOf('unknown')).toBe('running');
  expect(ballOf('ended')).toBe('ended');
  expect(new Set(Object.values(BALL_WORD))).toEqual(new Set(['Your move', 'Running', 'Ended']));
  for (const [key, word] of Object.entries(SESSION_STATE_WORD)) expect(word.startsWith(BALL_WORD[ballOf(key as never)])).toBe(true);
  // A question outranks a finished turn.
  expect(moveRank('asks')).toBeLessThan(moveRank('yours'));
  expect(moveRank('working')).toBe(Number.MAX_SAFE_INTEGER);
});
