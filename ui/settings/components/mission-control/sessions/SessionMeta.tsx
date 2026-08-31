import React from 'react'
import type { FloorAgent } from '../floorModel'
import type { SessionRowView } from '../recapModel'
import { formatAbsoluteRange, formatDuration, formatRelativeTime } from './sessionTime'

/** Presentation-only metadata for an ended session. */
export function SessionMeta({ agent, row, nowMs }: { agent: FloorAgent; row: SessionRowView; nowMs: number }) {
  const device = agent.sourceDevice || row.host
  const startedAtMs = agent.startedAtMs || agent.lastActivityMs || 0
  const lastActivityMs = agent.lastActivityMs || startedAtMs
  const absoluteRange = formatAbsoluteRange(startedAtMs, lastActivityMs)
  return (
    <div className="sx-endedmeta" title={absoluteRange || undefined}>
      Ran {formatDuration(startedAtMs, lastActivityMs)} · ended {formatRelativeTime(lastActivityMs, nowMs)}
      {device ? <> · Runs on <b>{device}</b></> : null}
    </div>
  )
}
