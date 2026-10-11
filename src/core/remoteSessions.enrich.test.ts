import { describe, expect, test } from 'bun:test';
import { normalizeActiveSession } from './remoteSessions';

// The active-session payload carries nested worktree/pr/preview/ticket objects that
// were previously dropped, leaving remote cards blank. These assert the enrichment.

describe('normalizeActiveSession — stop dropping nested fields', () => {
  const base = {
    sessionId: 's1',
    kind: 'claude',
    status: 'input_required',
    cwd: '/x/agents-cli/.agents/worktrees/headless-secrets-shadow/src/lib/secrets/linux.ts',
  };

  test('reads a structured ticket id, worktree slug/branch, preview, and pr.url', () => {
    const s = normalizeActiveSession(
      {
        ...base,
        ticket: { id: 'RUSH-1251', url: 'https://linear.app/x/RUSH-1251' },
        worktree: { slug: 'headless-secrets-shadow', path: '/x/wt', branch: 'muqsit/rush-1251' },
        pr: { url: 'https://github.com/o/r/pull/9', number: 9 },
        preview: 'Editing linux.ts to remove the stale resolver',
      } as any,
      'zion',
      1_000_000,
    );
    expect(s.ticket).toBe('RUSH-1251');
    expect(s.worktreeSlug).toBe('headless-secrets-shadow');
    expect(s.worktreePath).toBe('/x/wt');
    expect(s.branch).toBe('muqsit/rush-1251');
    expect(s.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(s.lastResponse).toBe('Editing linux.ts to remove the stale resolver');
    expect(s.phase).toBe('waiting');
  });

  test('falls back to worktreeSlugOf(cwd) when the payload omits the slug', () => {
    const s = normalizeActiveSession(base as any, 'zion', 1_000_000);
    expect(s.worktreeSlug).toBe('headless-secrets-shadow');
  });

  test('still accepts a bare-string ticket (older payloads)', () => {
    const s = normalizeActiveSession({ ...base, ticket: 'RUSH-9' } as any, 'zion', 1_000_000);
    expect(s.ticket).toBe('RUSH-9');
  });
});
