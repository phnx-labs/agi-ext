import { expect, test } from 'bun:test';
import {
  findSession, htmlTitle, indexArtifacts, leadQuery, matchTier, parseArtifactList, provenanceSessionId,
  renderedHtmlCandidates, searchAll, type IndexedSession, type RenderedFacts,
} from './searchIndex';

// The shapes below are `artifacts list --json` and a rendered page as they were on
// 2026-10-13. The case is the recording's: "mcp server" in ⌘K found nothing, and
// the plan rush-mcp-server/mcp-server.html was made by session a26860ac.

const LIST = JSON.stringify({
  count: 3,
  artifacts: [
    { id: 'f1', sourcePath: '/Users/me/.local/share/agents/artifacts/2026-10-12/rush-mcp-server/mcp-server.md', title: '', createdAt: '2026-10-12T23:00:00.000Z', updatedAt: '2026-10-12T23:50:00.000Z', revisionCount: 2, favorite: false },
    { id: 'f2', sourcePath: '/Users/me/src/agents/.agents/worktrees/oauth/.agents/plans/mcp-server.md', title: 'mcp-server.md · oauth', createdAt: '2026-10-12T23:20:00.000Z', updatedAt: '2026-10-12T23:30:00.000Z', revisionCount: 1, favorite: false },
    { id: 'f3', sourcePath: '/tmp/x/scratchpad/notes.md', title: 'Auto mode classifier permission handling', updatedAt: '2026-10-12T20:00:00.000Z' },
  ],
});

const PAGE = '<!doctype html><html><head><title>AGI | Rush MCP server, a task-oriented front door over the developer API</title></head><body>' +
  '<span class="provenance-part"><a href="agents://session/a26860ac-1b2c-4d5e-8f90-123456789abc">a26860ac</a></span></body></html>';

const SESSIONS: IndexedSession[] = [
  { sessionId: 'a26860ac-1b2c-4d5e-8f90-123456789abc', host: 'yosemite-m5', title: 'Rush MCP token security', text: 'PHNX-4365 · #3889', lastActivityMs: Date.parse('2026-10-13T00:20:00Z') },
  { sessionId: 'b1111111-0000-0000-0000-000000000000', host: 'yosemite-s1', title: 'Rush MCP OAuth', text: '', cwd: '/home/me/src/agents/.agents/worktrees/oauth', lastActivityMs: Date.parse('2026-10-13T00:10:00Z') },
  { sessionId: 'c2222222-0000-0000-0000-000000000000', host: 'zion', title: 'Auto mode classifier permission handling', text: '', lastActivityMs: Date.parse('2026-10-13T00:25:00Z') },
];

const page = (sourcePath: string, html: string): [string, RenderedFacts] => [sourcePath, { htmlPath: renderedHtmlCandidates(sourcePath)[0]!, title: htmlTitle(html), sessionId: provenanceSessionId(html) }];

test('the artifacts list parses, and a rendered page gives its real title and its session', () => {
  const list = parseArtifactList(LIST);
  expect(list.map((a) => a.id)).toEqual(['f1', 'f2', 'f3']);
  expect(list[0]!.updatedAtMs).toBe(Date.parse('2026-10-12T23:50:00.000Z'));
  expect(() => parseArtifactList('[]')).toThrow('Unexpected artifacts list shape');
  expect(htmlTitle(PAGE)).toBe('Rush MCP server, a task-oriented front door over the developer API');
  expect(provenanceSessionId(PAGE)).toBe('a26860ac-1b2c-4d5e-8f90-123456789abc');
  expect(provenanceSessionId('<a href="agents://session/a26860ac">x</a>')).toBe('a26860ac');
  expect(provenanceSessionId('<p>no link</p>')).toBeNull();
  expect(renderedHtmlCandidates('/a/b/plan.md')).toEqual(['/a/b/plan.html', '/a/b/.artifacts/plan.html']);
  expect(renderedHtmlCandidates('/a/b/page.html')).toEqual(['/a/b/page.html']);
});

test('an artifact maps to its session: the page link first, then the files the session wrote, then its worktree', () => {
  const list = parseArtifactList(LIST);
  const rendered = new Map([page(list[0]!.sourcePath, PAGE)]);
  const files = new Map([['c2222222-0000-0000-0000-000000000000', ['/tmp/x/scratchpad/notes.md']]]);
  const idx = indexArtifacts(list, rendered, files, SESSIONS);
  expect(idx[0]).toMatchObject({ title: 'Rush MCP server, a task-oriented front door over the developer API', sessionId: 'a26860ac-1b2c-4d5e-8f90-123456789abc', link: 'link', openPath: '/Users/me/.local/share/agents/artifacts/2026-10-12/rush-mcp-server/mcp-server.html' });
  // A worktree on another machine still matches: home folders compare as ~.
  expect(idx[1]).toMatchObject({ sessionId: 'b1111111-0000-0000-0000-000000000000', link: 'worktree' });
  expect(idx[2]).toMatchObject({ sessionId: 'c2222222-0000-0000-0000-000000000000', link: 'files' });
  // Nothing says who made it: no session.
  expect(indexArtifacts(list, new Map(), new Map(), [])[0]!.sessionId).toBeUndefined();
});

test('"mcp server" finds the plan first, made by the session that wrote it', () => {
  const list = parseArtifactList(LIST);
  const artifacts = indexArtifacts(list, new Map([page(list[0]!.sourcePath, PAGE)]), new Map(), SESSIONS);
  const found = searchAll('mcp server', { artifacts, sessions: SESSIONS, tickets: [], prs: [] });
  expect(found.artifacts[0]!.artifact.sourcePath).toContain('rush-mcp-server/mcp-server.md');
  expect(found.artifacts[0]!.session?.sessionId.slice(0, 8)).toBe('a26860ac');
  expect(found.artifacts[0]!.session?.title).toBe('Rush MCP token security');
  // "mcp" no longer lands on an unrelated session by fuzzy letters.
  expect(found.sessions.map((s) => s.title)).not.toContain('Auto mode classifier permission handling');
});

test('ranking: exact id, then title prefix, then title words, then other text; recency breaks ties', () => {
  const doc = (title: string, ids: string[] = [], text = '') => ({ ids, title, text, atMs: 0 });
  expect(matchTier(doc('Anything', ['a26860ac']), 'a26860ac')).toBe(0);
  expect(matchTier(doc('Anything', ['a26860ac-1b2c']), 'a26860')).toBe(0);
  expect(matchTier(doc('MCP server plan'), 'mcp ser')).toBe(1);
  expect(matchTier(doc('Rush MCP server'), 'server mcp')).toBe(2);
  expect(matchTier(doc('Rush plan', [], 'rush-mcp-server/mcp-server.html'), 'mcp server')).toBe(3);
  expect(matchTier(doc('Rush plan'), 'mcp')).toBeNull();
  const sessions: IndexedSession[] = [
    { sessionId: 's1', host: 'h', title: 'Old MCP server', text: '', lastActivityMs: 1 },
    { sessionId: 's2', host: 'h', title: 'New MCP server', text: '', lastActivityMs: 2 },
    { sessionId: 's3', host: 'h', title: 'MCP server', text: '', lastActivityMs: 0 },
    { sessionId: 'mcp-x', host: 'h', title: 'Zzz', text: '', lastActivityMs: 0 },
  ];
  expect(searchAll('mcp server', { artifacts: [], sessions, tickets: [], prs: [] }).sessions.map((s) => s.sessionId)).toEqual(['s3', 's2', 's1']);
  expect(searchAll('s1', { artifacts: [], sessions, tickets: [], prs: [] }).sessions.map((s) => s.sessionId)).toEqual(['s1']);
  // Tickets and PRs answer to their ids.
  const found = searchAll('PHNX-4365', { artifacts: [], sessions: [], tickets: [{ identifier: 'PHNX-4365', title: 'Rush MCP server', state: 'Todo', delegate: 'claude', assignee: null }], prs: [{ repo: 'o/agents', number: 3889, title: 'MCP', url: 'u', author: 'a', date: '', ciState: null, isDraft: false }] });
  expect(found.tickets.length).toBe(1);
  expect(searchAll('#3889', { artifacts: [], sessions: [], tickets: [], prs: [{ repo: 'o/agents', number: 3889, title: 'MCP', url: 'u', author: 'a', date: '', ciState: null, isDraft: false }] }).prs.length).toBe(1);
});

test('a short or long session id finds the session it names', () => {
  expect(findSession(SESSIONS, 'a26860ac')?.title).toBe('Rush MCP token security');
  expect(findSession(SESSIONS, 'session_a26860ac-1b2c-4d5e-8f90-123456789abc')?.title).toBe('Rush MCP token security');
  expect(findSession([{ sessionId: 'a26860ac' }], 'a26860ac-1b2c-4d5e-8f90-123456789abc')?.sessionId).toBe('a26860ac');
  expect(findSession(SESSIONS, 'a2686')).toBeUndefined();
});

test('the Lead row takes a sentence, not a single word', () => {
  expect(leadQuery('mcp')).toBeNull();
  expect(leadQuery('   ')).toBeNull();
  expect(leadQuery('  what is   blocked ')).toBe('what is blocked');
});
