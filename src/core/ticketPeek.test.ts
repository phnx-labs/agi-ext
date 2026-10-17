import { test, expect } from 'bun:test'
import { parseTicketView, renderTicketPeek, ticketPrompt } from './ticketPeek'

const START = { agentName: 'Claude', delegated: false }

test('the peek escapes everything the tracker sends and keeps only safe marks', () => {
  const html = renderTicketPeek('PHNX-1', '## Outcome\n* **one** `two` [doc](https://example.com/a?b=1&c=2) [x](https://x.io/`y`)\n<script>alert(1)</script>\n[x](javascript:alert(1))', START)
  expect(html).not.toMatch(/<script|data-url="javascript/)
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('<h4>Outcome</h4><ul><li><b>one</b> <code>two</code> <a href="#" data-url="https://example.com/a?b=1&amp;c=2">doc</a>')
  expect(html).not.toContain('data-url="https://x.io/<code>')
  expect(html).toContain('<div class="tpeek" data-peek="PHNX-1" hidden>')
})

test('a long description shows its opening lines, cut at a line, and points at the tab', () => {
  const para = 'word '.repeat(30).trim()
  const html = renderTicketPeek('A-1', Array.from({ length: 10 }, (_, i) => `${para} ${i}`).join('\n'), START)
  expect(html).toContain(`${para} 0`)
  expect(html).not.toContain(`${para} 9`)
  expect(html).toContain('More in its tab.')
  expect(renderTicketPeek('A-1', '', START)).toContain('No description.')
})

test('Start names the delegated agent; sessions already on it come first and starting another is quiet', () => {
  const idle = renderTicketPeek('A-1', 'x', { agentName: 'Codex', delegated: true })
  expect(idle).toContain('<button class="primary" data-start-ticket="A-1">▶ Start Codex</button>')
  expect(idle).toContain('Linear delegates it to this agent')
  const busy = renderTicketPeek('A-1', 'x', START, [{ sessionId: 's1', host: 'yosemite-m6', title: 'Merge <3867>', state: 'Your move · asks', where: 'yosemite-m6' }])
  expect(busy).toContain('On it now')
  expect(busy).toContain('data-open-session="s1" data-host="yosemite-m6">Open</button>')
  expect(busy).toContain('Merge &lt;3867&gt;')
  expect(busy).toContain('<button class="link" data-start-ticket="A-1">Start Claude in a new tab</button>')
  expect(busy).not.toContain('▶ Start')
})

test('a ticket view read gives the page and face a tile needs', () => {
  const t = parseTicketView(JSON.stringify({ identifier: 'PHNX-1', title: 'T', url: 'https://linear.app/x/PHNX-1', state: { name: 'Done' }, comments: { nodes: [] } }))
  expect(t).toEqual({ identifier: 'PHNX-1', title: 'T', url: 'https://linear.app/x/PHNX-1', state: 'Done' })
  expect(() => parseTicketView('{}')).toThrow('Unexpected linear issue shape')
  expect(ticketPrompt(t)).toBe('Work on PHNX-1: T (https://linear.app/x/PHNX-1)')
})
