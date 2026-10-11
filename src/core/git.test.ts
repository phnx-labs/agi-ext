import { describe, expect, test } from 'bun:test';
import {
  buildCommitPrompt,
  detectDirectoryMoves,
  formatChangeStatus,
  parseIgnorePatterns,
  prepareCommitContext,
  shouldIgnoreFile,
  summarizeDiff
} from './git';

const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
-const old = 0;
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1,2 @@
+export const x = 1;`;

describe('ignore patterns', () => {
  test('parseIgnorePatterns splits on commas, trimming and dropping empties', () => {
    expect(parseIgnorePatterns('')).toEqual([]);
    expect(parseIgnorePatterns('  node_modules  ,,dist,')).toEqual(['node_modules', 'dist']);
  });

  test('shouldIgnoreFile matches *.ext patterns by suffix and directory names by segment', () => {
    const patterns = ['node_modules', '*.lock', 'dist'];
    expect(shouldIgnoreFile('/node_modules/pkg/index.js', patterns)).toBe(true);
    expect(shouldIgnoreFile('/bun.lock', patterns)).toBe(true);
    expect(shouldIgnoreFile('/dist/out.js', patterns)).toBe(true);
    expect(shouldIgnoreFile('/src/main.ts', patterns)).toBe(false);
    expect(shouldIgnoreFile('/package-lock.json', patterns)).toBe(false);
  });
});

test('formatChangeStatus names the staging side and the change kind', () => {
  expect(formatChangeStatus(7, true)).toBe('Staged New');
  expect(formatChangeStatus(5, false)).toBe('Unstaged Modified');
  expect(formatChangeStatus(6, true)).toBe('Staged Deleted');
  expect(formatChangeStatus(99, false)).toBe('Unstaged Changed');
});

describe('detectDirectoryMoves', () => {
  const files = ['bun.lock', 'package.json', 'src/agents.ts', 'src/api.ts', 'src/file_ops.ts', 'tsconfig.json'];

  test('detects a directory flattened into its parent, at any depth', () => {
    expect(detectDirectoryMoves(files.map((f) => `cli-ts/${f}`), files)).toMatchObject({ fromPrefix: 'cli-ts/', toPrefix: '', fileCount: 6, dirName: 'cli-ts' });
    expect(detectDirectoryMoves(files.map((f) => `swarm/cli-ts/${f}`), files.map((f) => `swarm/${f}`)))
      .toMatchObject({ fromPrefix: 'swarm/cli-ts/', toPrefix: 'swarm/', fileCount: 6 });
  });

  test('returns null below the file threshold, when names differ, or when the match is partial', () => {
    expect(detectDirectoryMoves(['cli-ts/a.ts', 'cli-ts/b.ts'], ['a.ts', 'b.ts'])).toBeNull();
    expect(detectDirectoryMoves([], [])).toBeNull();
    const deleted = files.map((f) => `cli-ts/${f}`);
    expect(detectDirectoryMoves(deleted, files.map((f) => `other-${f}`))).toBeNull();
    expect(detectDirectoryMoves(deleted, [...files.slice(0, 3), 'x.ts', 'y.ts', 'z.ts'], 5)).toBeNull();
  });
});

describe('buildCommitPrompt', () => {
  test('forbids tool use, states the format, then status, diff and style examples in that order', () => {
    const prompt = buildCommitPrompt('Staged Modified: src/auth.ts', '+export function login() {}', ['feat: add authentication']);
    expect(prompt).toMatch(/^Write ONE conventional-commit message/);
    for (const rule of ['Respond IMMEDIATELY', 'do NOT use tools', 'Format: <type>: <description>', 'Single line, under 72 characters', 'No body, no trailers, no Co-Authored-By']) {
      expect(prompt).toContain(rule);
    }
    expect(prompt).toContain('- feat: add authentication');
    expect(prompt.indexOf('Format:')).toBeLessThan(prompt.indexOf('Git status:'));
    expect(prompt.indexOf('Git status:')).toBeLessThan(prompt.indexOf('Diff preview:'));
    expect(prompt.indexOf('Diff preview:')).toBeLessThan(prompt.indexOf('Style examples'));
  });

  test('leaves out the diff and examples sections when there are none', () => {
    const prompt = buildCommitPrompt('Modified: file.ts', '', []);
    expect(prompt).not.toContain('Diff preview:');
    expect(prompt).not.toContain('Style examples');
  });
});

test('summarizeDiff names each file with its changed-line count and a preview', () => {
  expect(summarizeDiff('')).toBe('');
  const summary = summarizeDiff(DIFF);
  expect(summary).toContain('File: a.ts');
  expect(summary).toContain('File: b.ts');
  expect(summary).toContain('lines changed');
  expect(summary).toContain('+export const x = 1;');
});

describe('prepareCommitContext', () => {
  test('carries the status, a diff summary and the user prompt', () => {
    const result = prepareCommitContext('Modified: src/index.ts\nNew: src/utils.ts', [], [], DIFF);
    expect(result.isMove).toBe(false);
    expect(result.context).toContain('New: src/utils.ts');
    expect(result.context).toContain('Diff Summary:');
    expect(result.userPrompt).toContain('generate a concise commit message');
  });

  test('truncates a long status list and reports a directory move', () => {
    const many = Array.from({ length: 150 }, (_, i) => `Modified: file${i}.ts`).join('\n');
    expect(prepareCommitContext(many, [], []).context).toContain('and 50 more files');
    const deleted = Array.from({ length: 10 }, (_, i) => `old/dir/file${i}.ts`);
    const moved = prepareCommitContext('status', deleted, deleted.map((p) => p.replace('old/dir/', '')));
    expect(moved.isMove).toBe(true);
    expect(moved.context).toContain('Move detected:');
  });
});
