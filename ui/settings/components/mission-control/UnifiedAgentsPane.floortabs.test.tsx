import { afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// PHNX-3925: the Fleet view no longer renders an empty FloorSubtabs bar. The strip
// (.fsubtabs) is gated on `openTaskTabs.length > 0` (UnifiedAgentsPane.tsx), and
// Dispatch moved to the top header. These tests pin both halves of that gate:
//   1. the REAL pane paints no .fsubtabs when there are no task tabs, and
//   2. the REAL FloorSubtabs the pane gates paints .fsubtabs once a task tab exists.
if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { renderToStaticMarkup } = require('react-dom/server')
const { UnifiedAgentsPane } = require('./UnifiedAgentsPane')
const { FloorSubtabs } = require('./FloorSubtabs')

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

afterEach(() => {
  document.body.innerHTML = ''
})

// The gate expression exactly as it lives in UnifiedAgentsPane.tsx: FloorSubtabs
// renders only when there is at least one open task tab. Reused across both cases.
const noop = () => {}
function gate(taskTabs: { id: string; title: string; source: 'LN' | 'GH' }[]) {
  return taskTabs.length > 0 ? (
    <FloorSubtabs
      fixed={[]}
      center="sessions"
      taskTabs={taskTabs}
      activeTaskTab={null}
      onSelectCenter={noop}
      onSelectTaskTab={noop}
      onCloseTaskTab={noop}
    />
  ) : null
}

describe('Fleet FloorSubtabs gate (PHNX-3925)', () => {
  test('the real pane paints NO .fsubtabs bar when there are no task tabs', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        React.createElement(UnifiedAgentsPane, {
          terminals: [],
          tasks: [],
          tasksLoading: false,
          unifiedTasks: [],
          unifiedTasksLoading: false,
          onDispatch: noop,
          search: '',
          onSearch: noop,
        }),
      )
    })

    // The empty full-width Dispatch band is gone: no sub-tab strip at all.
    expect(host.querySelector('.fsubtabs')).toBeNull()

    await act(async () => { root.unmount() })
    window.matchMedia = origMatchMedia
  })

  test('the gate paints .fsubtabs once a task tab opens', () => {
    expect(renderToStaticMarkup(gate([]))).toBe('')

    const html = renderToStaticMarkup(gate([{ id: 'RUSH-1', title: 'Token exchange', source: 'LN' }]))
    expect(html).toContain('class="fsubtabs"')
    expect(html).toContain('Token exchange')
  })
})
