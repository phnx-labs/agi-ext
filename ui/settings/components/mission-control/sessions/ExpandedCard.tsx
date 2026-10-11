import React, { useState } from 'react'
import { isPrevious, todoProgress, type FloorAgent } from '../floorModel'
import type { SessionRowView } from '../recapModel'
import { RowLinks } from './RowLinks'
import { SessionMeta } from './SessionMeta'
import { SessionTimeline } from './SessionTimeline'

type ActivityKind = 'reading' | 'editing' | 'agents' | 'idle'
const ACTIVITY_LEGEND: { kind: ActivityKind; label: string }[] = [
  { kind: 'reading', label: 'reading' },
  { kind: 'editing', label: 'editing' },
  { kind: 'agents', label: 'agents' },
  { kind: 'idle', label: 'idle' },
]

function activityKindOf(name: string): ActivityKind {
  if (/^(Read|Grep|Glob|WebFetch|WebSearch|NotebookRead|LS)$/i.test(name)) return 'reading'
  if (/^(Edit|Write|NotebookEdit|MultiEdit|Bash)$/i.test(name)) return 'editing'
  if (/^(Task|Agent|SendMessage|Workflow)$/i.test(name)) return 'agents'
  return 'idle'
}

function activitySegments(agent: FloorAgent): { kind: ActivityKind; pct: number }[] {
  const calls = agent.recent ?? []
  const tally: Record<ActivityKind, number> = { reading: 0, editing: 0, agents: 0, idle: 0 }
  for (const call of calls) tally[activityKindOf(call.name)] += 1
  return (Object.keys(tally) as ActivityKind[])
    .filter((kind) => tally[kind] > 0)
    .map((kind) => ({ kind, pct: Math.round((tally[kind] / calls.length) * 100) }))
}

function clockLabel(ms: number): string {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/** Long text clamped to five lines with an explicit See more / See less toggle. */
export function isLongText(text: string): boolean {
  return text.length > 320 || text.split(/\r?\n/).length > 5
}

function ClampedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = isLongText(text)
  return (
    <>
      <div className={`sx-ask${long ? (open ? ' expanded' : ' collapsed') : ''}`}>{text}</div>
      {long && (
        <button
          type="button"
          className="sx-see-more"
          aria-expanded={open}
          onClick={(event) => { event.stopPropagation(); setOpen((shown) => !shown) }}
        >{open ? 'See less' : 'See more'}</button>
      )}
    </>
  )
}

export interface ExpandedCardProps {
  agent: FloorAgent
  row: SessionRowView
  nowMs: number
}

export function ExpandedCard({ agent: a, row, nowMs }: ExpandedCardProps) {
  const hasRealRequest = Boolean(a.firstUserMessage?.trim())
  // Preserve the genuine first turn byte-for-byte for the expanded view. Trimming
  // here would make the UI's “full” request subtly incomplete.
  const ask = hasRealRequest ? a.firstUserMessage! : (row.you.text || a.prompt || '')
  // The activity bar tallies this window's own tool calls; a row without any (every
  // stream-projected row) shows no bar rather than a fake all-idle one.
  const hasActivity = (a.recent?.length ?? 0) > 0
  const segments = hasActivity ? activitySegments(a) : []
  const todos = a.todos ?? []
  const { done, total } = todoProgress(todos)
  const startLabel = clockLabel(a.startedAtMs || 0)
  const nowLabel = a.lastActivityMs ? clockLabel(a.lastActivityMs) : 'now'
  const attachments = a.attachments ?? []
  const live = !isPrevious(a)
  return (
    <div className="sx-detail" onClick={(e) => e.stopPropagation()}>
      <div className="sx-dsec">
        <div className="sx-dcap">{hasRealRequest ? 'Your request' : 'Request summary'}</div>
        {ask && <ClampedText text={ask} />}
        {row.title && row.title.trim() && row.title.trim() !== ask.trim() && (
          <div className="sx-goal">{row.title}</div>
        )}
        {live && attachments.length > 0 && (
          <div className="sx-thumbs">
            {attachments.slice(0, 6).map((att, i) => att.thumbnailUri
              ? <img key={i} className="th" src={att.thumbnailUri} alt={att.label} title={att.label} />
              : <span key={i} className="th ph" title={att.label}>{'🖼'}</span>)}
          </div>
        )}
      </div>
      {row.lastFull && (
        <div className="sx-dsec">
          <div className="sx-dcap">Latest reply</div>
          <ClampedText text={row.lastFull} />
        </div>
      )}
      <SessionTimeline timeline={a.timeline} nowMs={nowMs} />
      {live ? (hasActivity && (
        <div className="sx-dsec">
          <div className="sx-dcap">Activity</div>
          <div className="sx-actbar">
            {segments.map((segment, i) => <i key={i} className={segment.kind} style={{ width: `${segment.pct}%` }} />)}
          </div>
          <div className="sx-actlegend">
            {ACTIVITY_LEGEND.map((item) => <span key={item.kind}><span className={`dot ${item.kind}`} />{item.label}</span>)}
          </div>
          <div className="sx-actspan"><span>{startLabel || 'started'}</span><span>{nowLabel}</span></div>
        </div>
      )) : (
        <div className="sx-dsec">
          <div className="sx-dcap">Ended session</div>
          <SessionMeta agent={a} nowMs={nowMs} />
        </div>
      )}
      {total > 0 && (
        <div className="sx-dsec">
          <div className="sx-dcap">Checklist — {done} of {total} done</div>
          <div className="sx-todo">
            {todos.map((todo, i) => {
              const status = String(todo.status)
              const cls = status === 'completed' ? 'done' : status === 'in_progress' ? 'cur' : 'pend'
              const marker = status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○'
              return <div key={i} className={`it ${cls}`}><span className="mk">{marker}</span><span className="tx">{todo.content}</span></div>
            })}
          </div>
        </div>
      )}
      <div className="sx-dsec">
        <div className="sx-dcap">Catch up</div>
        <RowLinks agent={a} row={row} mode="expanded" />
      </div>
    </div>
  )
}
