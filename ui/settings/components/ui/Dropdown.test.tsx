import { expect, test } from 'bun:test'
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSection } from './Dropdown'
import { Modal } from './Modal'
if (typeof document === 'undefined') GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  return { host, dispose: async () => { await act(async () => root.unmount()); host.remove() } }
}
async function key(target: Element, key: string) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}

test('menu navigation skips disabled rows, wraps, selects once, restores trigger, and dismisses outside', async () => {
  const chosen: string[] = []
  function Picker() {
    const [open, setOpen] = useState(false)
    return <Dropdown open={open} onOpenChange={setOpen}>
      <DropdownTrigger>Choose host</DropdownTrigger>
      <DropdownMenu aria-label="Hosts">
        <DropdownSection>Machines</DropdownSection>
        {['A', 'offline', 'B'].map(label => <DropdownItem key={label} disabled={label === 'offline'}
          onClick={() => { chosen.push(label); setOpen(false) }}>{label}</DropdownItem>)}
      </DropdownMenu>
    </Dropdown>
  }
  const { host, dispose } = await mount(<Picker />)
  try {
    const trigger = host.querySelector('button')!
    trigger.focus()
    await key(trigger, 'ArrowDown')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.textContent).toBe('A')
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('B')
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('A')
    await key(document.activeElement!, 'End')
    expect(document.activeElement?.textContent).toBe('B')
    await key(document.activeElement!, 'Home')
    expect(document.activeElement?.textContent).toBe('A')
    await key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement?.textContent).toBe('B')
    await key(document.activeElement!, 'Enter')
    expect(chosen).toEqual(['B'])
    expect(document.activeElement).toBe(trigger)
    await act(async () => trigger.click())
    await key(document.activeElement!, 'Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    await act(async () => trigger.click())
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  } finally { await dispose() }
})

test('searchable menu navigates the current filtered items and Escape dismisses only the menu inside a modal', async () => {
  let closed = 0
  let filter: (query: string) => void = () => {}
  function Search() {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    filter = setQuery
    return <Modal onClose={() => closed++}>
      <Dropdown open={open} onOpenChange={setOpen}>
        <DropdownTrigger>Projects</DropdownTrigger>
        <DropdownMenu>
          <input aria-label="Search" value={query} onChange={e => setQuery(e.target.value)} />
          {['Alpha', 'Beta'].filter(x => x.includes(query)).map(x => <DropdownItem key={x}>{x}</DropdownItem>)}
        </DropdownMenu>
      </Dropdown>
    </Modal>
  }
  const { host, dispose } = await mount(<Search />)
  try {
    await act(async () => host.querySelector('button')!.click())
    expect(document.activeElement?.tagName).toBe('INPUT')
    await key(document.activeElement!, 'End')
    expect(document.activeElement?.tagName).toBe('INPUT')
    await key(document.activeElement!, 'Home')
    expect(document.activeElement?.tagName).toBe('INPUT')
    await key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement?.textContent).toBe('Beta')
    await act(async () => (host.querySelector('input') as HTMLInputElement).focus())
    await act(async () => filter('Alpha'))
    await key(host.querySelector('input')!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Alpha')
    await key(document.activeElement!, 'Escape')
    expect(closed).toBe(0)
    await key(document.activeElement!, 'Escape')
    expect(closed).toBe(1)
  } finally { await dispose() }
})
