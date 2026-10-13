import { expect, test } from 'bun:test';
import { BALL_WORD, SESSION_STATE_WORD, ballOf, moveRank, pendingCounts, pendingLines, pendingWords, sessionStateOf } from './sessionState';

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
  // Waiting is the agent's ball too, but its word says what it waits on.
  for (const [key, word] of Object.entries(SESSION_STATE_WORD)) if (key !== 'waiting') expect(word.startsWith(BALL_WORD[ballOf(key as never)])).toBe(true);
  expect(ballOf('waiting')).toBe('running');
  // A question outranks a finished turn.
  expect(moveRank('asks')).toBeLessThan(moveRank('yours'));
  expect(moveRank('working')).toBe(Number.MAX_SAFE_INTEGER);
});

test('idle with background work still running is Waiting; absent or empty pending is exactly as before', () => {
  const shell = { id: 'b1', description: 'Poll prod until the segment closes', startedAtMs: 1_000 };
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle', pending: { shells: [shell] } })).toBe('waiting');
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle', pending: { subagents: [], shells: [], monitors: [] } })).toBe('yours');
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle', pending: null })).toBe('yours');
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle' })).toBe('yours');
  // A question, a running turn, a stall and an exit all outrank pending work.
  expect(sessionStateOf({ phase: 'waiting', liveStatus: 'input_required', pending: { shells: [shell] } })).toBe('asks');
  expect(sessionStateOf({ phase: 'running', pending: { shells: [shell] } })).toBe('working');
  expect(sessionStateOf({ phase: 'idle', attention: { kind: 'stall', state: 'open' }, pending: { shells: [shell] } })).toBe('yours');
  expect(sessionStateOf({ phase: 'done', liveStatus: 'closed', pending: { shells: [shell] } })).toBe('ended');
  // Only status idle waits: a stopped process with leftover pending stays Your move.
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'stopped', pending: { shells: [shell] } })).toBe('yours');
  // Waiting is the agent's ball, so it never counts as Your move.
  expect(ballOf('waiting')).toBe('running');
  expect(moveRank('waiting')).toBe(Number.MAX_SAFE_INTEGER);
});

test('pending work is counted per kind and listed for the hover', () => {
  const p = {
    subagents: [{ id: 'a', description: 'Watch-a-run reels', startedAtMs: 1 }, { id: 'b', description: 'Story C reel', startedAtMs: 1 }],
    shells: [{ id: 'c', description: 'Poll prod', startedAtMs: 4 * 60_000 }],
    monitors: [{ id: 'd', description: '' }],
  };
  expect(pendingCounts(p)).toEqual({ subagents: 2, shells: 1, monitors: 1, total: 4 });
  expect(pendingCounts(undefined).total).toBe(0);
  expect(pendingWords(p)).toBe('2 subagents, 1 shell, 1 monitor');
  expect(pendingLines(p, 10 * 60_000)).toEqual(['⑂ Watch-a-run reels · 10m', '⑂ Story C reel · 10m', '▸ Poll prod · 6m', '◉ d']);
});
