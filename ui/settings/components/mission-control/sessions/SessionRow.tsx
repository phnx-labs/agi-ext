import React, { useEffect, useRef } from 'react'
import { isPrevious, type FloorAgent } from '../floorModel'
import { sessionRowView, type SessionRowView } from '../recapModel'
import { AgentAvatar, agentIdFromPrefix } from '../AgentAvatar'
import { ExpandedCard } from './ExpandedCard'
import { RowLinks } from './RowLinks'
import { formatRelativeTime } from './sessionTime'
import { previousResumeMessage, resumeSourceDevice } from './sessionActions'
import { isUnassigned } from '../sessionProjects'

export interface SessionRowProps {
  agent: FloorAgent
  nowMs: number
  selected: boolean
  active: boolean
  expanded: boolean
  height: number
  onToggleSelect: (id: string) => void
  onToggleStar: (agent: FloorAgent) => void
  onResume: (agent: FloorAgent) => void
  onSelect: (agent: FloorAgent) => void
  onToggleExpand: (id: string) => void
  onResumeContext?: (agent: FloorAgent, event: React.MouseEvent<HTMLButtonElement>) => void
  /** Open the assign-project menu for this row. Absent -> no assign affordance. */
  onAssignProject?: (agent: FloorAgent, event: React.MouseEvent<HTMLButtonElement>) => void
  /** Reports an expanded row's rendered height, so the list reserves exactly that. */
  onMeasure?: (id: string, height: number) => void
}

// The row's vertical padding plus its bottom border (floor.css .sx-row).
const ROW_CHROME_H = 25

function PromptChips({ you }: { you: SessionRowView['you'] }) {
  if (you.kind === 'image') return <><span className="sx-imgchip">{'🖼'} screenshot</span>{you.text}</>
  if (you.kind === 'command') return <><span className="sx-cmdchip">$ {you.chip}</span>{you.text}</>
  if (you.kind === 'skill') return <><span className="sx-slashchip">{you.chip}</span>{you.text}</>
  return <>{you.text}</>
}

/** Which optional lines the collapsed row renders; the virtual list sizes rows from it. */
export function collapsedLines(a: FloorAgent, row: SessionRowView): { step: string; now: boolean; you: boolean; agent: boolean } {
  const previous = isPrevious(a)
  const live = previous ? '' : ((a.summary || '').trim() || (a.verb ? `${a.verb} ${a.target}`.trim() : ''))
  // A stream row's live activity is the agent's latest words; the Agent line already
  // shows them, so the now-line appears only when it says something else.
  const step = live && row.lastFull.includes(live) ? '' : live
  const now = Boolean(step) || (!previous && (a.todos?.length ?? 0) > 0)
  return { step, now, you: row.youIsReal, agent: Boolean(row.lastLine) }
}

const PHASE_LABEL: Record<string, string> = {
  running: 'working', idle: 'idle', waiting: 'waiting', failed: 'failed', done: 'done',
}

function SessionRowImpl({
  agent: a, nowMs, selected, active, expanded, height,
  onToggleSelect, onToggleStar, onResume, onSelect, onToggleExpand, onResumeContext, onAssignProject, onMeasure,
}: SessionRowProps) {
  const growRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const grow = growRef.current
    if (!expanded || !onMeasure || !grow || typeof ResizeObserver === 'undefined') return
    const report = () => onMeasure(a.id, Math.ceil(grow.getBoundingClientRect().height) + ROW_CHROME_H)
    const watch = new ResizeObserver(report)
    watch.observe(grow)
    return () => watch.disconnect()
  }, [expanded, onMeasure, a.id])
  const previous = isPrevious(a)
  const canResume = !previous || !!previousResumeMessage(a)
  const resumeTitle = previous
    ? `Resume — relaunch from the transcript on ${a.sourceDevice || a.hostLabel || a.host}`
    : 'Resume this session'
  const row = sessionRowView(a)
  const liveClass = row.live === 'run' ? '' : row.live
  // The streamed harness id is authoritative. In particular, both the generic
  // Agents runner and Antigravity use the legacy AG abbreviation, but ship
  // distinct logos.
  const agentId = (a.agentType || agentIdFromPrefix(a.abbr) || row.harnessTag || 'agent').toLowerCase()
  const phaseClass = a.needs ? 'needs' : (a.phase || 'running')
  const phaseLabel = previous ? '' : a.needs ? 'needs you' : (PHASE_LABEL[a.phase] ?? a.phase ?? '')
  const lines = collapsedLines(a, row)
  const step = lines.step
  // "You ›" asserts the user actually typed something: it shows only when the CLI
  // carried a genuine user turn. A synthesized task label (topic, worktree slug, tab
  // name) never masquerades as the user's own words (PHNX-3939). "Agent ›" is the
  // agent's own latest words and is likewise omitted when the row carries none.
  const todos = a.todos ?? []
  const todoDone = todos.filter((todo) => String(todo.status) === 'completed').length
  return (
    <div
      className={`sx-row${selected ? ' sel' : ''}${active ? ' active' : ''}`}
      style={{ height }}
      onClick={() => onSelect(a)}
    >
      <button
        className={`sx-expandbtn${expanded ? ' on' : ''}`}
        title={expanded ? 'Collapse details' : 'Expand details'}
        aria-label={expanded ? 'Collapse details' : 'Expand details'}
        aria-expanded={expanded}
        onClick={(e) => { e.stopPropagation(); onToggleExpand(a.id) }}
      />
      <button className={`sx-cb${selected ? ' on' : ''}`} title="Select" onClick={(e) => { e.stopPropagation(); onToggleSelect(a.id) }} />
      <button
        className={`sx-star${a.pinned ? ' on' : ''}`}
        title={a.pinned ? 'Remove from Favorites' : 'Favorite — pin to top'}
        onClick={(e) => { e.stopPropagation(); onToggleStar(a) }}
      >{a.pinned ? '★' : '☆'}</button>
      <span className="sx-av"><AgentAvatar id={agentId} size={24} title={row.harnessTag || agentId} /></span>
      <span className="sx-grow" ref={growRef}>
        <div className="sx-titleline">
          {isUnassigned(a) ? (
            onAssignProject && (
              <button
                type="button"
                className="sx-assign"
                title="Assign this session to a project"
                onClick={(e) => { e.stopPropagation(); onAssignProject(a, e) }}
              >+ assign project ▾</button>
            )
          ) : (
            <span className="sx-proj" title={a.project}>{a.project}</span>
          )}
          <span className="sx-ttl" title={row.title}>{row.title}</span>
          {(row.host || row.folder) && (
            <span className="sx-where" title={[row.host, row.folderFull].filter(Boolean).join(' · ')}>
              {row.host && <b>{row.host}</b>}
              {row.host && row.folder ? ' · ' : ''}
              {row.folder}
            </span>
          )}
          {phaseLabel && <span className={`sx-phase ${phaseClass}`} title={a.liveStatus || a.phase}>{phaseLabel}</span>}
        </div>
        {lines.now ? (
          <div className="sx-now">
            {step && <b>{step}</b>}
            {!previous && todos.length > 0 && <span>{step ? ' · ' : ''}checklist {todoDone}/{todos.length}</span>}
          </div>
        ) : null}
        {row.youIsReal && (
          <div className="sx-roleline">
            <span className="sx-roletag you">You ›</span>
            <span className="sx-rolebody clip"><PromptChips you={row.you} /></span>
          </div>
        )}
        {row.lastLine && (
          <div className="sx-roleline">
            <span className="sx-roletag agent">Agent ›</span>
            <span className="sx-rolebody clip" title={row.lastFull}>{row.lastLine}</span>
          </div>
        )}
        <RowLinks agent={a} row={row} mode="compact" />
        {expanded && <ExpandedCard agent={a} row={row} nowMs={nowMs} />}
      </span>
      <span className="sx-rowactions">
        {canResume ? (
          <button
            className="sx-resumebtn"
            title={resumeTitle}
            onClick={(e) => { e.stopPropagation(); onResume(a) }}
            onContextMenu={(e) => {
              if (!onResumeContext || !previousResumeMessage(a) || !resumeSourceDevice(a)) return
              e.preventDefault()
              e.stopPropagation()
              onResumeContext(a, e)
            }}
          >
            <span aria-hidden>↻</span><span className="sx-resumelabel">Resume</span>
          </button>
        ) : null}
        <span className="sx-age">{formatRelativeTime(a.lastActivityMs || a.startedAtMs || 0, nowMs)}</span>
        <span className={`sx-live${liveClass ? ` ${liveClass}` : ''}`} title={a.liveStatus || a.phase} />
      </span>
    </div>
  )
}

export const SessionRow = React.memo(SessionRowImpl)
