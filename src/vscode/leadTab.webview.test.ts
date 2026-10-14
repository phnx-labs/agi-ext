import { expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';
import { newTurn, type LeadHistoryTurn } from '../core/lead';

mock.module('vscode', () => vscodeDouble());

// The tab's script lives inside a template literal; one mis-escaped character is a
// SyntaxError that leaves the tab blank. Parse what actually ships.
test('the Lead tab webview script parses and draws Lead text only as text', async () => {
  const { leadTabHtml } = await import('./leadTab.vscode');
  const html = leadTabHtml('vscode-webview:', 'N0NCE', { linear: 'l.svg', github: 'g.png', session: 's.png' });
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length).toBe(1);
  for (const js of scripts) expect(() => new Function(js)).not.toThrow();
  expect(html).toContain("script-src 'nonce-N0NCE'");
  // Turns are built with textContent and text nodes; the script never assigns innerHTML.
  expect(scripts[0]).not.toContain('innerHTML');
});

test('mergeTurns: history first, then live turns history does not hold yet', async () => {
  const { mergeTurns } = await import('./leadTab.vscode');
  const h: LeadHistoryTurn[] = [{ turn: 't_1', ask: 'a', text: 'PHNX-1 done.', summary: 'PHNX-1 done.', refs: [{ kind: 'ticket', id: 'PHNX-1' }], tools: [] }];
  const dup = newTurn('a', 1); dup.turn = 't_1'; dup.finished = true;
  const live = newTurn('b', 2); live.text = 'Working on #12';
  const merged = mergeTurns(h, [dup, live]);
  expect(merged.map((t) => t.ask)).toEqual(['a', 'b']);
  expect(merged[0].segments.map((s) => s.kind)).toEqual(['ref', 'text']);
  expect(merged[1].live).toBe(true);
  // #12 with no PR ref stays text.
  expect(merged[1].segments).toEqual([{ kind: 'text', text: 'Working on #12' }]);
});
