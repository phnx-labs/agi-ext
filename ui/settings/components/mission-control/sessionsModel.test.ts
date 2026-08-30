import { describe, test, expect } from 'bun:test'
import type { FloorAgent } from './floorModel'
import { isPrevious, sessionBand, resumeCommand, mergeSessionAgents } from './floorModel'
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
  test('an inactive index row is Previous', () => {
    expect(isPrevious(prevRow({ id: 'p1' }))).toBe(true)
    expect(isPrevious(mk({ sessionState: 'inactive' }))).toBe(true)
    expect(isPrevious(mk({ context: 'recent' }))).toBe(true)
  })
  test('a live row is NOT Previous', () => {
    expect(isPrevious(mk({ phase: 'running' }))).toBe(false)
    expect(isPrevious(mk({ phase: 'idle', sessionState: 'idle' }))).toBe(false)
    expect(isPrevious(mk({ sessionState: undefined, context: 'terminal' }))).toBe(false)
  })
  test('sessionBand routes a Previous row to the previous band', () => {
    expect(sessionBand(prevRow({ id: 'p1' }))).toBe('previous')
    expect(sessionBand(mk({ phase: 'running' }))).toBe('active')
    expect(sessionBand(mk({ phase: 'done' }))).toBe('done')
    expect(sessionBand(mk({ phase: 'idle' }))).toBe('attention')
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

describe('scopeSessions — filter chips are exactly All / Active / Favorites', () => {
  const list = [
    mk({ id: 'run', phase: 'running' }),
    mk({ id: 'idle', phase: 'idle' }),
    mk({ id: 'done', phase: 'done' }),
    prevRow({ id: 'prev' }),
    mk({ id: 'fav', phase: 'running', pinned: true }),
  ]
  test('active keeps live still-going sessions, drops Previous + done', () => {
    expect(scopeSessions(list, { ...EMPTY, filter: 'active' }).map((a) => a.id).sort()).toEqual(['fav', 'idle', 'run'])
  })
  test('favorites keeps only pinned', () => {
    expect(scopeSessions(list, { ...EMPTY, filter: 'favorites' }).map((a) => a.id)).toEqual(['fav'])
  })
  test('all keeps everything (Previous included, lands in the bottom band)', () => {
    expect(scopeSessions(list, EMPTY)).toHaveLength(5)
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

describe('groupSessions — Favorites pinned to a single top section, Previous excluded', () => {
  const list = [
    mk({ id: 'fav', pinned: true, phase: 'running' }),
    mk({ id: 'run', phase: 'running' }),
    prevRow({ id: 'prev' }),
  ]
  test('state group leads with Favorites; Previous is NOT a live band here', () => {
    const secs = groupSessions(list, 'state', 'recent', true)
    expect(secs.map((s) => s.label)).toEqual(['Favorites', 'Running'])
    const allIds = secs.flatMap((s) => s.agents.map((a) => a.id))
    expect(allIds).not.toContain('prev')
    expect(allIds.filter((id) => id === 'fav')).toHaveLength(1)
  })
  test('filter=favorites: no separate Favorites band (the whole list is pinned)', () => {
    const onlyFav = [mk({ id: 'f1', pinned: true }), mk({ id: 'f2', pinned: true })]
    const secs = groupSessions(onlyFav, 'state', 'recent', true, /* filterIsFavorites */ true)
    expect(secs.some((s) => s.kind === 'favorites')).toBe(false)
  })
  test('all-pinned on a non-favorites filter STILL renders the Favorites band', () => {
    const onlyFav = [mk({ id: 'f1', pinned: true, phase: 'running' }), mk({ id: 'f2', pinned: true, phase: 'idle' })]
    const secs = groupSessions(onlyFav, 'state', 'recent', true, /* filterIsFavorites */ false)
    expect(secs[0]!.kind).toBe('favorites')
  })
})

describe('buildSessionSections — Previous · resumable band is always LAST', () => {
  const now = 5_000_000
  const list = [
    mk({ id: 'run', phase: 'running' }),
    mk({ id: 'idle', phase: 'idle' }),
    prevRow({ id: 'prev1', lastActivityMs: now - 1000 }),
    prevRow({ id: 'prev2', lastActivityMs: now - 2000 }),
  ]
  test('band ordering places Previous last, sorted by last activity', () => {
    const secs = buildSessionSections(list, 'state', 'recent', true, { filter: 'all', nowMs: now })
    const last = secs[secs.length - 1]!
    expect(last.band).toBe('previous')
    expect(last.label).toBe('Previous · resumable')
    expect(last.agents.map((a) => a.id)).toEqual(['prev1', 'prev2'])
    expect(last.total).toBe(2)
    // no earlier section is the previous band
    expect(secs.slice(0, -1).some((s) => s.band === 'previous')).toBe(false)
  })
  test('the Active filter hides the Previous band entirely', () => {
    const secs = buildSessionSections(list, 'state', 'recent', true, { filter: 'active', nowMs: now })
    expect(secs.some((s) => s.band === 'previous')).toBe(false)
  })
  test('the band is bounded: previousShown caps rows while total reports the full count', () => {
    const many = Array.from({ length: 60 }, (_, i) => prevRow({ id: `p${i}`, lastActivityMs: now - i * 1000 }))
    const secs = buildSessionSections(many, 'flat', 'recent', true, { filter: 'all', nowMs: now, previousShown: 50 })
    const band = secs.find((s) => s.band === 'previous')!
    expect(band.agents).toHaveLength(50)
    expect(band.total).toBe(60)
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
  test('when everything is older than the window, still seed the newest page', () => {
    const old = Array.from({ length: 20 }, (_, i) => prevRow({ id: `o${i}`, lastActivityMs: now - (30 * 24 * 60 * 60 * 1000 + i) }))
    const ordered = orderedPrevious(old)
    expect(previousInitialCount(ordered, now)).toBe(10)
  })
  test('the cap never exceeds the default limit', () => {
    const many = Array.from({ length: 80 }, (_, i) => prevRow({ id: `m${i}`, lastActivityMs: now - i * 1000 }))
    expect(previousInitialCount(orderedPrevious(many), now)).toBe(PREVIOUS_DEFAULT_LIMIT)
  })
})

describe('sessionChipCounts — all / active / favorites', () => {
  test('counts each chip; Previous is not Active', () => {
    const list = [
      mk({ phase: 'running' }),
      mk({ phase: 'idle' }),
      prevRow({ id: 'prev' }),
      mk({ phase: 'done' }),
      mk({ pinned: true, phase: 'running' }),
    ]
    expect(sessionChipCounts(list)).toEqual({ all: 5, active: 3, favorites: 1 })
  })
})
