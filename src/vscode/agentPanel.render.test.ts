import { test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// The Goal / Progress / Checklist cards (PHNX-3939) are pure string-builders that
// live inside the webview's inline <script>, so they can't be imported. Extract
// their source by name (brace-matching) and eval it — the same technique the
// webview-syntax test uses — then exercise them with stub snapshots that stand in
// for the CLI-projected stream row. None of these functions use `${}` or backslash
// escapes, so the raw substring evaluates identically to the runtime template.
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

const NAMES = ['esc', 'truncate', 'relTime', 'renderGoalCard', 'renderCheckpointsCard', 'renderChecklistCard'];
const combined = NAMES.map(extractFn).join('\n');
const cards = eval(`(function(){ ${combined}\n return { renderGoalCard, renderCheckpointsCard, renderChecklistCard }; })()`) as {
  renderGoalCard: (s: unknown) => string;
  renderCheckpointsCard: (s: unknown) => string;
  renderChecklistCard: (s: unknown) => string;
};

test('renderGoalCard shows the ◈ goal, empty when absent (PHNX-3939)', () => {
  const html = cards.renderGoalCard({ goal: 'Ship the sidebar Goal + Progress cards' });
  expect(html).toContain('Goal');
  expect(html).toContain('◈');
  expect(html).toContain('Ship the sidebar Goal + Progress cards');

  expect(cards.renderGoalCard({ goal: '' })).toBe('');
  expect(cards.renderGoalCard({})).toBe('');
});

test('renderCheckpointsCard lists progress newest-first, empty when none (PHNX-3939)', () => {
  const html = cards.renderCheckpointsCard({
    checkpoints: [
      { text: 'Scoped the field contract', at: '2026-09-05T10:00:00Z' },
      { text: 'Wired the render layer', at: '2026-09-05T10:20:00Z' },
    ],
  });
  expect(html).toContain('Progress');
  expect(html).toContain('Scoped the field contract');
  expect(html).toContain('Wired the render layer');
  // Newest-first: the later checkpoint renders before the earlier one.
  expect(html.indexOf('Wired the render layer')).toBeLessThan(html.indexOf('Scoped the field contract'));

  expect(cards.renderCheckpointsCard({ checkpoints: [] })).toBe('');
  expect(cards.renderCheckpointsCard({})).toBe('');
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
