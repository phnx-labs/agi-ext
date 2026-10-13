import { expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());

// ⌘K's rows: sections in the approved order, an artifact that says who made it
// and goes to that session on Enter, and the Lead row only for a sentence while
// the Lead client has registered its command.

const { buildItems } = await import('./searchPalette.vscode');

const went: string[] = [];
const src = {
  sessions: [{ sessionId: 'a26860ac-1b2c', host: 'yosemite-m5', title: 'Rush MCP token security', text: 'PHNX-4365 · Build the token-scoped MCP server endpoint', lastActivityMs: 2, state: 'waiting' as const, stateWords: 'Waiting on 1 shell', local: false }],
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
