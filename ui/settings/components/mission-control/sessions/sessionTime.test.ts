import { describe, expect, test } from 'bun:test'
import { formatAbsoluteRange, formatDuration, formatRelativeTime } from './sessionTime'

describe('session time presentation', () => {
  const now = Date.UTC(2026, 7, 30, 16, 53)

  test('formats row age relative to last activity', () => {
    expect(formatRelativeTime(now - 9 * 60_000, now)).toBe('9m ago')
    expect(formatRelativeTime(now - 2 * 60 * 60_000, now)).toBe('2h ago')
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60_000, now)).toBe('3d ago')
    expect(formatRelativeTime(now - 30_000, now)).toBe('<1m ago')
  })

  test('formats elapsed duration and keeps sub-minute runs honest', () => {
    expect(formatDuration(now - 20_000, now)).toBe('<1m')
    expect(formatDuration(now - 2 * 60_000, now)).toBe('2m')
    expect(formatDuration(now - 65 * 60_000, now)).toBe('1h 5m')
  })

  test('formats a compact absolute hover range without duplicate timestamps', () => {
    const start = Date.UTC(2026, 7, 30, 16, 42)
    const end = Date.UTC(2026, 7, 30, 16, 44)
    expect(formatAbsoluteRange(start, end, { locale: 'en-US', timeZone: 'UTC' }))
      .toBe('Aug 30, 4:42–4:44 PM')
    expect(formatAbsoluteRange(start, start, { locale: 'en-US', timeZone: 'UTC' }))
      .toBe('Aug 30, 4:42 PM')
  })
})
