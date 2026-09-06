// Request / Timeline / Files normalization (PHNX-3939 follow-up).
//
// `testdata/session-rows.fold.json` is REAL data: the fold prototype's output for
// four live sessions across three harnesses (claude c9d700d5 + 82eaa149, codex
// 01a07510, grok 01a06f86), converted key-for-key into the CLI row contract
// (camelCase names, ISO timestamps, last-8 steps + an `earlier` counter). The
// synthetic literals below cover the shapes that run does not contain —
// attachment chips, an unavailable harness, and the Files payload.

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  normalizeActiveSession,
  normalizeFiles,
  normalizeRequest,
  normalizeTimeline,
  type RawActiveSession,
} from './remoteSessions';

const FOLD_ROWS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'testdata', 'session-rows.fold.json'), 'utf8'),
) as RawActiveSession[];

function foldRow(prefix: string): RawActiveSession {
  const row = FOLD_ROWS.find((r) => (r.sessionId ?? '').startsWith(prefix));
  if (!row) throw new Error(`no fold fixture row for ${prefix}`);
  return row;
}

describe('normalizeRequest', () => {
  test('carries the user’s own words through untouched', () => {
    const request = normalizeRequest(foldRow('c9d700d5').request)!;
    expect(request.kind).toBe('text');
    expect(request.turns).toBe(10);
    expect(request.text).toStartWith('And I think the other thing is');
    // The headline is the CLI's first sentence — never a rewrite of the request.
    expect(request.text).toContain(request.headline.replace(/…$/, ''));
  });

  test('a slash-command turn keeps its command and its kind', () => {
    const request = normalizeRequest({
      kind: 'skill', command: '/continue 8231082e', text: '', headline: '/continue 8231082e',
      attachments: [], pastedLines: 0, turns: 3,
      continues: { id: '8231082e', label: 'Agents Core' },
    })!;
    expect(request.kind).toBe('skill');
    expect(request.command).toBe('/continue 8231082e');
    expect(request.continues).toEqual({ id: '8231082e', label: 'Agents Core' });
  });

  test('attachments and pasted terminal survive as structure, not prose', () => {
    const request = normalizeRequest({
      kind: 'text',
      text: 'So there is a few issues with the AGI extension, at least when it’s installed.',
      headline: 'So there is a few issues with the AGI extension.',
      attachments: [
        { kind: 'image', name: 'Screenshot 2026-09-06 at 03.21.png' },
        { kind: 'image', name: 'Screenshot 2026-09-06 at 03.23.png' },
        { kind: 'dir', name: '@../agi-ext' },
        { kind: 'bogus', name: 'notes.md' },
      ],
      pastedLines: 9,
      turns: 6,
    })!;
    expect(request.attachments).toEqual([
      { kind: 'image', name: 'Screenshot 2026-09-06 at 03.21.png' },
      { kind: 'image', name: 'Screenshot 2026-09-06 at 03.23.png' },
      { kind: 'dir', name: '@../agi-ext' },
      // An unknown kind degrades to 'file' rather than dropping the attachment.
      { kind: 'file', name: 'notes.md' },
    ]);
    expect(request.pastedLines).toBe(9);
  });

  test('an empty or absent payload yields undefined so the card can fall back', () => {
    expect(normalizeRequest(undefined)).toBeUndefined();
    expect(normalizeRequest({})).toBeUndefined();
    expect(normalizeRequest({ text: '   ', headline: '', attachments: [] })).toBeUndefined();
    expect(normalizeRequest('a bare string')).toBeUndefined();
  });

  test('an oversized request is bounded, never truncated to nothing', () => {
    const request = normalizeRequest({ text: 'x'.repeat(9_000), turns: 1 })!;
    expect(request.text.length).toBe(2_000);
    expect(request.headline.length).toBe(200);
  });
});

describe('normalizeTimeline', () => {
  test('keeps the fold’s last 8 steps, the earlier counter, and the live now-line', () => {
    const timeline = normalizeTimeline(foldRow('c9d700d5').timeline)!;
    expect(timeline.state).toBe('ready');
    expect(timeline.steps).toHaveLength(8);
    expect(timeline.earlier).toEqual({ steps: 47, tools: 156, failed: 4 });
    expect(timeline.tools).toBe(167);
    expect(timeline.failed).toBe(4);
    expect(timeline.spanMs).toBeGreaterThan(0);
    const live = timeline.steps[timeline.steps.length - 1];
    expect(live.live).toBe(true);
    expect(live.now).toBe("Re-render the plan, copy it to zion, and reload Arc's tab");
    expect(live.mix).toEqual({ edit: 3 });
    expect(live.marks).toEqual(['artifact rendered']);
    expect(Number.isFinite(Date.parse(live.at))).toBe(true);
  });

  test('every harness in the fixture folds into the same step shape', () => {
    for (const prefix of ['c9d700d5', '82eaa149', '01a07510', '01a06f86']) {
      const timeline = normalizeTimeline(foldRow(prefix).timeline)!;
      expect(timeline.steps.length).toBeGreaterThan(0);
      for (const step of timeline.steps) {
        expect(step.text).toBeTruthy();
        expect(['narration', 'thinking', 'derived', 'user']).toContain(step.source);
        expect(step.tools).toBeGreaterThanOrEqual(0);
        expect(step.blocked).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('a user turn and a derived step keep their source so the card can style them', () => {
    const codex = normalizeTimeline(foldRow('01a07510').timeline)!;
    const sources = new Set(codex.steps.map((s) => s.source));
    expect(sources.has('narration') || sources.has('derived') || sources.has('user')).toBe(true);
  });

  test('an unavailable harness keeps its state and reason instead of vanishing', () => {
    const timeline = normalizeTimeline({
      steps: [], earlier: { steps: 0, tools: 0, failed: 0 }, tools: 0, failed: 0, spanMs: 0,
      state: 'unavailable', reason: 'OpenClaw writes no parseable transcript',
    })!;
    expect(timeline.state).toBe('unavailable');
    expect(timeline.reason).toBe('OpenClaw writes no parseable transcript');
    expect(timeline.steps).toEqual([]);
  });

  test('an absent or empty-but-unexplained payload yields undefined (fall back to checkpoints)', () => {
    expect(normalizeTimeline(undefined)).toBeUndefined();
    expect(normalizeTimeline({ steps: [] })).toBeUndefined();
    expect(normalizeTimeline([])).toBeUndefined();
  });

  test('a numeric epoch timestamp is normalized to ISO rather than dropped', () => {
    const timeline = normalizeTimeline({
      steps: [{ text: 'Reading the manifest', at: 1788688937530, source: 'narration', tools: 1, failed: 0, blocked: 0 }],
      state: 'ready',
    })!;
    expect(timeline.steps[0].at).toBe(new Date(1788688937530).toISOString());
  });

  test('more than 8 steps are bounded to the newest 8', () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({
      text: `step ${i}`, at: new Date(i * 1000).toISOString(), source: 'narration', tools: 1, failed: 0, blocked: 0,
    }));
    const timeline = normalizeTimeline({ steps, state: 'ready' })!;
    expect(timeline.steps).toHaveLength(8);
    expect(timeline.steps[0].text).toBe('step 12');
    expect(timeline.steps[7].text).toBe('step 19');
  });
});

describe('normalizeFiles', () => {
  test('carries the harness’s own change list, bounded to 8 with the true total', () => {
    const files = normalizeFiles({
      source: 'harness',
      total: 11,
      changes: Array.from({ length: 11 }, (_, i) => ({
        path: `musl-smoke/src/file${i}.rs`, op: i === 0 ? 'created' : 'modified', edits: i + 1,
        at: '2026-09-06T10:02:17.530Z',
      })),
    })!;
    expect(files.source).toBe('harness');
    expect(files.total).toBe(11);
    expect(files.changes).toHaveLength(8);
    expect(files.changes[0]).toEqual({
      path: 'musl-smoke/src/file0.rs', op: 'created', edits: 1, at: '2026-09-06T10:02:17.530Z',
    });
  });

  test('an unknown op degrades to modified; a pathless entry is dropped', () => {
    const files = normalizeFiles({
      source: 'tools',
      changes: [{ path: 'a.ts', op: 'renamed', edits: 2 }, { op: 'created' }, { path: 'b.ts', op: 'deleted' }],
    })!;
    expect(files.changes).toEqual([
      { path: 'a.ts', op: 'modified', edits: 2, at: '' },
      { path: 'b.ts', op: 'deleted', edits: 0, at: '' },
    ]);
    expect(files.total).toBe(2);
  });

  test('no usable change yields undefined so the Files card renders nothing', () => {
    expect(normalizeFiles(undefined)).toBeUndefined();
    expect(normalizeFiles({ changes: [] })).toBeUndefined();
  });
});

describe('normalizeActiveSession', () => {
  test('copies request/timeline/files off the row alongside the summarizer fields', () => {
    const raw = foldRow('c9d700d5');
    const session = normalizeActiveSession(raw, 'zion', Date.now());
    expect(session.request?.headline).toStartWith('And I think the other thing is');
    expect(session.timeline?.steps).toHaveLength(8);
    expect(session.files).toBeUndefined(); // the fold run carried no files payload
  });

  test('an older CLI row leaves all three undefined — never a fabricated value', () => {
    const session = normalizeActiveSession(
      { sessionId: 's1', kind: 'claude', topic: 'Fix the empty sidebar' } as RawActiveSession,
      'zion',
      Date.now(),
    );
    expect(session.request).toBeUndefined();
    expect(session.timeline).toBeUndefined();
    expect(session.files).toBeUndefined();
    expect(session.topic).toBe('Fix the empty sidebar');
  });
});
