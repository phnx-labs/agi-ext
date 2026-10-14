import { expect, test } from 'bun:test';
import { BALL_WORD, ballOf, pendingCounts, pendingLines, pendingWords, sessionStateOf, urgencyOf, urgencyRank } from './sessionState';

test('a waiting phase is Needs you, not Working: input_required is a question or permission pending', () => {
  expect(sessionStateOf({ phase: 'waiting', liveStatus: 'input_required' })).toBe('asks');
  expect(sessionStateOf({ phase: 'running', attention: { kind: 'permission', state: 'open' } })).toBe('asks');
  expect(sessionStateOf({ phase: 'running', attention: { kind: 'question', state: 'answered' } })).toBe('working');
});

test('a closed process is Ended, never Done: exiting says nothing about the work', () => {
  expect(sessionStateOf({ phase: 'done', liveStatus: 'closed' })).toBe('ended');
});

test('a finished turn that asked nothing is Idle, not your move; an unreadable live process is Unknown', () => {
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle' })).toBe('idle');
  expect(ballOf('idle')).toBe('idle');
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'unknown' })).toBe('unknown');
});

test('a gone process is Ended (no claim it succeeded); a live stall or failure is Stuck, still your move', () => {
  for (const liveStatus of ['orphaned', 'crashed', 'abandoned']) expect(sessionStateOf({ phase: 'failed', liveStatus })).toBe('ended');
  expect(sessionStateOf({ phase: 'idle', attention: { kind: 'stall', state: 'open' } })).toBe('stuck');
  expect(sessionStateOf({ phase: 'running', attention: { kind: 'failure', state: 'open' } })).toBe('stuck');
  expect(ballOf('stuck')).toBe('move');
});

test('an idle session with an open review request is Ready for review, not an ask', () => {
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle', attention: { kind: 'review', state: 'open' } })).toBe('review');
  expect(ballOf('review')).toBe('review');
});

test('by who has the ball: only asks, stalls and failures are your move', () => {
  expect(ballOf('asks')).toBe('move');
  expect(ballOf('working')).toBe('running');
  expect(ballOf('unknown')).toBe('running');
  expect(ballOf('waiting')).toBe('running');
  expect(ballOf('ended')).toBe('ended');
  expect(Object.values(BALL_WORD)).toEqual(['Your move', 'Ready for review', 'Idle', 'Running', 'Ended']);
});

test('urgency is the CLI\'s; an item from a CLI that sends none, or a value this version does not know, is normal', () => {
  expect(urgencyOf({ urgency: 'urgent' })).toBe('urgent');
  expect(urgencyOf({})).toBe('normal');
  expect(urgencyOf(null)).toBe('normal');
  expect(urgencyOf({ urgency: 'critical' })).toBe('normal');
  expect(['low', 'urgent', 'normal', 'high'].sort((a, b) => urgencyRank(a as never) - urgencyRank(b as never))).toEqual(['urgent', 'high', 'normal', 'low']);
});

test('idle with background work still running is Waiting; absent or empty pending is exactly as before', () => {
  const shell = { id: 'b1', description: 'Poll prod until the segment closes', startedAtMs: 1_000 };
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle', pending: { shells: [shell] } })).toBe('waiting');
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle', pending: { subagents: [], shells: [], monitors: [] } })).toBe('idle');
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle', pending: null })).toBe('idle');
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'idle' })).toBe('idle');
  // A question, a running turn, a stall and an exit all outrank pending work.
  expect(sessionStateOf({ phase: 'waiting', liveStatus: 'input_required', pending: { shells: [shell] } })).toBe('asks');
  expect(sessionStateOf({ phase: 'running', pending: { shells: [shell] } })).toBe('working');
  expect(sessionStateOf({ phase: 'idle', attention: { kind: 'stall', state: 'open' }, pending: { shells: [shell] } })).toBe('stuck');
  expect(sessionStateOf({ phase: 'done', liveStatus: 'closed', pending: { shells: [shell] } })).toBe('ended');
  // Only status idle waits: a stopped process with leftover pending stays Idle.
  expect(sessionStateOf({ phase: 'idle', liveStatus: 'stopped', pending: { shells: [shell] } })).toBe('idle');
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
