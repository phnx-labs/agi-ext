import React, { useEffect, useRef } from 'react'
import { isPrevious, type FloorAgent } from '../floorModel'
import { sessionRowView, type SessionRowView } from '../recapModel'
import { AgentAvatar, agentIdFromPrefix } from '../AgentAvatar'
import { ExpandedCard } from './ExpandedCard'
import { RowLinks } from './RowLinks'
import { formatRelativeTime } from './sessionTime'
import { previousResumeMessage, resumeSourceDevice } from './sessionActions'
import { isUnassigned } from '../sessionProjects'
import { SESSION_STATE_WORD, sessionStateOf } from '@shared/sessionState'

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
  /** Reports the row's rendered height (collapsed or expanded), so the list
   *  reserves exactly that: wrapped chips or a long detail card never clip. */
  onMeasure?: (key: string, height: number) => void
}

// The row's vertical padding plus its bottom border (floor.css .sx-row).
const ROW_CHROME_H = 25

/** One measurement per row and state: collapsing must not reuse the open height. */
export function measureKey(id: string, expanded: boolean): string {
  return expanded ? `${id}:open` : id
}

function PromptChips({ you }: { you: SessionRowView['you'] }) {
  if (you.kind === 'image') return <><span className="sx-imgchip">{'🖼'} screenshot</span>{you.text}</>
  if (you.kind === 'command') return <><span className="sx-cmdchip">$ {you.chip}</span>{you.text}</>
  if (you.kind === 'skill') return <><span className="sx-slashchip">{you.chip}</span>{you.text}</>
  return <>{you.text}</>
}

/** Which optional lines the collapsed row renders; the virtual list sizes rows from it. */
export function collapsedLines(row: SessionRowView): { you: boolean; agent: boolean } {
  return { you: row.youIsReal, agent: Boolean(row.lastLine) }
}

function SessionRowImpl({
  agent: a, nowMs, selected, active, expanded, height,
  onToggleSelect, onToggleStar, onResume, onSelect, onToggleExpand, onResumeContext, onAssignProject, onMeasure,
}: SessionRowProps) {
  const growRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const grow = growRef.current
    if (!onMeasure || !grow || typeof ResizeObserver === 'undefined') return
    const key = measureKey(a.id, expanded)
    const report = () => onMeasure(key, Math.ceil(grow.getBoundingClientRect().height) + ROW_CHROME_H)
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
  const phaseLabel = previous ? '' : SESSION_STATE_WORD[sessionStateOf({ phase: a.phase, liveStatus: a.liveStatus, needsYou: a.needs })].toLowerCase()
  // "You ›" asserts the user actually typed something: it shows only when the CLI
  // carried a genuine user turn. A synthesized task label (topic, worktree slug, tab
  // name) never masquerades as the user's own words (PHNX-3939). "Agent ›" is the
  // agent's own latest words and is likewise omitted when the row carries none.
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
          {row.host && <span className="sx-where host" title={`Runs on ${row.host}`}>{row.host}</span>}
          {row.folder && <span className="sx-where folder" title={row.folderFull}>{row.folder}</span>}
          {phaseLabel && <span className={`sx-phase ${phaseClass}`} title={a.liveStatus || a.phase}>{phaseLabel}</span>}
        </div>
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
