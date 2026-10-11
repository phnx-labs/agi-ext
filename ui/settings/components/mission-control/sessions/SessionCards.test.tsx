import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, expect, test } from 'bun:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionPresentationStore } from '../../../../../src/core/sessionPresentationStore'
import { sessionCardFields } from '../../../../../src/core/sessionCardFields'
import { SESSION_CARDS_SCRIPT } from '../../../../../src/shared/sessionCards'
import { adaptRemote, type RemoteSessionLike } from '../floorAdapter'
import type { FloorAgent, SessionCardSnapshot } from '../floorModel'
import { sessionRowView, shortFolder } from '../recapModel'
import { rowHeight } from '../SessionsPane'
import { SessionRow } from './SessionRow'

const RESET = await Bun.file(new URL('../testdata/fleet-reset.json', import.meta.url)).json()
const NOW = RESET.capturedAt as number
const noop = () => {}

const LIVE = 'b64b7320-58de-412c-88ab-1cf46e3d4f20'
const PREV_TIMELINE = '01a1245e-7541-79b3-9255-928fb77d88d3'
const PREV_BARE = '3c734cd4-fe3a-4e80-bba7-d69fe5ebbf23'

/**
 * The real path: stream reset -> presentation store -> RemoteSession plus the
 * host's card fields (settings.vscode.ts withSessionCards) -> postMessage -> FloorAgent.
 * `observer` is the machine the window runs on; observing from the worker makes
 * its sessions local, which is when artifacts get an inline preview URI.
 */
function floorRows(observer = 'zion'): Record<string, FloorAgent> {
  const store = new SessionPresentationStore()
  store.apply(RESET)
  const presented = store.presentedSessions(observer, 'this-mac', [], NOW).map((s) => ({
    ...s,
    card: sessionCardFields(s, {
      sessionId: s.sessionId, home: '/home/muqsit', remoteDevice: s.host === 'this-mac' ? undefined : s.host,
      previewUri: (p) => 'vscode-resource:' + p,
    }),
  }))
  const wire = JSON.parse(JSON.stringify(presented)) as RemoteSessionLike[]
  return Object.fromEntries(adaptRemote(wire, new Set(), 'zion').map((r) => [r.sessionId, r]))
}

/** What the sidebar would draw for the same snapshot, from the same shared script. */
function sidebarCards(snapshot: SessionCardSnapshot): string {
  const root = document.createElement('div')
  const render = new Function('root', 'viewState', 'vscode', `let lastSnapshot = null;
${SESSION_CARDS_SCRIPT}
lastSnapshot = arguments[3];
return renderArtifactsCard(lastSnapshot) + renderTimelineCard(lastSnapshot);`)
  return render(root, {}, { postMessage: noop, setState: noop }, snapshot) as string
}

function mount(agent: FloorAgent, expanded: boolean) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(
      <SessionRow
        agent={agent} nowMs={NOW} selected={false} active={false} expanded={expanded} height={rowHeight(agent, expanded)}
        onToggleSelect={noop} onToggleStar={noop} onResume={noop} onSelect={noop} onToggleExpand={noop}
      />,
    )
  })
  const cards = () => (host.querySelector('.sx-cards') as HTMLElement | null)?.shadowRoot?.querySelector('body') as HTMLElement | null
  return { host, cards, unmount: () => { act(() => root.unmount()); host.remove() } }
}

function render(agent: FloorAgent, expanded: boolean): string {
  return renderToStaticMarkup(
    <SessionRow
      agent={agent} nowMs={NOW} selected={false} active={false} expanded={expanded} height={rowHeight(agent, expanded)}
      onToggleSelect={noop} onToggleStar={noop} onResume={noop} onSelect={noop} onToggleExpand={noop}
    />,
  )
}

describe('stream row -> Fleet session card', () => {
  test('the adapter carries machine, folder, latest request, user turns and the card snapshot', () => {
    const live = floorRows()[LIVE]!
    expect(live.host).toBe('yosemite-m2')
    expect(live.cwd).toBe('/home/muqsit/src/github.com/acme/atlas')
    expect(live.userTurns).toHaveLength(3)
    expect(live.latestRequest).toBe('Please add my account id to the trusted owner ids when you get a chance.')
    expect(live.sessionCard).toMatchObject({ fullSessionId: LIVE, sessionHost: 'yosemite-m2', sessionLocal: false })
    expect((live.sessionCard!.timeline as { steps: unknown[] }).steps).toHaveLength(5)
  })

  test('collapsed live card shows machine + folder, your latest message, and the agent reply line', () => {
    const html = render(floorRows()[LIVE]!, false)
    expect(html).toContain('<span class="sx-where host" title="Runs on yosemite-m2">yosemite-m2</span>')
    expect(html).toContain('<span class="sx-where folder" title="/home/muqsit/src/github.com/acme/atlas">~/…/acme/atlas</span>')
    expect(html).toContain('<span class="sx-resumelabel">Resume</span>')
    expect(html).toContain('You ›')
    expect(html).toContain('Please add my account id to the trusted owner ids')
    expect(html).not.toContain('tell me why my own approvals are rejected')
    expect(html).toContain('Agent ›')
    expect(html).toContain('&quot;The merge guard now accepts your own-account approvals.&quot;')
    // The live activity is the same reply, so no now-line repeats it.
    expect(html).not.toContain('sx-now')
    expect(html).not.toContain('sx-cards')
  })

  test('expanded card draws the sidebar Timeline and Artifacts byte for byte', () => {
    const live = floorRows()[LIVE]!
    const row = mount(live, true)
    const body = row.cards()!
    expect(body).not.toBeNull()
    const sidebar = document.createElement('div')
    sidebar.innerHTML = sidebarCards(live.sessionCard!)
    expect(body.innerHTML).toBe(sidebar.innerHTML)
    // The sidebar's own pieces: the lane strip with an idle gap and turn markers,
    // the filter chips with counts, newest-first steps, the earlier counter, the gallery.
    expect(body.querySelector('.seek-gap')?.textContent).toContain('idle')
    expect(body.querySelectorAll('.seek-mk.you').length).toBeGreaterThan(0)
    const chips = Array.from(body.querySelectorAll('.tl-filters .tl-filter')).map((el) => el.textContent)
    expect(chips).toEqual(['Summary', 'You3', 'Failed1'])
    // The time chips: one per stretch of work between idle gaps.
    expect(body.querySelectorAll('.tl-phases .tl-phase')).toHaveLength(2)
    expect(body.querySelector('.step .step-txt')?.textContent).toBe('The merge guard now accepts your own-account approvals.')
    expect(body.querySelector('.timeline-earlier')?.textContent).toBe('▸ 141 earlier steps · 278 tools · 13 failed')
    expect(body.querySelector('.art-card')).not.toBeNull()
    // Remote: the image has no preview (it opens by copying it on click).
    expect(body.querySelector('img[data-thumb]')).toBeNull()
    row.unmount()
  })

  test('a filter chip re-renders the card in place, and its clicks name the session', () => {
    const posted: unknown[] = []
    ;(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m), getState: () => ({}), setState: noop })
    const live = floorRows()[LIVE]!
    const row = mount(live, true)
    const body = row.cards()!
    act(() => { (body.querySelector('[data-filter="user"]') as HTMLButtonElement).click() })
    expect(body.querySelector('.tl-filter.on')?.textContent).toBe('You3')
    expect(body.querySelectorAll('.tl-item')).toHaveLength(3)
    act(() => { (body.querySelector('.artifact-open') as HTMLButtonElement).click() })
    expect(posted.at(-1)).toMatchObject({ type: 'sessionCardAction', sessionId: LIVE, host: 'yosemite-m2', action: { type: 'openArtifact' } })
    row.unmount()
  })

  test('a scrolled artifact strip keeps its position when the stream re-renders the card', () => {
    const first = floorRows('yosemite-m2')[LIVE]!
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const draw = (agent: FloorAgent) => act(() => {
      root.render(<SessionRow agent={agent} nowMs={NOW} selected={false} active={false} expanded height={900}
        onToggleSelect={noop} onToggleStar={noop} onResume={noop} onSelect={noop} onToggleExpand={noop} />)
    })
    draw(first)
    const body = () => (host.querySelector('.sx-cards') as HTMLElement).shadowRoot!.querySelector('body')!
    act(() => { (body().querySelector('[data-art-group]') as HTMLButtonElement).click() })
    const strip = () => body().querySelector('[data-strip]') as HTMLElement
    expect(strip()).not.toBeNull()
    strip().scrollLeft = 40
    // A stream tick: a new row object for the same session.
    draw(floorRows('yosemite-m2')[LIVE]!)
    expect(strip().scrollLeft).toBe(40)
    act(() => root.unmount())
    host.remove()
  })

  test('a local session previews its images inline', () => {
    const local = floorRows('yosemite-m2')[LIVE]!
    expect(local.sessionCard).toMatchObject({ sessionLocal: true })
    const html = sidebarCards(local.sessionCard!)
    expect(html).toContain('data-thumb="vscode-resource:/home/muqsit/src/github.com/acme/atlas/.agents/artifacts/2026-10-10/merge-guard/flow.png"')
  })

  test('a previous row without preview takes its agent line from the newest narration step', () => {
    const prev = floorRows()[PREV_TIMELINE]!
    const row = sessionRowView(prev)
    expect(row.you.text).toBe('Continue..')
    expect(row.lastFull).toBe('Pulled 12 commits; the indexer and the export script changed.')
    const html = render(prev, false)
    expect(html).toContain('Agent ›')
  })

  test('a previous row with only its first message shows no agent line and no timeline', () => {
    const bare = floorRows()[PREV_BARE]!
    const row = mount(bare, true)
    expect(row.host.innerHTML).toContain('Check the carousel post schedule.')
    expect(row.host.innerHTML).not.toContain('Agent ›')
    expect(row.host.innerHTML).not.toContain('Latest reply')
    expect(row.cards()!.innerHTML).toBe('')
    row.unmount()
  })

  test('collapsed height follows the lines rendered; an expanded row uses its measured height', () => {
    const rows = floorRows()
    expect(rowHeight(rows[PREV_BARE]!, false)).toBeLessThan(rowHeight(rows[PREV_TIMELINE]!, false))
    expect(rowHeight(rows[LIVE]!, true)).toBeGreaterThan(rowHeight(rows[LIVE]!, false) + 200)
    expect(rowHeight(rows[LIVE]!, true, 900)).toBe(900)
  })
})

describe('shortFolder', () => {
  test('keeps short paths and elides the middle of long ones', () => {
    expect(shortFolder('/Users/me')).toBe('~')
    expect(shortFolder('/Users/me/src/repo')).toBe('~/src/repo')
    expect(shortFolder('/home/me/src/github.com/acme/atlas/')).toBe('~/…/acme/atlas')
    expect(shortFolder('/srv/a/b/c')).toBe('/…/b/c')
    expect(shortFolder('')).toBe('')
  })
})
