// Pure filter/sort/group model for the Sessions surface. No React, no DOM — every
// function here is unit-tested (sessionsModel.test.ts). The surface's whole value is
// recovering work fast, so the load-bearing rules are: favorite sessions are always
// reachable at the top, and PREVIOUS sessions (crashed / ended but resumable, folded
// in from the durable transcript index) surface in a bounded bottom band so a reboot
// that prunes dead PIDs never loses them.

import {
  isPrevious,
  sessionBand,
  PHASE_PROGRESS_RANK,
  type FloorAgent,
  type SessionBand,
  type SessionFilter,
  type SessionGroup,
  type SessionSort,
} from './floorModel'

/** One rendered section of the Sessions list: a header + its rows. */
export interface SessionSection {
  /** Stable key for React + scroll retention. */
  key: string
  /** Header text. */
  label: string
  /** What kind of grouping produced this section (drives header styling). */
  kind: 'favorites' | 'band' | 'project' | 'host'
  /** The state band, when kind === 'band'. */
  band?: SessionBand
  /** Rows in display order (already sorted). */
  agents: FloorAgent[]
  /** For the Previous band: the total resumable rows behind a bounded view, so the
   *  header can offer "Show 10 more". Absent for every other section. */
  total?: number
}

/** Rolling window a Previous session must fall inside to appear by default. */
export const PREVIOUS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Default cap on Previous rows shown before "Show 10 more" pages further back. */
export const PREVIOUS_DEFAULT_LIMIT = 50
/** How many older rows each "Show 10 more" reveals. */
export const PREVIOUS_PAGE = 10

export interface SessionScope {
  filter: SessionFilter
  /** Exact project name, or null for all. */
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

/** True when a session is a live, still-going one — not Previous, not finished. */
function isActive(a: FloorAgent): boolean {
  return !isPrevious(a) && a.phase !== 'done'
}

/**
 * Apply the status chip + project + host + search filters. Pure; order-independent.
 * 'favorites' keeps only pinned rows; 'active' keeps only live still-going sessions
 * (drops Previous + done); 'all' keeps everything (Previous rows land in the bottom band).
 */
export function scopeSessions(all: FloorAgent[], scope: SessionScope): FloorAgent[] {
  const q = scope.search.trim().toLowerCase()
  return all.filter((a) => {
    if (scope.filter === 'favorites' && !a.pinned) return false
    if (scope.filter === 'active' && !isActive(a)) return false
    if (scope.project && a.project !== scope.project) return false
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
        // Ascending rank (reconnect=0 first). At the shared default dir (desc:true
        // -> +1) this reads "most urgent first".
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

const BAND_LABEL: Record<SessionBand, string> = {
  attention: 'Needs attention',
  active: 'Running',
  done: 'Recently finished',
  previous: 'Previous · resumable',
}
// Ranked by progress (root AGENTS.md "Purpose"): live work that has STOPPED
// progressing (attention) first, then healthy running work, then done. PREVIOUS
// is never in this list — it is appended as a bounded bottom band by
// buildSessionSections, always last.
const BAND_ORDER: SessionBand[] = ['attention', 'active', 'done']

/**
 * Group the LIVE (non-Previous) scoped list into ordered sections. Favorite sessions
 * are lifted into a single "Favorites" section at the very top (so they are always
 * one glance away), and are NOT repeated below — EXCEPT when the filter is already
 * 'favorites', where the whole list is pinned and a separate band would be noise.
 * Everything else is grouped by `group`, and every section is sorted by (`sort`,`desc`).
 *
 * PREVIOUS rows are NOT grouped here — buildSessionSections appends them as a bounded
 * bottom band. A caller that wants the whole surface (live + Previous) uses
 * buildSessionSections, not this directly.
 */
export function groupSessions(
  scoped: FloorAgent[],
  group: SessionGroup,
  sort: SessionSort,
  desc: boolean,
  /** True when the active status filter is already 'favorites' — then the whole list
   *  is pinned, so a separate top "Favorites" section would be pure noise. Keyed off
   *  the actual filter, NOT "every visible row happens to be pinned" (which would
   *  also drop the section for a user whose only sessions are all favorited on the
   *  'all' filter — the exact case the top section exists for). */
  filterIsFavorites = false,
): SessionSection[] {
  const sections: SessionSection[] = []

  // Previous rows never enter the grouped live sections — they are the bottom band.
  const live = scoped.filter((a) => !isPrevious(a))
  const favorites = filterIsFavorites ? [] : live.filter((a) => a.pinned)
  const rest = filterIsFavorites ? live : live.filter((a) => !a.pinned)

  if (favorites.length) {
    sections.push({ key: 'favorites', label: 'Favorites', kind: 'favorites', agents: sortSessions(favorites, sort, desc) })
  }

  if (group === 'flat') {
    if (rest.length) sections.push({ key: 'all', label: 'All sessions', kind: 'band', agents: sortSessions(rest, sort, desc) })
    return sections
  }

  if (group === 'state') {
    for (const band of BAND_ORDER) {
      const inBand = rest.filter((a) => sessionBand(a) === band)
      if (inBand.length) {
        // The attention band exists to surface work that has STOPPED progressing, so
        // it always leads with the MOST-stuck session (oldest activity) — the highest
        // abandonment risk — independent of the list-wide sort. Other bands honor the
        // chosen (`sort`,`desc`).
        const agents = band === 'attention'
          ? [...inBand].sort((a, b) => {
              const d = (a.lastActivityMs || 0) - (b.lastActivityMs || 0)
              return d !== 0 ? d : (a.sessionId || a.id).localeCompare(b.sessionId || b.id)
            })
          : sortSessions(inBand, sort, desc)
        sections.push({ key: `band:${band}`, label: BAND_LABEL[band], kind: 'band', band, agents })
      }
    }
    return sections
  }

  // group === 'project' | 'host': bucket by key, order buckets by "most rows first"
  // so the busiest projects/machines rise to the top (Previous work is the bottom band,
  // not folded in here).
  const keyOf = group === 'project' ? (a: FloorAgent) => a.project : hostOf
  const buckets = new Map<string, FloorAgent[]>()
  for (const a of rest) {
    const k = keyOf(a) || '(none)'
    const b = buckets.get(k)
    if (b) b.push(a)
    else buckets.set(k, [a])
  }
  const ordered = [...buckets.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length
    return a[0].localeCompare(b[0])
  })
  for (const [k, rows] of ordered) {
    sections.push({
      key: `${group}:${k}`,
      label: k,
      kind: group === 'project' ? 'project' : 'host',
      agents: sortSessions(rows, sort, desc),
    })
  }
  return sections
}

/** Counts for the filter chips — computed once over the full (unscoped-by-chip) list. */
export function sessionChipCounts(all: FloorAgent[]): Record<SessionFilter, number> {
  let active = 0
  let favorites = 0
  for (const a of all) {
    if (a.pinned) favorites++
    if (!isPrevious(a) && a.phase !== 'done') active++
  }
  return { all: all.length, active, favorites }
}

/**
 * Fold the resumable PREVIOUS index rows into the live roster for the Sessions
 * surface only. Deduped by `sessionId` with the LIVE row always winning — a session
 * that is both in the live stream and the durable index is shown once, as live, never
 * as a stale Previous duplicate. Index rows with no sessionId (can't be keyed) and
 * every live row are kept. Pure so the dedup is unit-tested; the merged list is passed
 * ONLY to SessionsPane, never to the live feed (previous rows must not leak there).
 */
export function mergeSessionsWithPrevious(live: FloorAgent[], previous: FloorAgent[]): FloorAgent[] {
  const liveIds = new Set(live.map((a) => a.sessionId).filter((id): id is string => !!id))
  const extra = previous.filter((a) => !a.sessionId || !liveIds.has(a.sessionId))
  return [...live, ...extra]
}

// ---------- Previous · resumable bottom band ----------

/** Every PREVIOUS (ended, resumable) row, newest activity first. */
export function orderedPrevious(scoped: FloorAgent[]): FloorAgent[] {
  return scoped.filter(isPrevious).sort((a, b) => activityMs(b) - activityMs(a))
}

/**
 * How many Previous rows to show by default: those active within the last 7 days,
 * capped at 50. When everything resumable is older than the window (nothing recent),
 * still seed the band with the newest page so a reboot's recoverable work is never
 * fully hidden — "Show 10 more" then pages further back through the rest.
 */
export function previousInitialCount(ordered: FloorAgent[], nowMs: number): number {
  const withinWindow = ordered.filter((a) => {
    const t = activityMs(a)
    return t > 0 && nowMs - t <= PREVIOUS_WINDOW_MS
  }).length
  if (withinWindow > 0) return Math.min(withinWindow, PREVIOUS_DEFAULT_LIMIT)
  return Math.min(ordered.length, PREVIOUS_PAGE)
}

/**
 * The whole Sessions surface: the grouped LIVE sections, then — unless the filter is
 * 'active' — a single bounded "Previous · resumable" band appended LAST. `shown`
 * caps the band's rows (the component grows it via "Show 10 more"); the section
 * carries the full resumable `total` so the header can offer paging + Resume all N.
 */
export function buildSessionSections(
  scoped: FloorAgent[],
  group: SessionGroup,
  sort: SessionSort,
  desc: boolean,
  opts: { filter: SessionFilter; nowMs: number; previousShown?: number },
): SessionSection[] {
  const sections = groupSessions(scoped, group, sort, desc, opts.filter === 'favorites')
  if (opts.filter === 'active') return sections
  const ordered = orderedPrevious(scoped)
  if (ordered.length === 0) return sections
  const shown = opts.previousShown ?? previousInitialCount(ordered, opts.nowMs)
  sections.push({
    key: 'band:previous',
    label: BAND_LABEL.previous,
    kind: 'band',
    band: 'previous',
    agents: ordered.slice(0, Math.max(0, shown)),
    total: ordered.length,
  })
  return sections
}
