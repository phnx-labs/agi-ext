import React from 'react'
import { resumeCommand, type FloorAgent } from '../floorModel'
import type { SessionRowView } from '../recapModel'

function clockLabel(ms: number): string {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/** Presentation-only metadata for an ended session. */
export function SessionMeta({ agent, row }: { agent: FloorAgent; row: SessionRowView }) {
  const device = agent.sourceDevice || row.host
  const startLabel = clockLabel(agent.startedAtMs || 0)
  const lastLabel = agent.lastActivityMs ? clockLabel(agent.lastActivityMs) : 'now'
  const parts: string[] = []
  if (lastLabel) parts.push(`Last active ${lastLabel}`)
  if (startLabel) parts.push(`started ${startLabel}`)
  parts.push(resumeCommand(agent) ? `resumable on ${device}` : 'transcript only')
  return <div className="sx-endedmeta">{parts.join(' · ')}</div>
}
