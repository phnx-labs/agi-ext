import { GlobalRegistrator } from '@happy-dom/global-registrator'
if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, expect, test } from 'bun:test'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { ProjectMenu } from './ProjectMenu'
import type { ProjectFilterOption } from '../sessionsModel'

/** Drive a controlled input the way React observes it (native value setter + input event). */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const OPTS: ProjectFilterOption[] = [
  { value: null, label: 'All projects', count: 5 },
  { value: 'agents-cli', label: 'agents-cli', count: 2 },
  { value: 'rush', label: 'rush', count: 1 },
]

function mountMenu(props: Partial<React.ComponentProps<typeof ProjectMenu>> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const picks: Array<string | null> = []
  act(() => {
    root.render(
      <ProjectMenu
        state={{ x: 10, y: 10 }}
        options={OPTS}
        title="Filter by project"
        onPick={(v) => picks.push(v)}
        onClose={() => {}}
        {...props}
      />,
    )
  })
  const menu = document.body.querySelector('.sx-project-menu') as HTMLDivElement
  return { root, host, menu, picks }
}

describe('ProjectMenu', () => {
  test('renders every option with its count and marks the selected one', () => {
    const { root, host, menu } = mountMenu({ selected: 'agents-cli' })
    const items = [...menu.querySelectorAll('.sx-project-menu-item')]
    expect(items.map((i) => i.querySelector('.lab')?.textContent)).toEqual(['All projects', 'agents-cli', 'rush'])
    expect(menu.querySelector('.sx-project-menu-item.on .lab')?.textContent).toBe('agents-cli')
    act(() => root.unmount()); host.remove()
  })

  test('search narrows the list; picking an item reports its value', () => {
    const { root, host, menu, picks } = mountMenu()
    const input = menu.querySelector('.sx-project-menu-search input') as HTMLInputElement
    act(() => { typeInto(input, 'rush') })
    const items = [...menu.querySelectorAll('.sx-project-menu-item')]
    expect(items).toHaveLength(1)
    act(() => { (items[0] as HTMLButtonElement).click() })
    expect(picks).toEqual(['rush'])
    act(() => root.unmount()); host.remove()
  })

  test('a no-match query shows the empty state', () => {
    const { root, host, menu } = mountMenu()
    const input = menu.querySelector('.sx-project-menu-search input') as HTMLInputElement
    act(() => { typeInto(input, 'zzz-none') })
    expect(menu.querySelector('.sx-project-menu-empty')).toBeTruthy()
    expect(menu.querySelectorAll('.sx-project-menu-item')).toHaveLength(0)
    act(() => root.unmount()); host.remove()
  })
})
