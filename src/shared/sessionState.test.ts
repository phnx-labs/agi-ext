import { expect, test } from 'bun:test';
import { BALL_WORD, STATE_TONE, ageWords, ballOf, pendingCounts, pendingLines, pendingWords, relTime, sessionStateOf, sparkline, verdictChipHtml, verdictChipOf, urgencyOf, urgencyRank, waitFor } from './sessionState';

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

test('one family of time words: a card age, a sidebar time, and a wait that ticks', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  expect(ageWords(0, now)).toBe('');
  expect(ageWords(now - 10_000, now)).toBe('now');
  expect(ageWords(now - 5 * 60_000, now)).toBe('5m');
  expect(ageWords(now - 3 * 3_600_000, now)).toBe('3h');
  expect(ageWords(now - 3 * 86_400_000, now)).toBe('3d');
  expect(relTime(0, now)).toBe('');
  expect(relTime(now - 30_000, now)).toBe('just now');
  expect(relTime(now - 5 * 60_000, now)).toBe('5 min ago');
  expect(relTime(now - 90 * 60_000, now)).toBe('1 hour ago');
  expect(relTime(now - 50 * 3_600_000, now)).toBe('2 days ago');
  expect(waitFor(12_000)).toBe('12s');
  expect(waitFor(5 * 60_000 + 2_000)).toBe('5m 02s');
  expect(waitFor((18 * 60 + 4) * 60_000)).toBe('18h 4m');
  expect(waitFor(51 * 3_600_000)).toBe('2d 3h');
});

test('every state has one tone: your move, running, waiting on its own work, review, or quiet', () => {
  expect(STATE_TONE).toEqual({ asks: 'move', stuck: 'move', review: 'review', idle: 'quiet', working: 'running', waiting: 'waiting', unknown: 'running', ended: 'quiet' });
});

test('the ⌘K activity line folds the row histogram into block characters scaled to the busiest column', () => {
  const buckets = Array.from({ length: 48 }, (_, i) => ({ tools: i < 4 ? 8 : i >= 44 ? 4 : 0 }))
  const line = sparkline(buckets)
  expect(line).toHaveLength(12)
  expect(line[0]).toBe('█')
  expect(line[11]).toBe('▅')
  expect(line.slice(1, 11)).toBe('▁'.repeat(10))
  // No histogram, or a silent one, draws nothing rather than a flat line.
  expect(sparkline(undefined)).toBe('')
  expect(sparkline(Array.from({ length: 48 }, () => ({ tools: 0 })))).toBe('')
})

test('the done verdict takes an idle session\'s state word: ✓ Done, Not done with its gaps; unchecked reads plain Idle; every other state keeps its own word', () => {
  const at = '2026-10-18T20:00:00Z';
  const done = { state: 'done' as const, gaps: [], at };
  const open = { state: 'open' as const, gaps: ['open-pr', 'delivery', 'new-gap'], at };
  const unchecked = { state: 'unchecked' as const, gaps: [], at };
  expect(verdictChipOf('idle', done)).toEqual({ tone: 'ok', word: '✓ Done', why: 'Idle · its done-check passed' });
  // Each gap in words; one this version does not know as the CLI wrote it.
  expect(verdictChipOf('idle', open)).toEqual({ tone: 'bad', word: 'Not done', why: 'Idle · not done: a PR it opened is still open; merge, release or install not verified; new-gap' });
  expect(verdictChipOf('idle', unchecked)).toBeNull();
  for (const st of ['working', 'waiting', 'unknown', 'asks', 'stuck', 'review', 'ended'] as const) expect(verdictChipOf(st, done)).toBeNull();
  expect(verdictChipOf('idle', undefined)).toBeNull();
  expect(verdictChipOf('idle', null)).toBeNull();
});

test('the verdict escapes what the CLI wrote and carries no outside name, so a webview script can carry it', () => {
  expect(verdictChipHtml({ tone: 'bad', word: 'Not done', why: 'Not done: <b>"x"</b> & y' })).toBe('<span class="vchip v-bad" title="Not done: &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; y">Not done</span>');
  expect(verdictChipHtml(null)).toBe('');
  const carried = new Function(`${verdictChipHtml}\nreturn verdictChipHtml;`)() as typeof verdictChipHtml;
  expect(carried({ tone: 'ok', word: '✓ Done', why: 'ok' })).toBe('<span class="vchip v-ok" title="ok">✓ Done</span>');
});
