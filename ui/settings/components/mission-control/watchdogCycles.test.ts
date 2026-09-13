import { describe, expect, test } from 'bun:test'
import { groupIntoCycles } from './watchdogCycles'
import type { WatchdogEventUI } from './UnifiedAgentsPane'

function ev(ts: number, message = 'tick'): WatchdogEventUI {
  return { ts, kind: 'tick', message }
}

describe('groupIntoCycles', () => {
  test('returns empty for no events', () => {
    expect(groupIntoCycles([])).toEqual([])
  })

  test('keeps events within the 45s gap in a single cycle', () => {
    const events = [ev(0), ev(10_000), ev(20_000)]
    const cycles = groupIntoCycles(events)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.events).toHaveLength(3)
  })

  test('splits into a new cycle when the gap exceeds 45s', () => {
    const events = [ev(0), ev(10_000), ev(100_000), ev(110_000)]
    const cycles = groupIntoCycles(events)
    expect(cycles).toHaveLength(2)
    // reversed: newest cycle first
    expect(cycles[0]?.events.map((e) => e.ts)).toEqual([100_000, 110_000])
    expect(cycles[1]?.events.map((e) => e.ts)).toEqual([0, 10_000])
  })

  test('a gap of exactly 45s stays in the same cycle', () => {
    const events = [ev(0), ev(45_000)]
    expect(groupIntoCycles(events)).toHaveLength(1)
  })

  test('the newest cycle is first in the result', () => {
    const events = [ev(0), ev(200_000), ev(400_000)]
    const cycles = groupIntoCycles(events)
    expect(cycles).toHaveLength(3)
    expect(cycles[0]?.events[0]?.ts).toBe(400_000)
    expect(cycles[2]?.events[0]?.ts).toBe(0)
  })
})
