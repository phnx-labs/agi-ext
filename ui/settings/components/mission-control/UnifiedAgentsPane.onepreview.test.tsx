import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// ONE PREVIEW (PHNX-3939 follow-up). The Fleet view has no detail rail at all
// any more: the native `agentsPanel.terminal` sidebar is the only session
// preview, so a row click POSTS the selection to the host instead of opening a
// column. This is also the permanent fix for the whole class of defect PHNX-3938
// and PHNX-3592 chased — a persisted "detail open" pref could restore a blank
// third-width column with nothing selected. Asserted here:
//   1. a legacy floor pref with `right: true` restores NO column, ever;
//   2. clicking a session row posts 'session.select' with the row's session id and
//      owning host, and still opens no column;
//   3. the row keeps the PHNX-3879 click/expand split — the chevron expands the
//      card in place without changing the sidebar subject.
if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { UnifiedAgentsPane } = require('./UnifiedAgentsPane')
const { resetVsCodeApi } = require('../../hooks')

// SessionRow renders a harness avatar from the theme-injected icon table; seed it
// so the row (and its click target) paints regardless of test-file ordering.
;(window as unknown as { __ICONS__: Record<string, string> }).__ICONS__ = { claude: 'claude.svg', agents: 'agents.svg' }

const origMatchMedia = window.matchMedia
// Capture every host message the pane posts, so the selection contract is
// asserted on the real payload rather than on a rendered artifact.
const posted: Record<string, unknown>[] = []
;(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (msg: Record<string, unknown>) => { posted.push(msg) },
  getState: () => undefined,
  setState: () => {},
})


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

// Persist a LEGACY floor pref that still carries `right: true` — the exact state
// the empty-column bug depended on. Nothing may read it any more.
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

// The host API is a module singleton, and another test file in the same bun run
// may already have resolved it against ITS stub. Re-resolve before each test so
// the capture above is the bridge this pane actually posts through.
beforeEach(() => { resetVsCodeApi() })

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  posted.length = 0
  resetVsCodeApi()
})

describe('one preview: the Fleet list has no detail rail (PHNX-3939)', () => {
  test('a legacy right:true floor pref restores NO detail column', async () => {
    seedRailOpenPref()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(UnifiedAgentsPane, paneProps))
    })

    expect(host.querySelector('.detail-col')).toBeNull()
    expect(host.textContent).not.toContain('Select an agent or issue')

    await act(async () => { root.unmount() })
    window.matchMedia = origMatchMedia
  })

  test('clicking a session row posts session.select and opens no column', async () => {
    seedRailOpenPref()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(UnifiedAgentsPane, paneProps))
    })

    // Feed the session in through the canonical stream message the pane listens
    // for. Nothing is selected yet, so nothing has been posted.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'localSessions', ok: true, fetchedAt: Date.parse('2026-09-04T12:00:00Z'), sessions: [remoteSession()] },
      }))
    })
    const row = host.querySelector('.sx-row') as HTMLElement | null
    expect(row).toBeTruthy()
    expect(posted.filter((m) => m.type === 'session.select')).toHaveLength(0)

    await act(async () => { row!.click() })

    // The selection went to the HOST (which points the sidebar at it), carrying
    // both the session id and the device that owns it — the sidebar needs the
    // host to pick the right row and to name the right stream scope.
    expect(posted.filter((m) => m.type === 'session.select')).toEqual([
      { type: 'session.select', sessionId: 'sel-1', host: 'yosemite-s1' },
    ])
    // And still no rail.
    expect(host.querySelector('.detail-col')).toBeNull()
    // The row is highlighted so the list shows what you picked.
    expect(host.querySelector('.sx-row.active')).toBeTruthy()

    await act(async () => { root.unmount() })
    window.matchMedia = origMatchMedia
  })

  test('the expand chevron expands in place without changing the sidebar subject (PHNX-3879)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(UnifiedAgentsPane, paneProps))
    })
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'localSessions', ok: true, fetchedAt: Date.parse('2026-09-04T12:00:00Z'), sessions: [remoteSession()] },
      }))
    })
    const chevron = host.querySelector('.sx-row .sx-expandbtn') as HTMLElement | null
    expect(chevron).toBeTruthy()
    await act(async () => { chevron!.click() })
    // stopPropagation on the chevron means the row's onSelect never fires, so the
    // sidebar keeps whatever session it was already following.
    expect(posted.filter((m) => m.type === 'session.select')).toHaveLength(0)

    await act(async () => { root.unmount() })
    window.matchMedia = origMatchMedia
  })
})
