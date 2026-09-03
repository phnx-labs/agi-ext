import { test, expect } from 'bun:test'
import {
  PRIORITY_ORDER,
  dueSortValue,
  sortTasks,
  filterTasks,
  matchesSearch,
  filterTickets,
} from './listFilter'
import type { FloorTicket, TicketSource } from './floorModel'

// ---- PRIORITY_ORDER ---------------------------------------------------------

test('PRIORITY_ORDER ranks urgent < high < medium < low', () => {
  expect(PRIORITY_ORDER).toEqual({ urgent: 0, high: 1, medium: 2, low: 3 })
})

// ---- dueSortValue -----------------------------------------------------------

test('dueSortValue: missing due date sorts last', () => {
  expect(dueSortValue({ source: 'linear' })).toBe(Number.MAX_SAFE_INTEGER)
  expect(dueSortValue({ source: 'linear', metadata: {} })).toBe(Number.MAX_SAFE_INTEGER)
})

test('dueSortValue: parses an ISO due date to epoch millis', () => {
  expect(dueSortValue({ source: 'linear', metadata: { dueDate: '2026-01-02' } })).toBe(
    new Date('2026-01-02').getTime(),
  )
})

// ---- sortTasks --------------------------------------------------------------

type T = { id: string; source: string; priority?: string; metadata?: { dueDate?: string; repo?: string } }

test('sortTasks: source order (linear before github) always wins first', () => {
  const tasks: T[] = [
    { id: 'gh-urgent', source: 'github', priority: 'urgent' },
    { id: 'ln-low', source: 'linear', priority: 'low' },
  ]
  // Even though github's task is urgent and linear's is low, linear sorts first.
  expect(sortTasks(tasks, 'priority').map(t => t.id)).toEqual(['ln-low', 'gh-urgent'])
})

test('sortTasks: within a source, priority orders urgent -> low', () => {
  const tasks: T[] = [
    { id: 'a', source: 'linear', priority: 'low' },
    { id: 'b', source: 'linear', priority: 'urgent' },
    { id: 'c', source: 'linear', priority: 'medium' },
  ]
  expect(sortTasks(tasks, 'priority').map(t => t.id)).toEqual(['b', 'c', 'a'])
})

test('sortTasks: missing/unknown priority ranks last (99)', () => {
  const tasks: T[] = [
    { id: 'none', source: 'linear' },
    { id: 'high', source: 'linear', priority: 'high' },
  ]
  expect(sortTasks(tasks, 'priority').map(t => t.id)).toEqual(['high', 'none'])
})

test('sortTasks: due sort orders earlier dates first, undated last', () => {
  const tasks: T[] = [
    { id: 'late', source: 'linear', metadata: { dueDate: '2026-03-01' } },
    { id: 'none', source: 'linear' },
    { id: 'early', source: 'linear', metadata: { dueDate: '2026-01-01' } },
  ]
  expect(sortTasks(tasks, 'due').map(t => t.id)).toEqual(['early', 'late', 'none'])
})

test('sortTasks: priority+due breaks priority ties by due date', () => {
  const tasks: T[] = [
    { id: 'h-late', source: 'linear', priority: 'high', metadata: { dueDate: '2026-05-01' } },
    { id: 'h-early', source: 'linear', priority: 'high', metadata: { dueDate: '2026-02-01' } },
    { id: 'urgent', source: 'linear', priority: 'urgent', metadata: { dueDate: '2026-09-01' } },
  ]
  expect(sortTasks(tasks, 'priority+due').map(t => t.id)).toEqual(['urgent', 'h-early', 'h-late'])
})

test('sortTasks: does not mutate the input array', () => {
  const tasks: T[] = [
    { id: 'b', source: 'linear', priority: 'low' },
    { id: 'a', source: 'linear', priority: 'urgent' },
  ]
  const before = tasks.map(t => t.id)
  sortTasks(tasks, 'priority')
  expect(tasks.map(t => t.id)).toEqual(before)
})

// ---- filterTasks ------------------------------------------------------------

test('filterTasks: keeps only active sources', () => {
  const tasks: T[] = [
    { id: 'a', source: 'linear' },
    { id: 'b', source: 'github' },
  ]
  const out = filterTasks(tasks, { activeSources: new Set(['linear']), repoFilter: 'all' })
  expect(out.map(t => t.id)).toEqual(['a'])
})

test('filterTasks: repoFilter "all" keeps every repo; a value scopes to it', () => {
  const tasks: T[] = [
    { id: 'a', source: 'linear', metadata: { repo: 'foo/x' } },
    { id: 'b', source: 'linear', metadata: { repo: 'foo/y' } },
    { id: 'c', source: 'linear' },
  ]
  expect(filterTasks(tasks, { activeSources: new Set(['linear']), repoFilter: 'all' }).map(t => t.id)).toEqual([
    'a', 'b', 'c',
  ])
  expect(
    filterTasks(tasks, { activeSources: new Set(['linear']), repoFilter: 'foo/x' }).map(t => t.id),
  ).toEqual(['a'])
})

// ---- matchesSearch ----------------------------------------------------------

type Item = { id: string; title: string; labels: string[] }
const item: Item = { id: 'RUSH-812', title: 'Fix the widget', labels: ['bug', 'ui'] }
const FIELDS: Array<(i: Item) => string | string[] | null | undefined> = [
  i => i.id,
  i => i.title,
  i => i.labels,
]

test('matchesSearch: empty / whitespace query matches everything', () => {
  expect(matchesSearch(item, '', FIELDS)).toBe(true)
  expect(matchesSearch(item, '   ', FIELDS)).toBe(true)
})

test('matchesSearch: matches a string field case-insensitively', () => {
  expect(matchesSearch(item, 'rush-812', FIELDS)).toBe(true)
  expect(matchesSearch(item, 'WIDGET', FIELDS)).toBe(true)
})

test('matchesSearch: matches inside an array field', () => {
  expect(matchesSearch(item, 'ui', FIELDS)).toBe(true)
})

test('matchesSearch: returns false when nothing contains the query', () => {
  expect(matchesSearch(item, 'nonexistent', FIELDS)).toBe(false)
})

test('matchesSearch: skips null/undefined field accessors', () => {
  const fields: Array<(i: Item) => string | string[] | null | undefined> = [() => null, () => undefined, i => i.title]
  expect(matchesSearch(item, 'widget', fields)).toBe(true)
  expect(matchesSearch(item, 'RUSH', fields)).toBe(false)
})

// ---- filterTickets ----------------------------------------------------------

function ticket(over: Partial<FloorTicket>): FloorTicket {
  return {
    id: 'RUSH-1',
    title: 'A ticket',
    project: 'Rush',
    source: 'LN' as TicketSource,
    pri: 'med',
    status: 'todo',
    desc: '',
    labels: [],
    owner: '',
    ...over,
  }
}

const allSrc: Record<TicketSource, boolean> = { LN: true, GH: true }

test('filterTickets: excludes done tickets', () => {
  const tickets = [ticket({ id: 'a', status: 'todo' }), ticket({ id: 'b', status: 'done' })]
  const out = filterTickets(tickets, { projFilter: null, srcFilter: allSrc, search: '' })
  expect(out.map(t => t.id)).toEqual(['a'])
})

test('filterTickets: projFilter null keeps all; a value scopes to that project', () => {
  const tickets = [ticket({ id: 'a', project: 'Rush' }), ticket({ id: 'b', project: 'Atlas' })]
  expect(
    filterTickets(tickets, { projFilter: null, srcFilter: allSrc, search: '' }).map(t => t.id),
  ).toEqual(['a', 'b'])
  expect(
    filterTickets(tickets, { projFilter: 'Atlas', srcFilter: allSrc, search: '' }).map(t => t.id),
  ).toEqual(['b'])
})

test('filterTickets: honours the source visibility map', () => {
  const tickets = [ticket({ id: 'a', source: 'LN' }), ticket({ id: 'b', source: 'GH' })]
  const out = filterTickets(tickets, {
    projFilter: null,
    srcFilter: { LN: true, GH: false },
    search: '',
  })
  expect(out.map(t => t.id)).toEqual(['a'])
})

test('filterTickets: searches id, title and labels case-insensitively', () => {
  const tickets = [
    ticket({ id: 'RUSH-10', title: 'Login flow', labels: ['auth'] }),
    ticket({ id: 'RUSH-11', title: 'Dashboard', labels: ['ui'] }),
    ticket({ id: 'RUSH-12', title: 'Billing', labels: ['payments'] }),
  ]
  const byTitle = filterTickets(tickets, { projFilter: null, srcFilter: allSrc, search: 'dash' })
  expect(byTitle.map(t => t.id)).toEqual(['RUSH-11'])
  const byLabel = filterTickets(tickets, { projFilter: null, srcFilter: allSrc, search: 'AUTH' })
  expect(byLabel.map(t => t.id)).toEqual(['RUSH-10'])
  const byId = filterTickets(tickets, { projFilter: null, srcFilter: allSrc, search: 'rush-12' })
  expect(byId.map(t => t.id)).toEqual(['RUSH-12'])
})

test('filterTickets: empty search keeps all non-done, in-scope tickets', () => {
  const tickets = [ticket({ id: 'a' }), ticket({ id: 'b' })]
  expect(
    filterTickets(tickets, { projFilter: null, srcFilter: allSrc, search: '  ' }).map(t => t.id),
  ).toEqual(['a', 'b'])
})
