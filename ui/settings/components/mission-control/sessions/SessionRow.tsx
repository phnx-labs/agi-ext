import React from 'react'
import { isPrevious, type FloorAgent } from '../floorModel'
import { sessionRowView, type SessionRowView } from '../recapModel'
import { AgentAvatar, agentIdFromPrefix } from '../AgentAvatar'
import { ExpandedCard } from './ExpandedCard'
import { RowLinks } from './RowLinks'
import { formatRelativeTime } from './sessionTime'
import { previousResumeMessage, resumeSourceDevice } from './sessionActions'

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
  /** Open the "assign project" menu for an orphan (no resolved project) row. When
   *  provided AND the row has no project, an inline `+ assign` affordance renders in
   *  place of the project chip (PHNX-3796). */
  onAssignProject?: (agent: FloorAgent, event: React.MouseEvent) => void
}

function PromptChips({ you }: { you: SessionRowView['you'] }) {
  if (you.kind === 'image') return <><span className="sx-imgchip">{'🖼'} screenshot</span>{you.text}</>
  if (you.kind === 'command') return <><span className="sx-cmdchip">$ {you.chip}</span>{you.text}</>
  if (you.kind === 'skill') return <><span className="sx-slashchip">{you.chip}</span>{you.text}</>
  return <>{you.text}</>
}

const PHASE_LABEL: Record<string, string> = {
  running: 'working', idle: 'idle', waiting: 'waiting', failed: 'failed', done: 'done',
}

function SessionRowImpl({
  agent: a, nowMs, selected, active, expanded, height,
  onToggleSelect, onToggleStar, onResume, onSelect, onToggleExpand, onResumeContext, onAssignProject,
}: SessionRowProps) {
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
  const step = previous ? '' : ((a.summary || '').trim() || (a.verb ? `${a.verb} ${a.target}`.trim() : ''))
  const todos = a.todos ?? []
  const todoDone = todos.filter((todo) => String(todo.status) === 'completed').length
  return (
    <div
      className={`sx-row${selected ? ' sel' : ''}${active ? ' active' : ''}`}
      style={{ height }}
      onClick={() => { onToggleExpand(a.id); onSelect(a) }}
    >
      <button className={`sx-cb${selected ? ' on' : ''}`} title="Select" onClick={(e) => { e.stopPropagation(); onToggleSelect(a.id) }} />
      <button
        className={`sx-star${a.pinned ? ' on' : ''}`}
        title={a.pinned ? 'Remove from Favorites' : 'Favorite — pin to top'}
        onClick={(e) => { e.stopPropagation(); onToggleStar(a) }}
      >{a.pinned ? '★' : '☆'}</button>
      <span className="sx-av"><AgentAvatar id={agentId} size={24} title={row.harnessTag || agentId} /></span>
      <span className="sx-grow">
        <div className="sx-titleline">
          {a.project
            ? <span className="sx-proj" title={a.project}>{a.project}</span>
            : onAssignProject && !previous && (
              <button
                className="sx-assign"
                title="Assign this cloud/no-repo run to a project"
                aria-haspopup="menu"
                onClick={(e) => { e.stopPropagation(); onAssignProject(a, e) }}
              >+ assign project ▾</button>
            )}
          <span className="sx-ttl" title={row.title}>{row.title}</span>
          {phaseLabel && <span className={`sx-phase ${phaseClass}`} title={a.liveStatus || a.phase}>{phaseLabel}</span>}
        </div>
        {step || (!previous && todos.length > 0) ? (
          <div className="sx-now">
            {step && <b>{step}</b>}
            {!previous && todos.length > 0 && <span>{step ? ' · ' : ''}checklist {todoDone}/{todos.length}</span>}
          </div>
        ) : null}
        <div className="sx-roleline">
          <span className="sx-roletag you">You ›</span>
          <span className="sx-rolebody clip"><PromptChips you={row.you} /></span>
        </div>
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
