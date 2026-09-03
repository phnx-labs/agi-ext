// Project attribution + the Sessions surface's project filter. Pure (no React, no
// DOM beyond localStorage helpers) and unit-tested in sessionProjects.test.ts.
//
// WHY THIS EXISTS (PHNX-3796). A session's project used to come from ONE signal:
// resolve its cwd. Cloud and factory runs have no local cwd, so 48 of them fell
// into a bucket whose header was literally the em-dash placeholder — a blank group.
// Two fixes live here:
//
//   1. Attribution is widened to every project hint the stream row already carries
//      — worktree path, the CLI's repo word, the cloud run's PR repo slug, and the
//      weak branch / worktree-slug / team hints — matched with the SAME
//      matchLinearProject the host uses to bind a folder to a Linear project
//      (@shared/linearProjects). No new fetch, no polling: every hint is a field
//      already on the projected session row.
//   2. A session no hint can attribute is Unassigned — a named bucket with a stated
//      reason, never a blank header — and the user can assign it by hand.
//
// Manual assignment is a presentation preference of THIS dashboard (like pinned
// favorites), so it is persisted locally rather than written back to the CLI.

import { resolveProject, type ProjectRule } from '@shared/project'
import { matchLinearProject, type LinearProjectLite } from '@shared/linearProjects'
import type { FloorAgent } from './floorModel'

/** `FloorAgent.project` for a session no hint could attribute. */
export const UNASSIGNED_PROJECT = ''
/** Header/menu label for the unattributed bucket. Never render a blank one. */
export const UNASSIGNED_LABEL = 'Unassigned'
/** Why those rows are unattributed — stated inline so the bucket isn't a mystery. */
export const UNASSIGNED_REASON = 'cloud & no-repo runs — no cwd to match'

/** Which hint attributed a session. 'none' = genuinely repo-less -> Unassigned. */
type ProjectSource = 'cwd' | 'repo' | 'cloud' | 'branch' | 'worktree' | 'actor' | 'none'

/** Every project hint a projected session row can carry. All optional: a row that
 *  carries none of them is the genuinely repo-less case the Unassigned bucket names. */
export interface SessionProjectHints {
  /** Working directory — the strongest signal, and the only one before PHNX-3796. */
  cwd?: string | null
  /** Absolute worktree path; a cwd by another name when the row omitted cwd. */
  worktreePath?: string | null
  /** The CLI's repo/project word for the row ("phnx-labs/agi-ext", "agents-cli"). */
  repo?: string | null
  /** The row's PR URL — a cloud run's repo slug lives in it (github.com/o/r/pull/N). */
  prUrl?: string | null
  /** Branch name. Weak: only binds to an already-known project, exactly. */
  branch?: string | null
  /** `.agents/worktrees/<slug>` slug. Weak, same rule as branch. */
  worktreeSlug?: string | null
  /** The acting team (teams context / spawned team). Weak, same rule as branch. */
  team?: string | null
}

export interface SessionProjectAttribution {
  /** The resolved project name, or UNASSIGNED_PROJECT ('') when nothing matched. */
  project: string
  source: ProjectSource
}

export interface AttributeOptions {
  /** User cwd->project rules (same rules the rest of the Fleet view uses). */
  rules?: ProjectRule[]
  /** Project names already known — other sessions' projects plus the managed
   *  projects roster. Weak hints may only bind to one of these. */
  known?: string[]
}

/**
 * Words the CLI puts in a row's project slot when there is no repo — a run CONTEXT,
 * not a project. Attributing "cloud" as a project just renames the blank bucket.
 */
const CONTEXT_WORDS = new Set(['cloud', 'recent', 'team', 'teams', 'headless', 'terminal', 'session', 'unknown', 'none'])

/** Last path segment of a slug/path ("phnx-labs/agi-ext" -> "agi-ext"). */
function lastSegment(s: string): string {
  return s.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? ''
}

/** Project names -> the {id,name} shape matchLinearProject compares against. */
function toLite(names: string[]): LinearProjectLite[] {
  const seen = new Set<string>()
  const out: LinearProjectLite[] = []
  for (const name of names) {
    const n = (name || '').trim()
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push({ id: n, name: n })
  }
  return out
}

/** "https://github.com/phnx-labs/agi-ext/pull/42" -> "phnx-labs/agi-ext". */
export function repoSlugFromUrl(url: string | null | undefined): string {
  const m = (url || '').match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i)
  if (!m) return ''
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`
}

/** A repo-ish hint, or '' when the value is only a run-context word. */
function repoHint(raw: string | null | undefined): string {
  const v = (raw || '').trim()
  if (!v) return ''
  return CONTEXT_WORDS.has(v.toLowerCase()) ? '' : v
}

/**
 * Bind a WEAK hint (branch, worktree slug, team) to a project. Weak hints are
 * near-arbitrary strings, so only an EXACT normalized match against an already-known
 * project counts: a branch that merely contains a project's word ("rush-the-fix")
 * says nothing about which project the session belongs to. Each `/`-separated
 * segment gets a try, so "agents-cli/fix-lease" still finds "agents-cli".
 */
function matchWeakHint(raw: string | null | undefined, known: LinearProjectLite[]): string {
  const v = (raw || '').trim()
  if (!v || known.length === 0) return ''
  for (const segment of v.split(/[/\s]+/).filter(Boolean)) {
    const hit = matchLinearProject(segment, known, { fuzzy: false })
    if (hit) return hit.name
  }
  return ''
}

/**
 * Resolve one session's project from every hint it carries, strongest first:
 *
 *   cwd / worktree path  -> the existing rule + worktree-fold resolution
 *   CLI repo word        -> matchLinearProject (word-wise containment allowed: it IS
 *                           a repo slug, so "o/agents-cli-web" folds onto "agents-cli"
 *                           while "o/crush-cli" never folds onto "rush")
 *   PR repo slug         -> same, and this is how a cloud run gets its project
 *   branch / slug / team -> exact match against an already-known project only
 *
 * Nothing matched means genuinely repo-less: UNASSIGNED_PROJECT, source 'none'.
 * A prompt/label is deliberately NOT mined — free text names projects it isn't
 * working on, and a wrong project is worse than an honest Unassigned.
 */
export function attributeSessionProject(
  hints: SessionProjectHints,
  opts: AttributeOptions = {},
): SessionProjectAttribution {
  const known = toLite(opts.known ?? [])
  const rules = opts.rules ?? []

  const dir = (hints.cwd || '').trim() || (hints.worktreePath || '').trim()
  if (dir) {
    const fromCwd = resolveProject(dir, rules)
    if (fromCwd) return { project: fromCwd, source: 'cwd' }
  }

  const repo = repoHint(hints.repo)
  if (repo) {
    return { project: matchLinearProject(repo, known)?.name || lastSegment(repo) || repo, source: 'repo' }
  }

  const cloudRepo = repoSlugFromUrl(hints.prUrl)
  if (cloudRepo) {
    return { project: matchLinearProject(cloudRepo, known)?.name || lastSegment(cloudRepo), source: 'cloud' }
  }

  const branch = matchWeakHint(hints.branch, known)
  if (branch) return { project: branch, source: 'branch' }
  const slug = matchWeakHint(hints.worktreeSlug, known)
  if (slug) return { project: slug, source: 'worktree' }
  const team = matchWeakHint(hints.team, known)
  if (team) return { project: team, source: 'actor' }

  return { project: UNASSIGNED_PROJECT, source: 'none' }
}

/** True when a row landed in the Unassigned bucket. */
export function isUnassigned(agent: FloorAgent): boolean {
  return !(agent.project || '').trim()
}

// ---------- the Project filter control ----------

/**
 * One entry in the Project filter. `value` is the scope it selects:
 *   null -> All projects · '' -> Unassigned · otherwise the exact project name.
 */
export interface ProjectFilterOption {
  value: string | null
  label: string
  count: number
}

/**
 * Build the Project menu over the full session list: All projects first (total),
 * then each project by session count desc / name asc, then Unassigned LAST — it is
 * a real pick, not a leftover, but it never outranks work with a home. Unassigned
 * is listed only when something is actually unattributed.
 */
export function projectFilterOptions(agents: FloorAgent[]): ProjectFilterOption[] {
  const counts = new Map<string, number>()
  let unassigned = 0
  for (const a of agents) {
    if (isUnassigned(a)) { unassigned++; continue }
    counts.set(a.project, (counts.get(a.project) ?? 0) + 1)
  }
  const named = [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([label, count]): ProjectFilterOption => ({ value: label, label, count }))
  const out: ProjectFilterOption[] = [{ value: null, label: 'All projects', count: agents.length }, ...named]
  if (unassigned > 0) out.push({ value: UNASSIGNED_PROJECT, label: UNASSIGNED_LABEL, count: unassigned })
  return out
}

/** Case-insensitive substring filter behind the menu's search box. Generic over the
 *  item shape so the filter menu and the two assign menus share one implementation. */
export function filterProjectOptions<T extends { label: string }>(options: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((o) => o.label.toLowerCase().includes(q))
}

/** Label for the current pick, for the collapsed control. */
export function projectFilterLabel(value: string | null): string {
  if (value === null) return 'All projects'
  return value || UNASSIGNED_LABEL
}

// ---------- manual assignment (per row + bulk) ----------

/** sessionId (stable across restarts) or the row id when the CLI gave none. */
export function sessionAssignmentKey(agent: FloorAgent): string {
  return agent.sessionId || agent.id
}

/** Session key -> the project the user assigned it to. */
export type ProjectAssignments = Record<string, string>

/** Overlay the user's manual assignments on a session list. Identity-stable: rows
 *  without an assignment are returned as-is so React memoization still holds. */
export function applyProjectAssignments(agents: FloorAgent[], assignments: ProjectAssignments): FloorAgent[] {
  if (!assignments || Object.keys(assignments).length === 0) return agents
  return agents.map((a) => {
    const project = assignments[sessionAssignmentKey(a)]
    return project && project !== a.project ? { ...a, project } : a
  })
}

/** Assign one or many sessions to a project; an empty project clears the assignment. */
export function assignProjects(
  assignments: ProjectAssignments,
  agents: FloorAgent[],
  project: string,
): ProjectAssignments {
  const next = { ...assignments }
  for (const a of agents) {
    const key = sessionAssignmentKey(a)
    if (project) next[key] = project
    else delete next[key]
  }
  return next
}

/** Projects the assign menus offer: every attributed project in view, plus the
 *  curated managed projects (so a project with no live session is still pickable). */
export function assignableProjectNames(agents: FloorAgent[], extra: string[] = []): string[] {
  const names = new Set<string>()
  for (const a of agents) if (!isUnassigned(a)) names.add(a.project)
  for (const e of extra) if (e && e.trim()) names.add(e.trim())
  return [...names].sort((a, b) => a.localeCompare(b))
}

// ---------- persistence (same localStorage convention as savedViews) ----------

const FILTER_KEY = 'swarm.sessions.projectFilter'
const ASSIGN_KEY = 'swarm.sessions.projectAssignments'

/** Last picked project scope. `undefined` in storage -> All projects. */
export function loadProjectFilter(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function persistProjectFilter(value: string | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (value === null) localStorage.removeItem(FILTER_KEY)
    else localStorage.setItem(FILTER_KEY, JSON.stringify(value))
  } catch {
    // storage full / unavailable — the filter is a convenience, not critical
  }
}

export function loadProjectAssignments(): ProjectAssignments {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(ASSIGN_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: ProjectAssignments = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function persistProjectAssignments(assignments: ProjectAssignments): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(ASSIGN_KEY, JSON.stringify(assignments))
  } catch {
    // storage full / unavailable — assignments are a convenience, not critical
  }
}
