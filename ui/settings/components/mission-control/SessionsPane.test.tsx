import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()

import { describe, expect, test } from 'bun:test'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FloorAgent } from './floorModel'

const { SessionRow, SessionsPane, SESSION_ROW_CSS, SESSION_ROW_CSS3, ROW_H } = await import('./SessionsPane')
const { ResumeDeviceMenu } = await import('./sessions/ResumeDeviceMenu')

const noop = () => {}

function agent(over: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'r1',
    host: 'yosemite-s1',
    hostLabel: 'yosemite-s1',
    project: 'svatlas',
    name: 'session',
    abbr: 'CC',
    phase: 'running',
    verb: '',
    target: '',
    tok: 0,
    since: '2d',
    lastActivityMs: Date.parse('2026-08-23T12:00:00Z'),
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: '#418',
    prUrl: 'https://github.com/x/y/pull/418',
    ci: 'running',
    ticket: null,
    branch: '',
    worktreeSlug: '',
    worktreePath: '',
    resp: 'Widened the hero to a 2-col grid and pushed the CTA down. Screenshot attached — does the spacing read better now?',
    prompt: '/Users/muqsit/Screenshots/CleanShot 2026-08-23 at 12.03.45.png The landscape mode looks cramped — can we give the hero more room?',
    topic: 'Redesigning the SVAtlas landscape hero section',
    messages: [],
    question: null,
    reply: { kind: 'none', host: 'yosemite-s1' },
    todos: [],
    summary: '',
    recent: [],
    liveStatus: 'running',
    ...over,
  }
}

/** A resumable PREVIOUS (index) row folded in from the durable transcript index. */
function prevAgent(over: Partial<FloorAgent> = {}): FloorAgent {
  return agent({
    context: 'recent',
    sessionState: 'inactive',
    resumable: true,
    sourceDevice: 'yosemite-s0',
    recovery: { command: 'agents', args: ['sessions', 'resume', over.id ?? 'r1', '--device', 'yosemite-s0'] },
    liveStatus: 'idle',
    ...over,
  })
}

const rowProps = {
  nowMs: Date.parse('2026-08-25T12:00:00Z'),
  selected: false,
  active: false,
  expanded: false,
  height: 122,
  onToggleSelect: noop,
  onToggleStar: noop,
  onResume: noop,
  onSelect: noop,
  onToggleExpand: noop,
}

describe('SessionRow — compact card', () => {
  test('renders title, prompt, metadata links, and Resume without duplicating the device', () => {
    const html = renderToStaticMarkup(<SessionRow agent={agent()} {...rowProps} />)
    expect(html).toContain('Redesigning the SVAtlas landscape hero section')
    expect(html).toContain('You ›')
    expect(html).toContain('Claude ›')
    expect(html).toContain('screenshot')
    // path noise is scrubbed out of the prompt line
    expect(html).not.toContain('/Users/muqsit')
    expect(html).not.toContain('CleanShot')
    expect(html).toContain('PR #418')
    expect(html).toContain('▪ svatlas')
    expect(html).not.toContain('sx-chip device')
    expect(html).not.toContain('yosemite-s1')
    // a live session is always resumable
    expect(html).toContain('class="sx-resumelabel">Resume</span>')
    expect(html).not.toContain('sx-viewbtn')
  })

  test('skill prompt renders the /continue chip without the skill path', () => {
    const html = renderToStaticMarkup(
      <SessionRow
        agent={agent({
          prompt: 'Base directory for this skill: /home/muqsit/.agents/skills/continue\npick up the agents view cache work',
          topic: 'Continuing the usage-cache fix from a prior session',
          branch: 'fix-usage-cache',
          project: 'agents-cli',
        })}
        {...rowProps}
      />,
    )
    expect(html).toContain('/continue')
    expect(html).toContain('pick up the agents view cache work')
    expect(html).not.toContain('Base directory')
    expect(html).not.toContain('/home/muqsit')
    expect(html).toContain('fix-usage-cache')
  })

  test('command prompt renders the $ chip', () => {
    const html = renderToStaticMarkup(
      <SessionRow
        agent={agent({
          prompt: '<bash-input>crabbox status</bash-input>\nHelping understand the currency I set up for the agency — does it use Crabbox?',
          topic: 'Explaining the Crabbox CI currency model',
          pr: null,
          project: 'agents-cli',
        })}
        {...rowProps}
      />,
    )
    expect(html).toContain('$ crabbox status')
    expect(html).toContain('Helping understand the currency')
    expect(html).toContain('no PR')
    expect(html).not.toContain('<bash-input>')
  })

  test('clicking a row expands into the full detail card (the ask / activity / catch up)', () => {
    const html = renderToStaticMarkup(<SessionRow agent={agent()} {...rowProps} expanded />)
    expect(html).toContain('sx-detail')
    expect(html).toContain('The ask')
    expect(html).toContain('Activity')
    expect(html).toContain('Catch up')
    expect(html).toContain('The landscape mode looks cramped')
    expect(html).not.toContain('Resume here')
  })

  test('per-row Resume posts the same onResume the group control uses', () => {
    const seen: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(<SessionRow agent={agent({ id: 'resume-me' })} {...rowProps} onResume={(a) => { seen.push(a.id) }} />)
    })
    const btn = host.querySelector('.sx-resumebtn') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.querySelector('.sx-resumelabel')?.textContent).toBe('Resume')
    act(() => { btn.click() })
    expect(seen).toEqual(['resume-me'])
    act(() => root.unmount())
    host.remove()
  })

  test('a Previous row with recovery argv always routes its one-click Resume', () => {
    const seen: FloorAgent[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const previous = prevAgent({ id: 'previous-with-recovery', sessionId: undefined })
    act(() => {
      root.render(<SessionRow agent={previous} {...rowProps} onResume={(a) => { seen.push(a) }} />)
    })
    const resume = host.querySelector('.sx-resumebtn') as HTMLButtonElement
    expect(resume).toBeTruthy()
    act(() => { resume.click() })
    expect(seen).toEqual([previous])
    act(() => root.unmount())
    host.remove()
  })

  test('right-clicking Resume offers online alternate devices and keeps the current device out', () => {
    const previous = prevAgent({ id: 'resume-elsewhere', sourceDevice: 'yosemite-s0' })
    const contextSeen: string[] = []
    const seen: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        <SessionRow
          agent={previous}
          {...rowProps}
          onResumeContext={(a) => { contextSeen.push(a.id) }}
        />,
      )
    })
    const resume = host.querySelector('.sx-resumebtn') as HTMLButtonElement
    act(() => {
      resume.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    })
    expect(contextSeen).toEqual(['resume-elsewhere'])

    act(() => {
      root.render(
        <ResumeDeviceMenu
          state={{ agent: previous, x: 20, y: 20 }}
          devices={[
            { name: 'yosemite-s0', online: true },
            { name: 'yosemite-m3', online: true },
            { name: 'offline-box', online: false },
          ]}
          onChoose={(a, device) => { seen.push(`${a.id}:${device}`) }}
          onClose={noop}
        />,
      )
    })
    const menu = document.body.querySelector('.sx-resume-menu') as HTMLDivElement
    expect(menu).toBeTruthy()
    expect(menu.textContent).toContain('Resume on a different device…')
    expect(menu.textContent).not.toContain('yosemite-s0')
    expect(menu.textContent).toContain('yosemite-m3')
    expect((menu.querySelector('button[title="offline-box is offline"]') as HTMLButtonElement).disabled).toBe(true)
    act(() => { (menu.querySelector('button[title="Resume on yosemite-m3"]') as HTMLButtonElement).click() })
    expect(seen).toEqual(['resume-elsewhere:yosemite-m3'])
    act(() => root.unmount())
    host.remove()
  })

  test('clicking a session row selects it for the right detail panel', () => {
    const seen: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(<SessionRow agent={agent({ id: 'select-me' })} {...rowProps} onSelect={(a) => { seen.push(a.id) }} />)
    })
    act(() => { (host.querySelector('.sx-row') as HTMLDivElement).click() })
    expect(seen).toEqual(['select-me'])
    act(() => root.unmount())
    host.remove()
  })

  test('a non-resumable harness shows no dead action button', () => {
    const html = renderToStaticMarkup(
      <SessionRow
        agent={prevAgent({ id: 'grok1', abbr: 'GK', resumable: false, recovery: null })}
        {...rowProps}
        onResume={() => { throw new Error('must not resume a non-resumable harness') }}
      />,
    )
    expect(html).not.toContain('sx-resumebtn')
    expect(html).not.toContain('sx-viewbtn')
    expect(html).not.toContain('>View<')
  })

  test('Previous rows omit the redundant phase pill; live rows keep it', () => {
    const previous = renderToStaticMarkup(<SessionRow agent={prevAgent({ id: 'previous-row', phase: 'idle' })} {...rowProps} />)
    // The Previous band header already names the lifecycle, so a resumable-index
    // row renders no phase pill even when it carries a phase.
    expect(previous).not.toContain('sx-phase')

    const live = renderToStaticMarkup(<SessionRow agent={agent({ id: 'live-row', phase: 'idle' })} {...rowProps} />)
    expect(live).toContain('class="sx-phase idle"')
  })

  test('renders the harness identity as an avatar only', () => {
    const html = renderToStaticMarkup(<SessionRow agent={agent({ abbr: 'CX' })} {...rowProps} />)
    expect(html).toContain('class="sw-avatar sz-24"')
    expect(html).toContain('title="Codex ›"')
    expect(html).not.toContain('class="sx-agent"')
  })
})

describe('SessionsPane', () => {
  test('filter chips are exactly All | Active | Idle | Blocked | Favorites', () => {
    const html = renderToStaticMarkup(
      <SessionsPane agents={[agent({ id: 'a' })]} onToggleStar={noop} onResume={noop} onResumeMany={noop} onSelect={noop} />,
    )
    expect(html).toContain('>All<')
    expect(html).toContain('>Active<')
    expect(html).toContain('>Idle<')
    expect(html).toContain('>Blocked<')
    expect(html).toContain('>Favorites<')
    expect(html).not.toContain('>Orphaned<')
    expect(html).not.toContain('>Starred<')
    expect(html).not.toContain('All projects')
    expect(html).not.toContain('All hosts')
    expect(html).not.toContain('Filter by project')
    expect(html).not.toContain('Filter by machine')
    expect(html).toContain('<option value="project" selected="">Project</option>')
    expect(html).toContain('<option value="device">Device</option>')
    expect(html).toContain('<option value="status">Status</option>')
    expect(html).toContain('<option value="none">None</option>')
  })

  test('meta chips live under sx-metarow', () => {
    const html = renderToStaticMarkup(
      <SessionsPane agents={[agent({ id: 'a' })]} onToggleStar={noop} onResume={noop} onResumeMany={noop} onSelect={noop} />,
    )
    expect(html).toContain('class="sx-chip on')
    expect(html).toContain('sx-metarow')
    expect(html).toContain('sx-chip repo')
  })

  test('virtual row CSS keeps the declared height and clips long content to the viewport', () => {
    expect(ROW_H).toBe(146)
    expect(SESSION_ROW_CSS).toContain('.sw-sessions .sx-row {')
    expect(SESSION_ROW_CSS).toContain('box-sizing: border-box; width: 100%;')
    expect(SESSION_ROW_CSS).toContain('.sw-sessions .sx-rolebody { min-width: 0; flex: 1;')
    expect(SESSION_ROW_CSS).toContain('.sw-sessions .sx-band {')
    expect(SESSION_ROW_CSS).toContain('@media (max-width: 720px)')
    expect(SESSION_ROW_CSS3).toContain('.sx-titleline { min-width: 0;')
    expect(SESSION_ROW_CSS3).toContain('flex: 0 0 132px; width: 132px;')
    expect(SESSION_ROW_CSS3).toContain('flex-basis: 76px; width: 76px;')
  })

  test('Previous rows participate in the default Project group and remain resumable', () => {
    const now = Date.now()
    const html = renderToStaticMarkup(
      <SessionsPane
        agents={[
          prevAgent({ id: 'p1', lastActivityMs: now - 1000 }),
          prevAgent({ id: 'p2', topic: 'other', lastActivityMs: now - 2000 }),
        ]}
        onToggleStar={noop}
        onResume={noop}
        onResumeMany={noop}
        onSelect={noop}
      />,
    )
    expect(html).toContain('<span class="lab">svatlas</span>')
    expect(html).toContain('<span class="cnt">2</span>')
    expect(html).toContain('Resume all 2')
  })

  test('Previous defaults to 50 visible resumable rows (paging is model-tested)', () => {
    const now = Date.now()
    const html = renderToStaticMarkup(
      <SessionsPane
        agents={Array.from({ length: 60 }, (_, i) => prevAgent({ id: `p-${i}`, lastActivityMs: now - i * 1000 }))}
        onToggleStar={noop}
        onResume={noop}
        onResumeMany={noop}
        onSelect={noop}
      />,
    )
    expect(html).toContain('Resume all 50')
    expect(html).not.toContain('Resume all 60')
  })
  test('a metadata pill without a URL copies its value and does NOT toggle the row expand', () => {
    const copied: string[] = []
    const orig = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => { copied.push(t); return Promise.resolve() } },
    })
    let expandToggles = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(<SessionRow agent={agent({ id: 'copy-me', ticket: 'not-a-ticket' })} {...rowProps} onToggleExpand={() => { expandToggles += 1 }} />)
    })
    const ticket = Array.from(host.querySelectorAll('.sx-metarow .sx-chip')).find((el) => el.textContent?.includes('not-a-ticket')) as HTMLElement
    expect(ticket).toBeTruthy()
    expect(ticket.getAttribute('role')).toBe('button')
    act(() => { ticket.click() })
    expect(copied).toEqual(['not-a-ticket'])
    expect(expandToggles).toBe(0)            // and did NOT expand the row
    act(() => root.unmount())
    host.remove()
    if (orig) Object.defineProperty(globalThis.navigator, 'clipboard', orig)
  })

  test('an ENDED (Previous) row shows the meta line, not the empty activity bar', () => {
    const html = renderToStaticMarkup(<SessionRow agent={prevAgent({ id: 'ended1' })} {...rowProps} expanded />)
    expect(html).toContain('Ended session')
    expect(html).toContain('sx-endedmeta')
    expect(html).toContain('Ran &lt;1m · ended 2d ago · Runs on <b>yosemite-s0</b>')
    expect(html).toContain('title="Aug 23, 12:00 PM"')
    expect(html).not.toContain('sx-actbar')
  })

  test('a LIVE row keeps the activity bar and never shows the ended meta line', () => {
    const html = renderToStaticMarkup(<SessionRow agent={agent()} {...rowProps} expanded />)
    expect(html).toContain('sx-actbar')
    expect(html).toContain('Activity')
    expect(html).not.toContain('sx-endedmeta')
  })

  test('the summary line is suppressed when it just repeats the ask (no triple-duplicate)', () => {
    const same = 'Consolidate the dispatch maps into one catalog'
    const dupHtml = renderToStaticMarkup(<SessionRow agent={agent({ prompt: same, topic: same, resp: '' })} {...rowProps} expanded />)
    expect(dupHtml).not.toContain('sx-goal')
    const diffHtml = renderToStaticMarkup(<SessionRow agent={agent({ prompt: 'fix the thing', topic: 'A different recap summary', resp: '' })} {...rowProps} expanded />)
    expect(diffHtml).toContain('sx-goal')
    expect(diffHtml).toContain('A different recap summary')
  })
})
