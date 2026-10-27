import { test, expect } from 'bun:test'
import { parseTicketView, renderTicketPeek, ticketPrompt } from './ticketPeek'

test('the peek escapes everything the tracker sends and keeps only safe marks', () => {
  const html = renderTicketPeek('PHNX-1', '## Outcome\n* **one** `two` [doc](https://example.com/a?b=1&c=2) [x](https://x.io/`y`)\n<script>alert(1)</script>\n[x](javascript:alert(1))')
  expect(html).not.toMatch(/<script|data-url="javascript/)
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('<h4>Outcome</h4><ul><li><b>one</b> <code>two</code> <a href="#" data-url="https://example.com/a?b=1&amp;c=2">doc</a>')
  expect(html).not.toContain('data-url="https://x.io/<code>')
  expect(html).toContain('<div class="tpeek" data-peek="PHNX-1" hidden>')
})

test('a long description shows its opening lines, cut at a line', () => {
  const para = 'word '.repeat(30).trim()
  const html = renderTicketPeek('A-1', Array.from({ length: 10 }, (_, i) => `${para} ${i}`).join('\n'))
  expect(html).toContain(`${para} 0`)
  expect(html).not.toContain(`${para} 9`)
  expect(renderTicketPeek('A-1', '')).toContain('No description.')
})

test('the peek has no Start of its own; a session already on it is one click to its tab', () => {
  const idle = renderTicketPeek('A-1', 'x')
  expect(idle).not.toContain('data-start-ticket')
  expect(idle).not.toContain('class="hint"')
  const busy = renderTicketPeek('A-1', 'x', [{ sessionId: 's1', host: 'yosemite-m6', title: 'Merge <3867>', state: 'Your move · asks', where: 'yosemite-m6' }])
  expect(busy).toContain('<button class="ons" data-open-session="s1" data-host="yosemite-m6"><b>Merge &lt;3867&gt;</b><small>Your move · asks · yosemite-m6</small></button>')
  expect(busy).not.toContain('data-start-ticket')
})

test('a ticket view read gives the page and face a tile needs', () => {
  const t = parseTicketView(JSON.stringify({ identifier: 'PHNX-1', title: 'T', url: 'https://linear.app/x/PHNX-1', state: { name: 'Done' }, comments: { nodes: [] } }))
  expect(t).toEqual({ identifier: 'PHNX-1', title: 'T', url: 'https://linear.app/x/PHNX-1', state: 'Done' })
  expect(() => parseTicketView('{}')).toThrow('Unexpected linear issue shape')
  expect(ticketPrompt(t)).toBe('Work on PHNX-1: T (https://linear.app/x/PHNX-1)')
})
