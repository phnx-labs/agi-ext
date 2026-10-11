import React from 'react'
import type { FloorTimeline } from '../floorModel'
import { formatAbsoluteRange, formatRelativeTime } from './sessionTime'

type TimelineRole = 'you' | 'agent' | 'tools'

export interface TimelineEntry {
  role: TimelineRole
  text: string
  atMs: number
  /** "4 tools · 1 failed · 2 blocked"; '' when the step ran nothing. */
  work: string
  live: boolean
}

const ROLE_LABEL: Record<TimelineRole, string> = { you: 'You', agent: 'Agent', tools: 'Tools' }

function workLabel(tools: number, failed: number, blocked: number): string {
  const bits: string[] = []
  if (tools > 0) bits.push(`${tools} tool${tools === 1 ? '' : 's'}`)
  if (failed > 0) bits.push(`${failed} failed`)
  if (blocked > 0) bits.push(`${blocked} blocked`)
  return bits.join(' · ')
}

/** The CLI timeline (newest LAST) as display entries, newest FIRST. */
export function timelineEntries(timeline: FloorTimeline | undefined): TimelineEntry[] {
  return (timeline?.steps ?? [])
    .filter((step) => step.text.trim())
    .map((step) => ({
      role: step.source === 'user' ? 'you' as const : step.source === 'derived' ? 'tools' as const : 'agent' as const,
      text: step.text.trim(),
      atMs: Date.parse(step.at) || 0,
      work: workLabel(step.tools, step.failed, step.blocked),
      live: step.live === true,
    }))
    .reverse()
}

/** "141 earlier steps · 278 tools · 13 failed"; '' when nothing is older. */
export function earlierLabel(timeline: FloorTimeline | undefined): string {
  const earlier = timeline?.earlier
  if (!earlier || earlier.steps <= 0) return ''
  const bits = [`${earlier.steps} earlier step${earlier.steps === 1 ? '' : 's'}`]
  if (earlier.tools > 0) bits.push(`${earlier.tools} tools`)
  if (earlier.failed > 0) bits.push(`${earlier.failed} failed`)
  return bits.join(' · ')
}

/** Rendered height estimate for the virtual list (caption + one line per step). */
export function timelineHeight(timeline: FloorTimeline | undefined): number {
  if (!timeline) return 0
  const rows = timelineEntries(timeline).length + (earlierLabel(timeline) ? 1 : 0)
  if (rows === 0) return timeline.state === 'unavailable' ? 40 : 0
  return 24 + rows * 22
}

/** The session's step timeline: your turns and the agent's own narration, timed. */
export function SessionTimeline({ timeline, nowMs }: { timeline: FloorTimeline | undefined; nowMs: number }) {
  if (!timeline) return null
  const entries = timelineEntries(timeline)
  const earlier = earlierLabel(timeline)
  if (entries.length === 0) {
    if (timeline.state !== 'unavailable') return null
    return (
      <div className="sx-dsec">
        <div className="sx-dcap">Timeline</div>
        <div className="sx-tl-empty">{timeline.reason || 'The CLI cannot fold a timeline for this harness.'}</div>
      </div>
    )
  }
  return (
    <div className="sx-dsec">
      <div className="sx-dcap">Timeline</div>
      <ol className="sx-tl">
        {entries.map((entry, i) => (
          <li key={i} className={`sx-tl-step ${entry.role}${entry.live ? ' live' : ''}`}>
            <span className="sx-tl-at" title={formatRelativeTime(entry.atMs, nowMs)}>
              {entry.atMs ? formatAbsoluteRange(entry.atMs, entry.atMs) : ''}
            </span>
            <span className={`sx-tl-role ${entry.role}`}>{ROLE_LABEL[entry.role]}</span>
            <span className="sx-tl-text" title={entry.text}>{entry.text}</span>
            {entry.work && <span className="sx-tl-work">{entry.work}</span>}
          </li>
        ))}
        {earlier && <li className="sx-tl-earlier">{earlier}</li>}
      </ol>
    </div>
  )
}
