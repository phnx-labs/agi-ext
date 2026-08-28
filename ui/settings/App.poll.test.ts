import { expect, test, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Source-level regression guards (PHNX-3447 / PHNX-3435): the settings dashboard
// must not own an acting poll timer. Three setIntervals used to fetch on a fixed
// cadence — the Linear/GitHub backlog (30s), the floor tasks+terminals (30s), and
// the watchdog log (15s) — all violating the one-scheduler rule (the agents-cli
// daemon, or a CLI command it drives, is the only scheduler). They are now driven
// by real signals: the session CLI stream push (host-side), panel-visible, and
// window-focus-regained. Guard against any of them coming back.

const appSource = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf8')

describe('App dashboard timer budget (no acting poll)', () => {
  test('App.tsx owns no setInterval / setTimeout that fetches', () => {
    // No timer primitives at all in the dashboard shell.
    expect(appSource).not.toMatch(/setInterval\s*\(/)
    expect(appSource).not.toMatch(/setTimeout\s*\(/)
  })

  test('the removed poll cadences are gone', () => {
    // The old backlog/floor 30s and watchdog 15s intervals.
    expect(appSource).not.toMatch(/setInterval\([^)]*\)\s*,\s*30_?000/)
    expect(appSource).not.toMatch(/setInterval\([^)]*\)\s*,\s*15_?000/)
    expect(appSource).not.toContain("setInterval(poll, UNIFIED_TASKS_REFRESH_MS)")
  })

  test('refreshes are event-driven — visibility + window focus regained', () => {
    // The focus-regained backstop replaces the removed intervals.
    expect(appSource).toContain('useWindowFocusRegained(')
    // The backlog effect keys off panelVisible, not a cadence.
    expect(appSource).toMatch(/fetchUnifiedTasks\(\)[\s\S]{0,80}\}, \[activeTab, unifiedTasksLoaded, unifiedTasksLoading, panelVisible\]\)/)
    // The floor subscription still exists (stream-fed), and the focus handler
    // re-fetches tasks + terminals as the mis-seeded-visibility backstop.
    expect(appSource).toContain("vscode.postMessage({ type: 'subscribeFloor' })")
    expect(appSource).toContain("vscode.postMessage({ type: 'fetchTasks' })")
    expect(appSource).toContain("vscode.postMessage({ type: 'fetchAllTerminals' })")
    expect(appSource).toContain("vscode.postMessage({ type: 'getWatchdogLog' })")
  })
})
