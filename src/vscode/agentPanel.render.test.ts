import { test, expect } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';
import { STATE_TONE, relTime, verdictChipHtml } from '../shared/sessionState';
import { escapeHtml, serviceMark } from '../shared/sessionCards';
import { replyBoxHtml } from '../shared/replyBox';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// The sidebar cards (PHNX-3939) are pure string-builders that live inside the
// webview's inline <script>, so they can't be imported. Extract their source by
// name (brace-matching) and eval it — the same technique the webview-syntax test
// uses — then exercise them with stub snapshots that stand in for the
// CLI-projected stream row. None of these functions use `${}`, so the raw
// substring evaluates identically to the runtime template.
//
// Path labels arrive preformatted by the host; the template preserves them.
// The timeline and artifact cards live in src/shared/sessionCards.ts, which the
// sidebar inlines verbatim, so the cards are extracted from both sources.
const SRC = fs.readFileSync(path.join(import.meta.dir, 'agentPanel.vscode.ts'), 'utf8') + '\n' +
  fs.readFileSync(path.join(import.meta.dir, '..', 'shared', 'sessionCards.ts'), 'utf8');

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
  const lineEnd = SRC.indexOf('\n', start);
  // A multi-line object literal runs to its closing `};` at column 0.
  const end = SRC[lineEnd - 1] === '{' ? SRC.indexOf('\n};', start) + 3 : lineEnd;
  return SRC.slice(start, end);
}

const NAMES = [
  'truncate', 'compactDuration', 'renderInlineMarkdown', 'renderMarkdownPreview',
  'renderGoalCard', 'renderChecklistCard',
  'requestChips', 'renderRequestCard',
  'timelineFromCheckpoints', 'stepChips', 'renderStep', 'renderTimelineCard',
  'renderFilesCard', 'renderReplyBox', 'renderTerminalCard',
  'thumbImg',
  'compactTokens', 'prettyModel', 'clockTime', 'renderNeedsYou', 'renderSessionStats', 'renderFailures',
  'renderImageThumbs', 'renderSeekBar', 'currentFilter', 'renderFilterChips', 'filteredRows', 'renderFilteredBody',
  'renderSpawnedTeamCard', 'filterKey', 'requestTimelineFilter', 'applyTimelineFilter',
  'sessionState', 'seekSegments', 'currentRange', 'inRange', 'sectionCount', 'renderIdleWarning', 'renderMadeShelf', 'madeChips', 'renderRelated', 'renderBlocked', 'renderLatestUpdate', 'renderUpdate', 'artifactItems',
  'fileRow', 'fileTree', 'renderSubagentRow', 'renderRangeLane', 'renderNav',
  'prCheckSegments', 'prChecksBar', 'prReviewGlyph', 'prMergeGlyph',
  'artifactKind', 'timelineShown',
];
const CONSTS = ['HEAD_ICON', 'SHARE_ICON', 'SHAREABLE', 'SECTION_FILTERS', 'IDLE_WARN_MS', 'thumbCache', 'STEP_CHOICES', 'FILE_OP_SYMBOL', 'NEEDS_YOU_LABEL', 'TIMELINE_FILTERS', 'filterCache', 'pendingFilters', 'VERB_FILTERS', 'SUBAGENTS_FINISHED_SHOWN', 'busyArtifacts', 'LANE_BINS', 'PR_SEGMENT_ORDER', 'FILE_GLYPH'];
// These functions live inside a template literal, which collapses `\\` to `\` when
// the shell HTML is emitted. renderInlineMarkdown's regexes are written with the
// doubled form for exactly that reason, so the extracted source has to undergo the
// same collapse to be what the webview actually runs.
// What the host interpolates into the script, as the shell emits it.
const injected = `const esc = ${escapeHtml};\n${relTime}\n${replyBoxHtml}\n${verdictChipHtml}\nconst STATE_TONE = ${JSON.stringify(STATE_TONE)};\nconst APP_ICON = ${JSON.stringify({ github: serviceMark('github', 'art-icon'), linear: serviceMark('linear', 'art-icon') })};`;
const combined = injected + '\n' + [...CONSTS.map(extractConst), ...NAMES.map(extractFn)]
  .join('\n')
  .replace(/\\\\/g, '\\');
const viewState: Record<string, unknown> = {};
const cards = eval(`(function(){ const lastSnapshot = {}; ${combined}\n return {
  renderGoalCard, renderChecklistCard, renderRequestCard, renderTimelineCard,
  renderFilesCard, renderReplyBox, renderTerminalCard, renderMadeShelf, renderRelated, renderBlocked, renderLatestUpdate, currentRange,
  renderNeedsYou, renderSessionStats, renderFailures, renderSeekBar, renderSpawnedTeamCard, prettyModel, clockTime,
  prCheckSegments, renderNav,
}; })()`) as {
  renderMadeShelf: (s: unknown, range?: unknown) => string;
  renderRelated: (s: unknown) => string;
  renderBlocked: (s: unknown) => string;
  renderLatestUpdate: (s: unknown) => string;
  currentRange: (s: unknown) => { startMs: number; endMs: number } | null;
  renderNav: (s: unknown) => string;
  prCheckSegments: (pr: unknown) => { segments: { state: string; name: string }[]; passed: number; running: number; failed: number; counted: number };
  renderGoalCard: (s: unknown) => string;
  renderChecklistCard: (s: unknown) => string;
  renderRequestCard: (s: unknown) => string;
  renderTimelineCard: (s: unknown) => string;
  renderFilesCard: (s: unknown) => string;
  renderReplyBox: () => string;
  renderTerminalCard: (s: unknown) => string;
  renderNeedsYou: (s: unknown) => string;
  renderSessionStats: (s: unknown) => string;
  renderFailures: (s: unknown) => string;
  renderSeekBar: (s: unknown) => string;
  renderSpawnedTeamCard: (s: unknown) => string;
  prettyModel: (id: string) => string;
  clockTime: (ms: number) => string;
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

test('renderRequestCard leads with your own sentence, folds the full turn, and turns attachments and pasted terminal into chips', () => {
  const html = cards.renderRequestCard(snapshotFor('c9d700d5'));
  expect(html).toContain('request-headline');
  expect(html).toContain('And I think the other thing is');
  expect(html).toContain('Full request');
  expect(html).toContain('10 turns');
  const chips = cards.renderRequestCard(snapshotFor('82eaa149', {
    request: {
      kind: 'text',
      text: 'So there is a few issues with the AGI extension, at least when it’s installed.',
      headline: 'So there is a few issues with the AGI extension.',
      attachments: [{ kind: 'image', name: 'shot-0321.png' }, { kind: 'image', name: 'shot-0323.png' }, { kind: 'dir', name: '@../agi-ext' }],
      pastedLines: 9,
      turns: 6,
    },
  }));
  expect(chips).toContain('2 images');
  expect(chips).toContain('@../agi-ext');
  expect(chips).toContain('pasted terminal · 9 lines');
  // The chips REPLACE the noise — the raw paths never leak into the headline.
  expect(chips).toContain('So there is a few issues with the AGI extension.');
});

test('renderRequestCard shows a slash command as a command, else falls back to the topic and never synthesizes a sentence', () => {
  const html = cards.renderRequestCard(snapshotFor('c9d700d5', {
    request: {
      kind: 'skill', command: '/continue 8231082e', text: '', headline: '/continue 8231082e',
      attachments: [], pastedLines: 0, turns: 1, continues: { id: '8231082e', label: 'Agents Core' },
    },
  }));
  expect(html).toContain('request-command');
  expect(html).toContain('continues Agents Core');
  expect(cards.renderRequestCard({ conversation: { topic: 'Fix the empty Active Terminal sidebar' } })).toContain('Fix the empty Active Terminal sidebar');
  expect(cards.renderRequestCard({ conversation: { topic: '' } })).toBe('');
  expect(cards.renderRequestCard({})).toBe('');
});

test('renderTimelineCard shows the newest 8 steps by default, the now-line and the earlier fold, styling each step by who wrote it', () => {
  const html = cards.renderTimelineCard(snapshotFor('c9d700d5'));
  expect(html).toContain('167 tools');
  expect(html).toContain('4 failed');
  // The live step carries the now-line and the harness's own tool label.
  expect(html).toContain('step src-narration live');
  expect(html).toContain('▶ Re-render the plan, copy it to zion');
  // 8 steps ride the row and all 8 show by default; the viewer can pick 4, 16 or all.
  expect(html).not.toContain(' more</button>');
  expect(html).toContain('<option value="8" selected>8</option>');
  viewState.stepsShown = '4';
  expect(cards.renderTimelineCard(snapshotFor('c9d700d5'))).toContain('4 more</button>');
  delete viewState.stepsShown;
  expect(html).toContain('47 earlier steps');
  expect(html).toContain('artifact rendered');
  const steps = cards.renderTimelineCard({
    timeline: {
      steps: [
        { text: 'Ran 4 commands, edited 2 files', at: '2026-09-06T10:00:00Z', source: 'derived', tools: 6, failed: 0, blocked: 0 },
        { text: 'Wait hold on, do not create anything', at: '2026-09-06T10:01:00Z', source: 'user', tools: 0, failed: 0, blocked: 0 },
        { text: 'Checking the guard', at: '2026-09-06T10:02:00Z', source: 'narration', tools: 6, failed: 1, blocked: 2, mix: { run: 5 }, marks: ['worktree created'] },
      ],
      earlier: { steps: 0, tools: 0, failed: 0 }, tools: 12, failed: 1, spanMs: 120_000, state: 'ready',
    },
  });
  // A user turn is quoted, a derived step muted: neither is put in the agent's mouth.
  expect(steps).toContain('step src-user');
  expect(steps).toContain('“Wait hold on, do not create anything”');
  expect(steps).toContain('step src-derived');
  expect(steps).toContain('<span class="bad">1 failed</span>');
  expect(steps).toContain('<span class="bad">2 blocked</span>');
  expect(steps).toContain('<span class="mark">worktree created</span>');
});

test('renderTimelineCard says why there is no timeline instead of faking an empty session', () => {
  const html = cards.renderTimelineCard({ streamDegraded: true, streamScope: 'yosemite-m2' });
  expect(html).toContain('Waiting for the session stream…');
  expect(html).toContain('yosemite-m2');
  // It names the exact command it expects, so the state is diagnosable.
  expect(html).toContain('agents feed watch --json');
  const unavailable = cards.renderTimelineCard({
    timeline: {
      steps: [], earlier: { steps: 0, tools: 0, failed: 0 }, tools: 0, failed: 0, spanMs: 0,
      state: 'unavailable', reason: 'OpenClaw writes no parseable transcript',
    },
  });
  expect(unavailable).toContain('Timeline unavailable for this harness');
  expect(unavailable).toContain('OpenClaw writes no parseable transcript');
});

test('renderTimelineCard falls back to summarizer checkpoints on an older CLI', () => {
  const html = cards.renderTimelineCard({
    checkpoints: [
      { text: 'Scoped the field contract', at: '2026-09-05T10:00:00Z' },
      { text: 'Wired the render layer', at: '2026-09-05T10:20:00Z' },
    ],
  });
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
  // Tree by default: the folder once, its files by name under it.
  expect(html).toContain('<span class="ft-name">musl-smoke</span>');
  expect(html).toContain('>Cargo.toml</button>');
  // Paths render relative to the session cwd, with the absolute path clickable.
  expect(html).not.toContain('>/home/muqsit/src/agents-cli/musl-smoke/Cargo.toml<');
  expect(html).toContain('data-path="/home/muqsit/src/agents-cli/musl-smoke/Cargo.toml"');
  expect(html).toContain('file-op created');
});

test('renderFilesCard shows the op mix and the true total when bounded, and nothing when the CLI sent no files', () => {
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
  expect(html).toContain('1 modified');
  expect(html).toContain('1 deleted');
  expect(html).toContain('of 11');
  expect(cards.renderFilesCard({})).toBe('');
  expect(cards.renderFilesCard({ files: { changes: [], total: 0, source: 'tools' } })).toBe('');
});

test('the session header: the title and its one quick icon; fork, model, account and host live in the ⋯ menu', () => {
  {
    // A session with its tab here: open the tab. Fork is in ⋯ (owner video, 2026-10-17). No ◎ / ↻ (owner: "the rotation one reads as restart").
    const tabbed = cards.renderTerminalCard({ fullSessionId: 'c9d700d5', agentName: 'Claude', sessionChunk: 'c9d700d5', hasTerminal: true });
    expect(tabbed).toContain('data-action="focusSubject" aria-label="Open its tab"');
    expect(tabbed).not.toContain('aria-label="Fork session"');
    expect(tabbed).toContain('<span class="menu-k">Fork</span><span class="menu-v"><button type="button" class="action-btn" data-action="forkSubject">Fork this session</button>');
    expect(tabbed).not.toContain('data-action="resumeSubject"');
    expect(tabbed).not.toContain('>◎<');
    expect(tabbed).not.toContain('>↻<');
    // No tab here: resume (▶) instead of open.
    const header = cards.renderTerminalCard({ fullSessionId: 'c9d700d5', agentName: 'Claude', sessionChunk: 'c9d700d5' });
    expect(header).toContain('data-action="resumeSubject" aria-label="Resume session"');
    expect(header).not.toContain('data-action="focusSubject"');
    // A tab that has not reported a session id yet gets no verb (each needs one).
    expect(cards.renderTerminalCard({ agentName: 'Claude' })).not.toContain('data-action="forkSubject"');

    // A Project subject with no local tab says so, so "Focus" reads as an offer.
    const fleet = cards.renderTerminalCard({ fullSessionId: 's1', subjectSource: 'project', hasTerminal: false });
    expect(fleet).toContain('following the Project panel selection');

    // The reply box is built once (hidden until a session is the subject), with the mic.
    const reply = cards.renderReplyBox();
    expect(reply).toContain('Reply to this session…');
    expect(reply).toContain('<div class="reply-box" hidden>');
    expect(reply).toContain('id="reply-mic"');
  }
  {
    const header = cards.renderTerminalCard({ hasTerminal: true, terminalId: 'CL-test', fullSessionId: 'session-full', sessionChunk: 'session', agentType: 'claude', version: '2.1.280', account: 'muqsit@getrush.ai', accountLabel: 'gmail', cwd: '/repo', git: { branch: 'feature' }, sessionHost: 'peer' });
    expect(header).toContain('id="copy-session"');
    expect(header).toContain('data-action="setSessionId"');
    expect(header).toContain('title="muqsit@getrush.ai">gmail');
    expect(header).toContain('claude 2.1.280');
    expect(header).toContain('session-full');
    expect(header).not.toContain('version-pill');
    expect(cards.renderTerminalCard({ hasTerminal: false, fullSessionId: 'remote' })).not.toContain('setSessionId');
    expect(cards.renderTerminalCard({})).not.toContain('class="account-row"');
  }
  {
    const html = cards.renderTerminalCard({ git: { branch: 'feature', dirtyCount: 3 } });
    expect(html).toContain('data-scm title="Open Source Control">⎇ feature</button>');
    expect(html).toContain('class="dirty-pill" data-scm>3 changed</button>');
  }
  {
    const html = cards.renderTerminalCard({
      agentPrefix: 'CC', agentName: 'Claude', title: 'Grok accounts login verification', model: 'claude-opus-5-5',
      account: 'muqsit@getrush.ai', sessionChunk: 'c0d7375b', project: 'agents-cli', git: { branch: 'main' }, hostLabel: 'zion',
    });
    expect(html).toContain('>Grok accounts login verification</div>');
    expect(html).toContain('>Opus 5.5</b>');
    expect(html).not.toContain('>CC<');
    expect(html).toContain('where-chip proj">agents-cli<');
    expect(html).toContain('>zion</span>');
    expect(html).not.toContain('>worktree<');
    expect(cards.renderTerminalCard({ inWorktree: true, cwd: '/r/.agents/worktrees/x' })).toContain('>worktree</span>');
    expect(cards.prettyModel('gpt-6-astra')).toBe('gpt-6-astra');
  }
  {
    for (const key of Object.keys(viewState)) delete viewState[key];
    const html = cards.renderTerminalCard({ hasTerminal: true, terminalId: 'CL-1', fullSessionId: 'abc-full', sessionChunk: 'abc', title: 'Codebase health', model: 'claude-opus-5-5', accountLabel: 'work', hostLabel: 'yosemite-m1', project: 'agents', git: { branch: 'main' }, startedAtMs: Date.parse('2026-10-04T06:21:00'), tokenCount: 121_000_000, tokPerSec: 124 });
    const face = html.slice(0, html.indexOf('class="head-menu"'));
    const menu = html.slice(html.indexOf('class="menu-panel"'));
    expect(face).toContain('>Codebase health</div>');
    // The face is the title and the quick icons; who runs it moves into the ⋯ menu.
    expect(face).not.toContain('Opus 5.5');
    expect(face).not.toContain('yosemite-m1');
    expect(face).not.toContain('copy-session');
    expect(face).not.toContain('where-chip proj');
    for (const inMenu of ['menu-k">Model', '>Opus 5.5</b>', 'menu-k">Account', '>work</span>', 'menu-k">Host', '>yosemite-m1</span>', 'id="copy-session"', 'where-chip proj">agents<', '⎇ main', '121m tok · 124 tok/s', 'menu-k">Started']) expect(menu).toContain(inMenu);
    expect(html).toContain('aria-label="Session details"');
    // A tab whose harness has not reported an id yet still gets the pencil to set one.
    const idless = cards.renderTerminalCard({ hasTerminal: true, terminalId: 'CX-1', agentName: 'Codex' });
    expect(idless).toContain('data-action="setSessionId"');
    expect(idless).toContain('not reported yet');
  }
});


test('Made: one sideways row — the PR with its checks opens GitHub, then other PRs and the ticket tile, then files newest first; a range dims, a local page can be shared', () => {
  for (const key of Object.keys(viewState)) delete viewState[key];
  const prStatus = normalizePrStatus({ url: 'https://github.com/phnx-labs/agi-ext/pull/103', number: 103, title: 'Sidebar one card', state: 'MERGED', isDraft: false, mergeable: 'MERGEABLE', checks: 'passing',
    checkItems: Array.from({ length: 6 }, (_, i) => ({ name: 'c' + i, state: 'passed' })) })!;
  const snap = {
    fullSessionId: 'made', sessionLocal: true,
    ticket: { id: 'PHNX-4248', title: 'One card sidebar', state: 'In Progress' },
    prStatus, prVerdict: prVerdict(prStatus),
    pullRequests: [{ url: 'https://github.com/phnx-labs/agi-cli/pull/3716', ownerRepo: 'phnx-labs/agi-cli', number: 3716 }],
    artifacts: [
      { path: '/u/Downloads/Old/a.png', display: '~/Downloads/Old/a.png', basename: 'a.png', bucket: 'docs', editedAtMs: 1_000, uri: 'vscode-resource:/a.png' },
      { path: '/u/Downloads/New/index.html', display: '~/Downloads/New/index.html', basename: 'index.html', bucket: 'docs', editedAtMs: 3_000 },
      { path: '/u/Downloads/New/hero.jpg', display: '~/Downloads/New/hero.jpg', basename: 'hero.jpg', title: 'Launch hero', bucket: 'docs', editedAtMs: 2_000, uri: 'vscode-resource:/hero.jpg' },
    ],
    activityHistogram: { startMs: 0, endMs: 10_000, buckets: Array.from({ length: 10 }, () => ({ tools: 1, failed: 0, blocked: 0 })) },
  };
  const html = cards.renderMadeShelf(snap);
  expect(html).toContain('Made <span>6</span>');
  expect(html).toContain('data-strip="made"');
  const at = (needle: string) => html.indexOf(needle);
  // PR first (its state word), then the other PR, the ticket, then files newest first.
  expect(html).toContain('<b>#103</b><span class="mk-st pr-tone-ok">Merged</span>');
  expect([at('#103'), at('#3716'), at('PHNX-4248'), at('index.html'), at('Launch hero'), at('a.png')]).toEqual([at('#103'), at('#3716'), at('PHNX-4248'), at('index.html'), at('Launch hero'), at('a.png')].sort((x, y) => x - y));
  // The PR tile shows how many checks pass and opens the PR on GitHub; no card unfolds (owner video, 2026-10-12).
  expect(html).toContain('class="mk mk-pr" data-url="https://github.com/phnx-labs/agi-ext/pull/103"');
  expect(html).toContain('<span class="pr-frac pr-tone-ok">6/6</span>');
  expect(html).toContain('title="6 of 6 checks passed"');
  expect(html).not.toContain('data-pr-open');
  expect(html).not.toContain('pr-card');
  // The ticket is a tile with its title and state, and opens the ticket to read.
  expect(html).toContain('data-ticket="PHNX-4248"');
  expect(html).toContain('<span class="mk-st tk-st">In Progress</span>');
  expect(html).toContain('<span class="mk-t">One card sidebar</span>');
  expect(cards.renderMadeShelf({ ticket: { id: 'PHNX-1' } })).toContain('<span class="mk-t">Linear ticket</span>');
  // An image previews; a page shows its type mark and can be shared from this machine.
  expect(html).toContain('<img data-thumb="vscode-resource:/hero.jpg"');
  expect(html).toContain('data-share="/u/Downloads/New/index.html"');
  expect(cards.renderMadeShelf({ ...snap, sessionLocal: false })).not.toContain('data-share=');
  // Nothing dims until a range is chosen; then files changed outside it dim in place.
  expect(html).not.toContain('mk-file out');
  viewState.timelineRange = { made: [2_500, 4_000] };
  const ranged = cards.renderMadeShelf(snap, cards.currentRange(snap));
  expect((ranged.match(/mk mk-file out/g) || []).length).toBe(2);
  // As chips (the pinned card's default, owner video 2026-10-18 8:59 PM): one row in the same
  // order, the PR with its word, each file by name; what it only touched comes after, dashed.
  const chips = cards.renderMadeShelf({ ...snap, chips: true, touchedPrs: [{ url: 'https://github.com/x/y/pull/9', number: 9, repo: 'x/y', action: 'merged' }] });
  expect(chips).toContain('<div class="made chips"><div class="made-l">Made <span>6</span></div><div class="mk-row" data-strip="made">');
  expect(chips).not.toContain('class="mk ');
  expect(chips).toContain('class="mk-chip pr-tone-ok" data-url="https://github.com/phnx-labs/agi-ext/pull/103"');
  expect(chips).toContain('<span>#103 Merged</span>');
  expect(chips).toContain('data-artifact="/u/Downloads/New/index.html"');
  const c = (needle: string) => chips.indexOf(needle);
  expect([c('#103'), c('agi-cli #3716'), c('PHNX-4248'), c('index.html'), c('Launch hero'), c('a.png'), c('merged #9')]).toEqual([c('#103'), c('agi-cli #3716'), c('PHNX-4248'), c('index.html'), c('Launch hero'), c('a.png'), c('merged #9')].sort((x, y) => x - y));
  expect(chips).toContain('class="mk-chip mk-tch" data-url="https://github.com/x/y/pull/9"');
  expect(cards.renderMadeShelf({})).toBe('');
  // Every ticket it created is a tile after the one it is on; what it only acted on
  // follows as compact chips with the action word.
  const more = cards.renderMadeShelf({ ...snap, createdTickets: [{ id: 'PHNX-4248' }, { id: 'PHNX-4500', title: 'Follow-up' }], touchedPrs: [{ url: 'https://github.com/phnx-labs/agi-cli/pull/3995', number: 3995, action: 'merged' }], touchedTickets: [{ id: 'PHNX-4401', action: 'commented' }] });
  expect(more.match(/data-ticket="PHNX-4248"/g)?.length).toBe(1);
  expect(more.indexOf('PHNX-4248')).toBeLessThan(more.indexOf('PHNX-4500'));
  expect(more).toContain('Made <span>7</span>');
  expect(more).toContain('<div class="mk-touched"><span class="made-l">Touched</span><button type="button" class="mk-touch" data-url="https://github.com/phnx-labs/agi-cli/pull/3995" title="merged #3995">');
  expect(more).toContain('merged #3995</button><button type="button" class="mk-touch" data-ticket="PHNX-4401" title="commented PHNX-4401">');
  expect(more.indexOf('a.png')).toBeLessThan(more.indexOf('mk-touched'));
  expect(cards.renderMadeShelf({ touchedTickets: [{ id: 'PHNX-1', action: 'updated' }] })).toContain('updated PHNX-1');
  for (const key of Object.keys(viewState)) delete viewState[key];
});

test('back and forward name where they lead, and are absent with no trail', () => {
  expect(cards.renderNav({})).toBe('');
  const both = cards.renderNav({ nav: { back: '! git pull (Branch)', fwd: 'Carousel' } });
  expect(both).toContain('data-nav="back" title="Back to ! git pull (Branch)"');
  expect(both).toContain('data-nav="fwd" title="Forward to Carousel"');
  expect(both).toContain('class="nav-crumb" data-nav="back"');
  const backOnly = cards.renderNav({ nav: { back: 'A' } });
  expect(backOnly).toContain('data-nav="fwd" disabled');
});

test('pencil message reaches the host command and reports command failures', async () => {
  const method = (name: string) => {
    const start = SRC.indexOf('  private async ' + name + '(');
    const end = SRC.indexOf('\n  private ', start + 1);
    return SRC.slice(start, end).replace('private async ', 'async ');
  };
  const calls: unknown[][] = [];
  const warnings: string[] = [];
  let fail = false;
  const vscode = vscodeDouble({
    commands: { executeCommand: async (...args: unknown[]) => { calls.push(args); if (fail) throw new Error('command unavailable'); } },
    window: { showWarningMessage: (message: string) => { warnings.push(message); } },
  });
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync('class Host { snapshot = { hasTerminal: true }; ' + method('handleMessage') + method('runQuickAction') + '}');
  const host = new Function('vscode', 'terminals', code + '; return new Host();')(vscode, { getById: () => undefined });
  await host.handleMessage({ type: 'runQuickAction', action: 'setSessionId', terminalId: 'CL-test' });
  expect(calls).toEqual([['agents.setSessionId', { terminalId: 'CL-test' }]]);
  fail = true;
  await host.handleMessage({ type: 'runQuickAction', action: 'setSessionId', terminalId: 'CL-test' });
  expect(warnings).toHaveLength(1);
  host.snapshot.hasTerminal = false;
  await host.handleMessage({ type: 'runQuickAction', action: 'setSessionId', terminalId: 'CL-test' });
  expect(calls).toHaveLength(2);
});

test('needs-you shows the harness ask under the header, and nothing when no item is open', () => {
  const html = cards.renderNeedsYou({ hasTerminal: true, needsYou: { kind: 'question', text: 'Approve 2 device logins', openedAtMs: Date.now() - 6 * 60_000 } });
  expect(html).toContain('ASKS · WAITING 6 MIN');
  expect(html).toContain('Approve 2 device logins');
  expect(html).toContain('id="needs-you-reply"');
  expect(cards.renderNeedsYou({})).toBe('');
});

test('failures stay hidden behind one line and vanish for a clean session', () => {
  expect(cards.renderFailures({ failedCount: 0, blockedCount: 0 })).toBe('');
  const failures = [
    { atMs: Date.now() - 60_000, tool: 'Bash', summary: 'git fetch origin', error: 'exit 7', blocked: false },
    { atMs: Date.now(), tool: 'Bash', summary: 'rm -rf x', error: 'Permission denied', blocked: true },
  ];
  const html = cards.renderFailures({ failedCount: 1, blockedCount: 1, failures });
  expect(html).toContain('<details class="failures"');
  expect(html).not.toContain(' open id="failures"');
  expect(html).toContain('⚠ 1 failed · 1 blocked');
  expect(html).toContain('1 blocked by policy or permission');
});

test('the seek bar collapses idle runs into labeled gaps and marks your messages', () => {
  const startMs = Date.parse('2026-10-02T05:13:00Z');
  const buckets = Array.from({ length: 48 }, (_, i) => ({ tools: i < 5 ? 10 - i : i === 18 ? 6 : 0, failed: i === 0 ? 2 : 0, blocked: 0 }));
  const html = cards.renderSeekBar({ activityHistogram: { startMs, endMs: startMs + 48 * 22 * 60_000, buckets, userAtMs: [startMs, startMs + 18 * 22 * 60_000] } });
  expect((html.match(/class="seek-gap"/g) || []).length).toBe(2);
  expect((html.match(/class="seek-bar[ "]/g) || []).length).toBe(6);
  expect(html).toContain('seek-bar bad');
  expect(html).toContain('title="Your message 2">2</span>');
  expect(cards.renderSeekBar({})).toBe('');
});

test('the timeline offers row-backed filters and renders your turns under You', () => {
  const s = { fullSessionId: 'abc', sessionLocal: true, timeline: { steps: [{ text: 'Did a thing', at: new Date().toISOString(), source: 'narration', tools: 1, failed: 0, blocked: 0 }], earlier: { steps: 0, tools: 0, failed: 0 }, tools: 1, failed: 0, spanMs: 0, state: 'ready' },
    userTurns: [{ atMs: Date.now(), text: 'Check now..', images: 0 }] };
  const html = cards.renderTimelineCard(s);
  expect(html).toContain('data-filter="summary"');
  expect(html).toContain('data-filter="user" aria-pressed="false">You<em>1</em>');
  expect(html).toContain('data-filter="thinking" aria-pressed="false">Reasoning');
  expect(html).not.toContain('data-filter="failed"');
  // a remote session has no local index to read, so the heavy filters are not offered
  const remote = cards.renderTimelineCard({ ...s, sessionLocal: false });
  expect(remote).toContain('data-filter="user"');
  expect(remote).not.toContain('data-filter="thinking"');
});

test('subagents list what each one did and link its transcript', () => {
  const html = cards.renderSpawnedTeamCard({ subagents: [
    { id: 'agent-a', agentType: 'code-reviewer', description: 'Review PR 3716', status: 'done', startedAtMs: 0, endedAtMs: 11 * 60_000, toolCount: 44, resultExcerpt: 'CHANGES REQUESTED', transcriptPath: '/t/agent-a.jsonl' },
    { id: 'agent-b', agentType: 'code-reviewer', description: 'Review PR 3717', status: 'running', toolCount: 3, transcriptPath: '/t/agent-b.jsonl' },
  ] });
  expect(html).toContain('2 · 1 running');
  expect(html).toContain('Review PR 3716');
  expect(html).toContain('code-reviewer · 11m · 44 tools');
  expect(html).toContain('data-path="/t/agent-a.jsonl"');
});

test('plans open in the Agents Reader and the heavy filters run one CLI call for the current local subject only', async () => {
  const method = (name: string) => {
    const start = SRC.indexOf('  private async ' + name + '(');
    const end = SRC.indexOf('\n  private ', start + 1);
    return SRC.slice(start, end).replace('private async ', 'async ');
  };
  const opened: unknown[][] = [];
  const posted: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let cli: () => { stdout: string } = () => ({ stdout: JSON.stringify({ events: [{ timestamp: '2026-10-03T00:00:00Z', content: 'checking' }] }) });
  const vscode = vscodeDouble({
    commands: { executeCommand: async (...args: unknown[]) => { opened.push(args); } },
    Uri: { file: (p: string) => 'file://' + p },
    window: { withProgress: (_o: unknown, task: () => Promise<void>) => task(), showErrorMessage: async () => undefined },
    ProgressLocation: { Window: 10 },
  });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-artifacts-'));
  // Opening an artifact and loading a heavy filter live in sessionCardActions.ts;
  // the host methods call into it.
  const ACTIONS = fs.readFileSync(path.join(import.meta.dir, 'sessionCardActions.ts'), 'utf8');
  const moduleFn = (name: string) => {
    const start = ACTIONS.indexOf('async function ' + name + '(');
    const end = ACTIONS.indexOf('\n}\n', start) + 3;
    return ACTIONS.slice(start, end);
  };
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(moduleFn('localArtifactUri') + moduleFn('openSessionArtifact') + moduleFn('fetchTimelineFilter') + 'class Host { snapshot = { fullSessionId: "s-1", sessionLocal: true }; view = { webview: { postMessage: (m) => posted.push(m) } }; ' + method('handleMessage') + method('loadTimelineFilter') + '}');
  const pastedDir = path.join(cacheDir, 'pasted');
  const isInside = (p: string, dir: string) => { const rel = path.relative(dir, path.resolve(p)); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const host = new Function('vscode', 'sessionPathUri', 'runAgents', 'runCliArgs', 'shellQuote', 'VERB_FILTER_ROLES', 'posted', 'remoteDeviceArg', 'path', 'fs', 'REMOTE_ARTIFACT_CACHE_DIR', 'PASTED_ATTACHMENT_DIR', 'isInside', code + '; return new Host();')(
    vscode, (p: string) => 'vscode-remote://' + p, async (args: string) => { calls.push(args); return cli(); },
    async (tool: string, args: string[]) => { calls.push([tool, ...args].join(' ')); return cli(); }, (v: string) => "'" + v + "'", new Set(['assistant', 'tools', 'thinking']), posted,
    (host?: string) => (host && host !== 'this-mac' ? host : undefined), path, fs, cacheDir, pastedDir, isInside);

  await host.handleMessage({ type: 'openArtifact', path: '/a/plan.html' });
  await host.handleMessage({ type: 'openArtifact', path: '/a/notes.md' });
  expect(opened).toEqual([['vscode.openWith', 'file:///a/plan.html', 'agents.htmlReader'], ['vscode.openWith', 'file:///a/notes.md', 'agents.markdownEditor']]);

  // A remote session's artifact is copied here with one agents ssh call, then opened locally.
  host.snapshot.sessionHost = 'yosemite-m5';
  host.snapshot.artifacts = [{ path: '/home/u/report.html' }, { path: '/home/u/../../../../etc/x.html' }];
  // A path the row doesn't name, or one that climbs out of the cache, is never fetched or written.
  await host.handleMessage({ type: 'openArtifact', path: '/home/u/other.html' });
  await host.handleMessage({ type: 'openArtifact', path: '/home/u/../../../../etc/x.html' });
  expect(calls).toEqual([]);
  const timelineCli = cli;
  cli = () => ({ stdout: Buffer.from('<h1>report</h1>').toString('base64') });
  await host.handleMessage({ type: 'openArtifact', path: '/home/u/report.html' });
  const local = path.join(cacheDir, 'yosemite-m5', '/home/u/report.html');
  expect(calls.pop()).toBe(`ssh 'yosemite-m5' --argv '["base64","/home/u/report.html"]'`);
  expect(fs.readFileSync(local, 'utf8')).toBe('<h1>report</h1>');
  expect(opened.at(-1)).toEqual(['vscode.openWith', 'file://' + local, 'agents.htmlReader']);
  // A pasted image lives on this machine even for a remote session.
  await host.handleMessage({ type: 'openPath', path: path.join(pastedDir, 'shot.png') });
  expect(opened.at(-1)).toEqual(['vscode.open', 'file://' + path.join(pastedDir, 'shot.png')]);
  host.snapshot.sessionHost = undefined;
  cli = timelineCli;

  expect(calls).toEqual([]);
  // Each open says the tile is busy while it copies, then clears it.
  expect(posted.filter((m: { type: string }) => m.type === 'artifactBusy').slice(-2)).toEqual([
    { type: 'artifactBusy', path: '/home/u/report.html', busy: true },
    { type: 'artifactBusy', path: '/home/u/report.html', busy: false },
  ]);
  posted.splice(0, posted.length);
  await host.handleMessage({ type: 'loadTimelineFilter', role: 'assistant', sessionId: 'old-subject' });
  await host.handleMessage({ type: 'loadTimelineFilter', role: 'rm -rf', sessionId: 's-1' });
  expect(posted).toEqual([
    expect.objectContaining({ type: 'timelineFilter', role: 'assistant', sessionId: 'old-subject', error: 'Session changed before the filter loaded.' }),
    expect.objectContaining({ type: 'timelineFilter', role: 'rm -rf', sessionId: 's-1', error: 'That filter is not available.' }),
  ]);
  await host.handleMessage({ type: 'loadTimelineFilter', role: 'assistant', sessionId: 's-1' });
  expect(calls).toEqual(['sessions s-1 --include assistant --json']);
  expect(posted.at(-1)).toMatchObject({ type: 'timelineFilter', role: 'assistant', sessionId: 's-1', items: [{ text: 'checking' }] });

  cli = () => ({ stdout: JSON.stringify({ schemaVersion: 1, coverage: { indexedFiles: 1 }, sessions: [{ id: 's-1', calls: [{ timestamp: '2026-10-03T00:00:01Z', tool: 'Bash', input: 'ls', outcome: 'error' }] }] }) });
  await host.handleMessage({ type: 'loadTimelineFilter', role: 'tools', sessionId: 's-1' });
  expect(calls.at(-1)).toBe('sessions s-1 --include tools --json');
  expect(posted.at(-1)).toMatchObject({ role: 'tools', items: [{ text: 'Bash: ls', bad: true }] });
  // A session the tool index has not reached says so instead of showing an empty list.
  cli = () => ({ stdout: JSON.stringify({ schemaVersion: 1, coverage: { indexedFiles: 0 }, sessions: [] }) });
  await host.handleMessage({ type: 'loadTimelineFilter', role: 'tools', sessionId: 's-1' });
  expect(posted.at(-1)).toMatchObject({ role: 'tools', error: 'Tool calls for this session are not indexed yet.' });

  cli = () => { throw new Error('unknown session s-1\nmore'); };
  await host.handleMessage({ type: 'loadTimelineFilter', role: 'thinking', sessionId: 's-1' });
  expect(posted.at(-1)).toMatchObject({ role: 'thinking', error: 'unknown session s-1' });

  host.snapshot.sessionLocal = false;
  await host.handleMessage({ type: 'loadTimelineFilter', role: 'tools', sessionId: 's-1' });
  expect(calls).toHaveLength(4);
  expect(posted.at(-1)).toMatchObject({ role: 'tools', sessionId: 's-1', error: 'This session is on another machine.' });
});

test('a loaded heavy filter stays visible as the session moves on, with a click-only refresh', () => {
  const at = Date.now();
  const base = { fullSessionId: 'live', sessionLocal: true, lastActivityMs: at, timeline: { steps: [], earlier: { steps: 1, tools: 0, failed: 0 }, tools: 0, failed: 0, spanMs: 0, state: 'ready' } };
  const harness = eval(`(function(){ const viewState = { timelineFilter: { live: 'assistant' } }; const lastSnapshot = {}; ${combined}
    filterCache[filterKey(base, 'assistant')] = { items: [{ at: new Date(at).toISOString(), text: 'checking s0' }], atStamp: at };
    return { fresh: renderTimelineCard(base), moved: renderTimelineCard({ ...base, lastActivityMs: at + 5000 }), remote: renderTimelineCard({ ...base, sessionLocal: false }) };
  })()`) as { fresh: string; moved: string; remote: string };
  expect(harness.fresh).toContain('checking s0');
  expect(harness.fresh).not.toContain('data-refresh-filter');
  expect(harness.moved).toContain('checking s0');
  expect(harness.moved).toContain('data-refresh-filter="assistant">Refresh');
  expect(harness.remote).not.toContain('checking s0');
  expect(harness.remote).toContain('data-filter="summary" aria-pressed="true"');
});

test('Files folds single-child folders into one row and keeps a flat List view', () => {
  for (const key of Object.keys(viewState)) delete viewState[key];
  const change = (display: string, op: string) => ({ path: '/w/' + display, display, op, edits: 1, at: '' });
  const s = { files: { source: 'harness', total: 3, changes: [
    change('worktrees/db-proof/rush/api/scripts/dump-schema.sh', 'modified'),
    change('worktrees/db-proof/security-job/scripts/scan.sh', 'modified'),
    change('scratchpad/brief.md', 'created'),
  ] } };
  const tree = cards.renderFilesCard(s);
  // worktrees → db-proof has one child folder and no files, so they fold together;
  // db-proof itself has two children, so the fold stops there.
  expect(tree).toContain('<span class="ft-name">worktrees/db-proof</span><span class="ft-count">2</span>');
  expect(tree).toContain('<span class="ft-name">rush/api/scripts</span>');
  expect(tree).toContain('<span class="file-op created">A</span>');
  expect(tree).toContain('>brief.md</button>');
  expect(tree).toContain('data-files-view="tree" aria-pressed="true"');
  viewState.filesView = 'list';
  const list = cards.renderFilesCard(s);
  expect(list).not.toContain('class="ft-dir"');
  expect(list).toContain('>scratchpad/brief.md</button>');
  delete viewState.filesView;
});

test('the state line says the shared state word and running time; a live agent pulses its dot, the last activity is the tooltip', () => {
  const day = 26 * 3600_000;
  const running = cards.renderSessionStats({ state: { key: 'working', word: 'Working' }, durationMs: day, lastActivityMs: Date.now() - 2 * 60_000 });
  expect(running).toContain('state-running');
  expect(running).toContain('Working <b>1d 2h</b></span>');
  expect(running).toContain('title="Active 2 min ago"');
  expect(running).not.toContain(' live');
  const live = cards.renderSessionStats({ state: { key: 'working', word: 'Working' }, durationMs: day, lastActivityMs: Date.now() - 10_000, accountLabel: 'trp', agentType: 'claude' });
  expect(live).toContain('session-stats state-running live');
  expect(live).not.toContain('claude#trp');
  const idle = cards.renderSessionStats({ state: { key: 'yours', word: 'Your turn' }, durationMs: day, lastActivityMs: Date.now() - 3 * 3600_000 });
  expect(idle).toContain('Your turn · ran <b>1d 2h</b></span>');
  const asks = cards.renderSessionStats({ state: { key: 'asks', word: 'Needs you' }, durationMs: 60_000 });
  expect(asks).toContain('state-move');
  expect(asks).toContain('Needs you');
  const ended = cards.renderSessionStats({ state: { key: 'ended', word: 'Ended' }, durationMs: 60_000 });
  expect(ended).toContain('Ended · ran');
  expect(ended).not.toContain('Done');
  // An idle session's done verdict takes the state word's place, as on the cards; Idle without one.
  const verdict = cards.renderSessionStats({ state: { key: 'idle', word: 'Idle' }, durationMs: 60_000, verdict: { tone: 'bad', word: 'Not done', why: 'Idle · not done: teammates still running' } });
  expect(verdict).toContain('<span class="stats-text"><span class="vchip v-bad" title="Idle · not done: teammates still running"><i></i>Not done</span> · ran <b>');
  expect(verdict).not.toContain('state-dot');
  expect(verdict).not.toContain('>Idle');
  expect(cards.renderSessionStats({ state: { key: 'idle', word: 'Idle' }, durationMs: 60_000, verdict: null })).toContain('Idle · ran');
  expect(cards.renderSessionStats({})).toBe('');
});

test('subagent rows show type, duration and tools up front; running first, older finished fold away', () => {
  const now = Date.now();
  const sub = (id: string, status: string, startedAtMs: number, endedAtMs?: number) => ({ id, agentType: 'general-purpose', description: 'Task ' + id, status, startedAtMs, endedAtMs, toolCount: 9, transcriptPath: '/t/' + id + '.jsonl' });
  const html = cards.renderSpawnedTeamCard({ subagents: [
    sub('a', 'done', now - 9e6, now - 8e6), sub('b', 'done', now - 7e6, now - 6e6), sub('c', 'done', now - 5e6, now - 4e6),
    sub('d', 'done', now - 3e6, now - 2e6), sub('r', 'running', now - 3 * 60_000),
  ] });
  expect(html.indexOf('Task r')).toBeLessThan(html.indexOf('Task d'));
  expect(html).toContain('<span class="sub-meta">general-purpose · running 3m · 9 tools</span>');
  expect(html).toContain('<span class="sub-meta">general-purpose · 16m · 9 tools</span>');
  // Three newest finished are shown; the oldest folds behind one line.
  expect(html).toContain('1 more finished</summary>');
  expect(html.indexOf('1 more finished')).toBeLessThan(html.indexOf('Task a'));
  expect(html).toContain('5 · 1 running');
});

test('a dragged range narrows the strip, the steps and the You list; a range outside the strip lapses', () => {
  for (const key of Object.keys(viewState)) delete viewState[key];
  const startMs = Date.parse('2026-10-06T22:00:00Z');
  const bucketMs = 10 * 60_000;
  // Two bursts with an idle hour between them: buckets 0-2 and 9-11.
  const buckets = Array.from({ length: 12 }, (_, i) => ({ tools: i < 3 || i > 8 ? 4 : 0, failed: 0, blocked: 0 }));
  const at = (bucket: number) => startMs + bucket * bucketMs + 60_000;
  const s = {
    fullSessionId: 'sess', sessionLocal: false,
    activityHistogram: { startMs, endMs: startMs + 12 * bucketMs, buckets, userAtMs: [at(0), at(10)] },
    userTurns: [{ atMs: at(0), text: 'first burst ask', images: 0 }, { atMs: at(10), text: 'second burst ask', images: 0 }],
    timeline: { steps: [
      { text: 'early work', at: new Date(at(1)).toISOString(), source: 'narration', tools: 3, failed: 0, blocked: 0 },
      { text: 'late work', at: new Date(at(11)).toISOString(), source: 'narration', tools: 3, failed: 0, blocked: 0 },
    ], earlier: { steps: 0, tools: 0, failed: 0 }, tools: 6, failed: 0, spanMs: 0, state: 'ready' },
  };
  const all = cards.renderTimelineCard(s);
  expect(all).toContain('early work');
  expect(all).toContain('late work');
  expect(all).not.toContain('seek-bar out');
  expect(all).toContain('drag across to filter');
  expect(all).toContain('data-bucket-ms="' + bucketMs + '"');

  // Any stretch inside the strip, not only a phase.
  viewState.timelineRange = { sess: [startMs + 9 * bucketMs, startMs + 12 * bucketMs] };
  const late = cards.renderTimelineCard(s);
  expect(late).toContain('late work');
  expect(late).not.toContain('early work');
  expect(late).toContain('seek-bar out');
  expect(late).toContain('data-phase="" title="Show the whole session">30m selected ×</button>');
  viewState.timelineFilter = { sess: 'user' };
  const you = cards.renderTimelineCard(s);
  expect(you).toContain('second burst ask');
  expect(you).not.toContain('first burst ask');

  // A range outside the strip, or the whole of it, lapses: nothing stays dimmed.
  viewState.timelineFilter = {};
  for (const r of [[startMs - 5, startMs - 1], [startMs, startMs + 12 * bucketMs], [startMs + 5, startMs + 5]]) {
    viewState.timelineRange = { sess: r };
    const lapsed = cards.renderTimelineCard(s);
    expect(lapsed).not.toContain('seek-bar out');
    expect(lapsed).not.toContain('selected ×');
  }
  // A step with no usable time cannot be placed, so a range never hides it.
  viewState.timelineRange = { sess: [startMs + 9 * bucketMs, startMs + 12 * bucketMs] };
  const undated = cards.renderTimelineCard({ ...s, timeline: { ...s.timeline, steps: [...s.timeline.steps, { text: 'undated step', at: '', source: 'narration', tools: 1, failed: 0, blocked: 0 }] } });
  expect(undated).toContain('undated step');
  for (const key of Object.keys(viewState)) delete viewState[key];
});

import { normalizePrStatus, prAction, prRepo, prVerdict } from '../core/prStatus';

const PR_URL = 'https://github.com/phnx-labs/agi-ext/pull/103';
const prRow = (extra: object = {}) => {
  const prStatus = normalizePrStatus({ url: PR_URL, number: 103, state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', checks: 'passing', ...extra });
  return { prStatus, prVerdict: prVerdict(prStatus!), prAction: prAction(prStatus), prRepo: prRepo(PR_URL) };
};

test('the PR in the ⋯ menu: its glyphs and at most one merge action, with the reason when there is none (PHNX-4289)', () => {
  {
    for (const key of Object.keys(viewState)) delete viewState[key];
    const menu = (row: object) => cards.renderTerminalCard({ fullSessionId: 's', hasTerminal: true, ...row });
    // No head commit on the row: no merge button, and the reason why.
    const today = menu(prRow());
    expect(today).toContain('menu-k">PR');
    expect(today).toContain('title="Review required" aria-label="Review required"');
    expect(today).toContain('title="No conflicts" aria-label="No conflicts"');
    expect(today).not.toContain('data-pr-action');
    expect(today).toContain('needs a newer agents CLI');
    const ready = menu(prRow({ headSha: '358a1fb', reviewDecision: 'APPROVED' }));
    expect(ready).toContain('class="action-btn primary" data-pr-action="merge">Merge<');
    expect(ready).toContain('title="Approved"');
    const green = menu(prRow({ headSha: '358a1fb', checks: 'pending' }));
    expect(green).toContain('data-pr-action="automerge"');
    expect(green).not.toContain('action-btn primary');
    const failing = menu(prRow({ headSha: '358a1fb', checks: 'failing', mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' }));
    expect(failing).not.toContain('data-pr-action');
    expect(failing).toContain('class="pr-glyph bad" role="img" title="Changes requested"');
    expect(failing).toContain('class="pr-glyph bad" role="img" title="Has conflicts"');
    expect(menu({})).not.toContain('menu-k">PR');
    // The tile's words for a PR still checking.
    const tile = cards.renderMadeShelf(prRow({ headSha: '358a1fb', checks: 'pending', checkItems: [{ name: 'test', state: 'passed' }, { name: 'e2e', state: 'running' }] }));
    expect(tile).toContain('>Checks running<');
    expect(tile).toContain('title="1 of 2 checks passed, 1 running"');
    expect(tile).toContain('<span class="pr-frac pr-tone-warn">1/2</span>');
  }
  {
    const pr = (extra: object = {}) => normalizePrStatus({ url: PR_URL, number: 103, state: 'OPEN', isDraft: false, ...extra });
    // One segment per check, greens first, skipped out of the fraction.
    const bar = cards.prCheckSegments(pr({ checkItems: [
      { name: 'e2e', state: 'failed' }, { name: 'docs', state: 'skipped' }, { name: 'test', state: 'passed' },
      { name: 'lint', state: 'running' }, { name: 'types', state: 'passed' },
    ] }));
    expect(bar.segments.map((x) => x.name)).toEqual(['test', 'types', 'lint', 'e2e', 'docs']);
    expect([bar.passed, bar.running, bar.failed, bar.counted]).toEqual([2, 1, 1, 4]);
    // Only the rolled-up verdict on the row: one segment for it, no fraction.
    const rolled = cards.prCheckSegments(pr({ checks: 'pending' }));
    expect(rolled.segments).toEqual([{ state: 'running', name: 'checks pending' }]);
    expect(rolled.counted).toBe(0);
    expect(cards.prCheckSegments(pr()).segments).toEqual([]);

  }
});

test('a conflicting PR with green checks reads Conflicts on the Project panel card and in the sidebar alike', async () => {
  const { renderSessionCard, sessionPlace } = await import('../core/projectPanel');
  const row = prRow({ checks: 'passing', mergeable: 'CONFLICTING', reviewDecision: 'APPROVED', headSha: '358a1fb' });
  const here = { device: 'zion', localHost: 'this-mac', workspace: 'agents', editor: 'vscodium' as const, editorName: 'VSCodium', icons: {} };
  const s = { sessionId: 's', host: 'this-mac', title: 'T', label: '', topic: '', phase: 'idle' as const, liveStatus: 'idle', lastResponse: '', activity: '', ticket: null, lastActivityMs: 0, confirmedProject: 'agi', prStatus: row.prStatus };
  const card = renderSessionCard(s, sessionPlace(s, here), 0, { selected: false, pinned: false, here, thumbs: [], made: null });
  expect(card).toContain('class="chip pr-bad" title="PR #103: Conflicts"');
  expect(cards.renderMadeShelf(row)).toContain('<span class="mk-st pr-tone-bad">Conflicts</span>');
});

test('a merge runs one pinned CLI verb, only after the modal confirms and only if the host still agrees', async () => {
  const method = (name: string) => {
    const start = SRC.indexOf('  private async ' + name + '(');
    const end = SRC.indexOf('\n  private ', start + 1);
    return SRC.slice(start, end).replace('private async ', 'async ');
  };
  const calls: string[] = [];
  const asked: unknown[][] = [];
  let answer: string | undefined = 'Merge';
  const vscode = vscodeDouble({
    window: {
      showWarningMessage: async (...args: unknown[]) => { asked.push(args); return args.length > 2 ? answer : undefined; },
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
  });
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync('class Host { snapshot = {}; prActionBusy = false; ' + method('runPrAction') + method('decideAndRunPrAction') + '}');
  const host = new Function('vscode', 'runAgents', 'shellQuote', 'prAction', 'prRepo', code + '; return new Host();')(
    vscode, async (args: string) => { calls.push(args); return { stdout: '', stderr: '' }; }, (v: string) => "'" + v + "'", prAction, prRepo);

  host.snapshot = { project: 'agi-ui', ...prRow({ headSha: '358a1fbc2e', title: 'Compact header' }) };
  answer = undefined;               // dismissed modal: nothing runs
  await host.runPrAction('merge');
  expect(calls).toEqual([]);
  answer = 'Merge';
  await host.runPrAction('merge');
  expect(calls).toEqual(["projects prs merge 'agi-ui' --repo 'phnx-labs/agi-ext' --number 103 --sha '358a1fbc2e'"]);
  expect(asked.at(-1)?.[1]).toEqual({ modal: true });
  expect(String(asked.at(-1)?.[0])).toContain('at 358a1fb?');

  // The webview asked for a merge the host no longer allows (checks now failing): refused, nothing runs.
  host.snapshot = { project: 'agi-ui', ...prRow({ headSha: '358a1fbc2e', checks: 'failing' }) };
  await host.runPrAction('merge');
  expect(calls).toHaveLength(1);
  expect(String(asked.at(-1)?.[0])).toContain('a check failed');
  // Asking for auto-merge on a ready PR is not the decided action either.
  host.snapshot = { project: 'agi-ui', ...prRow({ headSha: '358a1fbc2e' }) };
  await host.runPrAction('automerge');
  expect(calls).toHaveLength(1);
  // Auto-merge when checks are running, confirmed: one pinned verb, never --admin.
  host.snapshot = { project: 'agi-ui', ...prRow({ headSha: '358a1fbc2e', checks: 'pending' }) };
  answer = 'Turn on auto-merge';
  await host.runPrAction('automerge');
  expect(calls.at(-1)).toBe("projects prs automerge 'agi-ui' --repo 'phnx-labs/agi-ext' --number 103 --sha '358a1fbc2e'");
  expect(calls.join(' ')).not.toContain('--admin');

  // The row moves while the dialog is open (a check goes red): confirming does nothing.
  const before = calls.length;
  host.snapshot = { project: 'agi-ui', ...prRow({ headSha: '358a1fbc2e' }) };
  vscode.window.showWarningMessage = async (...args: unknown[]) => {
    asked.push(args);
    if (args.length > 2) host.snapshot = { project: 'agi-ui', ...prRow({ headSha: '358a1fbc2e', checks: 'failing' }) };
    return args.length > 2 ? 'Merge' : undefined;
  };
  await host.runPrAction('merge');
  expect(calls).toHaveLength(before);
  expect(String(asked.at(-1)?.[0])).toContain('changed while the dialog was open (a check failed)');
  // A new commit lands while the dialog is open: same, nothing runs.
  host.snapshot = { project: 'agi-ui', ...prRow({ headSha: '358a1fbc2e' }) };
  vscode.window.showWarningMessage = async (...args: unknown[]) => {
    asked.push(args);
    if (args.length > 2) host.snapshot = { project: 'agi-ui', ...prRow({ headSha: 'aaaaaaaaaa' }) };
    return args.length > 2 ? 'Merge' : undefined;
  };
  await host.runPrAction('merge');
  expect(calls).toHaveLength(before);

  // A second click while the first dialog is open is ignored: one dialog, one merge.
  host.snapshot = { project: 'agi-ui', ...prRow({ headSha: '358a1fbc2e' }) };
  let release: (v: string) => void = () => {};
  let dialogs = 0;
  vscode.window.showWarningMessage = (...args: unknown[]) => { if (args.length > 2) dialogs++; return new Promise((r) => { release = r as (v: string) => void; }); };
  const first = host.runPrAction('merge');
  await host.runPrAction('merge');
  release('Merge');
  await first;
  expect(dialogs).toBe(1);
  expect(calls).toHaveLength(before + 1);
});

test('an opened subagent shows its model, what it was asked, and its result', () => {
  const html = cards.renderSpawnedTeamCard({ subagents: [{ id: 'a', agentType: 'code-reviewer', model: 'claude-sonnet-5-5', prompt: 'Review PR #103 for stubs', description: 'Review PR 103', status: 'done', startedAtMs: 1, endedAtMs: 60_001, toolCount: 13, resultExcerpt: 'NO BLOCKING FINDINGS', transcriptPath: '/t/a.jsonl' }] });
  expect(html).toContain('code-reviewer · Sonnet 5.5 · 1m · 13 tools');
  expect(html).toContain('<div class="sub-label">Asked</div><div class="sub-asked">Review PR #103 for stubs</div>');
  expect(html).toContain('<div class="sub-label">Result</div><div class="sub-result">NO BLOCKING FINDINGS</div>');
  // An older row without model or prompt shows exactly what it has.
  const older = cards.renderSpawnedTeamCard({ subagents: [{ id: 'b', agentType: 'Explore', description: 'Find it', status: 'done', toolCount: 2, transcriptPath: '/t/b.jsonl' }] });
  expect(older).not.toContain('Asked');
});

test('with a range set, the loaded tool calls draw as a zoomed lane over that stretch', () => {
  for (const key of Object.keys(viewState)) delete viewState[key];
  const startMs = Date.parse('2026-10-06T22:00:00Z');
  const bucketMs = 10 * 60_000;
  const buckets = Array.from({ length: 12 }, (_, i) => ({ tools: i < 3 || i > 8 ? 4 : 0, failed: 0, blocked: 0 }));
  const s = {
    fullSessionId: 'lane', sessionLocal: true,
    activityHistogram: { startMs, endMs: startMs + 12 * bucketMs, buckets, userAtMs: [] },
    userTurns: [{ atMs: startMs + 9 * bucketMs + 30_000, text: 'late ask', images: 0 }],
    timeline: { steps: [{ text: 'late work', at: new Date(startMs + 10 * bucketMs).toISOString(), source: 'narration', tools: 3, failed: 0, blocked: 0 }], earlier: { steps: 0, tools: 0, failed: 0 }, tools: 3, failed: 0, spanMs: 0, state: 'ready' },
  };
  viewState.timelineRange = { lane: [startMs + 9 * bucketMs, startMs + 12 * bucketMs] };
  // Summary with a range: one explicit click away from the calls, for a local session.
  expect(cards.renderTimelineCard(s)).toContain('data-filter="tools">Show tool calls</button>');
  expect(cards.renderTimelineCard({ ...s, sessionLocal: false })).not.toContain('Show tool calls');
  // The calls loaded: ticks inside the range only, failed in red, your turn marked.
  const range = [startMs + 9 * bucketMs, startMs + 12 * bucketMs];
  const items = [
    { at: new Date(startMs + 9 * bucketMs + 60_000).toISOString(), text: 'Bash: bun test', bad: false },
    { at: new Date(startMs + 10 * bucketMs).toISOString(), text: 'Bash: bun test', bad: true },
    { at: new Date(startMs + 60_000).toISOString(), text: 'Read: early.ts', bad: false },
  ];
  const html = eval(`(function(){ const viewState = { timelineFilter: { lane: 'tools' }, timelineRange: { lane: ${JSON.stringify(range)} } }; const lastSnapshot = {}; ${combined}
    requestTimelineFilter('lane', 'tools');
    applyTimelineFilter({ sessionId: 'lane', role: 'tools', items: ${JSON.stringify(items)} }, ${JSON.stringify(s)});
    return renderTimelineCard(${JSON.stringify(s)});
  })()`) as string;
  expect((html.match(/class="lane-tick/g) || []).length).toBe(2);
  expect(html).toContain('class="lane-tick bad"');
  expect(html).toContain('2 calls');
  // Thousands of calls in one stretch collapse to at most one tick per lane bin.
  const many = Array.from({ length: 5000 }, (_, i) => ({ at: new Date(range[0] + i * 300).toISOString(), text: 'Read: f' + i, bad: i === 4321 }));
  const dense = eval(`(function(){ const viewState = { timelineFilter: { lane: 'tools' }, timelineRange: { lane: ${JSON.stringify(range)} } }; const lastSnapshot = {}; ${combined}
    requestTimelineFilter('lane', 'tools');
    applyTimelineFilter({ sessionId: 'lane', role: 'tools', items: ${JSON.stringify(many)} }, ${JSON.stringify(s)});
    return renderTimelineCard(${JSON.stringify(s)});
  })()`) as string;
  const lane = dense.slice(dense.indexOf('class="range-lane"'), dense.indexOf('class="tl-item'));
  expect((lane.match(/class="lane-tick/g) || []).length).toBeLessThanOrEqual(200);
  expect(lane).toContain('class="lane-tick bad"');
  expect(lane).toContain('5000 calls');
  expect(html).toContain('title="turn 1 · late ask">1</span>');
  expect(html).not.toContain('early.ts');
  for (const key of Object.keys(viewState)) delete viewState[key];
});

test('Related: one line of chips with each session state dot and why in the tooltip; nothing when there are none', () => {
  const html = cards.renderRelated({ related: [
    { sessionId: 'a1', host: 'yosemite-m6', title: 'Codex sign-in accounts', state: 'asks', why: 'same ticket PHNX-4338' },
    { sessionId: 'b2', host: 'zion', title: 'Launch gate: OpenCode harness', state: 'working', why: 'similar request' },
  ] });
  expect(html).toContain('<span class="rel-l">Related</span>');
  expect(html).toContain('data-strip="related"');
  expect(html).toContain('class="rel-c state-move" data-related="a1" data-related-host="yosemite-m6" title="Codex sign-in accounts · same ticket PHNX-4338"');
  expect(html).toContain('class="rel-c state-running" data-related="b2"');
  expect(cards.renderRelated({ related: [] })).toBe('');
  expect(cards.renderRelated({})).toBe('');
});

test('blocked: the agent own words in a red strip, and its status posts sit among the steps in All and under Updates', () => {
  const at = Date.parse('2026-10-12T11:00:00Z');
  const blocked = { atMs: at, title: '1.22.48 publish blocked', detail: 'npm token 401 on mac-mini. Need npm login.', blocked: true, links: [] };
  const strip = cards.renderBlocked({ blocked, hasTerminal: true });
  expect(strip).toContain('class="blocked-strip"');
  expect(strip).toContain('1.22.48 publish blocked');
  expect(strip).toContain('id="blocked-reply"');
  expect(cards.renderBlocked({})).toBe('');
  const posted = { atMs: at - 3_600_000, title: 'Prototype v2 ready', detail: 'Chips + Other.', blocked: false, links: [{ name: 'index.html', href: '/u/a/index.html' }] };
  const s = { ...snapshotFor('c9d700d5'), updates: [posted, blocked] };
  const all = cards.renderTimelineCard(s);
  expect(all).toContain('data-filter="updates"');
  expect(all).toContain('<b>1.22.48 publish blocked</b>');
  for (const key of Object.keys(viewState)) delete viewState[key];
  viewState.timelineFilter = { [s.fullSessionId as string]: 'updates' };
  const only = cards.renderTimelineCard(s);
  expect(only).toContain('class="upd blocked"');
  expect(only).toContain('data-path="/u/a/index.html">index.html</a>');
  for (const key of Object.keys(viewState)) delete viewState[key];
});

test('the agent\'s newest feed post sits under the title, gold; a blocked post keeps its red strip instead', () => {
  const now = Date.now();
  const updates = [
    { atMs: now - 3_600_000, title: 'Older post', detail: '', blocked: false, links: [] },
    { atMs: now - 60_000, title: 'Self sign-up is built across three green PRs', detail: 'Merge phoenix-id#16, agents#4245 and agents#4244, then I release.', blocked: false, links: [] },
    { atMs: now - 30_000, title: 'Waiting on the npm token', detail: '', blocked: true, links: [] },
  ];
  const html = cards.renderLatestUpdate({ updates });
  expect(html).toContain('<div class="latest-k">FROM THE AGENT · ');
  expect(html).toContain('<div class="latest-t">Self sign-up is built across three green PRs</div>');
  expect(html).toContain('Merge phoenix-id#16, agents#4245 and agents#4244, then I release.');
  expect(html).not.toContain('Older post');
  expect(html).not.toContain('npm token');
  expect(cards.renderLatestUpdate({})).toBe('');
});

test('a Made tile for a rendered page names the source it came from', () => {
  const html = cards.renderMadeShelf({ artifacts: [{ path: '/h/p/plan.html', display: '~/p/plan.html', basename: 'plan.html', bucket: 'plans', renderedFrom: 'plan.md' }] });
  expect(html).toContain('<span class="mk-n">plan.html</span><span class="mk-m">html · from plan.md</span>');
});
