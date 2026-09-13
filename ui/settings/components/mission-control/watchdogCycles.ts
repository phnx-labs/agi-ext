import type { WatchdogEventUI } from './UnifiedAgentsPane'

export interface ScanCycle {
  ts: number
  events: WatchdogEventUI[]
}

export function groupIntoCycles(events: WatchdogEventUI[]): ScanCycle[] {
  const firstEvent = events[0]
  if (!firstEvent) return []
  const GAP_MS = 45_000
  const cycles: ScanCycle[] = []
  let current: ScanCycle = { ts: firstEvent.ts, events: [] }
  for (const ev of events) {
    if (ev.ts - current.ts > GAP_MS && current.events.length > 0) {
      cycles.push(current)
      current = { ts: ev.ts, events: [] }
    }
    current.events.push(ev)
    current.ts = ev.ts
  }
  if (current.events.length > 0) cycles.push(current)
  return cycles.reverse()
}
