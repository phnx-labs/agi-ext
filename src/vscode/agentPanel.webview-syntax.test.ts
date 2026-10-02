import { test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { sessionPathUriString } from '../core/sessionPath';

// The Active-Terminal panel's webview is a large inline <script> assembled inside
// a TypeScript template literal. A single mis-escaped backslash — e.g. a regex
// char class written `/^[/\\]/` in source ships as `/^[/\]/` because the template
// literal collapses `\\` → `\`, breaking the class — is a SyntaxError that crashes
// the ENTIRE webview script on parse. The panel then never renders and stays stuck
// on "Loading…" forever, silently, on every session (PHNX-3517). Nothing else in
// the suite exercises the generated webview JS, so this is the guard: extract the
// renderShell template exactly as it is emitted and assert every <script> block it
// contains parses as valid JavaScript.
test('renderShell webview script is syntactically valid JS (PHNX-3517)', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, 'agentPanel.vscode.ts'), 'utf8');
  const marker = 'return /* html */ `';
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);

  // Walk to the matching (unescaped) closing backtick of the template literal.
  let body = '';
  for (let i = start + marker.length; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { body += ch + src[i + 1]; i++; continue; }
    if (ch === '`') break;
    body += ch;
  }

  // Reproduce the exact runtime HTML string. The only interpolations are `nonce`
  // and `cspSource`; evaluating the extracted body as a template literal applies
  // the same escape processing the real code does, so a mis-escaped sequence
  // surfaces here identically.
  const nonce = 'TESTNONCE';
  const cspSource = 'vscode-webview:';
  const html: string = eval('`' + body + '`');

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);

  for (const script of scripts) {
    // `new Function` compiles (parses) the source without executing it; a
    // SyntaxError in the generated webview JS throws here. This exact check fails
    // on the pre-fix `/^[/\\]/` regex and passes on the fixed code.
    expect(() => new Function(script)).not.toThrow();
  }
});

// The panel's cards already use var(--vscode-*) tokens, but under a light or
// custom theme the webview canvas itself must be pinned to a theme background or
// short content leaves a dark void beneath cream cards (PHNX-3809). Guard both
// halves: the canvas is pinned to a theme token, and NO hardcoded color literal
// (hex / rgb / hsl) is ever reintroduced anywhere in the webview <style>.
test('webview chrome is theme-adaptive: canvas pinned + zero color literals (PHNX-3809)', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, 'agentPanel.vscode.ts'), 'utf8');
  const styleMatch = src.match(/<style>([\s\S]*?)<\/style>/);
  expect(styleMatch).not.toBeNull();
  const style = styleMatch![1];

  // Canvas (html) and body must both resolve their background from a theme token
  // so no untinted void shows through in any theme.
  expect(style).toMatch(/html\s*\{[^}]*background:\s*var\(--vscode-sideBar-background\)/);
  expect(style).toMatch(/body\s*\{[^}]*background:\s*var\(--vscode-sideBar-background\)/);
  // Body must stretch to the full viewport so short content can't expose a gap.
  expect(style).toMatch(/body\s*\{[^}]*min-height:\s*100vh/);

  // No hardcoded color literals: hex (#abc / #aabbcc / #aabbccdd), rgb(a), hsl(a).
  const literals = style.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g);
  expect(literals).toBeNull();
});

test('remote deliverables open on the session host (PHNX-3574)', () => {
  expect(sessionPathUriString('/repo/.agents/plans/sidebar.md', 'yosemite-m3')).toBe(
    'vscode-remote://ssh-remote+yosemite-m3/repo/.agents/plans/sidebar.md',
  );
});

test('local deliverables stay local for the normalized this-mac label (PHNX-3574)', () => {
  expect(sessionPathUriString('/repo/.agents/plans/sidebar.md', 'this-mac')).toBeUndefined();
});

test('Active Session render is outcome-oriented and drops utility-stack cards (PHNX-3574)', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, 'agentPanel.vscode.ts'), 'utf8');
  const renderStart = src.indexOf('root.innerHTML = (', src.indexOf('function render(snap)'));
  const renderEnd = src.indexOf("'<div class=\"footer\"", renderStart);
  const renderOrder = src.slice(renderStart, renderEnd);

  expect(renderOrder).toContain('renderSessionStats(snap)');
  expect(renderOrder).toContain('renderGoalCard(snap)');
  expect(renderOrder).toContain('renderRequestCard(snap)');
  expect(renderOrder).toContain('renderTimelineCard(snap)');
  expect(renderOrder).toContain('renderChecklistCard(snap)');
  expect(renderOrder).toContain('renderArtifactsCard(snap)');
  expect(renderOrder).toContain('renderSpawnedTeamCard(snap)');
  expect(renderOrder).toContain('renderActivityCard(snap)');
  expect(renderOrder).toContain('renderFilesCard(snap)');
  expect(renderOrder).toContain('renderReplyBox(snap)');
  // PHNX-3939 follow-up: what was ASKED leads, then what the agent actually did,
  // then the checklist; Files sit at the bottom and the reply field is last.
  expect(renderOrder.indexOf('renderRequestCard')).toBeLessThan(renderOrder.indexOf('renderTimelineCard'));
  expect(renderOrder.indexOf('renderTimelineCard')).toBeLessThan(renderOrder.indexOf('renderChecklistCard'));
  expect(renderOrder.indexOf('renderChecklistCard')).toBeLessThan(renderOrder.indexOf('renderFilesCard'));
  expect(renderOrder.indexOf('renderFilesCard')).toBeLessThan(renderOrder.indexOf('renderReplyBox'));
  // The Progress card folded INTO the Timeline card, which owns the checkpoints
  // fallback for an older CLI — two producers for one strip is what it replaced.
  expect(src).not.toContain('function renderCheckpointsCard');
  expect(renderOrder).not.toContain('renderConversationCard');
  expect(renderOrder).not.toContain('renderActionsCard');
  expect(renderOrder).not.toContain('renderPromptsCard');
  expect(renderOrder).not.toContain('renderWorktreesCard');
  expect(renderOrder).not.toContain('renderCwdCard');

  const manifest = fs.readFileSync(path.join(import.meta.dir, '../../package.json'), 'utf8');
  expect(manifest).not.toContain('agentsPanel.issues');
});
