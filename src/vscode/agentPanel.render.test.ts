import { test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// The sidebar cards (PHNX-3939) are pure string-builders that live inside the
// webview's inline <script>, so they can't be imported. Extract their source by
// name (brace-matching) and eval it — the same technique the webview-syntax test
// uses — then exercise them with stub snapshots that stand in for the
// CLI-projected stream row. None of these functions use `${}`, so the raw
// substring evaluates identically to the runtime template.
//
// Path labels arrive preformatted by the host; the template preserves them.
const SRC = fs.readFileSync(path.join(import.meta.dir, 'agentPanel.vscode.ts'), 'utf8');

function extractFn(name: string): string {
  const sig = `function ${name}(`;
  const start = SRC.indexOf(sig);
  if (start < 0) throw new Error(`function ${name} not found`);
  const braceStart = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function extractConst(name: string): string {
  const sig = `const ${name} = `;
  const start = SRC.indexOf(sig);
  if (start < 0) throw new Error(`const ${name} not found`);
  const end = SRC.indexOf('\n', start);
  return SRC.slice(start, end);
}

const NAMES = [
  'esc', 'truncate', 'relTime', 'compactDuration', 'renderInlineMarkdown', 'renderMarkdownPreview',
  'renderGoalCard', 'renderChecklistCard',
  'requestChips', 'renderRequestCard',
  'timelineFromCheckpoints', 'stepChips', 'renderStep', 'renderTimelineCard',
  'renderFilesCard', 'renderReplyBox', 'renderTerminalCard', 'renderArtifactsCard',
];
const CONSTS = ['TIMELINE_SHOWN', 'FILE_OP_SYMBOL'];
// These functions live inside a template literal, which collapses `\\` to `\` when
// the shell HTML is emitted. renderInlineMarkdown's regexes are written with the
// doubled form for exactly that reason, so the extracted source has to undergo the
// same collapse to be what the webview actually runs.
const combined = [...CONSTS.map(extractConst), ...NAMES.map(extractFn)]
  .join('\n')
  .replace(/\\\\/g, '\\');
const cards = eval(`(function(){ const viewState = {}; ${combined}\n return {
  renderGoalCard, renderChecklistCard, renderRequestCard, renderTimelineCard,
  renderFilesCard, renderReplyBox, renderTerminalCard, renderArtifactsCard,
}; })()`) as {
  renderGoalCard: (s: unknown) => string;
  renderChecklistCard: (s: unknown) => string;
  renderRequestCard: (s: unknown) => string;
  renderTimelineCard: (s: unknown) => string;
  renderFilesCard: (s: unknown) => string;
  renderReplyBox: (s: unknown) => string;
  renderTerminalCard: (s: unknown) => string;
  renderArtifactsCard: (s: unknown) => string;
};

test('renderGoalCard shows the ◈ goal, empty when absent (PHNX-3939)', () => {
  const html = cards.renderGoalCard({ goal: 'Ship the sidebar Goal + Progress cards' });
  expect(html).toContain('Goal');
  expect(html).toContain('◈');
  expect(html).toContain('Ship the sidebar Goal + Progress cards');

  expect(cards.renderGoalCard({ goal: '' })).toBe('');
  expect(cards.renderGoalCard({})).toBe('');
});

test('renderChecklistCard renders the progress bar + rows for a populated list (PHNX-3939)', () => {
  const html = cards.renderChecklistCard({
    todoProgress: {
      done: 1,
      total: 2,
      todos: [
        { content: 'Add RemoteSession fields', status: 'completed' },
        { content: 'Render the cards', status: 'in_progress' },
      ],
    },
  });
  expect(html).toContain('Checklist');
  expect(html).toContain('1/2');
  expect(html).toContain('todo-track');
  expect(html).toContain('width:50%');
  expect(html).toContain('Add RemoteSession fields');
  expect(html).toContain('Render the cards');
  expect(html).not.toContain('todo-empty');
});

test('renderChecklistCard is always on: summarizing while pending, else no-checklist (PHNX-3939)', () => {
  const pending = cards.renderChecklistCard({ summaryState: 'pending' });
  expect(pending).toContain('Checklist');
  expect(pending).toContain('todo-empty');
  expect(pending).toContain('Summarizing…');

  for (const s of [{}, { summaryState: 'ready' }, { summaryState: 'skipped' }, { todoProgress: { done: 0, total: 0, todos: [] } }]) {
    const html = cards.renderChecklistCard(s);
    expect(html).toContain('Checklist');
    expect(html).toContain('No checklist yet');
    expect(html).not.toContain('Summarizing');
  }
});


// ── Request / Timeline / Files cards (PHNX-3939 follow-up) ──────────────────
// Driven by the SAME real fold data the normalizer tests use
// (src/core/testdata/session-rows.fold.json): four live sessions across three
// harnesses, converted to the CLI row contract. `normalizeActiveSession` turns a
// row into exactly what buildSnapshot copies onto the snapshot, so these render
// tests exercise the real projection end to end rather than a hand-written stub.
import { normalizeActiveSession, type RawActiveSession } from '../core/remoteSessions';

const FOLD_ROWS = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, '..', 'core', 'testdata', 'session-rows.fold.json'), 'utf8'),
) as RawActiveSession[];

/** The snapshot fields buildSnapshot copies off one stream row, for one session. */
function snapshotFor(prefix: string, over: Record<string, unknown> = {}) {
  const raw = FOLD_ROWS.find((r) => (r.sessionId ?? '').startsWith(prefix));
  if (!raw) throw new Error(`no fold fixture row for ${prefix}`);
  const live = normalizeActiveSession(raw, 'zion', Date.now());
  return {
    hasSubject: true,
    hasTerminal: true,
    fullSessionId: live.sessionId,
    cwd: live.cwd,
    conversation: { topic: live.topic, messageCount: 0 },
    request: live.request,
    timeline: live.timeline,
    files: live.files,
    firstRequest: live.firstUserMessage || undefined,
    attachments: [],
    ...over,
  };
}

test('renderRequestCard leads with the user’s own sentence and folds the full turn', () => {
  const html = cards.renderRequestCard(snapshotFor('c9d700d5'));
  expect(html).toContain('Request');
  expect(html).toContain('request-headline');
  expect(html).toContain('And I think the other thing is');
  // The fold reports the size of the turn and how many turns there have been.
  expect(html).toContain('Full request');
  expect(html).toContain('chars');
  expect(html).toContain('10 turns');
});

test('renderRequestCard turns attachments and pasted terminal into chips, not prose', () => {
  const html = cards.renderRequestCard(snapshotFor('82eaa149', {
    request: {
      kind: 'text',
      text: 'So there is a few issues with the AGI extension, at least when it’s installed.',
      headline: 'So there is a few issues with the AGI extension.',
      attachments: [
        { kind: 'image', name: 'shot-0321.png' },
        { kind: 'image', name: 'shot-0323.png' },
        { kind: 'dir', name: '@../agi-ext' },
      ],
      pastedLines: 9,
      turns: 6,
    },
  }));
  expect(html).toContain('2 images');
  expect(html).toContain('@../agi-ext');
  expect(html).toContain('pasted terminal · 9 lines');
  // The chips REPLACE the noise — the raw paths never leak into the headline.
  expect(html).toContain('So there is a few issues with the AGI extension.');
  expect(html).toContain('6 turns');
});

test('renderRequestCard shows a slash command as a command, and what it continues', () => {
  const html = cards.renderRequestCard(snapshotFor('c9d700d5', {
    request: {
      kind: 'skill', command: '/continue 8231082e', text: '', headline: '/continue 8231082e',
      attachments: [], pastedLines: 0, turns: 1, continues: { id: '8231082e', label: 'Agents Core' },
    },
  }));
  expect(html).toContain('request-command');
  expect(html).toContain('/continue 8231082e');
  expect(html).toContain('continues Agents Core');
});

test('renderRequestCard falls back to the topic and never synthesizes a sentence', () => {
  const html = cards.renderRequestCard({
    conversation: { topic: 'Fix the empty Active Terminal sidebar' },
    request: undefined,
  });
  expect(html).toContain('Fix the empty Active Terminal sidebar');
  expect(cards.renderRequestCard({ conversation: { topic: '' } })).toBe('');
  expect(cards.renderRequestCard({})).toBe('');
});

test('renderTimelineCard shows the newest 5 steps, the live now-line, more, and the earlier fold', () => {
  const html = cards.renderTimelineCard(snapshotFor('c9d700d5'));
  expect(html).toContain('Timeline');
  // Header meta: span, tool count, failures.
  expect(html).toContain('167 tools');
  expect(html).toContain('4 failed');
  // The live step carries the amber now-line and the harness's own tool label.
  expect(html).toContain('step src-narration live');
  expect(html).toContain('▶ Re-render the plan, copy it to zion');
  expect(html).toContain('>now<');
  // 8 steps ride the row: 5 shown, 3 behind "more".
  expect(html).toContain('3 more');
  // Everything older is one counter, never a wall of rows.
  expect(html).toContain('47 earlier steps');
  expect(html).toContain('156 tools');
  // Chips: the verb mix and the milestone the CLI recognized.
  expect(html).toContain('3 edit');
  expect(html).toContain('artifact rendered');
});

test('renderTimelineCard styles a user turn and a derived step differently from narration', () => {
  const html = cards.renderTimelineCard({
    timeline: {
      steps: [
        { text: 'Ran 4 commands, edited 2 files', at: '2026-09-06T10:00:00Z', source: 'derived', tools: 6, failed: 0, blocked: 0 },
        { text: 'Wait hold on, do not create anything', at: '2026-09-06T10:01:00Z', source: 'user', tools: 0, failed: 0, blocked: 0 },
      ],
      earlier: { steps: 0, tools: 0, failed: 0 }, tools: 6, failed: 0, spanMs: 60_000, state: 'ready',
    },
  });
  // A user turn is quoted and hollow-dotted — it is not something the agent did.
  expect(html).toContain('step src-user');
  expect(html).toContain('“Wait hold on, do not create anything”');
  // A derived step is muted: the harness wrote no narration, so nothing is put in
  // the agent's mouth.
  expect(html).toContain('step src-derived');
  expect(html).toContain('Ran 4 commands, edited 2 files');
});

test('renderTimelineCard marks failures and blocks in red', () => {
  const html = cards.renderTimelineCard({
    timeline: {
      steps: [{
        text: "Checking the guard's exact patterns against the plan text",
        at: '2026-09-06T10:00:00Z', source: 'narration', tools: 6, failed: 1, blocked: 2,
        mix: { run: 5, test: 1 }, marks: ['worktree created'],
      }],
      earlier: { steps: 0, tools: 0, failed: 0 }, tools: 6, failed: 1, spanMs: 1000, state: 'ready',
    },
  });
  expect(html).toContain('<span class="bad">1 failed</span>');
  expect(html).toContain('<span class="bad">2 blocked</span>');
  expect(html).toContain('<span class="mark">worktree created</span>');
  expect(html).toContain('5 run');
});

test('renderTimelineCard says the stream is not running instead of faking an empty session', () => {
  const html = cards.renderTimelineCard({ streamDegraded: true, streamScope: 'this machine' });
  expect(html).toContain('Waiting for the session stream…');
  expect(html).toContain('this machine');
  // It names the exact command it expects, so the state is diagnosable.
  expect(html).toContain('agents feed watch --json');
  expect(html).not.toContain('No checklist yet');

  const remote = cards.renderTimelineCard({ streamDegraded: true, streamScope: 'yosemite-m2' });
  expect(remote).toContain('yosemite-m2');
});

test('renderTimelineCard says a harness has no timeline, with the reason', () => {
  const html = cards.renderTimelineCard({
    timeline: {
      steps: [], earlier: { steps: 0, tools: 0, failed: 0 }, tools: 0, failed: 0, spanMs: 0,
      state: 'unavailable', reason: 'OpenClaw writes no parseable transcript',
    },
  });
  expect(html).toContain('Timeline unavailable for this harness');
  expect(html).toContain('OpenClaw writes no parseable transcript');
});

test('renderTimelineCard falls back to summarizer checkpoints on an older CLI', () => {
  const html = cards.renderTimelineCard({
    checkpoints: [
      { text: 'Scoped the field contract', at: '2026-09-05T10:00:00Z' },
      { text: 'Wired the render layer', at: '2026-09-05T10:20:00Z' },
    ],
  });
  expect(html).toContain('Timeline');
  expect(html).toContain('Wired the render layer');
  // Newest first, same as the folded timeline.
  expect(html.indexOf('Wired the render layer')).toBeLessThan(html.indexOf('Scoped the field contract'));
  // No timeline and no checkpoints renders nothing at all.
  expect(cards.renderTimelineCard({})).toBe('');
});

test('renderFilesCard lists what the harness recorded, relative to cwd, with a count', () => {
  const html = cards.renderFilesCard({
    cwd: '/home/muqsit/src/agents-cli',
    files: {
      source: 'harness',
      total: 2,
      changes: [
        { path: '/home/muqsit/src/agents-cli/musl-smoke/Cargo.toml', display: 'musl-smoke/Cargo.toml', op: 'created', edits: 1, at: '2026-09-06T10:00:00Z' },
        { path: '/home/muqsit/src/agents-cli/musl-smoke/src/main.rs', display: 'musl-smoke/src/main.rs', op: 'created', edits: 1, at: '2026-09-06T10:00:30Z' },
      ],
    },
  });
  expect(html).toContain('Files');
  expect(html).toContain('2 created');
  expect(html).toContain('>musl-smoke/Cargo.toml</button>');
  // Paths render relative to the session cwd, with the absolute path clickable.
  expect(html).not.toContain('>/home/muqsit/src/agents-cli/musl-smoke/Cargo.toml<');
  expect(html).toContain('data-path="/home/muqsit/src/agents-cli/musl-smoke/Cargo.toml"');
  expect(html).toContain('file-op created');
});

test('renderFilesCard shows the op mix and the true total when the row is bounded', () => {
  const html = cards.renderFilesCard({
    cwd: '/repo',
    files: {
      source: 'tools',
      total: 11,
      changes: [
        { path: '/repo/a.ts', op: 'created', edits: 1, at: '' },
        { path: '/repo/b.ts', op: 'modified', edits: 3, at: '' },
        { path: '/repo/c.ts', op: 'deleted', edits: 1, at: '' },
      ],
    },
  });
  expect(html).toContain('1 created');
  expect(html).toContain('1 modified');
  expect(html).toContain('1 deleted');
  expect(html).toContain('of 11');
  expect(html).toContain('file-op deleted');
});

test('renderFilesCard renders nothing rather than guessing when the CLI sent no files', () => {
  expect(cards.renderFilesCard({})).toBe('');
  expect(cards.renderFilesCard({ files: { changes: [], total: 0, source: 'tools' } })).toBe('');
});

test('the header carries Focus and Resume, and the reply field needs a session', () => {
  const header = cards.renderTerminalCard({ fullSessionId: 'c9d700d5', agentName: 'Claude', sessionChunk: 'c9d700d5' });
  expect(header).toContain('data-action="focusSubject"');
  expect(header).toContain('data-action="resumeSubject"');
  expect(header).toContain('aria-label="Focus session"');
  expect(header).toContain('>◎<');
  expect(header).toContain('aria-label="Resume session"');
  expect(header).toContain('>↻<');
  // A tab that has not reported a session id yet gets neither verb (both need one).
  expect(cards.renderTerminalCard({ agentName: 'Claude' })).not.toContain('data-action="focusSubject"');

  // A Fleet subject with no local tab says so, so "Focus" reads as an offer.
  const fleet = cards.renderTerminalCard({ fullSessionId: 's1', subjectSource: 'fleet', hasTerminal: false });
  expect(fleet).toContain('following the Fleet selection');

  expect(cards.renderReplyBox({ fullSessionId: 's1' })).toContain('Reply to this session…');
  expect(cards.renderReplyBox({})).toBe('');
});


test('header separates identity Details and exposes terminal-only adoption', () => {
  const header = cards.renderTerminalCard({ hasTerminal: true, terminalId: 'CL-test', fullSessionId: 'session-full', sessionChunk: 'session', agentType: 'claude', version: '2.1.280', account: 'muqsit@getrush.ai', accountLabel: 'gmail', cwd: '/repo', git: { branch: 'feature' }, sessionHost: 'peer' });
  expect(header).toContain('id="copy-session"');
  expect(header).toContain('data-action="setSessionId"');
  expect(header).toContain('title="muqsit@getrush.ai">gmail');
  expect(header).toContain('claude 2.1.280');
  expect(header).toContain('session-full');
  expect(header).not.toContain('version-pill');
  expect(cards.renderTerminalCard({ hasTerminal: false, fullSessionId: 'remote' })).not.toContain('setSessionId');
  expect(cards.renderTerminalCard({})).not.toContain('class="account-row"');
});

test('Artifacts renders CLI plan and numbered PR with full paths and native buttons', () => {
  const html = cards.renderArtifactsCard({ plan: { path: '/repo/plan.md', display: 'plan.md' }, artifacts: [{ path: '/repo/doc.md', display: 'doc.md' }], pullRequests: [{ url: 'https://github.com/phnx-labs/agi-cli/pull/3716', ownerRepo: 'phnx-labs/agi-cli', number: 3716 }] });
  expect(html).toContain('<h2>Artifacts</h2>');
  expect(html).toContain('>PLAN</span>');
  expect(html).toContain('>DOC</span>');
  expect(html).toContain('#3716');
  expect(html).toContain('title="/repo/doc.md"');
  expect(html).toContain('<button type="button"');
  expect(cards.renderArtifactsCard({})).toBe('');
});
