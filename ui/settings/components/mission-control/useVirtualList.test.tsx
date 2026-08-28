import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { useVirtualList } = require('./useVirtualList')

// Record every element a ResizeObserver observes so we can assert the hook
// attaches to the scroll container even when it mounts AFTER first render — the
// PHNX-2458 blocker: the feed's scroll div only renders when its tab is active,
// so a mount-time `useLayoutEffect([])` observed a null ref and never fired.
const observed: Element[] = []
class FakeResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(el: Element) { observed.push(el) }
  unobserve() {}
  disconnect() {}
}

const originalRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver

beforeEach(() => {
  observed.length = 0
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
})
afterEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = originalRO
})

// A harness that mirrors the tab-gated feed: the scroll container renders only
// when `visible` is true, exactly like `center === 'agents'` gates the feed.
function Harness({ visible }: { visible: boolean }) {
  const { scrollRef, visibleItems, padTop, padBottom } = useVirtualList(
    Array.from({ length: 50 }, (_, i) => ({ key: String(i), height: 40 })),
    { overscan: 2 },
  )
  if (!visible) return React.createElement('div', null, 'other tab')
  return React.createElement(
    'div',
    { ref: scrollRef, 'data-testid': 'feed' },
    React.createElement('div', { style: { height: padTop } }),
    ...visibleItems.map((it: { key: string }) => React.createElement('div', { key: it.key }, it.key)),
    React.createElement('div', { style: { height: padBottom } }),
  )
}

describe('useVirtualList — observer attaches to a late-mounting container (PHNX-2458)', () => {
  test('does not observe while the scroll container is unmounted', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(React.createElement(Harness, { visible: false })))
    expect(observed.length).toBe(0)
    act(() => root.unmount())
    host.remove()
  })

  test('observes the container the moment it mounts (tab becomes active)', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    // First render with the feed's tab inactive — the scroll div is absent.
    act(() => root.render(React.createElement(Harness, { visible: false })))
    expect(observed.length).toBe(0)
    // Switch to the feed's tab: the scroll div mounts. The callback ref must fire
    // and attach the ResizeObserver — the mount-time-effect version never did.
    act(() => root.render(React.createElement(Harness, { visible: true })))
    const el = host.querySelector('[data-testid="feed"]')
    expect(el).not.toBeNull()
    expect(observed).toContain(el as Element)
    act(() => root.unmount())
    host.remove()
  })
})
