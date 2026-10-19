import { test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { sessionPathUriString } from '../core/sessionPath';
import { PATCH_SCRIPT, SESSION_CARDS_SCRIPT, THUMB_SCRIPT, sessionPanelCss, sessionPanelFontFaces } from '../shared/sessionCards';
import { STATE_TONE } from '../shared/sessionState';
import { REPLY_SCRIPT, replyBoxHtml } from '../shared/replyBox';

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

  // Reproduce the exact runtime HTML string. The interpolations are `nonce`,
  // `cspSource` and the two bundled font URIs; evaluating the extracted body as a
  // template literal applies the same escape processing the real code does, so a
  // mis-escaped sequence surfaces here identically.
  const nonce = 'TESTNONCE';
  const logoCss = '.hx-claude { background-image: url("vscode-webview://assets/claude.png"); }';
  const cspSource = 'vscode-webview:';
  const fontJost = 'vscode-webview://fonts/jost-var.woff2';
  const fontInter = 'vscode-webview://fonts/InterVariable.woff2';
  // The shared session cards (script and stylesheet) are interpolated too.
  void PATCH_SCRIPT; void THUMB_SCRIPT; void SESSION_CARDS_SCRIPT; void sessionPanelCss; void sessionPanelFontFaces; void STATE_TONE; void REPLY_SCRIPT; void replyBoxHtml;
  const html: string = eval('`' + body + '`');

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);

  // prettyModel reads the model's version with a digit class. Written with one
  // backslash in source, the template literal would emit /d+/ and every model would
  // show its raw id; the emitted script must carry the real class.
  expect(html).toContain('-(\\d+)-(\\d+)/');

  for (const script of scripts) {
    // `new Function` compiles (parses) the source without executing it; a
    // SyntaxError in the generated webview JS throws here. This exact check fails
    // on the pre-fix `/^[/\\]/` regex and passes on the fixed code.
    expect(() => new Function(script)).not.toThrow();
  }
});

// Under a light or custom theme the webview canvas must be pinned to the theme's
// sidebar background or short content leaves a dark void beneath cream cards
// (PHNX-3809). The Rush register then paints its sky and glass over that ground
// from ONE token block, keyed on the body class VS Code sets per theme kind.
// Guard: the canvas stays pinned, every color literal lives inside the token
// block, light and high-contrast each have their own block, and high contrast
// redefines every color token so a contrast theme never shows Rush colors.
test('webview chrome is theme-adaptive: canvas pinned, colors only from the token block (PHNX-3809)', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, 'agentPanel.vscode.ts'), 'utf8');
  // The sidebar's <style> is the shared session panel stylesheet.
  expect(src).toContain('<style>\n${sessionPanelCss(sessionPanelFontFaces(fontJost, fontInter))}\n  ${logoCss}\n</style>');
  const style = sessionPanelCss(sessionPanelFontFaces('vscode-webview://fonts/jost-var.woff2', 'vscode-webview://fonts/InterVariable.woff2'));

  // Canvas (html) and body must both resolve their background from a theme token
  // so no untinted void shows through in any theme.
  expect(style).toMatch(/html\s*\{[^}]*background:\s*var\(--vscode-sideBar-background\)/);
  expect(style).toMatch(/body\s*\{[^}]*background:\s*var\(--vscode-sideBar-background\)/);
  // Body must stretch to the full viewport so short content can't expose a gap.
  expect(style).toMatch(/body\s*\{[^}]*min-height:\s*100vh/);

  const tokenStart = style.indexOf('Rush register tokens');
  const tokenEnd = style.indexOf(':root {', tokenStart);
  expect(tokenStart).toBeGreaterThan(-1);
  expect(tokenEnd).toBeGreaterThan(tokenStart);
  const tokens = style.slice(tokenStart, tokenEnd);

  const block = (selector: string) => {
    const at = tokens.indexOf(selector + ' {');
    expect(at).toBeGreaterThan(-1);
    return tokens.slice(at, tokens.indexOf('}', at) + 1);
  };
  const names = (b: string) => new Set([...b.matchAll(/(--r-[a-z0-9-]+):/g)].map((m) => m[1]));
  const dark = block('body');
  const light = block('body.vscode-light');
  const contrast = block('body.vscode-high-contrast, body.vscode-high-contrast-light');

  // A color literal may appear ONLY inside those three theme blocks: hex,
  // rgb(a), hsl(a). Anything else in the stylesheet, including a rule slipped
  // in beside the blocks, reads tokens.
  const rules = [dark, light, contrast].reduce((s, b) => s.replace(b, ''), style);
  expect(rules.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)).toBeNull();
  // Every token a rule reads is defined by the default block.
  for (const [, used] of rules.matchAll(/var\((--r-[a-z0-9-]+)\)/g)) expect(names(dark).has(used)).toBe(true);
  // Every color token the default (dark) block defines is redefined for high
  // contrast; the font stacks are the only tokens it may inherit.
  const colorTokens = [...names(dark)].filter((n) => !['--r-display', '--r-sans', '--r-mono'].includes(n));
  expect(colorTokens.length).toBeGreaterThan(20);
  for (const n of colorTokens) expect(names(contrast).has(n)).toBe(true);
  // High contrast reads VS Code's own colors only, never a literal.
  expect(contrast.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)).toBeNull();
  // Day redefines the type and glass, so a light theme never inherits zinc-on-glass.
  for (const n of ['--r-text', '--r-caption', '--r-glass', '--r-edge', '--r-ok', '--r-warn', '--r-bad']) {
    expect(names(light).has(n)).toBe(true);
  }
  // The bundled faces load under the webview CSP.
  expect(src).toMatch(/font-src \$\{cspSource\}/);
});

test('remote deliverables open on the session host (PHNX-3574)', () => {
  expect(sessionPathUriString('/repo/.agents/plans/sidebar.md', 'yosemite-m3')).toBe(
    'vscode-remote://ssh-remote+yosemite-m3/repo/.agents/plans/sidebar.md',
  );
});

test('local deliverables stay local for the normalized this-mac label (PHNX-3574)', () => {
  expect(sessionPathUriString('/repo/.agents/plans/sidebar.md', 'this-mac')).toBeUndefined();
});

test('Active Session render is one card: request, then what it made, then the feed it filters', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, 'agentPanel.vscode.ts'), 'utf8');
  const fn = src.indexOf('function render(snap)');
  const renderStart = src.indexOf('patchChildren(body,', fn);
  const renderEnd = src.indexOf('bindPanel();', renderStart);
  const renderOrder = src.slice(renderStart, renderEnd);

  // One card (owner, 2026-10-12): who and how it stands, the goal, an open ask,
  // what you asked, what it made, then the strip and the feed it filters (files,
  // subagents and the checklist are feed chips).
  const order = ['renderNav', 'renderTerminalCard', 'renderSessionStats', 'renderGoalCard', 'renderNeedsYou',
    'renderRequestCard', 'renderMadeShelf', 'renderRelated', 'renderTimelineCard'];
  expect(renderStart).toBeGreaterThan(-1);
  for (let i = 1; i < order.length; i++) {
    expect(renderOrder.indexOf(order[i - 1])).toBeGreaterThan(-1);
    expect(renderOrder.indexOf(order[i - 1])).toBeLessThan(renderOrder.indexOf(order[i]));
  }
  // The reply box is built once beside the patched card, never inside it, so an
  // update cannot take the caret or a draft (owner video, 2026-10-12).
  expect(renderOrder).not.toContain('renderReplyBox');
  expect(src.slice(fn, renderStart)).toContain("'<div id=\"panel-body\"></div>' + renderReplyBox()");
});

test('the stylesheet keeps the button reset: no selector list dangles into the next rule', () => {
  // A selector list cut mid-way (its `{` line deleted) silently merges into the next
  // rule; the panel's step rows and Made tiles then render as grey browser buttons.
  const css = sessionPanelCss('');
  const reset = css.match(/([^{}]*)\{\s*background: transparent; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;\s*\}/);
  expect(reset).not.toBeNull();
  for (const sel of ['button.step', 'button.mk-open', 'button.mk', 'button.seek-range', 'button.timeline-more']) expect(reset![1]).toContain(sel);
  const lines = css.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i]!.trimEnd(), b = lines[i + 1]!.trim();
    if (a.endsWith(',') && !a.includes('{')) expect(b.includes('{') && b.includes('}') && !b.endsWith(',')).toBe(false);
  }
});
