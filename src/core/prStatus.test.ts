import { test, expect } from 'bun:test';
import { canOfferMerge, normalizePrStatus, parsePrForMerge, prAction, prRepo, rowMergeChoices } from './prStatus';

// The shape the feed puts on a row's `pr` today (agents-cli 1.22.122: gh's own
// words), plus the head commit, title and per-check items a newer CLI adds.
const row = {
  url: 'https://github.com/phnx-labs/agi-ext/pull/103', number: 103, state: 'OPEN', isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', checks: 'passing',
};

test('normalizes the feed row’s pr in gh’s vocabulary and drops what it cannot trust', () => {
  expect(normalizePrStatus(row)).toEqual({
    url: row.url, number: 103, state: 'open', isDraft: false, review: 'review_required', mergeable: 'mergeable', checks: 'passing', checkItems: [],
  });
  const newer = normalizePrStatus({
    ...row, title: 'Compact header', headSha: '358a1fbc2ebc86115b17d6eb8644d70b2763ea6e',
    checkItems: [{ name: 'test', state: 'passed', url: 'https://github.com/x' }, { name: 'lint', state: 'weird' }, { name: '', state: 'failed' }, { name: 'e2e', state: 'running', url: 'javascript:alert(1)' }],
  });
  expect(newer?.title).toBe('Compact header');
  expect(newer?.headSha).toBe('358a1fbc2ebc86115b17d6eb8644d70b2763ea6e');
  expect(newer?.checkItems).toEqual([{ name: 'test', state: 'passed', url: 'https://github.com/x' }, { name: 'e2e', state: 'running' }]);
  expect(normalizePrStatus({ url: 'https://github.com/a/b/pull/9' })?.number).toBe(9);
  expect(normalizePrStatus({ number: 3 })).toBeUndefined();
  // The number is the URL's; a row that disagrees is not trusted, so one PR is never linked while another merges.
  expect(normalizePrStatus({ ...row, number: 104 })).toBeUndefined();
  expect(normalizePrStatus({ ...row, number: 1.5 })).toBeUndefined();
  expect(normalizePrStatus({ ...row, url: 'https://github.com/phnx-labs/agi-ext/pull/103/../../x/pull/9' })).toBeUndefined();
  expect(normalizePrStatus({ ...row, headSha: 'not-a-sha' })?.headSha).toBeUndefined();
});

test('the card offers merge only when GitHub would take it, pinned to a known head', () => {
  const sha = { headSha: '358a1fb' };
  const pr = (extra: object) => normalizePrStatus({ ...row, ...sha, ...extra });
  expect(prAction(pr({}))).toEqual({ kind: 'merge', reason: 'not approved; your branch rules decide' });
  expect(prAction(pr({ reviewDecision: 'APPROVED' }))).toEqual({ kind: 'merge', reason: 'ready to merge' });
  expect(prAction(pr({ checks: 'pending' }))).toEqual({ kind: 'automerge', reason: 'checks running' });
  expect(prAction(pr({ checks: 'failing' }))).toEqual({ kind: 'none', reason: 'a check failed' });
  expect(prAction(pr({ mergeable: 'CONFLICTING' }))).toEqual({ kind: 'none', reason: 'has conflicts' });
  expect(prAction(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toEqual({ kind: 'none', reason: 'changes requested' });
  expect(prAction(pr({ isDraft: true }))).toEqual({ kind: 'none', reason: 'draft' });
  expect(prAction(pr({ state: 'MERGED' }))).toEqual({ kind: 'none', reason: 'merged' });
  expect(prAction(pr({ mergeable: 'UNKNOWN' })).kind).toBe('none');
  // Today's row has no head commit: nothing is offered, and the reason says why.
  expect(prAction(normalizePrStatus(row))).toEqual({ kind: 'none', reason: 'merging from here needs a newer agents CLI (head commit not on the row)' });
  expect(prAction(undefined).kind).toBe('none');
});

test('the repo comes only from a github.com pull URL', () => {
  expect(prRepo('https://github.com/phnx-labs/agi-ext/pull/103')).toBe('phnx-labs/agi-ext');
  expect(prRepo('https://evil.example/phnx-labs/agi-ext/pull/1')).toBeUndefined();
});


test('Merge ▾ is offered for an open, non-draft, conflict-free PR with a head commit', () => {
  const base = { url: 'https://github.com/o/r/pull/1', number: 1, state: 'open', isDraft: false, checkItems: [], headSha: 'abcdef1' } as const;
  expect(canOfferMerge({ ...base, mergeable: 'mergeable', checks: 'failing' } as never)).toBe(true);
  expect(canOfferMerge({ ...base, isDraft: true, mergeable: 'mergeable' } as never)).toBe(false);
  expect(canOfferMerge({ ...base, mergeable: 'conflicting' } as never)).toBe(false);
  expect(canOfferMerge({ ...base, headSha: undefined, mergeable: 'mergeable' } as never)).toBe(false);
  expect(canOfferMerge(undefined)).toBe(false);
});

// `agents projects prs <project> --json --repo R --number N`, as it read PR #137 on 2026-10-12.
const ONE_PR = JSON.stringify({ project: { name: 'agi-ui' }, repositories: [{ slug: 'phnx-labs/agi-ext', merge: { viewerIsAdmin: true, adminBypass: true, autoMergeAllowed: false },
  pullRequests: [{ number: 137, isDraft: false, state: 'OPEN', headSha: 'c9070350ff776ff354df90ac8f828f5173da0939', mergeable: true, mergeableState: 'clean', reviewDecision: 'REVIEW_REQUIRED', ciState: null }] }] });

test('merge from a PR row: one read gives the head and mergeability; methods when GitHub would merge, admin when you may bypass', () => {
  const pr = parsePrForMerge(ONE_PR, 'phnx-labs/agi-ext', 137);
  expect(pr).toMatchObject({ headSha: 'c9070350ff776ff354df90ac8f828f5173da0939', mergeableState: 'clean', viewerIsAdmin: true, adminBypass: true });
  expect(rowMergeChoices(pr).map((c) => c.label)).toEqual(['Squash and merge', 'Rebase and merge', 'Create a merge commit', 'Admin merge (squash)']);
  expect(rowMergeChoices({ ...pr!, mergeableState: 'blocked' }).map((c) => c.admin)).toEqual([true]);
  expect(rowMergeChoices({ ...pr!, mergeableState: 'blocked', viewerIsAdmin: false })).toEqual([]);
  expect(rowMergeChoices({ ...pr!, mergeableState: 'dirty' })).toEqual([]);
  expect(rowMergeChoices({ ...pr!, isDraft: true })).toEqual([]);
  expect(rowMergeChoices({ ...pr!, ciState: 'failure' }).map((c) => c.admin)).toEqual([true]);
  expect(parsePrForMerge(ONE_PR, 'phnx-labs/agi-ext', 1)).toBeUndefined();
});
