import { test, expect } from 'bun:test'
import {
  parseOverview, parsePrs, parseProjectDetection, parseProjectList, parseTickets,
  activityLine, projectSessions, renderOverview, renderPrs, renderSessionRow, renderTickets, sessionMark,
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
})

const row = (o: Partial<SessionLike>): SessionLike => ({
  sessionId: 's', host: 'yosemite-m6', title: 'T', label: '', topic: '', phase: 'running', liveStatus: 'running',
  lastResponse: '', activity: '', ticket: null, artifacts: [], lastActivityMs: 0, confirmedProject: 'agi', ...o,
})

test('session mark: an open ask beats a stall beats a failure beats working; idle and done sit last', () => {
  expect(sessionMark(row({ attention: { kind: 'permission', state: 'open' } }))).toBe('asks')
  expect(sessionMark(row({ attention: { kind: 'stall', state: 'open' }, phase: 'idle' }))).toBe('stopped')
  expect(sessionMark(row({ liveStatus: 'crashed', phase: 'idle' }))).toBe('stopped')
  expect(sessionMark(row({ phase: 'failed' }))).toBe('failed')
  expect(sessionMark(row({ attention: { kind: 'question', state: 'answered' } }))).toBe('working')
  expect(sessionMark(row({ phase: 'idle', liveStatus: 'idle' }))).toBe('idle')
  const ordered = projectSessions([
    row({ sessionId: 'run', lastActivityMs: 9 }),
    row({ sessionId: 'other', confirmedProject: 'rush' }),
    row({ sessionId: 'stall', attention: { kind: 'stall', state: 'open' }, phase: 'idle' }),
    row({ sessionId: 'ask', attention: { kind: 'question', state: 'open' } }),
  ], 'AGI')
  expect(ordered.map((r) => r.sessionId)).toEqual(['ask', 'stall', 'run'])
})

test('session row: three lines, the state is the icon, facts carry their words in titles', () => {
  const html = renderSessionRow(row({
    title: 'delete CLI copies', attention: { kind: 'question', state: 'open', question: { text: 'Run the restart on m2?' } },
    lastResponse: 'older text', ticket: 'PHNX-4227', lastActivityMs: Date.parse('2026-10-09T00:00:00Z') - 22 * 60000,
    prStatus: { number: 3835, checks: 'passing', isDraft: false }, artifacts: [1, 2, 3], files: { total: 41 },
  }), Date.parse('2026-10-09T00:00:00Z'), true)
  expect(html).toContain('class="l1">delete CLI copies')
  expect(html).toContain('class="l2">Run the restart on m2?')
  expect(html).toContain('aria-label="Asking you"')
  expect(html).toContain('m6')
  expect(html).toContain('22m')
  expect(html).toContain('PR #3835: ready to merge')
  expect(html).toContain('3 artifacts')
  expect(html).toContain('41 files changed')
  expect(html).not.toMatch(/>\s*asks\s*</)
  expect(html).toContain('srow sel')
})

test('a live tool call reads as the command it runs, never as a "Tool: args" label', () => {
  expect(activityLine('Bash: agents ssh zion ls')).toBe('<span class="cmd">$ agents ssh zion ls</span>')
  expect(activityLine('Read: src/a.ts')).toBe('<span class="tool">Read</span> <span class="cmd">src/a.ts</span>')
  expect(activityLine('thinking about it')).toBe('thinking about it')
  const html = renderSessionRow(row({ activity: 'Bash: cd /tmp && ls' }), 0, false)
  expect(html).toContain('class="l2 act"')
  expect(html).not.toContain('Bash:')
})

test('a tool-call preview in lastResponse also reads as a command; prose stays prose', () => {
  expect(renderSessionRow(row({ lastResponse: 'Bash: cd /tmp && ls' }), 0, false)).toContain('<span class="cmd">$ cd /tmp &amp;&amp; ls</span>')
  expect(renderSessionRow(row({ lastResponse: "No, it didn't come from a Rush number" }), 0, false)).toContain('class="l2">No, it didn&#39;t come')
})
