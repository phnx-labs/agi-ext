import { test, expect } from 'bun:test'
import {
  parseOverview, parsePrs, parseProjectDetection, parseProjectList, parseTickets,
  renderOverview, renderPrs, renderTickets,
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

test('overview: open milestones by due date first, overdue flagged, complete folded away', () => {
  const html = renderOverview(parseOverview(STATUS), '2026-10-08')
  expect(html.indexOf('Ship B')).toBeLessThan(html.indexOf('Ship C'))
  expect(html).toMatch(/class="ms late"[\s\S]*Ship B[\s\S]*overdue · due 2026-09-01/)
  expect(html).toContain('<summary>1 complete</summary>')
  expect(html).toContain('90%')
  expect(html).toContain('Ship B is 37d overdue')
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

test('prs: repos with open PRs first, a failed repo shows its error, partial is announced', () => {
  const model = parsePrs(JSON.stringify({ partial: true, repositories: [
    { slug: 'o/quiet', pullRequests: [], recentlyMerged: [] },
    { slug: 'o/broken', error: 'HTTP 502', pullRequests: [], recentlyMerged: [] },
    { slug: 'o/busy', defaultBranch: { name: 'main', ciState: 'FAILURE' },
      release: { latestTag: 'v1.22.123', npm: { version: '1.22.122' }, mergesSince: 3 },
      pullRequests: [{ number: 7, title: 'feat: x', url: 'https://github.com/o/busy/pull/7', isDraft: true, ciState: 'SUCCESS', author: { login: 'm' }, createdAt: '2026-10-08T00:00:00Z' }],
      recentlyMerged: Array.from({ length: 8 }, (_, i) => ({ number: i, title: `m${i}`, url: `https://github.com/o/busy/pull/${i}`, ciState: 'SUCCESS', author: { login: 'm' }, mergedAt: '2026-10-07T00:00:00Z' })) },
  ] }))
  expect(model.repos[0].slug).toBe('o/busy')
  expect(model.repos[0].merged).toHaveLength(5)
  const html = renderPrs(model)
  expect(html).toContain('Some repositories could not be fetched')
  expect(html).toContain('Fetch failed: HTTP 502')
  expect(html).toContain('<span class="tag">draft</span>')
  expect(html).toContain('v1.22.123 · npm 1.22.122 · 3 since')
})
