import { test, expect } from 'bun:test'
import {
  parseOverview, parsePrs, parseProjectDetection, parseProjectList, parseTickets,
  activityLine, projectSessions, renderOverview, renderPrs, renderSessionCard, renderSessions, renderTickets, sessionCount,
  type SessionLike,
} from './projectPanel'

// Shapes captured from agents-cli 1.22.123 / linear-cli on 2026-10-08.

test('detection: a matched workspace yields name + Linear name; no match is null', () => {
  expect(parseProjectDetection('{"name":"agi","linear":{"name":"AGI","projectId":"x"},"root":"~/src/a"}'))
    .toEqual({ name: 'agi', linearName: 'AGI' })
  expect(parseProjectDetection('{"name":null,"linear":null,"root":null}')).toBeNull()
})

test('project list keeps projects without a Linear binding', () => {
  expect(parseProjectList('[{"name":"agi","linear":{"name":"AGI"}},{"name":"wispr"}]'))
    .toEqual([{ name: 'agi', linearName: 'AGI' }, { name: 'wispr', linearName: null }])
})

const STATUS = JSON.stringify([{
  name: 'agi', description: 'Agents CLI',
  linear: { name: 'AGI', done: 90, total: 100, inProgress: 4,
    nextMilestone: { name: 'Ship B' },
    milestones: [
      { name: 'Ship A', done: 3, total: 3, targetDate: '2026-08-01' },
      { name: 'Ship C', done: 1, total: 4, targetDate: '2026-12-01' },
      { name: 'Ship B', done: 2, total: 5, targetDate: '2026-09-01' },
    ] },
  schedule: { kind: 'overdue', milestone: 'Ship B', days: 37 },
  byStatus: { running: 1, idle: 9 },
  openPrs: [{ number: 1 }, { number: 2 }],
  latestRelease: { tag: 'v1.2.3', publishedAt: '2026-10-08T22:32:31Z' },
}])

test('overview: the current milestone shows; with none current it says so and counts unplanned work', () => {
  const groups = parseTickets(JSON.stringify({ issues: [
    { identifier: 'A-1', title: 'a', url: 'u', priority: 2, state: { type: 'started', name: 'Doing' } },
    { identifier: 'A-2', title: 'b', url: 'u', priority: 3, state: { type: 'unstarted', name: 'Todo' }, projectMilestone: { name: 'Ship C' } },
  ] }))
  const withCurrent = renderOverview(parseOverview(STATUS), '2026-10-08', groups)
  expect(withCurrent).toContain('Ship C')
  expect(withCurrent).toContain('1/4')
  expect(withCurrent).toContain('90%')
  expect(withCurrent).toMatch(/aria-label="1 Doing, 1 Todo"/)
  const none = renderOverview(parseOverview(STATUS), '2026-12-31', groups)
  expect(none).toContain('No current milestone.')
  expect(none).toContain('2 past due.')
  expect(none).toContain('1 open tickets unplanned.')
})

test('overview refuses a status that is not one project card', () => {
  expect(() => parseOverview('[]')).toThrow('Expected one project card, got 0')
  expect(() => parseOverview('{}')).toThrow('Unexpected project status shape')
})

const issue = (id: string, type: string, name: string, priority: number, extra: object = {}) =>
  ({ identifier: id, title: `t ${id}`, url: `https://linear.app/x/${id}`, priority, state: { type, name }, ...extra })

test('tickets: Doing before Todo before Backlog, urgent first, no-priority last', () => {
  const groups = parseTickets(JSON.stringify({ issues: [
    issue('A-1', 'backlog', 'Backlog', 3),
    issue('A-2', 'unstarted', 'Todo', 0),
    issue('A-3', 'started', 'Doing', 2, { delegate: { name: 'Claude' }, projectMilestone: { name: 'Ship B' } }),
    issue('A-4', 'unstarted', 'Todo', 1),
  ] }))
  expect(groups.map((g) => g.state)).toEqual(['Doing', 'Todo', 'Backlog'])
  expect(groups[1].tickets.map((t) => t.identifier)).toEqual(['A-4', 'A-2'])
  expect(groups[0].tickets[0]).toMatchObject({ owner: 'Claude', milestone: 'Ship B' })
  expect(renderTickets(groups)).toContain('data-url="https://linear.app/x/A-3"')
})

test('tickets render escapes titles from the tracker', () => {
  const html = renderTickets(parseTickets(JSON.stringify({ issues: [{ ...issue('A-9', 'started', 'Doing', 2), title: '<img src=x onerror=alert(1)>' }] })))
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;img')
})

test('prs: repos with open PRs first, a failed repo shows its error, partial is announced, state is a ring', () => {
  const now = Date.parse('2026-10-09T00:00:00Z')
  const model = parsePrs(JSON.stringify({ partial: true, repositories: [
    { slug: 'o/quiet', pullRequests: [], recentlyMerged: [] },
    { slug: 'o/broken', error: 'HTTP 502', pullRequests: [], recentlyMerged: [] },
    { slug: 'o/busy', defaultBranch: { name: 'main', ciState: 'FAILURE' },
      pullRequests: [{ number: 7, title: 'feat: x', url: 'https://github.com/o/busy/pull/7', isDraft: true, ciState: 'SUCCESS', author: { login: 'm' }, createdAt: '2026-10-08T00:00:00Z' }],
      recentlyMerged: Array.from({ length: 8 }, (_, i) => ({ number: i, title: `m${i}`, url: `https://github.com/o/busy/pull/${i}`, ciState: 'SUCCESS', author: { login: 'm' }, mergedAt: '2026-10-07T00:00:00Z' })) },
  ] }))
  expect(model.repos[0].slug).toBe('o/busy')
  expect(model.repos[0].merged).toHaveLength(5)
  const html = renderPrs(model, now)
  expect(html).toContain('this list is incomplete')
  expect(html).toContain('Could not read: HTTP 502')
  expect(html).toContain('aria-label="Draft"')
  expect(html).toContain('#7 · 24h · m')
  expect(html).not.toContain('o/quiet')
  expect(html).toContain('<details open><summary>merged <span class="n">5</span>')
})

const row = (o: Partial<SessionLike>): SessionLike => ({
  sessionId: 's', host: 'yosemite-m6', title: 'T', label: '', topic: '', phase: 'running', liveStatus: 'running',
  lastResponse: '', activity: '', ticket: null, lastActivityMs: 0, confirmedProject: 'agi', ...o,
})
const NOW = Date.parse('2026-10-09T00:00:00Z')

test('projectSessions keeps only the CLI-confirmed project, newest first', () => {
  const ordered = projectSessions([
    row({ sessionId: 'old', lastActivityMs: 1 }),
    row({ sessionId: 'other', confirmedProject: 'rush', lastActivityMs: 9 }),
    row({ sessionId: 'new', lastActivityMs: 5 }),
  ], 'AGI')
  expect(ordered.map((r) => r.sessionId)).toEqual(['new', 'old'])
})

test('a card says what is going on: your ask, the agent in its own words, chips; the device only in the tooltip', () => {
  const html = renderSessionCard(row({
    title: 'Health', phase: 'idle', liveStatus: 'idle', request: { headline: 'Dude, no, no, dude.' },
    timeline: { steps: [{ text: 'older' }, { text: 'Your trusted publisher is set up correctly.' }] }, lastResponse: 'stale reply',
    ticket: 'PHNX-4227', worktreeSlug: 'cli-health-1009', files: { total: 16 }, lastActivityMs: NOW - 22 * 60000,
    prStatus: { number: 3855, checks: 'passing', isDraft: false }, viewingIn: 'Codium tab 3',
  }), NOW, true)
  expect(html).toContain('class="ttl">Health<')
  expect(html).toContain('Dude, no, no, dude.')
  expect(html).toContain('Your trusted publisher is set up correctly.')
  expect(html).not.toContain('stale reply')
  expect(html).toContain('PR #3855: ready to merge')
  expect(html).toContain('cli-health-1009')
  expect(html).toContain('16 files changed')
  expect(html).toContain('>22m<')
  expect(html).toContain('aria-label="Your turn"')
  expect(html).toContain('class="go">Focus<')
  expect(html).toContain('title="Your turn · yosemite-m6 · Codium tab 3"')
  expect(html).not.toMatch(/>m6</)
  expect(html).toContain('card st-yours sel')
  expect(renderSessionCard(row({ lastResponse: 'I filed [PHNX-4324](https://linear.app/x/issue/PHNX-43' }), NOW, false)).toContain('I filed PHNX-4324<')
})

test('a pending question shows in an amber box; a detached session offers Open, a non-resumable one nothing', () => {
  const ask = renderSessionCard(row({ phase: 'waiting', liveStatus: 'input_required', question: { text: 'Run the restart on m2?' }, viewingIn: 'detached' }), NOW, false)
  expect(ask).toContain('class="ask">Run the restart on m2?<')
  expect(ask).toContain('aria-label="Needs you"')
  expect(ask).toContain('class="go">Open<')
  expect(renderSessionCard(row({ phase: 'done', liveStatus: 'closed', resumable: false }), NOW, false)).not.toContain('class="go"')
})

test('pasted images show as thumbnails that open the full image; more than three fold into +N', () => {
  const thumbs = [1, 2, 3, 4, 5].map((i) => ({ uri: `vscode-resource:/a${i}.png`, path: `/h/.agents/.history/attachments/a${i}.png`, label: `a${i}.png` }))
  const html = renderSessionCard(row({ request: { headline: 'Turn this into an animation' } }), NOW, false, thumbs)
  expect(html.match(/class="th"/g)?.length).toBe(3)
  expect(html).toContain('data-path="/h/.agents/.history/attachments/a1.png"')
  expect(html).toContain('<b>+2</b>')
})

test('every session is listed, grouped by state in attention order; empty ones fold into one line at the end', () => {
  const html = renderSessions([
    row({ sessionId: 'ended', phase: 'done', liveStatus: 'closed', lastResponse: 'Shipped.' }),
    row({ sessionId: 'yours', phase: 'idle', liveStatus: 'idle', lastResponse: 'Done on my side.' }),
    row({ sessionId: 'ask', phase: 'waiting', liveStatus: 'input_required' }),
    row({ sessionId: 'work', lastResponse: 'Running the suite.' }),
    row({ sessionId: 'quiet', phase: 'done', liveStatus: 'closed' }),
  ], NOW, null)
  const order = ['Needs you', 'Working', 'Your turn', 'Ended'].map((w) => html.indexOf(`class="divider">${w}`))
  expect(order.every((i) => i >= 0)).toBe(true)
  expect([...order].sort((x, y) => x - y)).toEqual(order)
  expect(html).not.toContain('idle or done')
  expect(html).toContain('<details class="bare"><summary>1 more with nothing to show</summary>')
  expect(sessionCount([row({ lastResponse: 'x' }), row({}), row({ phase: 'waiting', lastResponse: 'y' })])).toEqual({ shown: 2, asks: 1 })
})

test('a live tool call reads as the command it runs, never as a "Tool: args" label', () => {
  expect(activityLine('Bash: agents ssh zion ls')).toBe('<span class="cmd">$ agents ssh zion ls</span>')
  expect(activityLine('Read: src/a.ts')).toBe('<span class="tool">Read</span> <span class="cmd">src/a.ts</span>')
  expect(activityLine('thinking about it')).toBe('thinking about it')
  const html = renderSessionCard(row({ activity: 'Bash: cd /tmp && ls', lastResponse: 'Checking the tree.' }), 0, false)
  expect(html).toContain('<span class="cmd">$ cd /tmp &amp;&amp; ls</span>')
  expect(html).not.toContain('Bash:')
})

test('overview shows a failed ticket read in place instead of an empty bar', () => {
  const html = renderOverview(parseOverview(STATUS), '2026-10-08', [], 'linear: HTTP 401')
  expect(html).toContain('Tickets could not be read: linear: HTTP 401')
  expect(html).not.toContain('class="sbar"')
})
