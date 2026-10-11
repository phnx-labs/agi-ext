import { test, expect } from 'bun:test'
import { commentArgv, parseTicketDetail, renderTicketDetail } from './ticketDetail'

// Shape of `linear tasks PHNX-4289 --json` (linear-cli, 2026-10-11), trimmed.
const RAW = JSON.stringify({
  identifier: 'PHNX-1', title: 'Panel <b>bold</b>', url: 'https://linear.app/x/PHNX-1',
  state: { name: 'Doing' }, assignee: { name: 'Muqsit' }, projectMilestone: { name: 'Q4 2026' },
  description: '## Outcome\n* **one** `two` [doc](https://example.com/a?b=1&c=2)\n<script>alert(1)</script>\n[x](javascript:alert(1))',
  comments: { nodes: [1, 2, 3, 4].map((n) => ({ body: n === 4 ? '<img src=x onerror=alert(1)>' : `c${n}`, createdAt: `2026-10-0${n}T00:00:00Z`, user: { name: 'Claude' } })) },
})

test('ticket detail escapes everything the tracker sends and keeps only safe marks', () => {
  const html = renderTicketDetail(parseTicketDetail(RAW), 'Claude')
  expect(html).not.toMatch(/<script|<img|<b>bold|data-url="javascript/)
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('<h4>Outcome</h4><ul><li><b>one</b> <code>two</code> <a href="#" data-url="https://example.com/a?b=1&amp;c=2">doc</a></li></ul>')
  expect(html).toContain('data-url="https://linear.app/x/PHNX-1">Open in Linear ↗</a>')
  // The last three comments, oldest of them first.
  expect(html).toContain('1 older in Linear')
  expect(html.indexOf('c2')).toBeLessThan(html.indexOf('&lt;img'))
  expect(html).not.toContain("<p>c1</p>")
})

test('a comment is one argv; text that starts with a dash stays the comment', () => {
  expect(commentArgv('PHNX-1', '--done please')).toEqual(['update', 'PHNX-1', '--comment=--done please'])
})
