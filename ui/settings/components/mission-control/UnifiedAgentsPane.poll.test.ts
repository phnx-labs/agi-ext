import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof globalThis.document === 'undefined') GlobalRegistrator.register()

import { expect, test, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TerminalDetail } from '../../types'
import { REMOTE_STALE_MS, THROUGHPUT_TICK_MS } from './floorRefresh'

const { UnifiedAgentsPane, defaultFloorPrefs, loadFloorPrefs, FLOOR_PREFS_LAYOUT_VERSION, registeredDevicesToDispatchDevices } = await import('./UnifiedAgentsPane')
const { SessionsPane } = await import('./SessionsPane')

// Source-level regression guards: the Floor must not reintroduce 3s local /
// 45s remote setInterval polls or the 140ms throughput React timer.
// (issue #2030 / factory-floor performance UI track)

const panePath = join(import.meta.dir, 'UnifiedAgentsPane.tsx')
const cssPath = join(import.meta.dir, 'design-system.css')
const source = readFileSync(panePath, 'utf8')
const css = readFileSync(cssPath, 'utf8')

/** Source with comments stripped — the guards below are about what the code
 *  DOES, and a tombstone comment naming the deleted call must not read as the
 *  call still being there. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

/** The extension-host files that answered this pane's messages. A webview-only
 *  scan cannot see a side channel that still exists on the other side of
 *  postMessage, so the no-subprocess guard reads them too. */
const EXT_DIR = join(import.meta.dir, '../../../../src/vscode')
const HOST_SOURCES: Record<string, string> = {
  'settings.vscode.ts': codeOnly(readFileSync(join(EXT_DIR, 'settings.vscode.ts'), 'utf8')),
  'remoteSessions.vscode.ts': codeOnly(readFileSync(join(EXT_DIR, 'remoteSessions.vscode.ts'), 'utf8')),
}

describe('Floor poll / timer budget (no recurring probes)', () => {
  test('mount-time registered devices feed Resume before Dispatch opens', () => {
    expect(registeredDevicesToDispatchDevices([
      { name: 'zion', host: 'zion.local', online: true },
      { name: 'offline-box', host: 'offline.local', online: false },
      null,
    ])).toEqual([
      { name: 'zion', host: 'zion.local', reachable: true },
      { name: 'offline-box', host: 'offline.local', reachable: false },
    ])
    expect(source).toMatch(/devicesData[\s\S]*?setDispatchDevices\(registeredDevicesToDispatchDevices\(msg\.devices\)\)/)
  })

  test('exports 1s throughput tick and a non-poll stale threshold', () => {
    expect(THROUGHPUT_TICK_MS).toBe(1_000)
    expect(REMOTE_STALE_MS).toBe(90_000)
  })

  test('does not define the old 3s local / 45s remote poll constants', () => {
    expect(source).not.toMatch(/LOCAL_POLL_MS\s*=\s*3_?000/)
    expect(source).not.toMatch(/REMOTE_POLL_MS\s*=\s*45_?000/)
    expect(source).not.toContain('setInterval(poll, LOCAL_POLL_MS)')
    expect(source).not.toContain('setInterval(sweep, REMOTE_POLL_MS)')
  })

  test('does not run a 140ms React throughput timer', () => {
    expect(source).not.toMatch(/setInterval\(\s*tick\s*,\s*140\s*\)/)
    expect(source).toContain('setInterval(tick, THROUGHPUT_TICK_MS)')
    expect(source).toContain('data-tick-ms={THROUGHPUT_TICK_MS}')
  })

  // PHNX-2833: the extension must not own a timer that fetches. Throughput
  // used to be pulled by polling the host every 2.5s; it is now pushed by the
  // host whenever the session CLI stream changes (settings.vscode.ts
  // pushFloorThroughput). Guard against reintroducing that poll.
  test('does not poll the host for floor throughput', () => {
    expect(source).not.toContain("postMessage({ type: 'getFloorThroughput' })")
    expect(source).not.toMatch(/setInterval\(\s*poll\s*,\s*2_?500\s*\)/)
  })

  test('seeds hosts once on visibility; remote refresh is manual', () => {
    expect(source).toContain("postMessage({ type: 'fetchLocalSessions' })")
    expect(source).toContain('data-testid="host-freshness-chip"')
    // One-shot seed on panelVisible — no setInterval around fetchHostSessions.
    expect(source).toMatch(/if \(!panelVisible\) return[\s\S]*?fetchLocalSessions[\s\S]*?fetchHostSessions/)
  })

  test('mount seed is cache-only; freshness chip passes force:true', () => {
    // panelVisible one-shot seed must omit force so the host serves last-good
    // without a fleet CLI fan-out (PR #2031 / #2033 seam).
    const mountSeed = source.match(
      /if \(!panelVisible\) return[\s\S]*?postMessage\(\{\s*type:\s*'fetchLocalSessions'\s*\}\)[\s\S]*?postMessage\(\{\s*type:\s*'fetchHostSessions'\s*\}\)/,
    )
    expect(mountSeed).not.toBeNull()
    expect(mountSeed![0]).not.toMatch(/force\s*:/)

    // Manual freshness chip is the only path that may force a fleet refresh.
    // onClick sits above data-testid on the same span (JSX attribute order).
    expect(source).toMatch(
      /onClick=\{\(\) => \{ if \(!syncingHosts\) \{[\s\S]*?postMessage\(\{\s*type:\s*'fetchHostSessions',\s*force:\s*true\s*\}\)[\s\S]*?\}\s*\}\}[\s\S]*?data-testid="host-freshness-chip"/,
    )
    // Exactly one forced fetchHostSessions in the pane source.
    const forced = source.match(/postMessage\(\{\s*type:\s*'fetchHostSessions',\s*force:\s*true\s*\}\)/g)
    expect(forced?.length).toBe(1)
  })

  test('retains last-good remote rows on hostSessions failure', () => {
    expect(source).toContain("msg.ok === false || typeof msg.error === 'string'")
    expect(source).toContain('Retain last-good sessions/roster')
    expect(source).toContain('setRemoteSyncError')
  })

  test('CSS interpolates sparkline bars and honors prefers-reduced-motion', () => {
    expect(css).toMatch(/\.sw-spark-bar[\s\S]*?transition:\s*height\s+0\.9s/)
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?\.sw-spark-bar[\s\S]*?transition:\s*none/)
  })

  test('empty / CLI-unavailable copy and per-host freshness are present', () => {
    expect(source).toContain('data-testid="zero-sessions"')
    expect(source).toContain('data-testid="stream-degraded"')
    expect(source).toContain('data-testid="zero-hosts"')
    expect(source).toContain('data-testid="cli-unavailable"')
    expect(source).toContain('data-testid="per-host-freshness"')
  })

  test('selecting a session spawns NO CLI process at all (PHNX-3939)', () => {
    // The rail's one-shot `sessions preview --json` fetch went away with the rail.
    // Selection is now pure presentation: it posts 'session.select' to the host,
    // which points the native sidebar at that session. The sidebar renders from
    // the warm session stream, so a click costs zero subprocesses — the strongest
    // possible form of the guard the 2026-08-25 CPU incident (agi-cli#3019 /
    // RUSH-3184) asked for.
    //
    // Scanning only this pane checked the CALLER and left the whole side channel
    // standing behind it — the 'fetchSessionPreview' host case and the
    // `agents sessions preview <id> --json` spawn it dispatched to survived the
    // rail deletion (#59 review). Scan the host half too: the guard is that the
    // subprocess does not exist anywhere, not that this one file stopped asking.
    const scanned = { ...HOST_SOURCES, 'UnifiedAgentsPane.tsx': codeOnly(source) }
    for (const [name, text] of Object.entries(scanned)) {
      expect(`${name} calls fetchSessionPreview: ${text.includes('fetchSessionPreview')}`)
        .toBe(`${name} calls fetchSessionPreview: false`)
      expect(`${name} spawns sessions preview: ${text.includes("'sessions', 'preview'")}`)
        .toBe(`${name} spawns sessions preview: false`)
    }
    expect(source).not.toContain('sessionPreviews')
    expect(source).toContain("postMessage({ type: 'session.select', sessionId: agent.sessionId, host: agent.host })")
  })

  // The managed-Projects management pane (and its last-good-on-error handling)
  // moved to Settings — FleetProjectsSection — with PHNX-3592. Its behavior is
  // covered there (FleetProjectsSection.test.tsx); the pane keeps only a plain
  // managedProjectsData fetch for the sidebar top-3 + feed linked-project lookup.
  test('managedProjectsData feeds the sidebar without a Projects pane', () => {
    expect(source).toContain("msg?.type === 'managedProjectsData' && Array.isArray(msg.projects)")
    expect(source).toContain('setManagedProjects(msg.projects as ManagedProject[])')
    // The Projects management pane no longer renders inside the Fleet view.
    expect(source).not.toContain('<ProjectsPane')
  })
})

test('does not derive a Needs-You question from local tool calls', () => {
  const now = Date.now()
  const terminal: TerminalDetail = {
    id: 'terminal-1',
    agentType: 'claude',
    label: 'migration-agent',
    autoLabel: null,
    createdAt: now - 60_000,
    index: 0,
    sessionId: 'session-1',
    firstUserMessage: 'Choose the migration strategy',
    status: 'running',
    lastActivityTimestamp: new Date(now).toISOString(),
    currentActivity: 'Waiting for a migration decision',
    waitingForInput: true,
    recentToolCalls: [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Drop the old table?',
          header: 'Migration',
          options: [
            { label: 'Drop it', description: 'Remove the legacy table' },
            { label: 'Keep it', description: 'Preserve the legacy table' },
          ],
        }],
      },
    }],
  }

  const html = renderToStaticMarkup(React.createElement(UnifiedAgentsPane, {
    terminals: [terminal],
    tasks: [],
    tasksLoading: false,
    unifiedTasks: [],
    unifiedTasksLoading: false,
    onDispatch: () => {},
    search: '',
    onSearch: () => {},
  }))

  expect(html).not.toContain('Drop the old table?')
  expect(html).not.toContain('Drop it')
  expect(html).not.toContain('Keep it')
})

test('follower with no reset renders degraded, not zero sessions', () => {
  const html = renderToStaticMarkup(React.createElement(UnifiedAgentsPane, {
    terminals: [],
    tasks: [],
    tasksLoading: false,
    unifiedTasks: [],
    unifiedTasksLoading: false,
    onDispatch: () => {},
    search: '',
    onSearch: () => {},
    sessionStreamDegraded: true,
  }))

  expect(html).toContain('Session data unavailable')
  expect(html).toContain('Waiting for the first snapshot')
  expect(html).not.toContain('No running sessions')
})

test('follower with a reset renders the genuine empty state', () => {
  const html = renderToStaticMarkup(React.createElement(UnifiedAgentsPane, {
    terminals: [],
    tasks: [],
    tasksLoading: false,
    unifiedTasks: [],
    unifiedTasksLoading: false,
    onDispatch: () => {},
    search: '',
    onSearch: () => {},
    sessionStreamDegraded: false,
  }))

  // With genuinely zero sessions, show a clean empty state — NOT "No sessions
  // match" (nothing to match against) and NOT the filter toolbar chrome, which is
  // dead weight when there is nothing to filter (the empty-sidebar fix).
  expect(html).toContain('No agent sessions yet')
  expect(html).not.toContain('No sessions match')
  expect(html).not.toContain('sx-filters')
  expect(html).not.toContain('Session data unavailable')
})

test('Fleet paints no sub-tab strip or Dispatch button when there are no task tabs (PHNX-3925)', () => {
  const html = renderToStaticMarkup(React.createElement(UnifiedAgentsPane, {
    terminals: [],
    tasks: [],
    tasksLoading: false,
    unifiedTasks: [],
    unifiedTasksLoading: false,
    onDispatch: () => {},
    search: '',
    onSearch: () => {},
  }))

  // PHNX-3594 already dropped the fixed counter pills; PHNX-3925 removes the
  // now-empty FloorSubtabs band entirely when no task tab is open — the strip is
  // gated on openTaskTabs.length > 0. Dispatch moved to the TopBar header
  // (covered by TopBar.test.tsx), so the pane renders neither the strip nor its
  // stranded Dispatch button here.
  expect(source).not.toContain('const fixedTabs')
  expect(html).not.toContain('class="fsubtab-cnt"')
  expect(html).not.toContain('class="fsubtabs"')
  expect(html).not.toContain('class="disp"')
})

test('Fleet layout prefs carry no detail-rail state, and a legacy one is dropped', () => {
  // PHNX-3939 follow-up: the rail is gone, so `right` is gone from the pref. The
  // layout version bump re-baselines an install whose stored pref still has it —
  // no dead key survives to restore a column that no longer exists.
  expect(defaultFloorPrefs()).toMatchObject({
    layoutVersion: FLOOR_PREFS_LAYOUT_VERSION,
    sidebar: false,
    rail: true,
  })
  expect(defaultFloorPrefs()).not.toHaveProperty('right')

  localStorage.setItem('swarmify.floorPrefs.v1', JSON.stringify({
    layoutVersion: 2,
    sidebar: true,
    rail: false,
    right: true,
    pinned: ['keep-me'],
    sidebarWidth: 320,
  }))
  try {
    const loaded = loadFloorPrefs()
    expect(loaded).toMatchObject({
      layoutVersion: FLOOR_PREFS_LAYOUT_VERSION,
      sidebar: false,
      rail: true,
      pinned: ['keep-me'],
      sidebarWidth: 320,
    })
  } finally {
    localStorage.removeItem('swarmify.floorPrefs.v1')
  }

  // Selection survives ONLY as the row highlight; there is no rail to open.
  expect(source).toContain('sessionsAgents.find((a) => a.id === selectedAgentId)')
  expect(source).toContain('onSelect={selectSession}')
  expect(source).not.toContain('rightOpen')
  expect(source).not.toContain('setRightOpen')
  expect(source).not.toContain('detail-col')
  expect(source).not.toContain('closeDetail')
  expect(source).not.toContain('<DetailPane')
  expect(source).not.toContain('<SessionPreviewCard')
  expect(source).not.toContain('aria-label="Close detail pane"')
  expect(source).not.toContain('Select an agent or issue to open its conversation')
  // PHNX-3594: the left icon rail (FloorRail) and its expanded FloorSidebar are
  // removed from the Fleet view entirely — Projects/Devices moved to Settings.
  // Guard that neither the rail nor the sidebar is reintroduced as Fleet chrome.
  expect(source).not.toContain("from './FloorRail'")
  expect(source).not.toContain('<FloorRail')
  expect(source).not.toContain('<FloorSidebar')
})

test('SessionsPane shows degraded copy when stream is degraded and empty', () => {
  const html = renderToStaticMarkup(React.createElement(SessionsPane, {
    agents: [],
    onToggleStar: () => {},
    onResume: () => {},
    onResumeMany: () => {},
    onSelect: () => {},
    streamDegraded: true,
  }))

  expect(html).toContain('Session data unavailable')
  expect(html).not.toContain('No sessions match')
})
