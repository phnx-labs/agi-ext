// Pure filter / sort / search helpers for the two backlog surfaces — BenchTab's
// unified-task work queue and BacklogCenter's floor ticket list. Both used to
// carry their own inline copies of the priority ranking, the source-then-priority
// -then-due comparator, and an ad-hoc id/title/label search; this is the single
// tested home for that logic. Keep it pure (no React, no vscode) so the
// behaviour is unit-checkable in isolation.

import type { FloorTicket, TicketSource } from './floorModel'

/**
 * Priority ranking shared by every list sort: lower rank sorts first. Keyed by
 * the UnifiedTask priority words ('urgent' | 'high' | 'medium' | 'low'). An
 * unknown / missing priority is treated as rank 99 by the callers below.
 */
export const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** Source ordering for the work queue: Linear tasks before GitHub tasks. */
const SOURCE_ORDER: Record<string, number> = {
  linear: 0,
  github: 1,
}

export type TaskSortOption = 'priority' | 'due' | 'priority+due'

/** Minimal shape the task sort/filter helpers read off a UnifiedTask/FlatTask. */
interface SortableTask {
  source: string
  priority?: string
  metadata?: { dueDate?: string; repo?: string }
}

/**
 * Due-date sort key in epoch millis; tasks with no due date sort last
 * (Number.MAX_SAFE_INTEGER), matching the inline BenchTab behaviour.
 */
export function dueSortValue(task: SortableTask): number {
  const due = task.metadata?.dueDate
  if (!due) return Number.MAX_SAFE_INTEGER
  return new Date(due).getTime()
}

/**
 * Sort tasks by source order, then (per `sortBy`) priority and/or due date.
 * Returns a new array; the input is not mutated. Ordering is identical to the
 * former inline comparator in BenchTab: source always wins first, then the
 * selected keys break ties in order.
 */
export function sortTasks<T extends SortableTask>(tasks: T[], sortBy: TaskSortOption): T[] {
  return [...tasks].sort((a, b) => {
    const sourceDiff = (SOURCE_ORDER[a.source] ?? 0) - (SOURCE_ORDER[b.source] ?? 0)
    if (sourceDiff !== 0) return sourceDiff

    if (sortBy === 'priority' || sortBy === 'priority+due') {
      const ra = a.priority ? PRIORITY_ORDER[a.priority] ?? 99 : 99
      const rb = b.priority ? PRIORITY_ORDER[b.priority] ?? 99 : 99
      if (ra !== rb) return ra - rb
    }

    if (sortBy === 'due' || sortBy === 'priority+due') {
      const da = dueSortValue(a)
      const db = dueSortValue(b)
      if (da !== db) return da - db
    }

    return 0
  })
}

export interface TaskFilterOptions {
  /** Sources whose tasks are visible (the active source chips). */
  activeSources: Set<string>
  /** 'all' shows every repo; any other value scopes to that `metadata.repo`. */
  repoFilter: string
}

/** Filter tasks by active source chips and the repo selector. Pure. */
export function filterTasks<T extends SortableTask>(tasks: T[], opts: TaskFilterOptions): T[] {
  let out = tasks.filter((t) => opts.activeSources.has(t.source))
  if (opts.repoFilter !== 'all') {
    out = out.filter((t) => t.metadata?.repo === opts.repoFilter)
  }
  return out
}

/**
 * Case-insensitive substring search over one item across several string / string[]
 * accessors. An empty (or whitespace-only) query matches everything, matching the
 * `!q ||` short-circuit the callers used inline. A field returning null/undefined is
 * skipped; an array field matches if any element contains the query.
 */
export function matchesSearch<T>(
  item: T,
  query: string,
  fields: Array<(item: T) => string | string[] | null | undefined>,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return fields.some((get) => {
    const value = get(item)
    if (value == null) return false
    if (Array.isArray(value)) return value.some((s) => s.toLowerCase().includes(q))
    return value.toLowerCase().includes(q)
  })
}

export interface TicketFilterOptions {
  /** null = all projects; a project name scopes the list. */
  projFilter: string | null
  /** Which ticket sources are visible (Linear / GitHub). */
  srcFilter: Record<TicketSource, boolean>
  /** Free-text query matched against id / title / labels. */
  search: string
}

/**
 * Filter the backlog ticket list: drop completed tickets, honour the project and
 * source selectors, and apply the free-text search across id / title / labels.
 * Pure — sorting and grouping stay with floorModel's sortTickets/groupTickets.
 */
export function filterTickets(tickets: FloorTicket[], opts: TicketFilterOptions): FloorTicket[] {
  return tickets.filter(
    (t) =>
      t.status !== 'done' &&
      (opts.projFilter === null || t.project === opts.projFilter) &&
      opts.srcFilter[t.source] &&
      matchesSearch(t, opts.search, [(x) => x.id, (x) => x.title, (x) => x.labels || []]),
  )
}
