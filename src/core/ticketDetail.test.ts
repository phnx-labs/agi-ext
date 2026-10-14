import { test, expect } from 'bun:test'
import { commentArgv, parseTicketDetail, renderTicketDetail } from './ticketDetail'

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

test('the card keeps description and comments folded: the full ticket opens as its Linear page', () => {
  const html = renderTicketDetail(parseTicketDetail(RAW), { agentName: 'Claude', delegated: false })
  expect(html).toContain('<details><summary>Description</summary>')
  expect(html).toContain('<details><summary>Comments <span class="n">4</span>')
  expect(html).not.toContain('<details open>')
})
