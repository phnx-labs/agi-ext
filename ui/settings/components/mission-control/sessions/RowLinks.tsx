import React from 'react'
import { isPrevious, resumeCommand, type FloorAgent } from '../floorModel'
import type { SessionRowView } from '../recapModel'

/** Copy a short value and keep the click out of the row expand handler. */
export function copyPill(e: React.MouseEvent, text: string): void {
  e.stopPropagation()
  navigator.clipboard?.writeText(text)?.catch(() => { /* clipboard unavailable in this host */ })
}

interface RowLinksProps {
  agent: FloorAgent
  row: SessionRowView
  mode: 'compact' | 'expanded'
  onResume: (agent: FloorAgent) => void
  onView: (agent: FloorAgent) => void
}

/** The row's two metadata-link surfaces, kept behind one interaction contract. */
export function RowLinks({ agent: a, row, mode, onResume, onView }: RowLinksProps) {
  const device = a.sourceDevice || row.host
  if (mode === 'expanded') {
    const canResume = !isPrevious(a) || !!resumeCommand(a)
    return (
      <div className="sx-catch">
        {a.ticket && <span className="lnk" role="button" title={`Copy ${a.ticket}`} onClick={(e) => copyPill(e, a.ticket!)}>◇ {a.ticket}</span>}
        {row.repo && <span className="lnk" role="button" title={`Copy ${row.repo}`} onClick={(e) => copyPill(e, row.repo!)}>▪ {row.repo}{a.files ? ` · ${a.files} files` : ''}</span>}
        <span className="lnk" role="button" onClick={(e) => { e.stopPropagation(); onView(a) }}>Session ↗</span>
        {device && <span className="lnk" role="button" title={`Copy ${device}`} onClick={(e) => copyPill(e, device)}>◈ {device}</span>}
        {canResume
          ? <span className="lnk go" onClick={() => onResume(a)}>↻ Resume here</span>
          : <span className="lnk" onClick={() => onView(a)}>View transcript</span>}
      </div>
    )
  }

  return (
    <div className="sx-metarow">
      {row.repo && <span className="sx-chip repo" role="button" title={`Copy ${row.repo}`} onClick={(e) => copyPill(e, row.repo!)}>▪ {row.repo}</span>}
      {row.pr && (
        <span className="sx-chip pr" role="button" title={`Copy ${row.pr.label}`} onClick={(e) => copyPill(e, row.pr!.label)}>
          <span className={`ci${row.pr.ci === 'running' ? ' run' : row.pr.ci === 'failed' ? ' fail' : ''}`} />
          {' '}{row.pr.label}
        </span>
      )}
      {a.ticket && <span className="sx-chip ticket" role="button" title={`Copy ${a.ticket}`} onClick={(e) => copyPill(e, a.ticket!)}>◇ {a.ticket}</span>}
      {row.branch && <span className="sx-chip branch" role="button" title={`Copy ${row.branch}`} onClick={(e) => copyPill(e, row.branch!)}>⑂ {row.branch}</span>}
      {(a.attachments?.length ?? 0) > 0 && <span className="sx-chip attach">{'🖼'} {a.attachments!.length}</span>}
      {(a.plans?.length ?? 0) > 0 && <span className="sx-chip art">◆ {a.plans!.length}</span>}
      {device && <span className="sx-chip device" role="button" title={`Copy ${device}`} onClick={(e) => copyPill(e, device)}>◈ {device}</span>}
      {!row.pr && !a.ticket && <span className="sx-chip nopr">no PR</span>}
    </div>
  )
}
