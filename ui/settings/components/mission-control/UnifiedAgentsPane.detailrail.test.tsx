import { afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// PHNX-3938 (folds PHNX-3592): the Fleet view's right-hand detail rail must NOT
// render a blank third-width column just because `rightOpen` was restored true
// from the persisted floor pref. The rail is gated on rightOpen AND an actual
// selection, so:
//   1. with the pref restored open but nothing selected, no .detail-col exists
//      (and none of the removed "Select an agent" .detail-empty placeholder), and
//   2. clicking a session row selects it and the .detail-col appears.
if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { UnifiedAgentsPane } = require('./UnifiedAgentsPane')

// SessionRow renders a harness avatar from the theme-injected icon table; seed it
// so the row (and its click target) paints regardless of test-file ordering.
;(window as unknown as { __ICONS__: Record<string, string> }).__ICONS__ = { claude: 'claude.svg', agents: 'agents.svg' }

const origMatchMedia = window.matchMedia
;(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
})
window.matchMedia = (() => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as typeof window.matchMedia

const noop = () => {}
const paneProps = {
  terminals: [],
  tasks: [],
  tasksLoading: false,
  unifiedTasks: [],
  unifiedTasksLoading: false,
  onDispatch: noop,
  search: '',
  onSearch: noop,
}

// Persist the floor pref with the detail rail restored OPEN — the exact state the
// bug depended on (rightOpen initialized true from the saved pref, no selection).
function seedRailOpenPref() {
  localStorage.setItem(
    'swarmify.floorPrefs.v1',
    JSON.stringify({ layoutVersion: 2, plain: false, sidebar: false, rail: true, right: true, pinned: [], hostPins: null, sidebarWidth: 300 }),
  )
}

// A minimal genuinely-remote session (host !== 'this-mac') so it folds onto the
// Sessions list through adaptRemote without any local-terminal plumbing.
function remoteSession(over: Record<string, unknown> = {}) {
  return {
    host: 'yosemite-s1',
    sessionId: 'sel-1',
    agentType: 'claude',
    cwd: '/home/muqsit/src/agents-cli',
    project: 'agents-cli',
    phase: 'running',
    activity: 'working',
    tokPerSec: 0,
    waitingForInput: false,
    lastResponse: 'Did a thing.',
    prUrl: null,
    ticket: null,
    branch: 'main',
    sinceMs: 1000,
    startedAtMs: Date.parse('2026-09-04T11:59:59Z'),
    topic: 'Test session for the detail rail',
    context: 'remote',
    cloudTaskId: '',
    cloudProvider: '',
    teamName: '',
    pid: 123,
    transport: '',
    replyRail: '',
    replyMuxTarget: '',
    replyMuxSocket: '',
    tmuxPane: '',
    ...over,
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('Fleet detail rail gate (PHNX-3938)', () => {
  test('rightOpen restored true but nothing selected paints NO detail column', async () => {
    seedRailOpenPref()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(UnifiedAgentsPane, paneProps))
    })

    // The persisted-open pref alone must not conjure the rail...
    expect(host.querySelector('.detail-col')).toBeNull()
    // ...and the old "Select an agent or issue" placeholder is gone for good.
    expect(host.textContent).not.toContain('Select an agent or issue')

    await act(async () => { root.unmount() })
    window.matchMedia = origMatchMedia
  })

  test('selecting a session row opens the detail column', async () => {
    seedRailOpenPref()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(UnifiedAgentsPane, paneProps))
    })

    // Feed the session in through the canonical local/remote stream message the
    // pane already listens for — no selection yet, so still no rail.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'localSessions', ok: true, fetchedAt: Date.parse('2026-09-04T12:00:00Z'), sessions: [remoteSession()] },
      }))
    })
    const row = host.querySelector('.sx-row') as HTMLElement | null
    expect(row).toBeTruthy()
    expect(host.querySelector('.detail-col')).toBeNull()

    // Clicking the row selects the session; the rail now renders.
    await act(async () => { row!.click() })
    expect(host.querySelector('.detail-col')).toBeTruthy()

    await act(async () => { root.unmount() })
    window.matchMedia = origMatchMedia
  })
})
