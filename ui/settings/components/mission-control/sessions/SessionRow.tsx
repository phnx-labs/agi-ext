import React from 'react'
import { isPrevious, resumeCommand, type FloorAgent } from '../floorModel'
import { sessionRowView, type SessionRowView } from '../recapModel'
import { AgentAvatar, agentIdFromPrefix } from '../AgentAvatar'
import { ExpandedCard } from './ExpandedCard'
import { RowLinks } from './RowLinks'

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
  onView: (agent: FloorAgent) => void
  onSelect: (agent: FloorAgent) => void
  onToggleExpand: (id: string) => void
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
  onToggleSelect, onToggleStar, onResume, onView, onSelect, onToggleExpand,
}: SessionRowProps) {
  const previous = isPrevious(a)
  const canResume = !previous || !!resumeCommand(a)
  const resumeTitle = previous
    ? `Resume — relaunch from the transcript on ${a.sourceDevice || a.hostLabel || a.host}`
    : 'Resume this session'
  const row = sessionRowView(a)
  const liveClass = row.live === 'run' ? '' : row.live
  const agentId = agentIdFromPrefix(a.abbr) ?? (row.harnessTag || 'agent').toLowerCase()
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
          <span className="sx-agent">{agentId}</span>
          {a.project && <span className="sx-proj" title={a.project}>{a.project}</span>}
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
        <RowLinks agent={a} row={row} mode="compact" onResume={onResume} onView={onView} />
        {expanded && <ExpandedCard agent={a} row={row} nowMs={nowMs} onResume={onResume} onView={onView} />}
      </span>
      <span className="sx-rowactions">
        {canResume ? (
          <button className="sx-resumebtn" title={resumeTitle} onClick={(e) => { e.stopPropagation(); onResume(a) }}>
            <span aria-hidden>↻</span><span className="sx-resumelabel">Resume</span>
          </button>
        ) : (
          <button
            className="sx-viewbtn"
            title="View the session transcript (this harness has no resume path)"
            onClick={(e) => { e.stopPropagation(); onView(a) }}
          ><span aria-hidden>↗</span><span className="sx-resumelabel">View</span></button>
        )}
        <span className="sx-age">{row.age}</span>
        <span className={`sx-live${liveClass ? ` ${liveClass}` : ''}`} title={a.liveStatus || a.phase} />
      </span>
    </div>
  )
}

export const SessionRow = React.memo(SessionRowImpl)
