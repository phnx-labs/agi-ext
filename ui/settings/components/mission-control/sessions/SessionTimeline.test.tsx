import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()

import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionPresentationStore } from '../../../../../src/core/sessionPresentationStore'
import { adaptRemote, type RemoteSessionLike } from '../floorAdapter'
import { sessionRowView, shortFolder } from '../recapModel'
import { rowHeight } from '../SessionsPane'
import { SessionRow } from './SessionRow'
import { timelineEntries, earlierLabel } from './SessionTimeline'

const RESET = await Bun.file(new URL('../testdata/fleet-reset.json', import.meta.url)).json()
const NOW = RESET.capturedAt as number
const noop = () => {}

/** The real path: stream reset -> presentation store -> RemoteSession -> FloorAgent. */
function floorRows() {
  const store = new SessionPresentationStore()
  store.apply(RESET)
  const presented = store.presentedSessions('zion', 'this-mac', [], NOW)
  // postMessage is a structured clone; JSON round-trip is the same boundary.
  const wire = JSON.parse(JSON.stringify(presented)) as RemoteSessionLike[]
  const rows = adaptRemote(wire, new Set(), 'zion')
  return Object.fromEntries(rows.map((r) => [r.sessionId, r]))
}

function render(agent: ReturnType<typeof floorRows>[string], expanded: boolean): string {
  return renderToStaticMarkup(
    <SessionRow
      agent={agent} nowMs={NOW} selected={false} active={false} expanded={expanded} height={rowHeight(agent, expanded)}
      onToggleSelect={noop} onToggleStar={noop} onResume={noop} onSelect={noop} onToggleExpand={noop}
    />,
  )
}

const LIVE = 'b64b7320-58de-412c-88ab-1cf46e3d4f20'
const PREV_TIMELINE = '01a1245e-7541-79b3-9255-928fb77d88d3'
const PREV_BARE = '3c734cd4-fe3a-4e80-bba7-d69fe5ebbf23'

describe('stream row -> Fleet session card', () => {
  test('the adapter carries machine, folder, timeline, latest request and user turns', () => {
    const live = floorRows()[LIVE]!
    expect(live.host).toBe('yosemite-m2')
    expect(live.cwd).toBe('/home/muqsit/src/github.com/acme/atlas')
    expect(live.timeline?.steps).toHaveLength(5)
    expect(live.userTurns).toHaveLength(3)
    expect(live.latestRequest).toBe('Please add my account id to the trusted owner ids when you get a chance.')
    expect(live.resp).toContain('own-account approvals')
  })

  test('collapsed live card shows machine + folder, your latest message, and the agent reply line', () => {
    const html = render(floorRows()[LIVE]!, false)
    expect(html).toContain('class="sx-where"')
    expect(html).toContain('<b>yosemite-m2</b> · ~/…/acme/atlas')
    expect(html).toContain('You ›')
    expect(html).toContain('Please add my account id to the trusted owner ids')
    expect(html).not.toContain('tell me why my own approvals are rejected')
    expect(html).toContain('Agent ›')
    expect(html).toContain('&quot;The merge guard now accepts your own-account approvals.&quot;')
    // The live activity is the same reply, so no now-line repeats it.
    expect(html).not.toContain('sx-now')
  })

  test('expanded live card shows the full reply and the timeline newest first, without a fake activity bar', () => {
    const html = render(floorRows()[LIVE]!, true)
    expect(html).toContain('Latest reply')
    expect(html).toContain('I ran it against the real reviews and it allows the merge.')
    expect(html).toContain('Timeline')
    const order = ['The merge guard now accepts', 'The lookup works', 'Read 1 file, ran 1 git command', 'Please add my account id to the trusted', 'Two of the things']
      .map((text) => html.indexOf(text, html.indexOf('sx-tl')))
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true)
    expect(html).toContain('sx-tl-role you')
    expect(html).toContain('sx-tl-role agent')
    expect(html).toContain('sx-tl-role tools')
    expect(html).toContain('4 tools · 1 failed')
    expect(html).toContain('141 earlier steps · 278 tools · 13 failed')
    expect(html).not.toContain('sx-actbar')
  })

  test('a previous row without preview takes its agent line from the newest narration step', () => {
    const prev = floorRows()[PREV_TIMELINE]!
    const row = sessionRowView(prev)
    expect(row.you.text).toBe('Continue..')
    expect(row.lastFull).toBe('Pulled 12 commits; the indexer and the export script changed.')
    const html = render(prev, true)
    expect(html).toContain('Agent ›')
    expect(html).toContain('Ended session')
    expect(html).toContain('Timeline')
  })

  test('a previous row with only its first message shows no agent line and no timeline', () => {
    const bare = floorRows()[PREV_BARE]!
    const html = render(bare, true)
    expect(html).toContain('Check the carousel post schedule.')
    expect(html).not.toContain('Agent ›')
    expect(html).not.toContain('Latest reply')
    expect(html).not.toContain('sx-tl')
  })

  test('collapsed height follows the lines rendered, so a sparse row leaves no blank block', () => {
    const rows = floorRows()
    expect(rowHeight(rows[PREV_BARE]!, false)).toBeLessThan(rowHeight(rows[PREV_TIMELINE]!, false))
    expect(rowHeight(rows[LIVE]!, true)).toBeGreaterThan(rowHeight(rows[LIVE]!, false) + 200)
  })
})

describe('timeline helpers', () => {
  test('entries map sources to roles and drop blank steps', () => {
    const entries = timelineEntries({
      steps: [
        { text: 'go', at: '2026-10-10T00:00:00Z', source: 'user', tools: 0, failed: 0, blocked: 0 },
        { text: ' ', at: '2026-10-10T00:00:01Z', source: 'narration', tools: 0, failed: 0, blocked: 0 },
        { text: 'thinking about it', at: '2026-10-10T00:00:02Z', source: 'thinking', tools: 0, failed: 0, blocked: 2, live: true },
      ],
      earlier: { steps: 1, tools: 0, failed: 0 },
      state: 'partial',
    })
    expect(entries.map((e) => [e.role, e.text, e.work, e.live])).toEqual([
      ['agent', 'thinking about it', '2 blocked', true],
      ['you', 'go', '', false],
    ])
    expect(earlierLabel({ steps: [], earlier: { steps: 1, tools: 0, failed: 0 }, state: 'ready' })).toBe('1 earlier step')
  })

  test('shortFolder keeps short paths and elides the middle of long ones', () => {
    expect(shortFolder('/Users/me')).toBe('~')
    expect(shortFolder('/Users/me/src/repo')).toBe('~/src/repo')
    expect(shortFolder('/home/me/src/github.com/acme/atlas/')).toBe('~/…/acme/atlas')
    expect(shortFolder('/srv/a/b/c')).toBe('/…/b/c')
    expect(shortFolder('')).toBe('')
  })
})
