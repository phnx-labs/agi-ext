import { test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

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

test('Active Session render is outcome-oriented and drops utility-stack cards (PHNX-3574)', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, 'agentPanel.vscode.ts'), 'utf8');
  const renderStart = src.indexOf('root.innerHTML = (', src.indexOf('function render(snap)'));
  const renderEnd = src.indexOf("'<div class=\"footer\"", renderStart);
  const renderOrder = src.slice(renderStart, renderEnd);

  expect(renderOrder).toContain('renderSessionStats(snap)');
  expect(renderOrder).toContain('renderConversationCard(snap)');
  expect(renderOrder).toContain('renderChecklistCard(snap)');
  expect(renderOrder).toContain('renderDeliverablesCard(snap)');
  expect(renderOrder).toContain('renderSpawnedTeamCard(snap)');
  expect(renderOrder).toContain('renderActivityCard(snap)');
  expect(renderOrder.indexOf('renderConversationCard')).toBeLessThan(renderOrder.indexOf('renderChecklistCard'));
  expect(renderOrder).not.toContain('renderActionsCard');
  expect(renderOrder).not.toContain('renderPromptsCard');
  expect(renderOrder).not.toContain('renderWorktreesCard');
  expect(renderOrder).not.toContain('renderCwdCard');

  const manifest = fs.readFileSync(path.join(import.meta.dir, '../../package.json'), 'utf8');
  expect(manifest).not.toContain('agentsPanel.issues');
});
