// Webview mirror of the `agents sessions preview <id> --json` envelope. The CLI
// owns the shape (renderSessionPreview / buildSessionPreviewDigest); this file
// is the read side — a tolerant normalizer that turns the untyped `envelope`
// (posted verbatim by the host `fetchSessionPreview` verb) into the typed model
// the detail panel renders (PHNX-2973). Same "mirror the CLI shape, parse field
// by field" contract RemoteSessionLike already follows in floorAdapter.ts.
//
// No transcript parsing here — the CLI computed every field; we only reshape its
// JSON. This keeps the extension a presentation layer (AGENTS.md rule #3).

export type FileOp = 'created' | 'modified' | 'deleted'
export interface PreviewFileChange { path: string; op: FileOp }

export interface PreviewSessionHeader {
  id: string
  shortId: string
  agent: string
  version: string
  model: string
  account: string
  machine: string
  cwd: string
  project: string
  gitBranch: string
  createdAt: string
  lastActivity: string
  durationMs: number
  messageCount: number
  tokenCount: number
  costUsd: number
  label: string
  topic: string
  ticketId: string
  prUrl: string
}

export interface PreviewChangeCounts { created: number; modified: number; deleted: number }
export interface PreviewSkill { name: string; count: number }
export interface PreviewHook { name: string; event?: string; count: number; failed: number }
export interface PreviewLink { kind: string; url: string; label: string }
export interface PreviewToolCount { tool: string; count: number }
export interface PreviewTest { runner: string; ok: boolean; passed?: number; failed?: number }

export interface PreviewDigest {
  firstUser: string
  lastAssistant: string
  filesRead: number
  toolCalls: number
  planFile: string
  subAgentCount: number
  backgroundShellCount?: number
  toolTags: string[]
  changes: PreviewChangeCounts
  changedFiles: PreviewFileChange[]
  dirs: string[]
  repos: string[]
  skills: PreviewSkill[]
  plugins: string[]
  hooks: PreviewHook[]
  links: PreviewLink[]
  errorCount: number
  firstError?: string
  toolHistogram: PreviewToolCount[]
  test?: PreviewTest
}

export interface SessionPreview {
  session: PreviewSessionHeader
  digest?: PreviewDigest
  activity?: string
  error?: string
}

// ---- tolerant coercion helpers ------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
function objList<T>(v: unknown, map: (o: Record<string, unknown>) => T | undefined): T[] {
  if (!Array.isArray(v)) return []
  const out: T[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const mapped = map(x as Record<string, unknown>)
    if (mapped !== undefined) out.push(mapped)
  }
  return out
}

function normalizeDigest(raw: unknown): PreviewDigest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const d = raw as Record<string, unknown>
  const c = rec(d.changes)
  const t = rec(d.test)
  const test: PreviewTest | undefined = str(t.runner)
    ? { runner: str(t.runner), ok: t.ok === true, passed: optNum(t.passed), failed: optNum(t.failed) }
    : undefined
  return {
    firstUser: str(d.firstUser),
    lastAssistant: str(d.lastAssistant),
    filesRead: num(d.filesRead),
    toolCalls: num(d.toolCalls),
    planFile: str(d.planFile),
    subAgentCount: num(d.subAgentCount),
    backgroundShellCount: optNum(d.backgroundShellCount),
    toolTags: strList(d.toolTags),
    changes: { created: num(c.created), modified: num(c.modified), deleted: num(c.deleted) },
    changedFiles: objList<PreviewFileChange>(d.changedFiles, (f) => {
      const path = str(f.path)
      const op = f.op === 'created' || f.op === 'modified' || f.op === 'deleted' ? (f.op as FileOp) : undefined
      return path && op ? { path, op } : undefined
    }),
    dirs: strList(d.dirs),
    repos: strList(d.repos),
    skills: objList<PreviewSkill>(d.skills, (s) => {
      const name = str(s.name)
      return name ? { name, count: num(s.count) } : undefined
    }),
    plugins: strList(d.plugins),
    hooks: objList<PreviewHook>(d.hooks, (h) => {
      const name = str(h.name)
      return name ? { name, event: str(h.event) || undefined, count: num(h.count), failed: num(h.failed) } : undefined
    }),
    links: objList<PreviewLink>(d.links, (l) => {
      const url = str(l.url)
      const label = str(l.label)
      return url && label ? { kind: str(l.kind) || 'other', url, label } : undefined
    }),
    errorCount: num(d.errorCount),
    firstError: str(d.firstError) || undefined,
    toolHistogram: objList<PreviewToolCount>(d.toolHistogram, (h) => {
      const tool = str(h.tool)
      return tool ? { tool, count: num(h.count) } : undefined
    }),
    test,
  }
}

function normalizeHeader(raw: unknown): PreviewSessionHeader {
  const s = rec(raw)
  return {
    id: str(s.id),
    shortId: str(s.shortId),
    agent: str(s.agent),
    version: str(s.version),
    model: str(s.model),
    account: str(s.account),
    machine: str(s.machine),
    cwd: str(s.cwd),
    project: str(s.project),
    gitBranch: str(s.gitBranch),
    createdAt: str(s.createdAt),
    lastActivity: str(s.lastActivity),
    durationMs: num(s.durationMs),
    messageCount: num(s.messageCount),
    tokenCount: num(s.tokenCount),
    costUsd: num(s.costUsd),
    label: str(s.label),
    topic: str(s.topic),
    ticketId: str(s.ticketId),
    prUrl: str(s.prUrl),
  }
}

/**
 * Turn the raw `envelope` posted by the host into the typed model, or an
 * error-only result. `error` from the CLI (`{...,error}`) or a missing digest
 * both surface as `error` so the panel can show a reason instead of a blank.
 */
export function normalizeSessionPreview(envelope: unknown, fallbackError?: string): SessionPreview | undefined {
  if (fallbackError && (!envelope || typeof envelope !== 'object')) {
    return { session: normalizeHeader(undefined), error: fallbackError }
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return undefined
  const e = envelope as Record<string, unknown>
  const session = normalizeHeader(e.session)
  const digest = normalizeDigest(e.preview)
  const active = rec(e.active)
  const cliError = str(e.error) || undefined
  return {
    session,
    digest,
    activity: str(active.activity) || undefined,
    error: cliError ?? (digest ? undefined : fallbackError ?? 'no preview available'),
  }
}

// ---- display formatting -------------------------------------------------------

/** 1_117_641 -> "1.1m", 54_600 -> "54.6k", 812 -> "812". Matches the CLI card. */
export function humanTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/** Collapse a home-anchored absolute path to `~` for display. */
export function tildePath(p: string): string {
  return p ? p.replace(/^\/(?:Users|home)\/[^/]+/, '~') : p
}
