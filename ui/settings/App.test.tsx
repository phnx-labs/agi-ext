import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')

type PostedMessage = { type?: string }
type IntervalEntry = { delay?: number; timer: ReturnType<typeof setInterval> }
const activeIntervals: IntervalEntry[] = []

const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const originalDateNow = Date.now
const originalMatchMedia = window.matchMedia

function installHost(posts: PostedMessage[]) {
  ;(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: PostedMessage) => posts.push(message),
    getState: () => undefined,
    setState: () => {},
  })
}

function installIcons() {
  ;(window as unknown as { __ICONS__: unknown }).__ICONS__ = {
    claude: 'claude.svg',
    codex: { dark: 'codex-dark.svg', light: 'codex-light.svg' },
    gemini: 'gemini.svg',
    opencode: 'opencode.svg',
    cursor: { dark: 'cursor-dark.svg', light: 'cursor-light.svg' },
    agents: 'agents.svg',
    shell: 'shell.svg',
    github: 'github.svg',
    antigravity: 'antigravity.svg',
    grok: { dark: 'grok-dark.svg', light: 'grok-light.svg' },
    kimi: 'kimi.svg',
    droid: { dark: 'droid-dark.svg', light: 'droid-light.svg' },
  }
}

function installBrowserShims(intervals: IntervalEntry[]) {
  globalThis.setInterval = new Proxy(originalSetInterval, {
    apply(target, thisArg, args) {
      const timer = Reflect.apply(target, thisArg, args)
      const entry = { delay: args[1], timer }
      intervals.push(entry)
      activeIntervals.push(entry)
      return timer
    },
  })
}

afterEach(() => {
  for (const { timer } of activeIntervals.splice(0)) originalClearInterval(timer)
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  Date.now = originalDateNow
  window.matchMedia = originalMatchMedia
  document.body.innerHTML = ''
  delete (globalThis as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi
})

describe('App unified task refresh', () => {
  // The removed timers (PHNX-3447 / PHNX-3435): the backlog no longer refreshes
  // on a 30s setInterval, the floor tasks/terminals no longer on a 30s
  // setInterval, and the watchdog log no longer on a 15s setInterval. Each is
  // now driven by a real signal — window-focus-regained and panel-visible — the
  // sanctioned one-scheduler replacement (PHNX-2833, mirroring the Issues
  // Panel). These tests assert the events drive the refetch AND that no acting
  // interval is registered at all.

  // The webview host API (getVsCodeApi) is a module singleton bound to the FIRST
  // installed host, so every test in this file must share ONE posts/intervals
  // pair and clear it between runs rather than swap in fresh arrays.
  const posts: PostedMessage[] = []
  const intervals: IntervalEntry[] = []
  let now = 1_000

  beforeEach(() => {
    posts.length = 0
    intervals.length = 0
    now = 1_000
    Date.now = () => now
    installHost(posts)
    installIcons()
    installBrowserShims(intervals)
  })

  async function mountApp() {
    const { default: App } = await import('./App')
    const rootElement = document.createElement('div')
    document.body.appendChild(rootElement)
    const root = createRoot(rootElement)
    await act(async () => {
      root.render(React.createElement(App))
    })
    return root
  }

  const count = (type: string) =>
    posts.filter((message) => message.type === type).length

  async function dispatch(data: unknown) {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data }))
    })
  }

  test('refreshes the backlog on window-focus-regained, never on a timer', async () => {
    const root = await mountApp()

    // Initial floor-tab load fires exactly one backlog fetch.
    expect(count('fetchUnifiedTasks')).toBe(1)

    // Flip the loaded flags (host replied). This alone must NOT refetch — it is
    // inside the de-dup window and there is no interval to fire.
    await dispatch({ type: 'tasksData', tasks: [] })
    await dispatch({ type: 'unifiedTasksData', tasks: [] })
    expect(count('fetchUnifiedTasks')).toBe(1)

    // A focus regained inside the de-dup window is a no-op.
    now += 5_000
    await dispatch({ type: 'windowFocusRegained' })
    expect(count('fetchUnifiedTasks')).toBe(1)

    // A focus regained past the de-dup window refetches the backlog.
    now += 30_001
    await dispatch({ type: 'windowFocusRegained' })
    expect(count('fetchUnifiedTasks')).toBe(2)

    // No acting poll timer was ever registered.
    expect(intervals.filter((e) => e.delay === 30_000 || e.delay === 15_000)).toHaveLength(0)

    await act(async () => { root.unmount() })
  })

  test('refetches the backlog when the panel becomes visible again', async () => {
    const root = await mountApp()

    await dispatch({ type: 'tasksData', tasks: [] })
    await dispatch({ type: 'unifiedTasksData', tasks: [] })
    expect(count('fetchUnifiedTasks')).toBe(1)

    now += 30_001
    await dispatch({ type: 'panelVisibility', visible: false })
    // Hidden: no refetch.
    expect(count('fetchUnifiedTasks')).toBe(1)

    await dispatch({ type: 'panelVisibility', visible: true })
    // Visible again past the de-dup window: refetch.
    expect(count('fetchUnifiedTasks')).toBe(2)

    await act(async () => { root.unmount() })
  })

  test('focus-regained re-fetches the floor tasks + terminals backstop', async () => {
    const root = await mountApp()

    // Mount seeds one fetchTasks (tab load) and one fetchAllTerminals (init).
    await dispatch({ type: 'tasksData', tasks: [] })
    const tasksBefore = count('fetchTasks')
    const terminalsBefore = count('fetchAllTerminals')

    await dispatch({ type: 'windowFocusRegained' })
    expect(count('fetchTasks')).toBe(tasksBefore + 1)
    expect(count('fetchAllTerminals')).toBe(terminalsBefore + 1)

    await act(async () => { root.unmount() })
  })

  // The window-restore case names two triggers (panel-visible + focus-regained)
  // that can land together; the shared de-dup guard must collapse them to ONE
  // real host refetch (PHNX-3447 — the redundant-spawn class this ticket removes).
  test('a second focus-regained inside the de-dup window does not re-fire the floor backstop', async () => {
    const root = await mountApp()
    await dispatch({ type: 'tasksData', tasks: [] })

    await dispatch({ type: 'windowFocusRegained' })
    const tasksAfterFirst = count('fetchTasks')
    const terminalsAfterFirst = count('fetchAllTerminals')

    // Same mocked clock (`now` unchanged) → within BACKSTOP_REFETCH_DEDUP_MS → skipped.
    await dispatch({ type: 'windowFocusRegained' })
    expect(count('fetchTasks')).toBe(tasksAfterFirst)
    expect(count('fetchAllTerminals')).toBe(terminalsAfterFirst)

    await act(async () => { root.unmount() })
  })
})
