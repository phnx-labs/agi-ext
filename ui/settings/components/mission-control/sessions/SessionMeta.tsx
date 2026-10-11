import React from 'react'
import type { FloorAgent } from '../floorModel'
import { formatAbsoluteRange, formatDuration, formatRelativeTime } from './sessionTime'

/** Presentation-only metadata for an ended session. The device is in the row header. */
export function SessionMeta({ agent, nowMs }: { agent: FloorAgent; nowMs: number }) {
  const startedAtMs = agent.startedAtMs || agent.lastActivityMs || 0
  const lastActivityMs = agent.lastActivityMs || startedAtMs
  const absoluteRange = formatAbsoluteRange(startedAtMs, lastActivityMs)
  return (
    <div className="sx-endedmeta" title={absoluteRange || undefined}>
      Ran {formatDuration(startedAtMs, lastActivityMs)} · ended {formatRelativeTime(lastActivityMs, nowMs)}
    </div>
  )
}
