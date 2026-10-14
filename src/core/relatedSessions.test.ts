import { expect, test } from 'bun:test';
import { relatedSessions } from './relatedSessions';

const NOW = Date.parse('2026-10-12T22:00:00Z');
const row = (o: Record<string, unknown>) => ({ sessionId: 'x', host: 'm6', title: '', label: '', topic: '', cwd: '/r', branch: 'main', prUrl: '', lastResponse: '', lastActivityMs: NOW - 60_000, phase: 'idle', liveStatus: 'idle', ...o }) as never;

test('related: a shared ticket or PR ties strongest, then the same branch, then a similar request; never itself, never stale', () => {
  const me = row({ sessionId: 'me', title: 'Codex sign-in accounts for the Phoenix org', topic: 'PHNX-4338 codex sign-in', branch: 'fix/codex-signin', cwd: '/rush' });
  const rows = [
    me,
    row({ sessionId: 'ticket', title: 'Follow-up', topic: 'work on PHNX-4338 docs' }),
    row({ sessionId: 'branch', title: 'Tests', branch: 'fix/codex-signin', cwd: '/rush' }),
    row({ sessionId: 'similar', title: 'Phoenix org codex sign-in expired again' }),
    row({ sessionId: 'unrelated', title: 'Landing page hero image' }),
    row({ sessionId: 'old', topic: 'PHNX-4338', lastActivityMs: NOW - 9 * 24 * 3600_000 }),
  ];
  const got = relatedSessions(me, rows, NOW);
  expect(got.map((r) => r.sessionId)).toEqual(['ticket', 'branch', 'similar']);
  expect(got[0]!.why).toBe('same ticket PHNX-4338');
  expect(got[1]!.why).toBe('same branch fix/codex-signin');
  expect(got[2]!.why).toBe('similar request');
  expect(got[0]!.state).toBe('idle');
  // A shared default branch is no tie, and a lone shared word is not similarity.
  expect(relatedSessions(row({ sessionId: 'a', title: 'deploy factory' }), [row({ sessionId: 'b', title: 'factory landing' })], NOW)).toEqual([]);
});
