import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()

import React from 'react'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const posted: unknown[] = []
;(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => { posted.push(message) },
  getState: () => undefined,
  setState: () => {},
})

const { PillLink, githubPullRequestUrl, githubRepoUrl } = await import('./RowLinks')
const { resetVsCodeApi } = await import('../../../hooks/useVscodeApi')

beforeEach(() => {
  posted.length = 0
  // The host API is a process-wide singleton resolved on first use; without
  // this reset an earlier test file's host wins and our stub is never observed.
  resetVsCodeApi()
})
afterAll(() => {
  delete (globalThis as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi
})

describe('session row links', () => {
  test('PillLink opens through the host bridge and stops row propagation', () => {
    let rowClicks = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        <div onClick={() => { rowClicks += 1 }}>
          <PillLink href="https://linear.app/issue/PHNX-3542" copyText="PHNX-3542" className="ticket">
            ◇ PHNX-3542
          </PillLink>
        </div>,
      )
    })
    act(() => { (host.querySelector('a.ticket') as HTMLAnchorElement).click() })
    expect(posted).toEqual([{ type: 'openExternal', url: 'https://linear.app/issue/PHNX-3542' }])
    expect(rowClicks).toBe(0)
    act(() => root.unmount())
    host.remove()
  })

  test('derives only a trustworthy GitHub repository URL from a PR URL', () => {
    expect(githubRepoUrl('https://github.com/phnx-labs/agi-ext/pull/23'))
      .toBe('https://github.com/phnx-labs/agi-ext')
    expect(githubRepoUrl('https://gitlab.com/phnx-labs/agi-ext/pull/23')).toBeNull()
    expect(githubRepoUrl('https://github.com/phnx-labs/agi-ext/issues/23')).toBeNull()
  })

  test('opens only a normalized GitHub pull-request URL', () => {
    expect(githubPullRequestUrl('https://github.com/phnx-labs/agi-ext/pull/23?utm_source=feed#discussion'))
      .toBe('https://github.com/phnx-labs/agi-ext/pull/23')
    expect(githubPullRequestUrl('https://attacker.example/phnx-labs/agi-ext/pull/23')).toBeNull()
    expect(githubPullRequestUrl('#23')).toBeNull()
  })
})
