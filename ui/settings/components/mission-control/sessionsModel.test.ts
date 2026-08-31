import { describe, test, expect } from 'bun:test'
import type { FloorAgent } from './floorModel'
import { isPrevious, sessionBand, sessionStatus, resumeCommand, mergeSessionAgents } from './floorModel'
import {
  scopeSessions,
  sortSessions,
  groupSessions,
  buildSessionSections,
  sessionChipCounts,
  orderedPrevious,
  previousInitialCount,
  PREVIOUS_DEFAULT_LIMIT,
  type SessionScope,
} from './sessionsModel'

function mk(over: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: over.id ?? 'a1',
    host: 'this-mac',
    hostLabel: 'zion',
    project: 'agents-cli',
    name: 'a-session',
    abbr: 'CC',
    phase: 'running',
    verb: '',
    target: '',
    tok: 0,
    since: '2s',
    lastActivityMs: 0,
    startedAtMs: 0,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: null,
    prUrl: null,
    ticket: null,
    branch: '',
    worktreeSlug: '',
    worktreePath: '',
    resp: '',
    prompt: '',
    topic: '',
    sessionId: over.id ?? 'a1',
    messages: [],
    question: null,
    reply: { kind: 'terminal', host: 'this-mac', terminalId: 'CC-1' },
    todos: [],
    summary: '',
    recent: [],
    ...over,
  } as FloorAgent
}

/** A resumable PREVIOUS (index) row: state 'inactive', resumable, with a recovery command. */
function prevRow(over: Partial<FloorAgent> = {}): FloorAgent {
  return mk({
    context: 'recent',
    sessionState: 'inactive',
    resumable: true,
    sourceDevice: 'yosemite-s0',
    recovery: { command: 'agents', args: ['sessions', 'resume', over.id ?? 'p1', '--device', 'yosemite-s0'] },
    ...over,
  })
}

const EMPTY: SessionScope = { filter: 'all', project: null, host: null, search: '' }

describe('isPrevious classification', () => {
  test('only a genuinely-inactive index row is Previous', () => {
    expect(isPrevious(prevRow({ id: 'p1' }))).toBe(true)
    expect(isPrevious(mk({ sessionState: 'inactive' }))).toBe(true)
  })
  test('a live row is NOT Previous — even a picker row tagged context:recent while still running', () => {
    expect(isPrevious(mk({ phase: 'running' }))).toBe(false)
    expect(isPrevious(mk({ phase: 'idle', sessionState: 'idle' }))).toBe(false)
    expect(isPrevious(mk({ sessionState: undefined, context: 'terminal' }))).toBe(false)
    // the load-bearing regression guard: a running session in the picker fetch
    // (context 'recent', state 'running') must stay Active, never Previous.
    expect(isPrevious(mk({ context: 'recent', sessionState: 'running', phase: 'running' }))).toBe(false)
  })
  test('sessionBand routes a Previous row to the previous band', () => {
    expect(sessionBand(prevRow({ id: 'p1' }))).toBe('previous')
    expect(sessionBand(mk({ phase: 'running' }))).toBe('active')
    expect(sessionBand(mk({ phase: 'done' }))).toBe('done')
    expect(sessionBand(mk({ phase: 'idle' }))).toBe('attention')
  })
  test('sessionStatus uses the shared Active / Idle / Blocked / Previous taxonomy', () => {
    expect(sessionStatus(mk({ phase: 'running' }))).toBe('active')
    expect(sessionStatus(mk({ phase: 'idle' }))).toBe('idle')
    expect(sessionStatus(mk({ phase: 'waiting' }))).toBe('idle')
    expect(sessionStatus(mk({ phase: 'running', needs: true }))).toBe('blocked')
    expect(sessionStatus(mk({ phase: 'failed' }))).toBe('blocked')
    expect(sessionStatus(mk({ phase: 'done' }))).toBe('previous')
    expect(sessionStatus(prevRow())).toBe('previous')
  })
})

describe('resumeCommand', () => {
  test('a resumable Previous row builds `agents sessions resume <id> --device <device>`', () => {
    const cmd = resumeCommand(prevRow({ id: 'abc123', sourceDevice: 'yosemite-s0' }))
    expect(cmd).toEqual({ command: 'agents', args: ['sessions', 'resume', 'abc123', '--device', 'yosemite-s0'] })
  })
  test('falls back to a built command when no recovery is present but the row is resumable', () => {
    const cmd = resumeCommand(mk({ id: 'x9', sessionState: 'inactive', resumable: true, recovery: null, sourceDevice: 'zion' }))
    expect(cmd).toEqual({ command: 'agents', args: ['sessions', 'resume', 'x9', '--device', 'zion'] })
  })
  test('a non-resumable harness (recovery null, resumable false) has no command -> View', () => {
    expect(resumeCommand(mk({ id: 'g1', sessionState: 'inactive', resumable: false, recovery: null }))).toBeNull()
  })
})

describe('mergeSessionAgents — live wins over the index row', () => {
  test('dedup by sessionId keeps the LIVE row and drops the index duplicate', () => {
    const live = [mk({ id: 'dup', phase: 'running', sessionState: 'running' })]
    const previous = [prevRow({ id: 'dup' }), prevRow({ id: 'p2' })]
    const merged = mergeSessionAgents(live, previous)
    expect(merged.map((a) => a.id)).toEqual(['dup', 'p2'])
    // the surviving 'dup' is the LIVE one (not Previous)
    expect(isPrevious(merged.find((a) => a.id === 'dup')!)).toBe(false)
    // p2 stays a Previous row
    expect(isPrevious(merged.find((a) => a.id === 'p2')!)).toBe(true)
  })
  test('index rows with no sessionId are never coalesced away', () => {
    const previous = [prevRow({ id: '', sessionId: undefined }), prevRow({ id: '', sessionId: undefined })]
    expect(mergeSessionAgents([], previous)).toHaveLength(2)
  })
})

describe('scopeSessions — status filters share the sessionStatus taxonomy', () => {
  const list = [
    mk({ id: 'run', phase: 'running' }),
    mk({ id: 'idle', phase: 'idle' }),
    mk({ id: 'wait', phase: 'waiting' }),
    mk({ id: 'blocked', phase: 'running', needs: true }),
    mk({ id: 'failed', phase: 'failed' }),
    mk({ id: 'done', phase: 'done' }),
    prevRow({ id: 'prev' }),
    mk({ id: 'fav', phase: 'running', pinned: true }),
  ]
  test('Active is working only; waiting folds into Idle; needs/failed are Blocked', () => {
    expect(scopeSessions(list, { ...EMPTY, filter: 'active' }).map((a) => a.id).sort()).toEqual(['fav', 'run'])
    expect(scopeSessions(list, { ...EMPTY, filter: 'idle' }).map((a) => a.id).sort()).toEqual(['idle', 'wait'])
    expect(scopeSessions(list, { ...EMPTY, filter: 'blocked' }).map((a) => a.id).sort()).toEqual(['blocked', 'failed'])
  })
  test('favorites keeps only pinned', () => {
    expect(scopeSessions(list, { ...EMPTY, filter: 'favorites' }).map((a) => a.id)).toEqual(['fav'])
  })
  test('all keeps everything (Previous included, lands in the bottom band)', () => {
    expect(scopeSessions(list, EMPTY)).toHaveLength(8)
  })
})

describe('scopeSessions — project / host / search', () => {
  const list = [
    mk({ id: 'a', project: 'agents-cli', hostLabel: 'zion', topic: 'refactor secrets broker' }),
    mk({ id: 'b', project: 'rush', hostLabel: 'mac-mini', topic: 'blog post' }),
  ]
  test('project filter', () => {
    expect(scopeSessions(list, { ...EMPTY, project: 'rush' }).map((a) => a.id)).toEqual(['b'])
  })
  test('host filter uses hostLabel (the Device label)', () => {
    expect(scopeSessions(list, { ...EMPTY, host: 'zion' }).map((a) => a.id)).toEqual(['a'])
  })
  test('search matches topic', () => {
    expect(scopeSessions(list, { ...EMPTY, search: 'secrets' }).map((a) => a.id)).toEqual(['a'])
  })
})

describe('sortSessions — status puts Previous last, done terminal above it', () => {
  test('Previous ranks below every live phase incl. done', () => {
    const rows = [
      prevRow({ id: 'prev' }),
      mk({ id: 'done', phase: 'done' }),
      mk({ id: 'run', phase: 'running' }),
      mk({ id: 'idle', phase: 'idle' }),
    ]
    expect(sortSessions(rows, 'status', true).map((a) => a.id)).toEqual(['idle', 'run', 'done', 'prev'])
  })
  test('recent vs started remain distinct', () => {
    const s1 = mk({ id: 's1', startedAtMs: 1_000, lastActivityMs: 9_000 })
    const s2 = mk({ id: 's2', startedAtMs: 8_000, lastActivityMs: 2_000 })
    expect(sortSessions([s2, s1], 'recent', true).map((a) => a.id)).toEqual(['s1', 's2'])
    expect(sortSessions([s1, s2], 'started', true).map((a) => a.id)).toEqual(['s2', 's1'])
  })
})

describe('groupSessions — the whole bounded list, including Previous, is re-bucketed', () => {
  const list = [
    mk({ id: 'run', phase: 'running', project: 'agi-ext', hostLabel: 'zion' }),
    mk({ id: 'idle', phase: 'waiting', project: 'agi-ext', hostLabel: 'yosemite-m2' }),
    mk({ id: 'blocked', phase: 'running', needs: true, project: 'rush', hostLabel: 'zion' }),
    prevRow({ id: 'prev-agi', project: 'agi-ext', hostLabel: 'yosemite-m2' }),
    prevRow({ id: 'prev-rush', project: 'rush', hostLabel: 'yosemite-s0' }),
  ]
  test('Project buckets Previous alongside matching live sessions', () => {
    const secs = groupSessions(list, 'project', 'recent', true)
    expect(secs.find((s) => s.label === 'agi-ext')!.agents.map((a) => a.id).sort()).toEqual(['idle', 'prev-agi', 'run'])
    expect(secs.find((s) => s.label === 'rush')!.agents.map((a) => a.id).sort()).toEqual(['blocked', 'prev-rush'])
  })
  test('Device buckets Previous by the same displayed device key', () => {
    const secs = groupSessions(list, 'device', 'recent', true)
    expect(secs.find((s) => s.label === 'yosemite-m2')!.agents.map((a) => a.id).sort()).toEqual(['idle', 'prev-agi'])
    expect(secs.find((s) => s.label === 'yosemite-s0')!.agents.map((a) => a.id)).toEqual(['prev-rush'])
  })
  test('Status uses the same classifier as filters and includes Previous', () => {
    const secs = groupSessions(list, 'status', 'recent', true)
    expect(secs.map((s) => s.label)).toEqual(['Active', 'Idle', 'Blocked', 'Previous'])
    expect(secs.find((s) => s.label === 'Previous')!.agents.map((a) => a.id).sort()).toEqual(['prev-agi', 'prev-rush'])
  })
  test('None returns one section containing every row exactly once', () => {
    const secs = groupSessions(list, 'none', 'recent', true)
    expect(secs).toHaveLength(1)
    expect(secs[0]!.agents).toHaveLength(list.length)
  })
})

describe('buildSessionSections — bounded Previous rows stay inside the selected grouping', () => {
  const now = 5_000_000
  const list = [
    mk({ id: 'run', phase: 'running' }),
    mk({ id: 'idle', phase: 'idle' }),
    prevRow({ id: 'prev1', lastActivityMs: now - 1000 }),
    prevRow({ id: 'prev2', lastActivityMs: now - 2000 }),
  ]
  test('Status groups the bounded Previous rows under Previous', () => {
    const secs = buildSessionSections(list, 'status', 'recent', true, { filter: 'all', nowMs: now })
    expect(secs.find((s) => s.status === 'previous')!.agents.map((a) => a.id)).toEqual(['prev1', 'prev2'])
  })
  test('the Active filter hides Previous before grouping', () => {
    const active = scopeSessions(list, { ...EMPTY, filter: 'active' })
    const secs = buildSessionSections(active, 'status', 'recent', true, { filter: 'active', nowMs: now })
    expect(secs.some((s) => s.status === 'previous')).toBe(false)
  })
  test('the bound caps grouped rows and exposes one paging header with shown/total', () => {
    const many = Array.from({ length: 60 }, (_, i) => prevRow({ id: `p${i}`, lastActivityMs: now - i * 1000 }))
    const secs = buildSessionSections(many, 'project', 'recent', true, { filter: 'all', nowMs: now, previousShown: 50 })
    expect(secs.filter((s) => s.kind !== 'pager').flatMap((s) => s.agents)).toHaveLength(50)
    expect(secs.find((s) => s.kind === 'pager')).toMatchObject({ shown: 50, total: 60 })
  })
  test('the default build never renders more than 50 recent Previous rows', () => {
    const recent = Array.from({ length: 80 }, (_, i) => prevRow({ id: `recent-${i}`, lastActivityMs: now - i * 1000 }))
    const old = Array.from({ length: 20 }, (_, i) => prevRow({ id: `old-${i}`, lastActivityMs: now - (8 * 24 * 60 * 60 * 1000 + i) }))
    const sections = buildSessionSections([...recent, ...old], 'device', 'recent', true, { filter: 'all', nowMs: now })
    expect(sections.filter((s) => s.kind !== 'pager').flatMap((s) => s.agents)).toHaveLength(PREVIOUS_DEFAULT_LIMIT)
    expect(sections.find((s) => s.kind === 'pager')).toMatchObject({ shown: PREVIOUS_DEFAULT_LIMIT, total: 100 })
  })
})

describe('previous band bounds', () => {
  const now = 10_000_000
  test('default window shows sessions within the last 7 days, capped at 50', () => {
    const recent = Array.from({ length: 3 }, (_, i) => prevRow({ id: `r${i}`, lastActivityMs: now - i * 1000 }))
    const old = [prevRow({ id: 'old', lastActivityMs: now - 30 * 24 * 60 * 60 * 1000 })]
    const ordered = orderedPrevious([...recent, ...old])
    expect(previousInitialCount(ordered, now)).toBe(3)
  })
  test('when everything is older than the window, require explicit paging', () => {
    const old = Array.from({ length: 20 }, (_, i) => prevRow({ id: `o${i}`, lastActivityMs: now - (30 * 24 * 60 * 60 * 1000 + i) }))
    const ordered = orderedPrevious(old)
    expect(previousInitialCount(ordered, now)).toBe(0)
  })
  test('the cap never exceeds the default limit', () => {
    const many = Array.from({ length: 80 }, (_, i) => prevRow({ id: `m${i}`, lastActivityMs: now - i * 1000 }))
    expect(previousInitialCount(orderedPrevious(many), now)).toBe(PREVIOUS_DEFAULT_LIMIT)
  })
})

describe('sessionChipCounts — All / Active / Idle / Blocked / Favorites', () => {
  test('counts each chip; Previous is not Active', () => {
    const list = [
      mk({ phase: 'running' }),
      mk({ phase: 'idle' }),
      prevRow({ id: 'prev' }),
      mk({ phase: 'done' }),
      mk({ pinned: true, phase: 'running', needs: true }),
    ]
    expect(sessionChipCounts(list)).toEqual({ all: 5, active: 1, idle: 1, blocked: 1, favorites: 1 })
  })
})
