import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  mapStatusToPhase,
  normalizeHost,
  resolveSessionHost,
  resolveProject,
  normalizeActiveSession,
  normalizeQuestion,
  dialablePeerScopes,
  isDerivedSessionName,
  type RemoteSession,
  type RawActiveSession,
} from './remoteSessions';

const TESTDATA = path.join(__dirname, 'testdata');
const ACTIVE = JSON.parse(
  fs.readFileSync(path.join(TESTDATA, 'active-sessions.json'), 'utf-8')
) as RawActiveSession[];

// Fixed fetch clock so sinceMs assertions are deterministic. Chosen just after
// the newest startedAtMs in the fixture.
const FETCHED_AT = 1782865920000;

describe('normalizeHost', () => {
  test('collapses FQDN, case, and separators to the agents-cli device label', () => {
    // Matches an `agents devices` registry name for the local machine so the
    // HOSTS sidebar folds this-mac into it instead of double-listing.
    expect(normalizeHost('zion')).toBe('zion');
    expect(normalizeHost('zion.local')).toBe('zion');
    expect(normalizeHost('ZION')).toBe('zion');
    expect(normalizeHost('zion.tail1a85a1.ts.net')).toBe('zion');
    expect(normalizeHost("Muqsit's Mac mini")).toBe('muqsit-s-mac-mini');
    expect(normalizeHost('')).toBe('');
  });
});

describe('resolveSessionHost', () => {
  // This is the fix for the "all sessions attributed to the local machine" bug: a
  // Stream rows already carry their authoritative source machine, so we must
  // bucket each row by ITS OWN `machine` id, not the host we queried.
  const LOCAL_ID = 'zion';
  const LOCAL_LABEL = 'this-mac';

  test('a remote row buckets under its own machine, not the querying host', () => {
    expect(resolveSessionHost('yosemite-s0', LOCAL_LABEL, LOCAL_ID, LOCAL_LABEL)).toBe('yosemite-s0');
    expect(resolveSessionHost('yosemite-s1', LOCAL_LABEL, LOCAL_ID, LOCAL_LABEL)).toBe('yosemite-s1');
  });

  test("this machine's own rows fold to the local label so this-mac routing works", () => {
    expect(resolveSessionHost('zion', LOCAL_LABEL, LOCAL_ID, LOCAL_LABEL)).toBe('this-mac');
    // FQDN / case variants normalize to the same id before the local-fold check.
    expect(resolveSessionHost('ZION.tail1a85a1.ts.net', LOCAL_LABEL, LOCAL_ID, LOCAL_LABEL)).toBe('this-mac');
  });

  test('a machine-less row (cloud) falls back to the querying host', () => {
    expect(resolveSessionHost(undefined, LOCAL_LABEL, LOCAL_ID, LOCAL_LABEL)).toBe('this-mac');
    expect(resolveSessionHost('', 'yosemite-s0', LOCAL_ID, LOCAL_LABEL)).toBe('yosemite-s0');
  });

  test('a whole mixed-fleet payload splits across the correct buckets', () => {
    const rows = ['zion', 'zion', 'yosemite-s0', 'yosemite-s0', 'yosemite-s1', undefined];
    const buckets = rows.map((m) => resolveSessionHost(m, LOCAL_LABEL, LOCAL_ID, LOCAL_LABEL));
    const count: Record<string, number> = {};
    for (const b of buckets) count[b] = (count[b] || 0) + 1;
    // zion x2 + the machine-less cloud row fold to this-mac; remotes stay split.
    expect(count).toEqual({ 'this-mac': 3, 'yosemite-s0': 2, 'yosemite-s1': 1 });
  });
});

describe('mapStatusToPhase', () => {
  test('maps the real CLI status values', () => {
    expect(mapStatusToPhase('running')).toBe('running');
    expect(mapStatusToPhase('queued')).toBe('running');
    expect(mapStatusToPhase('input_required')).toBe('waiting');
    expect(mapStatusToPhase('failed')).toBe('failed');
    expect(mapStatusToPhase('completed')).toBe('done');
    expect(mapStatusToPhase('idle')).toBe('idle');
    expect(mapStatusToPhase(undefined)).toBe('idle');
    expect(mapStatusToPhase('nonsense')).toBe('idle');
  });

  test('the computed lifecycle statuses (RUSH-2066): closed -> done, abandoned -> failed', () => {
    // A dead process has exited cleanly; a days-stale/dangling one needs attention.
    // Without these cases both would silently fall through to `idle` on the Floor.
    expect(mapStatusToPhase('closed')).toBe('done');
    expect(mapStatusToPhase('exited')).toBe('done');
    expect(mapStatusToPhase('abandoned')).toBe('failed');
  });
});

describe('resolveProject', () => {
  test('folds a worktree to its repo, else the last path segment', () => {
    expect(resolveProject('/Users/muqsit/src/github.com/muqsitnawaz/swarmify/.agents/worktrees/factory-floor-port')).toBe('swarmify');
    expect(resolveProject('/home/muqsit/src/github.com/o/prix-api')).toBe('prix-api');
    expect(resolveProject('/a/b/repo/')).toBe('repo');
    expect(resolveProject('')).toBe('');
  });

  test('carries the CLI confirmedProject, null when the cwd is in no defined project (PHNX-4289)', () => {
    const base = { kind: 'claude', status: 'running', cwd: '/x/y/agents-cli', sessionFile: '/x/aaaaaaaa.jsonl' };
    expect(normalizeActiveSession({ ...base, confirmedProject: 'agi' } as RawActiveSession, 'zion', FETCHED_AT).confirmedProject).toBe('agi');
    expect(normalizeActiveSession({ ...base, confirmedProject: null } as RawActiveSession, 'zion', FETCHED_AT).confirmedProject).toBeNull();
  });

  test('carries Claude\'s recap with its time, without the CLI hint, only when it has words and a time; and forkOf', () => {
    const base = { kind: 'claude', status: 'idle', cwd: '/x/y/agents', sessionFile: '/x/aaaaaaaa.jsonl' };
    const at = (o: object) => normalizeActiveSession({ ...base, ...o } as RawActiveSession, 'zion', FETCHED_AT);
    expect(at({ recap: { text: ' Next is the release. ', at: '2026-10-19T00:49:31.496Z' } }).recap).toEqual({ text: 'Next is the release.', at: '2026-10-19T00:49:31.496Z' });
    expect(at({ recap: { text: 'x', at: 1792370971605 } }).recap).toEqual({ text: 'x', at: new Date(1792370971605).toISOString() });
    expect(at({ recap: { text: '', at: '2026-10-19T00:49:31.496Z' } }).recap).toBeUndefined();
    expect(at({ recap: { text: 'x', at: 'soon' } }).recap).toBeUndefined();
    expect(at({}).recap).toBeUndefined();
    // The CLI's done-check: kept with a known state and a time; absent stays absent.
    expect(at({ doneVerdict: { state: 'open', gaps: ['open-pr', '', 'delivery'], at: '2026-10-18T20:00:00Z' } }).doneVerdict).toEqual({ state: 'open', gaps: ['open-pr', 'delivery'], at: '2026-10-18T20:00:00Z' });
    expect(at({ doneVerdict: { state: 'done', at: '2026-10-18T20:00:00Z' } }).doneVerdict).toEqual({ state: 'done', gaps: [], at: '2026-10-18T20:00:00Z' });
    expect(at({ doneVerdict: { state: 'maybe', gaps: [], at: '2026-10-18T20:00:00Z' } }).doneVerdict).toBeUndefined();
    expect(at({ doneVerdict: { state: 'done', gaps: [] } }).doneVerdict).toBeUndefined();
    expect(at({}).doneVerdict).toBeUndefined();
    expect(at({ forkOf: '4aa3c855-eb2e' }).forkOf).toBe('4aa3c855-eb2e');
    expect(at({}).forkOf).toBeUndefined();
    // Tickets it created, and what it only acted on: entries the CLI filled in, else absent.
    expect(at({ createdTickets: ['PHNX-1', '', 'PHNX-2'] }).createdTickets).toEqual(['PHNX-1', 'PHNX-2']);
    expect(at({ createdTickets: [] }).createdTickets).toBeUndefined();
    expect(at({ touchedPrs: [{ url: 'https://github.com/o/r/pull/7', number: 7, repo: 'o/r', action: 'merged' }, { url: '', number: 8 }] }).touchedPrs).toEqual([{ url: 'https://github.com/o/r/pull/7', number: 7, repo: 'o/r', action: 'merged' }]);
    expect(at({ touchedTickets: [{ id: 'PHNX-3', action: 'commented' }, { action: 'x' }] }).touchedTickets).toEqual([{ id: 'PHNX-3', action: 'commented' }]);
    expect(at({ touchedPrs: [{ url: '' }] }).touchedPrs).toBeUndefined();
  });

  test('copies the glance fields verbatim and drops malformed entries', () => {
    const s = normalizeActiveSession(
      {
        kind: 'claude', status: 'running', cwd: '/x/y/agents-cli', sessionFile: '/x/aaaaaaaa.jsonl',
        model: 'claude-opus-5-5',
        failures: [{ atMs: 1, tool: 'Bash', summary: 'git fetch origin', error: 'exit 7', blocked: false }, { tool: 'Bash' }],
        activityHistogram: { startMs: 10, endMs: 20, buckets: [{ tools: 3, failed: 1 }, {}], userAtMs: [10, 'x'] },
        userTurns: [{ atMs: 5, text: 'Check now..', images: 1 }, { atMs: 6, text: '' }],
        subagents: [{ id: 'agent-a', agentType: 'code-reviewer', description: 'Review PR 3716', status: 'weird', toolCount: 44, transcriptPath: '/t/a.jsonl' }, { description: 'no id' }],
        artifacts: [{ path: '/a/plan.html', basename: 'plan.html', bucket: 'plans', title: 'Direct tools' }],
      } as RawActiveSession,
      'zion',
      FETCHED_AT,
    );
    expect(s.model).toBe('claude-opus-5-5');
    expect(s.failures).toEqual([{ atMs: 1, tool: 'Bash', summary: 'git fetch origin', error: 'exit 7', blocked: false }]);
    expect(s.activityHistogram).toEqual({ startMs: 10, endMs: 20, buckets: [{ tools: 3, failed: 1, blocked: 0 }, { tools: 0, failed: 0, blocked: 0 }], userAtMs: [10] });
    expect(s.userTurns).toEqual([{ atMs: 5, text: 'Check now..', images: 1 }]);
    expect(s.subagents?.map((x) => [x.id, x.status, x.toolCount])).toEqual([['agent-a', 'done', 44]]);
    expect(s.artifacts[0].title).toBe('Direct tools');
  });

  test('a turn the harness wrote for itself never reads as yours or as the agent’s work', () => {
    const notice = '<task-notification><task-id>bw39xxns6</task-id><status>completed</status></task-notification>';
    const s = normalizeActiveSession(
      {
        kind: 'claude', status: 'running', cwd: '/x', sessionFile: '/x/c.jsonl',
        activity: 'working', preview: notice,
        userTurns: [{ atMs: 100, text: 'Check the build', images: 0 }, { atMs: 200, text: notice }, { atMs: 300, text: 'All done??' }],
        activityHistogram: { startMs: 0, endMs: 400, buckets: [{ tools: 1 }], userAtMs: [100, 200, 300] },
        timeline: { steps: [
          { text: notice, at: 200, source: 'user' },
          { text: 'Ran the suite', at: 250, source: 'narration', live: true, now: '<system-reminder>todo list</system-reminder>' },
        ] },
      } as RawActiveSession,
      'zion',
      FETCHED_AT,
    );
    expect(s.activity).toBe('');
    expect(s.userTurns?.map((t) => t.text)).toEqual(['Check the build', 'All done??']);
    // Marker 2 and "turn 2" stay the same turn: the notice's marker leaves with its row.
    expect(s.activityHistogram?.userAtMs).toEqual([100, 300]);
    expect(s.timeline?.steps.map((x) => x.text)).toEqual(['Ran the suite']);
    expect(s.timeline?.steps[0].now).toBeUndefined();
  });

  test('an envelope stamped the same millisecond as your message takes only its own marker', () => {
    const s = normalizeActiveSession(
      {
        kind: 'claude', status: 'running', cwd: '/x', sessionFile: '/x/d.jsonl',
        userTurns: [{ atMs: 200, text: 'Ship it' }, { atMs: 200, text: '<task-notification><task-id>x</task-id></task-notification>' }],
        activityHistogram: { startMs: 0, endMs: 400, buckets: [{ tools: 1 }], userAtMs: [200, 200] },
      } as RawActiveSession,
      'zion',
      FETCHED_AT,
    );
    expect(s.userTurns?.map((t) => t.text)).toEqual(['Ship it']);
    expect(s.activityHistogram?.userAtMs).toEqual([200]);
  });

  test('an older CLI row leaves every glance field absent rather than empty', () => {
    const s = normalizeActiveSession({ kind: 'claude', status: 'running', cwd: '/x', sessionFile: '/x/b.jsonl' } as RawActiveSession, 'zion', FETCHED_AT);
    expect([s.model, s.failures, s.activityHistogram, s.userTurns, s.subagents]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  test('copies the summarizer signals verbatim — goal, checkpoints, checklist, state (PHNX-3939)', () => {
    const s = normalizeActiveSession(
      {
        kind: 'claude',
        status: 'running',
        cwd: '/x/y/agents/agi-ext',
        sessionFile: '/x/aaaaaaaa.jsonl',
        goal: 'Ship the sidebar Goal + Progress cards',
        checkpoints: [
          { text: 'Scoped the CLI field contract', at: '2026-09-05T10:00:00Z' },
          { text: 'Wired the render layer', at: '2026-09-05T10:20:00Z' },
          { text: '', at: '2026-09-05T10:30:00Z' }, // textless → dropped
          null,
        ],
        summaryChecklist: {
          items: [
            { content: 'Add RemoteSession fields', status: 'completed' },
            { content: 'Render the cards', status: 'in_progress', activeForm: 'Rendering the cards' },
            { content: 'Write tests', status: 'weird' }, // unknown status → pending
            { content: '' }, // contentless → dropped
          ],
        },
        summaryState: 'ready',
      } as RawActiveSession,
      'zion',
      FETCHED_AT,
    );
    expect(s.goal).toBe('Ship the sidebar Goal + Progress cards');
    expect(s.checkpoints).toEqual([
      { text: 'Scoped the CLI field contract', at: '2026-09-05T10:00:00Z' },
      { text: 'Wired the render layer', at: '2026-09-05T10:20:00Z' },
    ]);
    expect(s.summaryChecklist).toEqual([
      { content: 'Add RemoteSession fields', status: 'completed' },
      { content: 'Render the cards', status: 'in_progress', activeForm: 'Rendering the cards' },
      { content: 'Write tests', status: 'pending' },
    ]);
    expect(s.summaryState).toBe('ready');
  });

  test('summaryChecklist also accepts a bare array; absent signals are undefined (PHNX-3939)', () => {
    const arrayShape = normalizeActiveSession(
      {
        kind: 'claude',
        status: 'running',
        cwd: '/x/y/agents/agi-ext',
        sessionFile: '/x/bbbbbbbb.jsonl',
        summaryChecklist: [{ content: 'One item', status: 'pending' }],
        summaryState: 'garbage', // invalid → undefined
      } as unknown as RawActiveSession,
      'zion',
      FETCHED_AT,
    );
    expect(arrayShape.summaryChecklist).toEqual([{ content: 'One item', status: 'pending' }]);
    expect(arrayShape.summaryState).toBeUndefined();

    // A row with no summarizer signals leaves goal/checklist/state undefined and
    // checkpoints an empty array — the render layer supplies the topic fallback.
    const bare = normalizeActiveSession(
      { kind: 'claude', status: 'running', cwd: '/x/y/agents/agi-ext', sessionFile: '/x/cccccccc.jsonl', topic: 'raw request' } as RawActiveSession,
      'zion',
      FETCHED_AT,
    );
    expect(bare.goal).toBeUndefined();
    expect(bare.checkpoints).toEqual([]);
    expect(bare.summaryChecklist).toBeUndefined();
    expect(bare.summaryState).toBeUndefined();
  });

  test("a cwd-bearing row ignores the CLI's project word; a cwd-less one keeps it (PHNX-3796)", () => {
    // With a cwd, the resolved cwd is authoritative — the CLI word must not override it.
    const local = normalizeActiveSession(
      { kind: 'claude', status: 'running', cwd: '/x/y/agents/prix/api', project: 'something-else', sessionFile: '/x/aaaaaaaa.jsonl' } as RawActiveSession,
      'zion',
      FETCHED_AT,
    );
    expect(local.project).toBe('api');

    // With no cwd there is nothing to resolve, so the CLI's own word is the only
    // repo hint there is — dropping it is what left cloud rows with a blank project.
    const cloud = normalizeActiveSession(
      { kind: 'claude', status: 'running', context: 'cloud', cloudTaskId: 't1', project: 'phnx-labs/agi-ext' } as RawActiveSession,
      'pinnacles',
      FETCHED_AT,
    );
    expect(cloud.project).toBe('phnx-labs/agi-ext');

    // A genuinely repo-less row still resolves to ''.
    const bare = normalizeActiveSession(
      { kind: 'claude', status: 'running', context: 'cloud', cloudTaskId: 't2' } as RawActiveSession,
      'pinnacles',
      FETCHED_AT,
    );
    expect(bare.project).toBe('');
  });
});

describe('normalizeQuestion — carry the CLI decision across postMessage', () => {
  test('keeps text, clamps reason, drops label-less options', () => {
    const q = normalizeQuestion({
      text: 'Ship v0.9.290 now?',
      reason: 'question',
      options: [{ label: 'Build now', description: 'the two follow-ups', key: '1' }, { key: '2' } as any, { label: 'Pull backlog', key: '2' }],
    });
    expect(q).toEqual({
      text: 'Ship v0.9.290 now?',
      reason: 'question',
      options: [
        { label: 'Build now', description: 'the two follow-ups', key: '1' },
        { label: 'Pull backlog', description: '', key: '2' },
      ],
    });
  });
  test('an unknown reason falls back to "question"; permission/plan pass through', () => {
    expect(normalizeQuestion({ text: 'x', reason: 'weird' as any, options: [] })?.reason).toBe('question');
    expect(normalizeQuestion({ text: 'x', reason: 'permission', options: [] })?.reason).toBe('permission');
    expect(normalizeQuestion({ text: 'x', reason: 'plan_review', options: [] })?.reason).toBe('plan_review');
  });
  test('returns null for a missing/textless question', () => {
    expect(normalizeQuestion(null)).toBeNull();
    expect(normalizeQuestion({ text: '', reason: 'question', options: [] })).toBeNull();
    expect(normalizeQuestion(undefined as any)).toBeNull();
  });
});

describe('normalizeActiveSession — question + tail passthrough', () => {
  test('carries the CLI question object and assistant tail onto the RemoteSession', () => {
    const base = ACTIVE.find((r) => r.context === 'terminal')!;
    const raw = {
      ...base,
      status: 'input_required',
      question: { text: 'Approve?', reason: 'permission', options: [{ label: 'Approve', key: '1' }, { label: 'Deny', key: 'esc' }] },
      tail: ['earlier turn', 'Approve rm -rf build?'],
    } as unknown as RawActiveSession;
    const s = normalizeActiveSession(raw, 'this-mac', FETCHED_AT);
    expect(s.waitingForInput).toBe(true);
    expect(s.question).toEqual({ text: 'Approve?', reason: 'permission', options: [{ label: 'Approve', description: '', key: '1' }, { label: 'Deny', description: '', key: 'esc' }] });
    expect(s.tail).toEqual(['earlier turn', 'Approve rm -rf build?']);
  });
  test('question is null and tail is [] when the CLI supplied none', () => {
    const base = ACTIVE.find((r) => r.context === 'terminal')!;
    const s = normalizeActiveSession(base, 'this-mac', FETCHED_AT);
    expect(s.question).toBeNull();
    expect(s.tail).toEqual([]);
  });
});

describe('normalizeActiveSession — presence passthrough (Attach picker)', () => {
  test('carries the CLI presence value onto the RemoteSession', () => {
    const base = ACTIVE.find((r) => r.context === 'terminal')!;
    for (const presence of ['background', 'parked', 'attached']) {
      const raw = { ...base, presence } as unknown as RawActiveSession;
      const s = normalizeActiveSession(raw, 'this-mac', FETCHED_AT);
      expect(s.presence).toBe(presence);
    }
  });
  test('presence is "" when the CLI supplied none (not undefined — the extension filters on ===)', () => {
    const base = ACTIVE.find((r) => r.context === 'terminal')!;
    const s = normalizeActiveSession(base, 'this-mac', FETCHED_AT);
    expect(s.presence).toBe('');
  });
});

describe('normalizeActiveSession', () => {
  test('uses the queried host, not the payload host field', () => {
    // The terminal record carries host:"ghostty" (the emulator). Identity must
    // come from the machine we queried.
    const terminal = ACTIVE.find((r) => r.context === 'terminal')!;
    const s = normalizeActiveSession(terminal, 'mac-mini', FETCHED_AT);
    expect(s.host).toBe('mac-mini');
    expect(s.agentType).toBe('codex');
  });

  test('coerces object-shaped ticket/branch/topic to strings (React #31 guard)', () => {
    // The session JSON is not schema-validated; the CLI has been observed emitting
    // `ticket` as an object `{ id }` instead of a string. Those fields flow into the
    // Floor card's name/summary and are rendered as React children, so a non-string
    // must never survive normalization (else "Objects are not valid as a React child").
    const base = ACTIVE.find((r) => r.context === 'terminal')!;
    const bad = {
      ...base,
      ticket: { id: 'RUSH-1262' },
      branch: { id: 'abc' },
      topic: { id: 'xyz' },
      label: { id: 'manual' },
      prUrl: { id: 'p' },
    } as unknown as RawActiveSession;
    const s = normalizeActiveSession(bad, 'this-mac', FETCHED_AT);
    expect(typeof s.branch).toBe('string');
    expect(typeof s.topic).toBe('string');
    expect(typeof s.label).toBe('string');
    expect(s.ticket === null || typeof s.ticket === 'string').toBe(true);
    expect(s.prUrl === null || typeof s.prUrl === 'string').toBe(true);
    // No object leaked through under the guise of a string.
    for (const v of [s.ticket, s.branch, s.topic, s.label, s.prUrl]) {
      expect(typeof v === 'object' && v !== null).toBe(false);
    }
  });

  test('normalizes spawnedTeam to a string', () => {
    const base = ACTIVE.find((r) => r.context === 'terminal')!;
    const ok = normalizeActiveSession({ ...base, spawnedTeam: 'redesign' } as unknown as RawActiveSession, 'this-mac', FETCHED_AT);
    expect(ok.spawnedTeam).toBe('redesign');
    // An object where a string is expected must not leak through: it renders as a card child.
    const bad = normalizeActiveSession({ ...base, spawnedTeam: { name: 'foo' } } as unknown as RawActiveSession, 'this-mac', FETCHED_AT);
    expect(typeof bad.spawnedTeam).toBe('string');
  });

  test('normalizes structured attachment metadata for preview', () => {
    const base = ACTIVE.find((r) => r.context === 'terminal')!;
    const s = normalizeActiveSession({
      ...base,
      attachments: [
        {
          path: '/home/muqsit/.agents/.history/attachments/factory-floor.png',
          name: 'factory-floor.png',
          mediaType: 'image/png',
          sizeBytes: 12345,
        },
      ],
    } as RawActiveSession, 'this-mac', FETCHED_AT);

    expect(s.attachments).toEqual([
      {
        path: '/home/muqsit/.agents/.history/attachments/factory-floor.png',
        label: 'factory-floor.png',
        mediaType: 'image/png',
        sizeBytes: 12345,
        thumbnailUri: undefined,
      },
    ]);
  });

  test('input_required becomes waiting + waitingForInput', () => {
    const terminal = ACTIVE.find((r) => r.status === 'input_required')!;
    const s = normalizeActiveSession(terminal, 'this-mac', FETCHED_AT);
    expect(s.phase).toBe('waiting');
    expect(s.waitingForInput).toBe(true);
  });

  test('derives sessionId from the session file when absent', () => {
    const terminal = ACTIVE.find((r) => r.context === 'terminal')!;
    expect(terminal.sessionId).toBeUndefined();
    const s = normalizeActiveSession(terminal, 'this-mac', FETCHED_AT);
    expect(s.sessionId).toBe('d71b62ce-01d1-40ae-af9d-8ed34275234b');
  });

  test('falls back to cloudTaskId for cloud records with no sessionId/file', () => {
    const cloud = ACTIVE.find((r) => r.context === 'cloud' && r.status === 'queued')!;
    const s = normalizeActiveSession(cloud, 'cloud', FETCHED_AT);
    expect(s.sessionId).toBe('task_e');
    expect(s.phase).toBe('running');
  });

  test('carries pid for terminal records (0 when absent)', () => {
    const terminal = ACTIVE.find((r) => r.context === 'terminal')!;
    const s = normalizeActiveSession(terminal, 'this-mac', FETCHED_AT);
    expect(s.pid).toBe(typeof terminal.pid === 'number' ? terminal.pid : 0);
    expect(s.teamName).toBe(terminal.teamName ?? '');
  });

  test('carries the CLI viewingIn words', () => {
    const s = normalizeActiveSession(
      { context: 'terminal', kind: 'claude', sessionId: 'abc', status: 'running', viewingIn: 'Codium tab 3' },
      'this-mac', FETCHED_AT,
    );
    expect(s.viewingIn).toBe('Codium tab 3');
  });

  test('extracts a ticket id from label/topic', () => {
    const backend = ACTIVE.find((r) => r.label === 'backend')!;
    const s = normalizeActiveSession(backend, 'this-mac', FETCHED_AT);
    expect(s.ticket).toBe('RUSH-812');
  });

  test('computes skew-free elapsed from the fetch clock', () => {
    const backend = ACTIVE.find((r) => r.label === 'backend')!;
    const s = normalizeActiveSession(backend, 'this-mac', FETCHED_AT);
    expect(s.sinceMs).toBe(FETCHED_AT - 1782865917676);
    expect(s.startedAtMs).toBe(1782865917676);
  });
});

describe('live signals from the CLI payload (issue #741)', () => {
  // activity / tokPerSec / awaitingReason ride the `agents ps
  // --json` rows themselves — the extension no longer re-derives them from the
  // transcript tail (the old enrichWithSessionContent).
  const base: RawActiveSession = {
    sessionId: 'x',
    kind: 'claude',
    cwd: '/repo',
    status: 'running',
  };

  test('a working session maps preview to the live now-line and rounds tokPerSec', () => {
    const s = normalizeActiveSession(
      { ...base, activity: 'working', preview: '$ bun test', tokPerSec: 27.9166 },
      'this-mac',
      1_000_000,
    );
    expect(s.activity).toBe('$ bun test');
    expect(s.tokPerSec).toBe(28);
    expect(s.lastResponse).toBe('$ bun test');
  });

  test('an idle session gets no now-line even when a stale preview is present', () => {
    const s = normalizeActiveSession(
      { ...base, status: 'idle', activity: 'idle', preview: 'Edit linux.ts', tokPerSec: 0 },
      'this-mac',
      1_000_000,
    );
    expect(s.activity).toBe('');
    expect(s.lastResponse).toBe('Edit linux.ts'); // the last turn still shows as body text
    expect(s.tokPerSec).toBe(0);
  });

  test('a waiting session carries the CLI awaitingReason and waiting phase', () => {
    const s = normalizeActiveSession(
      { ...base, status: 'input_required', activity: 'waiting_input', awaitingReason: 'plan_review', preview: 'Approve the plan?' },
      'this-mac',
      1_000_000,
    );
    expect(s.phase).toBe('waiting');
    expect(s.waitingForInput).toBe(true);
    expect(s.awaitingReason).toBe('plan_review');
    expect(s.activity).toBe(''); // waiting, not working — no live now-line
  });

  test('absent live-signal fields default cleanly (older CLI payloads)', () => {
    const s = normalizeActiveSession(base, 'this-mac', 1_000_000);
    expect(s.activity).toBe('');
    expect(s.tokPerSec).toBe(0);
    expect(s.awaitingReason).toBe('');
    expect(s.waitingForInput).toBe(false);
  });

  test('a null awaitingReason (running rows) normalizes to empty string', () => {
    const s = normalizeActiveSession({ ...base, awaitingReason: null }, 'this-mac', 1_000_000);
    expect(s.awaitingReason).toBe('');
  });

  test('carries outcome-card metrics, artifacts, and subagent count from the CLI row (PHNX-3574)', () => {
    const s = normalizeActiveSession({
      ...base,
      tokenCount: '163000000' as unknown as number,
      durationMs: 12_960_000,
      planFile: '/repo/.agents/plans/plan-sidebar.md',
      subAgentCount: 34,
      artifacts: [
        { path: '/repo/.agents/plans/plan-sidebar.html', basename: 'plan-sidebar.html', bucket: 'plans' },
        { path: '/repo/.agents/artifacts/sidebar.png', basename: 'sidebar.png', bucket: 'artifacts', editedAtMs: 1_700, junk: 1 },
        { path: '/u/Downloads/Set/a.jpg', basename: 'a.jpg', bucket: 'docs', editedAtMs: 'soon' },
        { path: '', basename: 'bad', bucket: 'docs' },
      ],
    }, 'this-mac', 1_000_000);

    expect(s.tokenCount).toBe(163_000_000);
    expect(s.durationMs).toBe(12_960_000);
    expect(s.planFile).toBe('/repo/.agents/plans/plan-sidebar.md');
    expect(s.subAgentCount).toBe(34);
    expect(s.artifacts).toEqual([
      { path: '/repo/.agents/plans/plan-sidebar.html', basename: 'plan-sidebar.html', bucket: 'plans' },
      { path: '/repo/.agents/artifacts/sidebar.png', basename: 'sidebar.png', bucket: 'artifacts', editedAtMs: 1_700 },
      { path: '/u/Downloads/Set/a.jpg', basename: 'a.jpg', bucket: 'docs' },
    ]);
  });
});

describe('normalizeActiveSession — topic', () => {
  test('carries the topic (or falls back to the cloud label) so remote cards are not blank', () => {
    const term = normalizeActiveSession(
      { kind: 'claude', status: 'running', sessionFile: '/x/aaaaaaaa.jsonl', topic: 'Add a pre-commit hook', label: 'hooks label' } as RawActiveSession,
      'zion',
      FETCHED_AT
    );
    expect(term.topic).toBe('Add a pre-commit hook');
    expect(term.label).toBe('hooks label');
    const cloud = normalizeActiveSession(
      { kind: 'codex', status: 'queued', cloudTaskId: 'task_e', label: 'Read README and summarize' } as RawActiveSession,
      'this-mac',
      FETCHED_AT
    );
    expect(cloud.topic).toBe('Read README and summarize');
    expect(cloud.label).toBe('Read README and summarize');
    const legacy = normalizeActiveSession(
      { kind: 'claude', status: 'running', prompt: 'Repair remote cards' } as RawActiveSession,
      'yosemite-m0',
      FETCHED_AT
    );
    expect(legacy.topic).toBe('Repair remote cards');
    const firstMessage = normalizeActiveSession(
      {
        kind: 'codex', status: 'running', title: 'Explaining a background run',
        firstUserMessage: 'Explain the background run\nwith all of these original details.',
      } as RawActiveSession,
      'mac-mini',
      FETCHED_AT
    );
    expect(firstMessage.title).toBe('Explaining a background run');
    expect(firstMessage.firstUserMessage).toBe('Explain the background run\nwith all of these original details.');
    expect(firstMessage.topic).toBe('Explain the background run\nwith all of these original details.');
  });
});

describe('dialablePeerScopes — the peers the follower-degraded gate may wait on (PHNX-2735)', () => {
  test('includes online POSIX/Windows peers, normalized, excluding the local machine', () => {
    const scopes = dialablePeerScopes([
      { name: 'zion', online: true, platform: 'macos' },        // local — excluded
      { name: 'yosemite-s0', online: true, platform: 'linux' },
      { name: 'Win-Mini', online: true, platform: 'windows' },  // normalized
    ], 'zion');
    expect(scopes.sort()).toEqual(['win-mini', 'yosemite-s0']);
  });

  test('excludes an offline peer — the CLI never dials it, so we must not wait on it', () => {
    const scopes = dialablePeerScopes([
      { name: 'yosemite-s0', online: true, platform: 'linux' },
      { name: 'macbook-air', online: false, platform: 'macos' },
    ], 'zion');
    expect(scopes).toEqual(['yosemite-s0']);
  });

  // The regression the re-review caught: an approved Tailscale device with an
  // unrecognized OS (an iPad → platform 'unknown') reads online but the CLI feed
  // never dials it, so it emits neither a reset nor `scope unavailable`. Waiting
  // on it would hang the merged Floor at "connecting" forever. It MUST NOT appear.
  test('excludes an online device on a non-dialable platform (iPad → unknown)', () => {
    const scopes = dialablePeerScopes([
      { name: 'yosemite-s0', online: true, platform: 'linux' },
      { name: 'ipad165', online: true, platform: 'unknown' },
      { name: 'iphone182', online: true, platform: undefined },
    ], 'zion');
    expect(scopes).toEqual(['yosemite-s0']);
  });
});

describe('normalizeActiveSession — todos plan progress (RUSH-1380)', () => {
  test('carries the CLI TodoWrite checklist through to the card', () => {
    const s = normalizeActiveSession(
      {
        kind: 'claude',
        status: 'running',
        activity: 'working',
        cwd: '/x/y',
        sessionFile: '/x/bbbbbbbb.jsonl',
        todos: {
          items: [
            { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
            { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
            { content: 'Verify', status: 'pending' },
          ],
          done: 1,
          total: 3,
          activeForm: 'Shipping it',
        },
      } as RawActiveSession,
      'yosemite-s0',
      FETCHED_AT
    );
    expect(s.todos).toEqual([
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
      { content: 'Verify', status: 'pending' },
    ]);
  });

  test('drops contentless items and coerces an unknown status to pending', () => {
    const s = normalizeActiveSession(
      {
        kind: 'claude',
        status: 'running',
        sessionFile: '/x/cccccccc.jsonl',
        todos: { items: [{ status: 'in_progress' }, { content: 'Do it', status: 'weird' }] },
      } as RawActiveSession,
      'zion',
      FETCHED_AT
    );
    expect(s.todos).toEqual([{ content: 'Do it', status: 'pending' }]);
  });

  test('no todos payload ⇒ field absent', () => {
    const s = normalizeActiveSession(
      { kind: 'claude', status: 'running', sessionFile: '/x/dddddddd.jsonl' } as RawActiveSession,
      'zion',
      FETCHED_AT
    );
    expect(s.todos).toBeUndefined();
  });

  test('empty items array ⇒ field absent', () => {
    const s = normalizeActiveSession(
      { kind: 'claude', status: 'running', sessionFile: '/x/eeeeeeee.jsonl', todos: { items: [] } } as RawActiveSession,
      'zion',
      FETCHED_AT
    );
    expect(s.todos).toBeUndefined();
  });
});

describe('isDerivedSessionName', () => {
  test('matches only <cwd basename>-<digits>', () => {
    expect(isDerivedSessionName('agents-cli-55', '/home/muqsit/src/agents-cli')).toBe(true);
    expect(isDerivedSessionName('agents-cli-55', '/home/muqsit/src/agents-cli/')).toBe(true);
    expect(isDerivedSessionName('agents-cli', '/home/muqsit/src/agents-cli')).toBe(false);
    expect(isDerivedSessionName('other-55', '/home/muqsit/src/agents-cli')).toBe(false);
  });

  test('is false when the cwd is unknown', () => {
    expect(isDerivedSessionName('agents-cli-55', '')).toBe(false);
  });
});

describe('feed pending, effort and fast (agents-cli round 16 fields)', () => {
  const base: RawActiveSession = { sessionId: '2bfd9583', status: 'idle', cwd: '/home/me/src/agents' };
  test('pending keeps the running work with ids; an empty or absent field stays absent', () => {
    const s = normalizeActiveSession({ ...base, pending: { subagents: [], shells: [{ id: 'b1', description: 'Poll prod', startedAtMs: 5 }, { description: 'no id' }], monitors: 'junk' } }, 'zion', 0);
    expect(s.pending).toEqual({ shells: [{ id: 'b1', description: 'Poll prod', startedAtMs: 5 }] });
    expect(normalizeActiveSession({ ...base, pending: { subagents: [], shells: [], monitors: [] } }, 'zion', 0).pending).toBeUndefined();
    expect(normalizeActiveSession(base, 'zion', 0).pending).toBeUndefined();
  });
  test('effort and fast ride along only when the CLI knows them', () => {
    expect(normalizeActiveSession({ ...base, effort: 'high', fast: true }, 'zion', 0)).toMatchObject({ effort: 'high', fast: true });
    expect(normalizeActiveSession({ ...base, effort: 'xhigh' }, 'zion', 0).effort).toBe('xhigh');
    const bare = normalizeActiveSession({ ...base, effort: 'turbo', fast: 'yes' }, 'zion', 0);
    expect(bare.effort).toBeUndefined();
    expect(bare.fast).toBeUndefined();
  });
});
