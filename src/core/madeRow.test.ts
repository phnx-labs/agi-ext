import { test, expect } from 'bun:test';
import { madeChip, madeItems, madeList, prMentions, readState, type MadeInput, type PrFact } from './madeRow';
import { mergeRing, prFacts, parsePrs } from './projectPanel';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const SINCE = NOW - 7 * 86_400_000;
const url = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

// Review's own read of two repositories (`agents projects prs list --json`).
const facts = prFacts(parsePrs(JSON.stringify({ repositories: [
  { slug: 'phnx-labs/rush', pullRequests: [
    { number: 6779, title: 'DESIGN.md tokens', url: url('phnx-labs/rush', 6779), ciState: 'SUCCESS', headSha: 'abc1234', createdAt: new Date(NOW - 30 * 60_000).toISOString() },
    { number: 6821, title: 'require the canary token', url: url('phnx-labs/rush', 6821), ciState: 'FAILURE', failingChecks: ['test'], createdAt: new Date(NOW - 3600_000).toISOString() },
    { number: 6767, title: 'resume once', url: url('phnx-labs/rush', 6767), ciState: 'PENDING', createdAt: new Date(NOW - 3600_000).toISOString() },
    { number: 6800, title: 'rebase me', url: url('phnx-labs/rush', 6800), ciState: 'SUCCESS', mergeable: false, createdAt: new Date(NOW - 3600_000).toISOString() },
  ], recentlyMerged: [{ number: 6805, title: 'merged one', url: url('phnx-labs/rush', 6805), mergedAt: new Date(NOW - 60_000).toISOString() }] },
] })).repos);
const byUrl = new Map(facts.map((f) => [f.url.toLowerCase(), f]));

const base = (over: Partial<MadeInput> = {}): MadeInput => ({
  prs: [], touched: [], files: [], said: '', fact: (k) => byUrl.get(k), known: facts, opened: () => undefined, since: SINCE, ...over,
});

test('a PR from Review says its state in words: green only for Ready, red for what blocks it, plain otherwise (C6, C7)', () => {
  const word = (n: number) => { const f = facts.find((x) => x.number === n)!; return [f.word, f.tone, f.ready]; };
  expect(word(6779)).toEqual(['Ready', 'ok', true]);
  expect(word(6821)).toEqual(['Failing', 'bad', false]);
  expect(word(6800)).toEqual(['Conflicts', 'bad', false]);
  expect(word(6767)).toEqual(['Checks running', '', false]);
  expect(word(6805)).toEqual(['Merged', '', false]);
});

test('every PR it opened, acted on or names gets a chip; what its latest reply names comes first, marked (C4)', () => {
  const items = madeItems(base({
    prs: [{ url: url('phnx-labs/rush', 6779), ownerRepo: 'phnx-labs/rush', number: 6779 }],
    touched: [{ url: url('phnx-labs/rush', 6805), number: 6805, repo: 'phnx-labs/rush', action: 'merged' }],
    said: 'The release gate waits in #6821, and phnx-labs/rush#6767 is still running.',
  }));
  expect(items.map((i) => [i.label, i.word, i.mention])).toEqual([
    ['#6821', 'Failing', true], ['#6767', 'Checks running', true], ['#6779', 'Ready', false], ['#6805', 'Merged', false],
  ]);
  // Only the ready one merges from its ring, at the head commit the list read (C8).
  expect(items.filter((i) => i.merge).map((i) => i.merge)).toEqual([{ repo: 'phnx-labs/rush', number: 6779, sha: 'abc1234' }]);
});

test('a bare #N matches only when exactly one known PR has that number', () => {
  const known = [{ url: url('a/x', 5), slug: 'a/x', number: 5 }, { url: url('a/y', 5), slug: 'a/y', number: 5 }, { url: url('a/x', 9), slug: 'a/x', number: 9 }];
  expect(prMentions('see #5 and #9 and #12', known)).toEqual([url('a/x', 9)]);
  expect(prMentions('https://github.com/A/X/pull/5 again', known)).toEqual([url('a/x', 5)]);
});

test('the row’s own PR speaks when Review has not read it, and a ready one with its head commit merges', () => {
  const main = { url: url('o/r', 7), number: 7, state: 'open' as const, isDraft: false, checks: 'passing' as const, mergeable: 'mergeable' as const, headSha: 'deadbee' };
  const [i] = madeItems(base({ main }));
  expect([i!.word, i!.tone, i!.merge]).toEqual(['Ready', 'ok', { repo: 'o/r', number: 7, sha: 'deadbee' }]);
  const [merged] = madeItems(base({ main: { ...main, state: 'merged' } }));
  expect(merged!.tone).toBe('');
  expect(merged!.merge).toBeUndefined();
});

test('a page is its headline, newest first; never opened, changed since opened, or seen (C3, C5)', () => {
  const files = [
    { path: '/a/old.html', name: 'old.html', title: 'Old findings', editedAtMs: SINCE - 1000 },
    { path: '/a/new.html', name: 'new.html', title: 'The Grok X bot misses your feed', editedAtMs: NOW - 6 * 3600_000 },
    { path: '/a/notes.md', name: 'notes.md', editedAtMs: NOW - 5 * 60_000 },
  ];
  const opened: Record<string, number> = { '/a/notes.md': NOW - 3600_000 };
  const items = madeItems(base({ files, opened: (k) => opened[k] }));
  expect(items.map((i) => [i.label, i.read])).toEqual([['notes.md', 'changed'], ['The Grok X bot misses your feed', 'new'], ['Old findings', 'seen']]);
  expect(readState(undefined, undefined, SINCE)).toBe('seen');
  expect(readState(NOW, NOW + 1, SINCE)).toBe('seen');
});

test('a chip draws its word, its age and the still unread dot; a ready PR is followed by Review’s ring', () => {
  const ring = (m: { repo: string; number: number; sha?: string }) => mergeRing(m, 'squash');
  const [ready] = madeItems(base({ prs: [{ url: url('phnx-labs/rush', 6779), ownerRepo: 'phnx-labs/rush', number: 6779 }] }));
  const html = madeChip(ready!, NOW, ring);
  expect(html).toContain('<span class="mn">#6779</span><span class="mw">Ready</span><span class="mwhen">30m</span>');
  expect(html).toContain('class="chip mi pr pr-ok r-new"');
  expect(html).toContain('<i class="rd"');
  expect(html).toContain('data-merge-repo="phnx-labs/rush" data-merge-number="6779" data-merge-sha="abc1234"');
  expect(html).toContain('Merge #6779');
  const page = madeChip({ kind: 'page', key: '/a/p.html', path: '/a/p.html', label: 'A <b> headline', tip: 'x', mention: false, atMs: NOW - 120_000, read: 'changed' }, NOW, ring);
  expect(page).toContain('<span class="mt">A &lt;b&gt; headline</span><span class="mwhen">changed 2m</span>');
  expect(page).toContain('data-artifact="/a/p.html" data-made-key="/a/p.html"');
});

test('the drawer lists what its latest reply names apart, with each item’s state, change and whether you opened it', () => {
  const ring = (m: { repo: string; number: number; sha?: string }) => mergeRing(m, 'squash');
  const items = madeItems(base({ said: 'see #6821', files: [{ path: '/a/p.html', name: 'p.html', title: 'Page', editedAtMs: NOW - 600_000 }], opened: (k) => (k === '/a/p.html' ? NOW - 3600_000 : undefined) }));
  const html = madeList(items, NOW, ring, (k) => (k === '/a/p.html' ? NOW - 3600_000 : undefined));
  expect(html).toContain('Named in its latest reply');
  expect(html).toContain('<span class="pr-bad">Failing</span>');
  expect(html).toContain('<b>Changed 10m ago</b>, after you opened it');
  expect(madeList([], NOW, ring, () => undefined)).toBe('');
});

test('a fact list with no URL or number is dropped', () => {
  const f: PrFact[] = prFacts([{ slug: 'o/r', error: null, branch: null, release: null, open: [{ number: 0, title: '', url: '', isDraft: false, ciState: null, author: '?', avatar: null, date: '', failing: 0, headSha: null, head: null, base: null, failingChecks: [], conflicting: false }], merged: [] }]);
  expect(f).toEqual([]);
});

test('an image is an item the drawer lists, flagged so the card keeps it as a preview', () => {
  const items = madeItems(base({ files: [{ path: '/a/shot.png', name: 'shot.png', editedAtMs: NOW - 60_000, image: true }, { path: '/a/plan.html', name: 'plan.html' }] }));
  expect(items.map((i) => [i.label, !!i.image])).toEqual([['shot.png', true], ['plan.html', false]]);
});
