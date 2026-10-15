import { test, expect } from 'bun:test'
import { commentArgv, commentRun, parseTicketDetail, renderTicketDetail, ticketProfile, ticketRead } from './ticketDetail'
import type { ProjectRef } from './projectPanel'

// Shape of `linear tasks PHNX-4289 --json` (linear-cli, 2026-10-11), trimmed.
const RAW = JSON.stringify({
  identifier: 'PHNX-1', title: 'Panel <b>bold</b>', url: 'https://linear.app/x/PHNX-1',
  state: { name: 'Doing' }, assignee: { name: 'Muqsit' }, projectMilestone: { name: 'Q4 2026' },
  description: '## Outcome\n* **one** `two` [doc](https://example.com/a?b=1&c=2) [x](https://x.io/`y`)\n<script>alert(1)</script>\n[x](javascript:alert(1))',
  comments: { nodes: [1, 2, 3, 4].map((n) => ({ body: n === 4 ? '<img src=x onerror=alert(1)>' : `c${n}`, createdAt: `2026-10-0${n}T00:00:00Z`, user: { name: 'Claude' } })) },
})

test('ticket detail escapes everything the tracker sends and keeps only safe marks', () => {
  const html = renderTicketDetail(parseTicketDetail(RAW), { agentName: 'Claude', delegated: false })
  expect(html).not.toMatch(/<script|<img|<b>bold|data-url="javascript/)
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('<h4>Outcome</h4><ul><li><b>one</b> <code>two</code> <a href="#" data-url="https://example.com/a?b=1&amp;c=2">doc</a>')
  expect(html).toContain('data-url="https://linear.app/x/PHNX-1">Open in Linear ↗</a>')
  expect(html).not.toContain('data-url="https://x.io/<code>')
  // The last three comments, oldest of them first.
  expect(html).toContain('1 older in Linear')
  expect(html.indexOf('c2')).toBeLessThan(html.indexOf('&lt;img'))
  expect(html).not.toContain("<p>c1</p>")
})

test('a comment is one argv; text that starts with a dash stays the comment', () => {
  expect(commentArgv('PHNX-1', '--done please')).toEqual(['update', 'PHNX-1', '--comment=--done please'])
})

test('a delegated ticket names its agent; sessions already on it come first with Open, starting another is quiet', () => {
  const t = parseTicketDetail(JSON.stringify({ ...JSON.parse(RAW), delegate: { name: 'Claude' } }))
  expect(t.delegate).toBe('Claude')
  const idle = renderTicketDetail(t, { agentName: 'Claude', delegated: true })
  expect(idle).toContain('Delegated to <b>Claude</b> · assigned to Muqsit')
  expect(idle).toContain('<button class="primary" data-start>▶ Start Claude in a new tab</button>')
  expect(idle).toContain('Claude is the agent Linear delegates it to')
  const busy = renderTicketDetail(t, { agentName: 'Claude', delegated: true }, [{ sessionId: 's1', host: 'yosemite-m6', title: 'Merge <3867>', state: 'Your move · asks', where: 'yosemite-m6' }])
  expect(busy).toContain('On it now')
  expect(busy).toContain('data-open-session="s1" data-host="yosemite-m6">Open</button>')
  expect(busy).toContain('Merge &lt;3867&gt;')
  expect(busy).toContain('<button class="link" data-start>Start Claude in a new tab</button>')
  expect(busy).not.toContain('▶ Start')
})

// The shown project is talora-health (personal workspace); agi reads the default workspace.
const TALORA: ProjectRef = { name: 'talora-health', linearName: 'Talora', linearProfile: 'personal' }
const AGI: ProjectRef = { name: 'agi', linearName: 'AGI', linearProfile: null }
const REGISTRY = [TALORA, AGI]
const BASE = { PATH: '/usr/bin' }

test('a ticket opened from another surface reads in the profile of the project it names, not the shown one', () => {
  const profile = ticketProfile({ project: 'agi' }, TALORA, REGISTRY)
  expect(profile).toBeNull()
  expect(ticketRead({ id: 'PHNX-1', profile }, BASE)).toEqual({ argv: ['tasks', 'PHNX-1', '--json'], env: BASE })
  expect(ticketProfile({ project: 'talora-health' }, AGI, REGISTRY)).toBe('personal')
})

test('a ticket from a session in no project reads in the default profile, whatever is shown', () => {
  expect(ticketProfile({ project: null }, TALORA, [])).toBeNull()
})

test('a named project the registry does not list is an error, never the default profile', () => {
  expect(() => ticketProfile({ project: 'gone' }, TALORA, REGISTRY)).toThrow('No project named gone')
})

test('a ticket opened from the panel reads in the shown project\'s profile; no shown project is the default', () => {
  const profile = ticketProfile('panel', TALORA, [])
  expect(ticketRead({ id: 'TAL-3', profile }, BASE).env).toEqual({ PATH: '/usr/bin', LINEAR_PROFILE: 'personal' })
  expect(ticketProfile('panel', null, [])).toBeNull()
})

test('Comment posts in the profile the open ticket was read in, and only on that ticket', () => {
  // Opened from a default-workspace session while talora (personal) is shown.
  const opened = { id: 'PHNX-1', profile: ticketProfile({ project: 'agi' }, TALORA, REGISTRY) }
  expect(commentRun(opened, 'PHNX-1', 'done', BASE)).toEqual({ argv: ['update', 'PHNX-1', '--comment=done'], env: BASE })
  expect(commentRun({ id: 'TAL-3', profile: 'personal' }, 'TAL-3', 'ok', BASE).env).toEqual({ PATH: '/usr/bin', LINEAR_PROFILE: 'personal' })
  expect(() => commentRun(opened, 'PHNX-2', 'x', BASE)).toThrow('PHNX-2 is not the ticket open in the panel.')
  expect(() => commentRun(undefined, 'PHNX-1', 'x', BASE)).toThrow()
})
