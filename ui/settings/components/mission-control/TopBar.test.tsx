import { afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Guarded happy-dom registration (App.test.tsx idiom): a click fires the real
// onClick handler, which renderToStaticMarkup cannot exercise. Register only when
// no document exists so this survives a run launched outside ui/ (no bunfig preload).
if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { TopBar } = require('./TopBar')

afterEach(() => {
  document.body.innerHTML = ''
})

async function mount(node: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  return { host, root }
}

const base = {
  activeTab: 'floor' as const,
  onTabChange: () => {},
  activeSwarmCount: 0,
  isLightTheme: false,
}

describe('TopBar Dispatch button (PHNX-3925)', () => {
  test('renders the lime .disp button and fires onDispatch on click when the prop is set', async () => {
    let fired = 0
    const { host, root } = await mount(
      React.createElement(TopBar, { ...base, onDispatch: () => { fired += 1 } }),
    )

    const btn = host.querySelector('button.disp') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain('Dispatch')

    await act(async () => { btn!.click() })
    expect(fired).toBe(1)

    await act(async () => { root.unmount() })
  })

  test('renders no Dispatch button when onDispatch is undefined (e.g. off the Fleet tab)', async () => {
    const { host, root } = await mount(
      React.createElement(TopBar, { ...base, activeTab: 'panel' as const }),
    )

    expect(host.querySelector('button.disp')).toBeNull()

    await act(async () => { root.unmount() })
  })
})
