import React, { useMemo, useState, useCallback } from 'react'
import { Icon } from './icons'
import {
  isPrevious,
  resumeCommand,
  type FloorAgent,
  type SessionFilter,
  type SessionGroup,
  type SessionSort,
} from './floorModel'
import {
  scopeSessions,
  buildSessionSections,
  sessionChipCounts,
  orderedPrevious,
  previousInitialCount,
  PREVIOUS_PAGE,
  type SessionSection,
  type SessionScope,
} from './sessionsModel'
import { sessionRowView } from './recapModel'
import { useVirtualList } from './useVirtualList'
import { useNow } from './useNow'
import { SessionRow } from './sessions/SessionRow'
import {
  ResumeDeviceMenu,
  type ResumeDevice,
  type ResumeDeviceMenuState,
} from './sessions/ResumeDeviceMenu'
import { ProjectMenu, type ProjectMenuItem, type ProjectMenuState } from './sessions/ProjectMenu'
import {
  applyProjectAssignments,
  assignProjects,
  assignableProjectNames,
  loadProjectAssignments,
  loadProjectFilter,
  persistProjectAssignments,
  persistProjectFilter,
  projectFilterLabel,
  projectFilterOptions,
  UNASSIGNED_LABEL,
  UNASSIGNED_PROJECT,
  type ProjectAssignments,
} from './sessionProjects'
import { SESSION_ROW_CSS } from './sessions/sessionRowStyles'

export { SessionRow } from './sessions/SessionRow'
export { SESSION_ROW_CSS } from './sessions/sessionRowStyles'

// The Sessions surface: one place to see every session you own — local + remote,
// active + orphaned — and resume any of them, or a whole project's worth after a
// reboot. It reads the roster AGI EXT already polls (floorAgents); every filter /
// sort / group runs client-side, and the list is virtualized (fixed-offset
// windowing below), so hundreds of rows render like twenty.

export const ROW_H = 146
const ROW_EXPANDED_EXTRA = 56
const HEADER_H = 32
const OVERSCAN = 4

interface SessionsPaneProps {
  agents: FloorAgent[]
  /** Toggle the favorite (pin) on a session — parent owns the persisted set. */
  onToggleStar: (a: FloorAgent) => void
  /** Resume / focus a single session — parent routes to the owning machine. */
  onResume: (a: FloorAgent) => void
  /** Resume a previous session on an explicitly selected alternate device. */
  onResumeOnDevice?: (a: FloorAgent, device: string) => void
  /** Fleet devices already loaded by the parent; this view never fetches them. */
  devices?: ResumeDevice[]
  /** Resume many at once (bulk). Parent loops the resume path. */
  onResumeMany: (agents: FloorAgent[]) => void
  /** Select a session for the detail pane. */
  onSelect: (a: FloorAgent) => void
  /** Currently selected session id (detail pane). */
  selectedId?: string | null
  /** True while the follower has not yet observed a CLI stream reset. */
  streamDegraded?: boolean
  /** Curated project names from the managed-projects roster the parent already
   *  loaded. They join the assign menu so a project with no live session is still
   *  pickable; this view never fetches them itself. */
  managedProjectNames?: string[]
}

type VItem =
  | { kind: 'header'; section: SessionSection; height: number; key: string }
  | { kind: 'row'; agent: FloorAgent; section: SessionSection; height: number; key: string }

function rowHeight(agent: FloorAgent, expanded: boolean, ask: string): number {
  if (!expanded) return ROW_H
  // The detail card: the ask (quoted prompt, capped), the activity bar + legend,
  // the checklist (one line per todo), and the catch-up link row. Estimate each so
  // the virtual list reserves enough space without clipping.
  const askLines = Math.min(8, Math.max(1, ask.split(/\n/).length + Math.ceil(ask.length / 88)))
  const askH = 34 + askLines * 18            // caption + goal + quoted block
  const activityH = 58                        // caption + bar + legend + span
  const todos = agent.todos ?? []
  const todoH = todos.length > 0 ? 22 + todos.length * 20 : 0
  const catchH = 40                           // caption + link row
  return ROW_H + ROW_EXPANDED_EXTRA + askH + activityH + todoH + catchH
}

const SORT_OPTS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Last active' },
  { value: 'started', label: 'Started' },
  { value: 'status', label: 'Status' },
  { value: 'name', label: 'Name' },
  { value: 'tok', label: 'Tokens/s' },
]
const GROUP_OPTS: { value: SessionGroup; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'device', label: 'Device' },
  { value: 'status', label: 'Status' },
  { value: 'none', label: 'None' },
]
const FILTER_OPTS: { value: SessionFilter; label: string; tone?: 'active' | 'idle' | 'blocked' }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active', tone: 'active' },
  { value: 'idle', label: 'Idle', tone: 'idle' },
  { value: 'blocked', label: 'Blocked', tone: 'blocked' },
  { value: 'favorites', label: 'Favorites' },
]

export function SessionsPane({ agents, onToggleStar, onResume, onResumeOnDevice, onResumeMany, devices = [], onSelect, selectedId, streamDegraded = false, managedProjectNames = [] }: SessionsPaneProps) {
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<SessionGroup>('project')
  const [sort, setSort] = useState<SessionSort>('recent')
  const [desc, setDesc] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // How many Previous rows are shown; null = the default 7-day/50 bound. "Show 10
  // more" bumps it, paging further back through the resumable history.
  const [previousShown, setPreviousShown] = useState<number | null>(null)
  const [resumeMenu, setResumeMenu] = useState<ResumeDeviceMenuState | null>(null)
  // Needs-you narrowing — the affordance the removed left icon rail used to carry
  // (PHNX-3594). A toggle over the scoped list, not one of the primary filter chips.
  const [needsOnly, setNeedsOnly] = useState(false)
  // Project scope (PHNX-3796): null = all projects, '' = the Unassigned bucket,
  // otherwise an exact project name. Persisted, so the pick survives a reload.
  const [project, setProject] = useState<string | null>(() => loadProjectFilter())
  // Manual project assignments for rows no hint could attribute — a presentation
  // override of THIS surface, persisted locally like the pinned favorites.
  const [assignments, setAssignments] = useState<ProjectAssignments>(() => loadProjectAssignments())
  const [projectMenu, setProjectMenu] = useState<
    { kind: 'filter'; targets: null; state: ProjectMenuState } |
    { kind: 'assign'; targets: FloorAgent[]; state: ProjectMenuState } |
    null
  >(null)
  const nowMs = useNow(30000)

  // Manual assignments apply BEFORE anything else reads `project`, so the filter,
  // the chip counts, the grouping, and the row all agree on one value.
  const rows = useMemo(() => applyProjectAssignments(agents, assignments), [agents, assignments])

  const projectOptions = useMemo(() => projectFilterOptions(rows), [rows])
  // A remembered pick whose project has since disappeared from the fleet would show
  // an empty list forever; fall back to All projects instead of a dead end.
  const activeProject = useMemo(
    () => (project !== null && !projectOptions.some((o) => o.value === project) ? null : project),
    [project, projectOptions],
  )
  const projectScoped = useMemo(
    () => (activeProject === null ? rows : rows.filter((a) => (a.project || UNASSIGNED_PROJECT) === activeProject)),
    [rows, activeProject],
  )

  // Chips and the needs-you badge count what the CURRENT project scope contains —
  // the point of the filter is that every number on the toolbar agrees with it.
  const counts = useMemo(() => sessionChipCounts(projectScoped), [projectScoped])
  const needsCount = useMemo(() => projectScoped.filter((a) => a.needs).length, [projectScoped])

  const scope: SessionScope = useMemo(() => ({ filter, project: activeProject, host: null, search }), [filter, activeProject, search])
  const scoped = useMemo(() => {
    const base = scopeSessions(rows, scope)
    return needsOnly ? base.filter((a) => a.needs) : base
  }, [rows, scope, needsOnly])
  const sections = useMemo(
    () => buildSessionSections(scoped, group, sort, desc, { filter, nowMs, previousShown: previousShown ?? undefined }),
    [scoped, group, sort, desc, filter, nowMs, previousShown],
  )

  // Flatten sections into a single windowable item list with per-item heights.
  const items: VItem[] = useMemo(() => {
    const out: VItem[] = []
    for (const s of sections) {
      out.push({ kind: 'header', section: s, height: HEADER_H, key: `h:${s.key}` })
      for (const a of s.agents) {
        const open = expanded.has(a.id)
        const ask = open ? sessionRowView(a).you.text : ''
        out.push({ kind: 'row', agent: a, section: s, height: rowHeight(a, open, ask), key: a.id })
      }
    }
    return out
  }, [sections, expanded])

  const { scrollRef, onScroll, visibleItems: visible, totalHeight, padTop, padBottom } = useVirtualList(items, { overscan: OVERSCAN })

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectedAgents = useMemo(() => scoped.filter((a) => selected.has(a.id)), [scoped, selected])
  // The visible Previous slice is authoritative for both bulk counts and actions.
  // Hidden history only joins after an explicit "Show 10 more" page.
  const previousAll = useMemo(() => orderedPrevious(scoped), [scoped])
  const previousTotal = previousAll.length
  const previousVisible = Math.min(previousTotal, Math.max(0, previousShown ?? previousInitialCount(previousAll, nowMs)))
  const previousVisibleRows = useMemo(() => previousAll.slice(0, previousVisible), [previousAll, previousVisible])
  const previousResumable = useMemo(() => previousVisibleRows.filter((a) => !!resumeCommand(a)), [previousVisibleRows])
  const previousHasMore = previousTotal > previousVisible
  const previousPageSize = Math.min(PREVIOUS_PAGE, Math.max(0, previousTotal - previousVisible))

  // A band's group Resume action resumes only the RESUMABLE rows it holds.
  const resumeSection = useCallback((s: SessionSection) => onResumeMany(s.agents.filter((a) => !!resumeCommand(a))), [onResumeMany])
  const showMorePrevious = useCallback(() => setPreviousShown((s) => (
    Math.min(previousAll.length, (s ?? previousInitialCount(previousAll, nowMs)) + PREVIOUS_PAGE)
  )), [previousAll, nowMs])
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const openResumeMenu = useCallback((agent: FloorAgent, event: React.MouseEvent) => {
    setResumeMenu({ agent, x: event.clientX, y: event.clientY })
  }, [])
  const closeResumeMenu = useCallback(() => setResumeMenu(null), [])

  // ----- project filter + manual assignment (PHNX-3796) -----
  const closeProjectMenu = useCallback(() => setProjectMenu(null), [])
  const openProjectFilter = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const r = event.currentTarget.getBoundingClientRect()
    setProjectMenu({ kind: 'filter', targets: null, state: { x: r.left, y: r.bottom + 6 } })
  }, [])
  const openAssignMenu = useCallback((targets: FloorAgent[], event: React.MouseEvent<HTMLButtonElement>) => {
    const r = event.currentTarget.getBoundingClientRect()
    setProjectMenu({ kind: 'assign', targets, state: { x: r.left, y: r.bottom + 6 } })
  }, [])
  const openRowAssign = useCallback((agent: FloorAgent, event: React.MouseEvent<HTMLButtonElement>) => {
    openAssignMenu([agent], event)
  }, [openAssignMenu])
  const chooseProject = useCallback((value: string | null) => {
    setProject(value)
    persistProjectFilter(value)
  }, [])
  const chooseAssignment = useCallback((targets: FloorAgent[], value: string | null) => {
    setAssignments((prev) => {
      // `null` is the menu's "Clear assignment" pick — assignProjects deletes on ''.
      const next = assignProjects(prev, targets, value ?? '')
      persistProjectAssignments(next)
      return next
    })
  }, [])
  // The assign menu offers every project in view plus the curated managed ones, so a
  // project that currently has no live session is still assignable.
  const assignItems: ProjectMenuItem[] = useMemo(
    () => assignableProjectNames(rows, managedProjectNames).map((name) => ({ value: name, label: name })),
    [rows, managedProjectNames],
  )
  const clearableTargets = useMemo(
    () => (projectMenu?.kind === 'assign' ? projectMenu.targets.some((a) => assignments[a.sessionId || a.id]) : false),
    [projectMenu, assignments],
  )

  return (
    <div className="sw-sessions">
      <style>{SESSION_ROW_CSS}</style>
      <div className="sx-filters">
        <div className="sx-chips">
          {FILTER_OPTS.map(({ value: f, label, tone }) => (
            <button
              key={f}
              className={`sx-chip${filter === f ? ' on' : ''}`}
              onClick={() => setFilter(f)}
            >
              {tone && <span className={`sx-status-dot ${tone}`} aria-hidden />}
              {label}
              <span className="n">{counts[f]}</span>
            </button>
          ))}
        </div>
        {needsCount > 0 && (
          <button
            type="button"
            className={`sx-needs${needsOnly ? ' on' : ''}`}
            title={`${needsCount} session${needsCount === 1 ? '' : 's'} need you`}
            aria-pressed={needsOnly}
            onClick={() => setNeedsOnly((v) => !v)}
          >
            <Icon name="alert" size={11} /> Needs you <span className="n">{needsCount}</span>
          </button>
        )}
        <div className="sx-search">
          <Icon name="search" size={12} />
          <input
            aria-label="Search sessions"
            placeholder="Search topic, repo, id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="sx-group" title="Filter to one project">
          Project
          <button type="button" className="sx-projbtn" aria-haspopup="menu" onClick={openProjectFilter}>
            <b>{projectFilterLabel(activeProject)}</b>
            <span aria-hidden>▾</span>
          </button>
        </label>
        <label className="sx-group" title="Group sessions">
          Group <b>{GROUP_OPTS.find((o) => o.value === group)!.label}</b>
          <select value={group} onChange={(e) => setGroup(e.target.value as SessionGroup)}>
            {GROUP_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="sx-group" title="Sort sessions">
          Sort <b>{SORT_OPTS.find((o) => o.value === sort)!.label}</b>
          <select value={sort} onChange={(e) => setSort(e.target.value as SessionSort)}>
            {SORT_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <button className="sx-dir" title={desc ? 'Descending' : 'Ascending'} onClick={() => setDesc((d) => !d)}>
          <Icon name={desc ? 'chevD' : 'chevR'} size={12} />
        </button>
      </div>

      <div className="sx-scroll" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 ? (
          <div className="sx-empty">
            {streamDegraded && rows.length === 0
              ? 'Session data unavailable. Waiting for the first snapshot…'
              : <>No sessions match. {rows.length > 0 && <button className="sx-link" onClick={() => { setFilter('all'); setSearch(''); setNeedsOnly(false); chooseProject(null) }}>Clear filters</button>}</>}
          </div>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${padTop}px)` }}>
              {visible.map((it, i) =>
                it.kind === 'header' ? (
                  <SectionHeader
                    key={it.section.key}
                    section={it.section}
                    resumableCount={it.section.agents.filter((a) => !!resumeCommand(a)).length}
                    onResumeAll={() => resumeSection(it.section)}
                    hasMore={it.section.kind === 'pager' && previousHasMore}
                    moreCount={previousPageSize}
                    onShowMore={showMorePrevious}
                    onAssignAll={openAssignMenu}
                  />
                ) : (
                  <SessionRow
                    key={it.agent.id}
                    agent={it.agent}
                    nowMs={nowMs}
                    selected={selected.has(it.agent.id)}
                    active={selectedId === it.agent.id}
                    expanded={expanded.has(it.agent.id)}
                    height={it.height}
                    onToggleSelect={toggleSelect}
                    onToggleStar={onToggleStar}
                    onResume={onResume}
                    onResumeContext={onResumeOnDevice ? openResumeMenu : undefined}
                    onSelect={onSelect}
                    onToggleExpand={toggleExpand}
                    onAssignProject={openRowAssign}
                  />
                )
              )}
              {/* bottom spacer keeps the scrollbar honest */}
              <div style={{ height: padBottom }} aria-hidden />
            </div>
          </div>
        )}
      </div>

      {(selected.size > 0 || previousResumable.length > 0) && (
        <div className="sx-bulk">
          {selected.size > 0 ? (
            <>
              <span className="sx-bulk-n"><b>{selected.size}</b> selected</span>
              <button className="sx-ghost" onClick={() => setSelected(new Set(scoped.map((a) => a.id)))}>Select all ({scoped.length})</button>
              <button className="sx-ghost" onClick={() => setSelected(new Set())}>Clear</button>
              <button className="sx-ghost" onClick={() => selectedAgents.forEach(onToggleStar)}>Favorite</button>
              <button className="sx-primary" onClick={() => onResumeMany(selectedAgents.filter((a) => !!resumeCommand(a)))}>Resume {selected.size} selected</button>
            </>
          ) : (
            <>
              <span className="sx-bulk-n"><b>{previousResumable.length}</b> previous · resumable</span>
              <button className="sx-primary" onClick={() => onResumeMany(previousResumable)}>Resume all {previousResumable.length}</button>
            </>
          )}
        </div>
      )}
      {projectMenu?.kind === 'filter' && (
        <ProjectMenu
          title="Filter to a project"
          items={projectOptions}
          selected={activeProject}
          state={projectMenu.state}
          onChoose={chooseProject}
          onClose={closeProjectMenu}
        />
      )}
      {projectMenu?.kind === 'assign' && (
        <ProjectMenu
          title={projectMenu.targets.length > 1 ? `Assign ${projectMenu.targets.length} sessions to…` : 'Assign this session to…'}
          items={clearableTargets ? [{ value: null, label: 'Clear assignment' }, ...assignItems] : assignItems}
          state={projectMenu.state}
          onChoose={(value) => chooseAssignment(projectMenu.targets, value)}
          onClose={closeProjectMenu}
          emptyLabel="No projects to assign to yet"
        />
      )}
      {resumeMenu && onResumeOnDevice && (
        <ResumeDeviceMenu
          state={resumeMenu}
          devices={devices}
          onChoose={onResumeOnDevice}
          onClose={closeResumeMenu}
        />
      )}
    </div>
  )
}

function SectionHeaderImpl({ section, resumableCount, onResumeAll, hasMore, moreCount, onShowMore, onAssignAll }: {
  section: SessionSection
  resumableCount: number
  onResumeAll: () => void
  hasMore: boolean
  moreCount: number
  onShowMore: () => void
  /** Bulk-assign every row under this header (Unassigned band only). */
  onAssignAll?: (agents: FloorAgent[], event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  const isPrev = section.status === 'previous'
  const countLabel = section.kind === 'pager' && section.total !== undefined
    ? `${section.shown ?? 0} shown of ${section.total}`
    : String(section.agents.length)
  return (
    <div className={`sx-band${isPrev ? ' previous' : ''}${section.status ? ` ${section.status}` : ''}`} style={{ height: HEADER_H }}>
      <span className="g" aria-hidden />
      <span className="lab">{section.label}</span>
      <span className="cnt">{countLabel}</span>
      {section.reason && <span className="why">· {section.reason}</span>}
      {section.unassigned && onAssignAll && section.agents.length > 0 && (
        <button
          type="button"
          className="sx-band-assign"
          title={`Assign all ${section.agents.length} unassigned sessions to a project`}
          onClick={(e) => { e.stopPropagation(); onAssignAll(section.agents, e) }}
        >assign all ▾</button>
      )}
      {hasMore && (
        <button className="sx-band-more" onClick={(e) => { e.stopPropagation(); onShowMore() }}>Show {moreCount} more</button>
      )}
      {resumableCount > 0 && (
        <button className="sx-band-act" onClick={(e) => { e.stopPropagation(); onResumeAll() }}>Resume all {resumableCount}</button>
      )}
    </div>
  )
}
const SectionHeader = React.memo(SectionHeaderImpl)
