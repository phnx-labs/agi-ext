import { expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

const executed: unknown[][] = [];
mock.module('vscode', () => vscodeDouble({ commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } } }));

// ⌘K's rows: sections in the approved order, an artifact that says who made it
// and goes to that session on Enter, and the Lead row only for a sentence while
// the Lead client has registered its command.

const { buildItems } = await import('./searchPalette.vscode');

const went: string[] = [];
const src = {
  sessions: [{ sessionId: 'a26860ac-1b2c', host: 'yosemite-m5', title: 'Rush MCP token security', text: 'PHNX-4365 · Build the token-scoped MCP server endpoint', lastActivityMs: 2, state: 'waiting' as const, stateWords: 'Waiting on 1 shell', local: false, spark: '' }],
  tickets: [{ identifier: 'PHNX-4365', title: 'Rush MCP server: hand Rush a task', state: 'Todo', delegate: 'claude', assignee: null }],
  prs: [{ repo: 'o/agents', number: 3889, title: 'MCP server endpoint', url: 'https://example.invalid/pr/3889', author: 'a', date: '2026-10-12T00:00:00Z', ciState: 'SUCCESS', isDraft: false }],
  goToSession: (id: string, host: string) => { went.push(`${id}@${host}`); },
  openTicket: (id: string) => { went.push(id); },
};
const artifacts = [{ id: 'f1', title: 'Rush MCP server, a task-oriented front door', sourcePath: '/x/rush-mcp-server/mcp-server.md', openPath: '/x/rush-mcp-server/mcp-server.html', updatedAtMs: 1, sessionId: 'a26860ac-1b2c', link: 'link' as const }];

test('sections come in order: Artifacts, Sessions, Tickets, Pull requests, then Lead', () => {
  const items = buildItems('mcp server', src, true, artifacts);
  expect(items.filter((i) => i.kind === -1).map((i) => i.label)).toEqual(['Artifacts', 'Sessions', 'Tickets', 'Pull requests', 'Lead']);
  const art = items[1]!;
  expect(art.label).toBe('Rush MCP server, a task-oriented front door');
  expect(art.detail).toBe('made by Rush MCP token security on yosemite-m5');
  expect(art.buttons?.length).toBe(1);
  art.go!();
  expect(went.pop()).toBe('a26860ac-1b2c@yosemite-m5');
  expect(items.find((i) => i.description?.startsWith('Session'))!.description).toBe('Session · Waiting on 1 shell · yosemite-m5');
  expect(items.at(-1)!.label).toBe('Ask the Lead: “mcp server”');
  // The row hands the words to the Lead client's command (agents.lead.ask, registered by #140).
  items.at(-1)!.go!();
  expect(executed.at(-1)).toEqual(['agents.lead.ask', 'mcp server']);
});

test('a session waiting on you leads ⌘K under Needs you, so Enter reaches it; rows carry the activity line', () => {
  const ask = { sessionId: 'c4f1', host: 'zion', title: 'fork of Carousel pipeline', text: 'PHNX-4379', lastActivityMs: 1, state: 'asks' as const, stateWords: 'Asks · 18m 07s', local: true, spark: '▂▅█▃' };
  const items = buildItems('', { ...src, sessions: [...src.sessions, ask] }, false, artifacts);
  expect(items.filter((i) => i.kind === -1).map((i) => i.label)).toEqual(['Needs you', 'Artifacts', 'Sessions', 'Tickets', 'Pull requests']);
  expect(items[1]!.label).toBe('fork of Carousel pipeline');
  expect(items[1]!.description).toBe('Session · Asks · 18m 07s · zion  ▂▅█▃');
  // Listed once: not again under Sessions.
  expect(items.filter((i) => i.label === 'fork of Carousel pipeline')).toHaveLength(1);
  items[1]!.go!();
  expect(went.pop()).toBe('c4f1@zion');
});

test('the Lead row needs a sentence and the Lead command', () => {
  expect(buildItems('mcp', src, true, artifacts).some((i) => i.label.startsWith('Ask the Lead'))).toBe(false);
  expect(buildItems('mcp server', src, false, artifacts).some((i) => i.label.startsWith('Ask the Lead'))).toBe(false);
});

test('nothing found says so, with the index error when the CLI failed', () => {
  const items = buildItems('zzz', src, false, [], 'artifacts not found');
  expect(items).toHaveLength(1);
  expect(items[0]!.label).toBe('Nothing matches “zzz”');
  expect(items[0]!.description).toBe('artifacts: artifacts not found');
});

test('the artifact index reads a page prefix only, re-reads only on a new mtime, and indexes pages larger than the prefix', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const { ArtifactIndex, PAGE_PREFIX_BYTES } = await import('./searchPalette.vscode');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-index-'));
  try {
    const small = path.join(dir, 'small.md');
    const big = path.join(dir, 'big.md');
    fs.writeFileSync(path.join(dir, 'small.html'), '<title>AGI | Small plan</title><a href="agents://session/a26860ac">a</a>');
    // 1.5 MB: the title and link near the top, then far more than the prefix. A link past the prefix is never seen.
    fs.writeFileSync(path.join(dir, 'big.html'), '<title>AGI | Big report</title><a href="agents://session/b1111111">b</a>' + 'x'.repeat(PAGE_PREFIX_BYTES * 3) + '<a href="agents://session/c2222222">late</a>');
    const list = JSON.stringify({ artifacts: [{ id: '1', sourcePath: small, title: '', updatedAt: '2026-10-13T00:00:00Z' }, { id: '2', sourcePath: big, title: '', updatedAt: '2026-10-13T00:00:00Z' }] });
    const calls: string[] = [];
    const idx = new ArtifactIndex(async (tool, args) => { calls.push(`${tool} ${args.join(' ')}`); return { stdout: tool === 'artifacts' ? list : '[]' }; });
    await idx.refresh([]);
    expect(idx.error).toBeUndefined();
    const arts = idx.artifacts([]);
    expect(arts.map((a) => [a.title, a.sessionId])).toEqual([['Small plan', 'a26860ac'], ['Big report', 'b1111111']]);
    expect(idx.reads).toBe(2);
    // Unchanged pages are not read again.
    await idx.refresh([], true);
    expect(idx.reads).toBe(2);
    // A new mtime is.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'small.html'), later, later);
    await idx.refresh([], true);
    expect(idx.reads).toBe(3);
    expect(calls.filter((c) => c === 'artifacts list --json').length).toBe(3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
