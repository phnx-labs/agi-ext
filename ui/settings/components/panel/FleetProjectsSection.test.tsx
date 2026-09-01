import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { FleetProjectsSection } = require('./FleetProjectsSection')

// getVsCodeApi()/resolveBridge() is a MODULE singleton (host/bridge.ts) bound to the
// FIRST test file that posts — so a whole-suite run binds it to whichever file ran
// first, and this file's outbound posts land in THAT file's sink, not ours. We
// therefore assert only on what is deterministic in-suite: render output and the
// component's reaction to inbound `window` 'message' events (its own listener, no
// singleton involved). installHost() still provides a host so the mount-time posts
// resolve a bridge instead of throwing when this file happens to bind first.
function installHost() {
  ;(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => undefined,
    setState: () => {},
  })
}

async function dispatch(data: unknown) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data }))
  })
}

async function mount() {
  const rootElement = document.createElement('div')
  document.body.appendChild(rootElement)
  const root = createRoot(rootElement)
  await act(async () => {
    root.render(React.createElement(FleetProjectsSection))
  })
  return { root, rootElement }
}

beforeEach(() => {
  installHost()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FleetProjectsSection', () => {
  test('renders the reused ProjectsPane', async () => {
    const { root, rootElement } = await mount()

    // The reused ProjectsPane renders its "Projects" head + the CLI-managed list label.
    expect(rootElement.textContent).toContain('Projects')
    expect(rootElement.textContent).toContain('CLI-managed projects')

    await act(async () => root.unmount())
  })

  test('a host-picked folder enables the Add project button', async () => {
    const { root, rootElement } = await mount()

    // A host-picked folder prefills the add form (path + name), enabling Add.
    await dispatch({
      type: 'projectFolderPicked',
      path: '/Users/muqsit/src/github.com/phnx-labs/agents-cli',
      repoSlug: 'phnx-labs/agents-cli',
      name: 'agents-cli',
    })

    const addBtn = Array.from(rootElement.querySelectorAll('button')).find(
      (b) => (b as HTMLButtonElement).textContent === 'Add project',
    ) as HTMLButtonElement | undefined
    expect(addBtn).toBeTruthy()
    // Clicking the enabled Add must not throw (outbound post routes through the
    // module-singleton bridge, which is not observable in a whole-suite run).
    await act(async () => addBtn!.click())

    await act(async () => root.unmount())
  })

  test('managedProjectsData renders a row with a Remove control', async () => {
    const { root, rootElement } = await mount()

    await dispatch({
      type: 'managedProjectsData',
      projects: [
        { id: 'alpha', name: 'Alpha', path: '/alpha', dirs: [{ path: '/alpha' }], confidence: 'high', source: 'manual' },
      ],
    })

    expect(rootElement.textContent).toContain('Alpha')
    const removeBtn = Array.from(rootElement.querySelectorAll('button')).find(
      (b) => (b as HTMLButtonElement).textContent === 'Remove',
    ) as HTMLButtonElement | undefined
    expect(removeBtn).toBeTruthy()
    await act(async () => removeBtn!.click())

    await act(async () => root.unmount())
  })

  test('a managedProjectsData error surfaces inline and keeps last-good projects', async () => {
    const { root, rootElement } = await mount()

    await dispatch({
      type: 'managedProjectsData',
      projects: [
        { id: 'alpha', name: 'Alpha', path: '/alpha', dirs: [{ path: '/alpha' }], confidence: 'high', source: 'manual' },
      ],
    })
    expect(rootElement.textContent).toContain('Alpha')

    // A subsequent error must NOT wipe the last-good row; it surfaces inline.
    await dispatch({ type: 'managedProjectsData', error: 'agents projects list failed' })
    expect(rootElement.textContent).toContain('Alpha')
    expect(rootElement.textContent).toContain('agents projects list failed')

    await act(async () => root.unmount())
  })
})
