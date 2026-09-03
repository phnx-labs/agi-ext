// Pure filter/sort/group model for the Sessions surface. No React, no DOM — every
// function here is unit-tested (sessionsModel.test.ts). The surface's whole value is
// recovering work fast, so the load-bearing rules are: filters and Status grouping
// share one CLI-field classifier, and bounded PREVIOUS history participates in every
// grouping rather than escaping into an unrelated flat band.

import { UNASSIGNED_LABEL, UNASSIGNED_PROJECT, UNASSIGNED_REASON, isUnassigned } from './sessionProjects'
import {
  isPrevious,
  sessionStatus,
  PHASE_PROGRESS_RANK,
  type FloorAgent,
  type SessionFilter,
  type SessionGroup,
  type SessionSort,
  type SessionStatus,
} from './floorModel'

/** One rendered section of the Sessions list: a header + its rows. */
export interface SessionSection {
  /** Stable key for React + scroll retention. */
  key: string
  /** Header text. */
  label: string
  /** What kind of grouping produced this section (drives header styling). */
  kind: 'project' | 'device' | 'status' | 'none' | 'pager'
  /** Shared status, when grouped by status or when this is the Previous pager. */
  status?: SessionStatus
  /** Rows in display order (already sorted). */
  agents: FloorAgent[]
  /** For the Previous band: the total resumable rows behind a bounded view, so the
   *  header can offer "Show 10 more". Absent for every other section. */
  total?: number
  /** For the Previous pager: how many bounded rows are currently visible. */
  shown?: number
  /** Why this section exists, when the label alone doesn't say it. Only the
   *  Unassigned project bucket sets it, so the orphan group is never a blank
   *  header with an unexplained count (PHNX-3796). */
  reason?: string
  /** True for the Unassigned project bucket — drives the assign-all affordance. */
  unassigned?: boolean
}

/** Rolling window a Previous session must fall inside to appear by default. */
const PREVIOUS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Default cap on Previous rows shown before "Show 10 more" pages further back. */
export const PREVIOUS_DEFAULT_LIMIT = 50
/** How many older rows each "Show 10 more" reveals. */
export const PREVIOUS_PAGE = 10

export interface SessionScope {
  filter: SessionFilter
  /** Project scope: null = all projects, '' (UNASSIGNED_PROJECT) = only the
   *  unattributed rows, otherwise an exact project name. */
  project: string | null
  /** hostLabel ?? host, or null for all. */
  host: string | null
  /** Free-text query over topic / project / host / branch / id. */
  search: string
}

const hostOf = (a: FloorAgent): string => a.hostLabel ?? a.host

/** Epoch ms of a session's last activity, falling back to its start. 0 when unknown. */
function activityMs(a: FloorAgent): number {
  return a.lastActivityMs || a.startedAtMs || 0
}

/**
 * Apply the status chip + project + host + search filters. Pure; order-independent.
 * Status chips and Group: Status use the exact same `sessionStatus` classifier.
 */
export function scopeSessions(all: FloorAgent[], scope: SessionScope): FloorAgent[] {
  const q = scope.search.trim().toLowerCase()
  return all.filter((a) => {
    if (scope.filter === 'favorites' && !a.pinned) return false
    if (scope.filter !== 'all' && scope.filter !== 'favorites' && sessionStatus(a) !== scope.filter) return false
    // `null` means all projects; '' is a real pick (the Unassigned bucket), so this
    // compares against null rather than testing truthiness.
    if (scope.project !== null && (a.project || UNASSIGNED_PROJECT) !== scope.project) return false
    if (scope.host && hostOf(a) !== scope.host) return false
    if (q) {
      const hay = `${a.name} ${a.topic ?? ''} ${a.prompt ?? ''} ${a.project} ${hostOf(a)} ${a.branch} ${a.worktreeSlug} ${a.sessionId ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

// Lower rank sorts first under 'status'. Live sessions defer to the shared
// PHASE_PROGRESS_RANK (progress, not liveness — root AGENTS.md "Purpose"), so
// `Sort: Status` puts idle-but-unfinished work above running and leaves `done`
// terminal. PREVIOUS (ended, resumable) rows rank last, matching the bottom band.
function statusRank(a: FloorAgent): number {
  if (isPrevious(a)) return PHASE_PROGRESS_RANK.done + 1
  return PHASE_PROGRESS_RANK[a.phase]
}

/**
 * Sort a list by the chosen key. `desc` reverses the natural direction (natural =
 * most-recent / newest / most-urgent / most-tokens first, and A→Z for name). Stable
 * within equal keys via a sessionId tiebreak so rows don't jitter between renders.
 */
export function sortSessions(list: FloorAgent[], sort: SessionSort, desc: boolean): FloorAgent[] {
  const dir = desc ? 1 : -1
  const arr = [...list]
  arr.sort((a, b) => {
    let cmp = 0
    switch (sort) {
      case 'recent':
        cmp = (b.lastActivityMs || 0) - (a.lastActivityMs || 0)
        break
      case 'started':
        cmp = (b.startedAtMs || 0) - (a.startedAtMs || 0)
        break
      case 'status':
        // Ascending rank (most-stopped live phase first, Previous last). At the shared
        // default dir (desc:true -> +1) this reads "most urgent first".
        cmp = statusRank(a) - statusRank(b)
        break
      case 'tok':
        cmp = (b.tok || 0) - (a.tok || 0)
        break
      case 'name': {
        // A→Z at the shared default dir (desc:true -> +1).
        const an = (a.topic || a.name || '').toLowerCase()
        const bn = (b.topic || b.name || '').toLowerCase()
        cmp = an.localeCompare(bn)
        break
      }
    }
    if (cmp === 0) cmp = (a.sessionId || a.id).localeCompare(b.sessionId || b.id)
    return cmp * dir
  })
  return arr
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: 'Active',
  idle: 'Idle',
  blocked: 'Blocked',
  previous: 'Previous',
}
const STATUS_ORDER: SessionStatus[] = ['active', 'idle', 'blocked', 'previous']

/**
 * Group the entire bounded visible list—including Previous—into ordered sections.
 * Favorites are a filter, not a second grouping rule, so a row appears exactly once.
 */
export function groupSessions(
  scoped: FloorAgent[],
  group: SessionGroup,
  sort: SessionSort,
  desc: boolean,
): SessionSection[] {
  if (scoped.length === 0) return []
  if (group === 'none') {
    return [{ key: 'all', label: 'All sessions', kind: 'none', agents: sortSessions(scoped, sort, desc) }]
  }
  if (group === 'status') {
    return STATUS_ORDER.flatMap((status) => {
      const rows = scoped.filter((a) => sessionStatus(a) === status)
      return rows.length > 0
        ? [{ key: `status:${status}`, label: STATUS_LABEL[status], kind: 'status' as const, status, agents: sortSessions(rows, sort, desc) }]
        : []
    })
  }

  // Project and Device bucket the whole bounded list, ordered by most rows first.
  // Project keys on '' for an unattributed session; Device still falls back to a
  // literal '(none)' because a session always ran SOMEWHERE.
  const keyOf = group === 'project'
    ? (a: FloorAgent) => (isUnassigned(a) ? UNASSIGNED_PROJECT : a.project)
    : (a: FloorAgent) => hostOf(a) || '(none)'
  const sections: SessionSection[] = []
  const buckets = new Map<string, FloorAgent[]>()
  for (const a of scoped) {
    const k = keyOf(a)
    const b = buckets.get(k)
    if (b) b.push(a)
    else buckets.set(k, [a])
  }
  const isOrphanBucket = (k: string) => group === 'project' && k === UNASSIGNED_PROJECT
  const ordered = [...buckets.entries()].sort((a, b) => {
    // Unassigned is always LAST, however large it is: it is the bucket of work that
    // still needs a home, not the fleet's biggest project.
    if (isOrphanBucket(a[0]) !== isOrphanBucket(b[0])) return isOrphanBucket(a[0]) ? 1 : -1
    if (b[1].length !== a[1].length) return b[1].length - a[1].length
    return a[0].localeCompare(b[0])
  })
  for (const [k, rows] of ordered) {
    const orphan = isOrphanBucket(k)
    sections.push({
      key: `${group}:${orphan ? 'unassigned' : k}`,
      label: orphan ? UNASSIGNED_LABEL : k,
      kind: group,
      agents: sortSessions(rows, sort, desc),
      ...(orphan ? { reason: UNASSIGNED_REASON, unassigned: true } : {}),
    })
  }
  return sections
}

/** Counts for the filter chips — computed once over the full (unscoped-by-chip) list. */
export function sessionChipCounts(all: FloorAgent[]): Record<SessionFilter, number> {
  let active = 0
  let idle = 0
  let blocked = 0
  let favorites = 0
  for (const a of all) {
    if (a.pinned) favorites++
    const status = sessionStatus(a)
    if (status === 'active') active++
    else if (status === 'idle') idle++
    else if (status === 'blocked') blocked++
  }
  return { all: all.length, active, idle, blocked, favorites }
}

// ---------- Previous · resumable bottom band ----------

/** Every PREVIOUS (ended, resumable) row, newest activity first. */
export function orderedPrevious(scoped: FloorAgent[]): FloorAgent[] {
  return scoped.filter(isPrevious).sort((a, b) => activityMs(b) - activityMs(a))
}

/**
 * How many Previous rows to show by default: those active within the last 7 days,
 * capped at 50. When the window holds none but resumable history exists further
 * back (a user returning after a long gap), fall back to the most-recent
 * PREVIOUS_PAGE rows instead of an empty band — "Show more" still pages beyond
 * that (PHNX-3811).
 */
export function previousInitialCount(ordered: FloorAgent[], nowMs: number): number {
  const withinWindow = ordered.filter((a) => {
    const t = activityMs(a)
    return t > 0 && nowMs - t <= PREVIOUS_WINDOW_MS
  }).length
  if (withinWindow === 0 && ordered.length > 0) return Math.min(ordered.length, PREVIOUS_PAGE)
  return Math.min(withinWindow, PREVIOUS_DEFAULT_LIMIT)
}

/**
 * The whole Sessions surface: bound Previous history first, then group the entire
 * visible list. When more Previous rows exist, append a header-only paging control;
 * the visible Previous cards stay inside the selected Project/Device/Status bucket.
 */
export function buildSessionSections(
  scoped: FloorAgent[],
  group: SessionGroup,
  sort: SessionSort,
  desc: boolean,
  opts: { filter: SessionFilter; nowMs: number; previousShown?: number },
): SessionSection[] {
  const ordered = orderedPrevious(scoped)
  const shown = Math.min(ordered.length, Math.max(0, opts.previousShown ?? previousInitialCount(ordered, opts.nowMs)))
  const visiblePreviousIds = new Set(ordered.slice(0, shown).map((a) => a.id))
  const visible = scoped.filter((a) => !isPrevious(a) || visiblePreviousIds.has(a.id))
  const sections = groupSessions(visible, group, sort, desc)
  if (ordered.length > shown) {
    sections.push({
      key: 'pager:previous',
      label: 'Previous history',
      kind: 'pager',
      status: 'previous',
      agents: [],
      shown,
      total: ordered.length,
    })
  }
  return sections
}
