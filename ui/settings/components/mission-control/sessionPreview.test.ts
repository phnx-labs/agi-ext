import { test, expect, describe } from 'bun:test'
import { normalizeSessionPreview, humanTokens, tildePath } from './sessionPreview'

// The raw envelope `agents sessions preview <id> --json` emits, verbatim.
const rawEnvelope = {
  schemaVersion: 1,
  session: {
    id: 'abc123def', shortId: 'abc123de', agent: 'claude', version: '2.1.207',
    model: 'claude-opus-4-8', account: 'muqsit@getrush.ai', machine: 'yosemite-m1',
    cwd: '/home/muqsit/repo', project: 'repo', gitBranch: 'main',
    createdAt: '2026-08-28T17:00:00.000Z', lastActivity: '2026-08-28T17:10:00.000Z',
    durationMs: 600000, messageCount: 42, tokenCount: 1_117_641, costUsd: 1.18,
    label: 'repo-fe', topic: '', ticketId: 'PHNX-2973', prUrl: '',
  },
  active: { status: 'running', activity: 'editing files', lastActivityMs: 1, startedAtMs: 1, pid: 99 },
  preview: {
    schemaVersion: 1,
    firstUser: 'do the thing',
    lastAssistant: 'done',
    filesRead: 9,
    toolCalls: 311,
    planFile: '',
    subAgentCount: 2,
    toolTags: [],
    changes: { created: 3, modified: 3, deleted: 7 },
    changedFiles: [
      { path: 'cli/src/a.ts', op: 'created' },
      { path: 'cli/src/b.ts', op: 'modified' },
      { path: 'cli/src/c.ts', op: 'nonsense' }, // bad op → dropped
      { path: 42, op: 'deleted' },               // bad path → dropped
    ],
    dirs: ['~/repo'],
    repos: ['agents-cli'],
    artifacts: [],
    skills: [{ name: 'review', count: 2 }],
    plugins: [],
    hooks: [{ name: 'UserPromptSubmit', event: 'UserPromptSubmit', count: 60, failed: 0 }],
    links: [{ kind: 'other', url: 'https://github.com/a/b/pull/1', label: 'PR#1' }],
    errorCount: 37,
    firstError: 'Bash',
    toolHistogram: [{ tool: 'Bash', count: 280 }, { tool: 'Edit', count: 11 }],
    test: { runner: 'tests', ok: true, passed: 1 },
  },
  error: null,
}

describe('normalizeSessionPreview', () => {
  test('maps the full envelope into the typed model', () => {
    const p = normalizeSessionPreview(rawEnvelope)
    expect(p).toBeDefined()
    expect(p!.session.version).toBe('2.1.207')
    expect(p!.session.account).toBe('muqsit@getrush.ai')
    expect(p!.session.tokenCount).toBe(1_117_641)
    expect(p!.session.ticketId).toBe('PHNX-2973')
    expect(p!.digest).toBeDefined()
    expect(p!.digest!.changes).toEqual({ created: 3, modified: 3, deleted: 7 })
    expect(p!.digest!.toolHistogram).toEqual([{ tool: 'Bash', count: 280 }, { tool: 'Edit', count: 11 }])
    expect(p!.digest!.errorCount).toBe(37)
    expect(p!.digest!.firstError).toBe('Bash')
    expect(p!.digest!.test).toEqual({ runner: 'tests', ok: true, passed: 1, failed: undefined })
    expect(p!.error).toBeUndefined()
  })

  test('keeps well-formed changedFiles and drops bad path/op entries', () => {
    const p = normalizeSessionPreview(rawEnvelope)
    expect(p!.digest!.changedFiles).toEqual([
      { path: 'cli/src/a.ts', op: 'created' },
      { path: 'cli/src/b.ts', op: 'modified' },
    ])
  })

  test('surfaces a CLI error string when the digest is absent', () => {
    const p = normalizeSessionPreview({ session: rawEnvelope.session, preview: null, error: 'not indexed here' })
    expect(p!.digest).toBeUndefined()
    expect(p!.error).toBe('not indexed here')
  })

  test('surfaces the fallback error when the host could not run the verb', () => {
    const p = normalizeSessionPreview(undefined, 'agents CLI not found')
    expect(p!.digest).toBeUndefined()
    expect(p!.error).toBe('agents CLI not found')
  })

  test('returns undefined for junk with no fallback', () => {
    expect(normalizeSessionPreview('nope')).toBeUndefined()
    expect(normalizeSessionPreview(null)).toBeUndefined()
  })
})

describe('humanTokens', () => {
  test('formats millions / thousands / units', () => {
    expect(humanTokens(1_117_641)).toBe('1.1m')
    expect(humanTokens(54_600)).toBe('54.6k')
    expect(humanTokens(812)).toBe('812')
    expect(humanTokens(0)).toBe('0')
  })
})

describe('tildePath', () => {
  test('collapses a home-anchored path', () => {
    expect(tildePath('/home/muqsit/repo/x')).toBe('~/repo/x')
    expect(tildePath('/Users/mo/repo')).toBe('~/repo')
    expect(tildePath('relative/x')).toBe('relative/x')
  })
})
