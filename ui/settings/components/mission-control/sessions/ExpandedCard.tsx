import React, { useState } from 'react'
import { isPrevious, todoProgress, type FloorAgent } from '../floorModel'
import type { SessionRowView } from '../recapModel'
import { RowLinks } from './RowLinks'
import { SessionMeta } from './SessionMeta'
import { SessionCards } from './SessionCards'

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
  // The row's You line is the LATEST turn; once there are later ones, this
  // block says it is the first so the two never read as the same message.
  const laterTurns = (a.userTurns?.length ?? 0) > 1
  // Preserve the genuine first turn byte-for-byte for the expanded view. Trimming
  // here would make the UI's “full” request subtly incomplete.
  const ask = hasRealRequest ? a.firstUserMessage! : (row.you.text || a.prompt || '')
  const todos = a.todos ?? []
  const { done, total } = todoProgress(todos)
  const attachments = a.attachments ?? []
  const live = !isPrevious(a)
  return (
    <div className="sx-detail" onClick={(e) => e.stopPropagation()}>
      <div className="sx-dsec">
        <div className="sx-dcap">{!hasRealRequest ? 'Request summary' : laterTurns ? 'First request' : 'Your request'}</div>
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
      {a.sessionCard && <SessionCards snapshot={a.sessionCard} />}
      {!live && (
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
