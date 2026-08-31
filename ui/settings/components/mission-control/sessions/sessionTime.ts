const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export interface TimeFormatOptions {
  locale?: string
  timeZone?: string
}

/** Compact relative age, always explicit about being in the past. */
export function formatRelativeTime(atMs: number, nowMs: number): string {
  if (!Number.isFinite(atMs) || atMs <= 0 || !Number.isFinite(nowMs)) return '—'
  const elapsed = Math.max(0, nowMs - atMs)
  if (elapsed < MINUTE_MS) return '<1m ago'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`
  if (elapsed < 30 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`
  if (elapsed < 365 * DAY_MS) return `${Math.floor(elapsed / (30 * DAY_MS))}mo ago`
  return `${Math.floor(elapsed / (365 * DAY_MS))}y ago`
}

/** Compact elapsed duration from session start to its last observed activity. */
export function formatDuration(startedAtMs: number, lastActivityMs: number): string {
  const elapsed = Number.isFinite(startedAtMs) && Number.isFinite(lastActivityMs)
    ? Math.max(0, lastActivityMs - startedAtMs)
    : 0
  if (elapsed < MINUTE_MS) return '<1m'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS)
    const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const days = Math.floor(elapsed / DAY_MS)
  const hours = Math.floor((elapsed % DAY_MS) / HOUR_MS)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

function formatParts(ms: number, opts: TimeFormatOptions) {
  const locale = opts.locale ?? undefined
  const timeZone = opts.timeZone
  const date = new Date(ms)
  const dateText = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }).format(date)
  const dayKey = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(date)
  const timeText = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(date)
  const dayPeriod = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true, timeZone })
    .formatToParts(date)
    .find((part) => part.type === 'dayPeriod')?.value ?? ''
  return { dateText, dayKey, timeText, dayPeriod }
}

/** Absolute start/end range for hover text; identical timestamps collapse to one. */
export function formatAbsoluteRange(
  startedAtMs: number,
  lastActivityMs: number,
  opts: TimeFormatOptions = {},
): string {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return ''
  const endMs = Number.isFinite(lastActivityMs) && lastActivityMs > 0
    ? Math.max(startedAtMs, lastActivityMs)
    : startedAtMs
  const start = formatParts(startedAtMs, opts)
  if (endMs === startedAtMs) return `${start.dateText}, ${start.timeText}`
  const end = formatParts(endMs, opts)
  if (start.dayKey !== end.dayKey) return `${start.dateText}, ${start.timeText}–${end.dateText}, ${end.timeText}`
  const startTime = start.dayPeriod && start.dayPeriod === end.dayPeriod
    ? start.timeText.replace(new RegExp(`\\s*${start.dayPeriod}$`), '')
    : start.timeText
  return `${start.dateText}, ${startTime}–${end.timeText}`
}
