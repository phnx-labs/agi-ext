import { expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { Modal } from './Modal'
if (typeof document === 'undefined') GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('modal traps focus in both directions, excludes disabled/hidden controls, handles Escape/backdrop and restores focus', async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let closed = 0
  await act(async () => root.render(<Modal onClose={() => closed++} aria-label="Test dialog">
    <button>First</button><button disabled>Disabled</button><div hidden><button>Hidden</button></div><div style={{ display: 'none' }}><input /></div><button>Last</button>
  </Modal>))
  try {
    const modal = host.querySelector('[role="dialog"]')!
    const first = host.querySelector('button')!
    const last = host.querySelectorAll('button')[3]!
    expect(document.activeElement).toBe(first)
    const tab = (shiftKey: boolean) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }))
    await act(async () => { tab(true) })
    expect(document.activeElement).toBe(last)
    await act(async () => { tab(false) })
    expect(document.activeElement).toBe(first)
    await act(async () => trigger.focus())
    expect(document.activeElement).toBe(first)
    await act(async () => first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(closed).toBe(0)
    await act(async () => modal.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(closed).toBe(1)
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(closed).toBe(2)
  } finally {
    await act(async () => root.unmount())
    expect(document.activeElement).toBe(trigger)
    host.remove(); trigger.remove()
  }
})

test('only the topmost nested modal handles Escape and restores focus to the parent', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let outer = 0, inner = 0
  function Dialogs({ nested }: { nested: boolean }) {
    return <Modal onClose={() => outer++}><button>Parent</button>{nested && <Modal onClose={() => inner++}><button>Child</button></Modal>}</Modal>
  }
  try {
    await act(async () => root.render(<Dialogs nested={false} />))
    await act(async () => root.render(<Dialogs nested />))
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(inner).toBe(1); expect(outer).toBe(0)
    await act(async () => root.render(<Dialogs nested={false} />))
    expect(document.activeElement?.textContent).toBe('Parent')
  } finally { await act(async () => root.unmount()); host.remove() }
})


test('a parent mounting with an already-open nested dialog does not steal its focus or Escape', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let outer = 0, inner = 0
  try {
    await act(async () => root.render(<Modal onClose={() => outer++}><button>Parent</button>
      <Modal onClose={() => inner++}><button>Child</button></Modal>
    </Modal>))
    expect(document.activeElement?.textContent).toBe('Child')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(inner).toBe(1); expect(outer).toBe(0)
  } finally { await act(async () => root.unmount()); host.remove() }
})
