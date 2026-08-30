import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof globalThis.document === 'undefined') GlobalRegistrator.register()

import { expect, test, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TerminalDetail } from '../../types'
import { REMOTE_STALE_MS, THROUGHPUT_TICK_MS } from './floorRefresh'

const { UnifiedAgentsPane, defaultFloorPrefs, loadFloorPrefs, FLOOR_PREFS_LAYOUT_VERSION } = await import('./UnifiedAgentsPane')
const { SessionsPane } = await import('./SessionsPane')

// Source-level regression guards: the Floor must not reintroduce 3s local /
// 45s remote setInterval polls or the 140ms throughput React timer.
// (issue #2030 / factory-floor performance UI track)

const panePath = join(import.meta.dir, 'UnifiedAgentsPane.tsx')
const cssPath = join(import.meta.dir, 'design-system.css')
const source = readFileSync(panePath, 'utf8')
const css = readFileSync(cssPath, 'utf8')

describe('Floor poll / timer budget (no recurring probes)', () => {
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

  test('session-preview fetch is one-shot per selection, never a poll (PHNX-2973)', () => {
    // The digest fetch fires on selection and is guarded so re-renders (from
    // floorAgents rebuilding selectedFloorAgent's identity on every stream tick)
    // do NOT re-spawn the CLI — exactly the per-tab spawn-loop the 2026-08-25
    // CPU incident (agi-cli#3019 / RUSH-3184) warns against.
    // The in-flight/ready guard: return early once the sessionId is recorded.
    expect(source).toContain('if (sessionPreviews[sid]) return')
    // Its only trigger is the effect above — no setInterval around it.
    expect(source).not.toMatch(/setInterval\([\s\S]{0,40}fetchSessionPreview/)
    expect(source).toContain("postMessage({ type: 'fetchSessionPreview', host: selectedFloorAgent!.host, sessionId: sid })")
    // Exactly one fetchSessionPreview dispatch site in the pane.
    const previewFetches = source.match(/type:\s*'fetchSessionPreview'/g)
    expect(previewFetches?.length).toBe(1)
  })

  test('managedProjectsData.error retains last-good projects', () => {
    // Failure path surfaces error and returns before setManagedProjects.
    expect(source).toMatch(
      /msg\?\.type === 'managedProjectsData'[\s\S]*?typeof msg\.error === 'string'[\s\S]*?setProjectCommandError\(msg\.error\)[\s\S]*?return/,
    )
    expect(source).toContain('Retain last-good projects')
    // Success path still replaces projects and clears the error.
    expect(source).toMatch(
      /Array\.isArray\(msg\.projects\)[\s\S]*?setManagedProjects\(msg\.projects as ManagedProject\[\]\)[\s\S]*?setProjectCommandError\(null\)/,
    )
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

  expect(html).toContain('No sessions match')
  expect(html).not.toContain('Session data unavailable')
})

test('Fleet omits fixed counter tabs while keeping Dispatch in its header', () => {
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

  expect(source).not.toContain('const fixedTabs')
  expect(html).not.toContain('class="fsubtab-cnt"')
  expect(html).toContain('class="disp"')
  expect(html).toContain('Dispatch')
})

test('Fleet layout defaults and legacy prefs keep both side panels closed', () => {
  expect(defaultFloorPrefs()).toMatchObject({
    layoutVersion: FLOOR_PREFS_LAYOUT_VERSION,
    sidebar: false,
    rail: true,
    right: false,
  })

  localStorage.setItem('swarmify.floorPrefs.v1', JSON.stringify({
    sidebar: true,
    rail: false,
    right: true,
    pinned: ['keep-me'],
    sidebarWidth: 320,
  }))
  try {
    expect(loadFloorPrefs()).toMatchObject({
      layoutVersion: FLOOR_PREFS_LAYOUT_VERSION,
      sidebar: false,
      rail: true,
      right: false,
      pinned: ['keep-me'],
      sidebarWidth: 320,
    })
  } finally {
    localStorage.removeItem('swarmify.floorPrefs.v1')
  }

  expect(source).toContain('sessionsAgents.find((a) => a.id === selectedAgentId)')
  expect(source).toContain('onSelect={(a) => selectSession(a.id)}')
  expect(source).toContain('{rightOpen && <div className="detail-col">')
  expect(source).not.toContain("rightOpen && center !== 'sessions'")
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
