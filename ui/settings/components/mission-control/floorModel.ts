// Fleet — shared webview view-model + pure logic contract.
//
// Lives in ui/ (NOT src/core) because the webview bundle is isolated from the
// extension host: no ui/ file may import from src/*. Data crosses the boundary
// via postMessage; types are mirrored on each side.
//
// This file is the SEAM between the webview workstreams. Types below are authored
// up front so COMPONENTS and SHELL build against a stable contract; LOGIC fills
// the function bodies and adds floorModel.test.ts. No two agents edit this file
// except LOGIC (owner after this scaffold).
//
// Design source of truth: ~/Downloads/factory-floor-prototype/factory-floor.html
// (+ DESIGN.md). Field names mirror the prototype's AGENTS / TICKETS mock objects
// so the port is a 1:1 translation, not a redesign.

import type { UnifiedTask, RecentEvent, RecentToolCall } from '../../types'
import type { PlanFile } from '../../utils/planDetector'

export type { RecentEvent, RecentToolCall }

// ---------- project resolution ----------
//
// resolveProject + worktreeSlugOf are canonical in src/shared/project.ts, imported
// via @shared — the SAME impl the extension host uses, so a session's project can no
// longer resolve differently on each side of the postMessage boundary. Re-exported
// so existing importers (e.g. floorAdapter) keep their `from './floorModel'` path.
import { resolveProject, worktreeSlugOf } from '@shared/project'
import { UNASSIGNED_LABEL } from './sessionProjects'
import type { ProjectRule } from '@shared/project'
export { resolveProject, worktreeSlugOf }
export type { ProjectRule }

// ---------- agent view-model ----------

/**
 * The session's lifecycle phase, a straight presentation rename of the CLI-provided
 * status (`RemotePhase` on the stream; `phaseFromStatus` for an as-yet-unprojected
 * local tab). The extension does NOT classify this — a wedged/stalled agent is not a
 * phase but a CLI attention row (`attentionKind === 'stall'`), and needs-you membership
 * comes from `attention.state === 'open'`, never from phase. Matches `RemotePhase`
 * one-to-one so a session cannot present a phase the CLI never reported.
 */
export type FloorPhase = 'running' | 'idle' | 'waiting' | 'failed' | 'done'

/**
 * Why the CLI raised an attention row for a session, carried verbatim from the stream
 * (`RemoteAttention.kind`). The needs-you surface's membership, per-row reason, and
 * ORDER all key off this — the extension classifies nothing. Ordering priority is
 * `ATTENTION_KIND_RANK`: question → permission → plan_review → declared → failure →
 * stall → review.
 */
export type AttentionKind =
  | 'question'
  | 'permission'
  | 'plan_review'
  | 'declared'
  | 'failure'
  | 'stall'
  | 'review'

/** Terminal-tab prefix per agent CLI (ui utils is the reference map). */
export type AgentAbbr = 'CC' | 'CX' | 'GX' | 'CR' | 'AG' | 'GK' | 'KM' | 'DR' | 'OC' | 'SH'

type StructuredQuestionKind = 'choice' | 'confirm' | 'destructive' | 'retry'

/**
 * Parsed from an agent's last response. Drives the structured-reply buttons
 * (option chips vs Confirm/Cancel vs Retry) instead of a bare free-text box.
 * Prototype: QCLUSTERS + structuredReply(), factory-floor.html:369-379,591-597.
 */
export interface StructuredQuestion {
  kind: StructuredQuestionKind
  /** The question text shown above the option buttons. */
  text: string
  /** Multiple-choice options; first is the recommended/primary. Empty for retry. */
  options: string[]
  /** Stable key so identical questions across agents cluster for batch triage. */
  clusterKey: string
  /**
   * Why the agent handed control back, when known from the CLI state engine
   * (question / plan_review / permission). Absent for text-heuristic questions.
   * Drives the "why blocked" chip on the decision panel.
   */
  reason?: 'question' | 'plan_review' | 'permission'
  /**
   * Per-option selection keystroke for an interactive TUI prompt, parallel to
   * `options`: a digit ('1'…) for AskUserQuestion/plan, or 'esc' to cancel/deny.
   * '' for a free-text choice. Absent entirely for text-parsed questions (which take
   * a free-text reply). The reply layer sends the keystroke instead of the label when
   * present, so a select-list prompt is actually driven, not fed a label it ignores.
   */
  optionKeys?: string[]
}

type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** One item of an agent's task checklist, parsed from its latest TodoWrite call. */
export interface TodoItem {
  content: string
  status: TodoStatus
}

/**
 * How a user reply reaches THIS agent. Built by the adapter from the agent's
 * source so the host handler ('replyToAgent') can dispatch without re-deriving:
 *   terminal -> the live vscode terminal (sendText); local tabs only.
 *   tmux     -> `tmux -S <muxSocket> send-keys -t <muxTarget>`, over ssh when the
 *               session is on another host. This is how a headless/interactive agent
 *               running inside tmux (local or remote) receives a reply; the CLI hands
 *               us the socket + pane in `provenance.reply`.
 *   cloud    -> `agents cloud message <cloudTaskId> <text>`.
 *   team     -> `agents factory answer <teamName> <text>`.
 *   none     -> no reachable channel (raw non-tmux TTY, e.g. bare Ghostty); `reason`
 *               is shown inline instead of a dead send.
 * `host` is 'this-mac' for local delivery or a remote name the handler prefixes with
 * ssh (tmux/cloud/team commands run on the machine that owns the session).
 */
export type ReplyKind = 'terminal' | 'tmux' | 'cloud' | 'team' | 'none'

export interface ReplyTarget {
  kind: ReplyKind
  host: string
  terminalId?: string
  sessionId?: string
  muxSocket?: string
  muxTarget?: string
  cloudTaskId?: string
  cloudProvider?: string
  teamName?: string
  reason?: string
}

/**
 * The at-a-glance unit rendered in every Floor surface. Built by SHELL's adapter
 * from the real UnifiedAgent (+ cross-host session data). Mirrors prototype
 * AGENTS: factory-floor.html:336-347.
 */
// CI state of an agent's open PR. Mirrors src/core/prChecks.ts (kept as a plain
// string union so UI and extension code need not share an import across roots).
export type CiStatus = 'passed' | 'failed' | 'running' | null

export interface FloorAttachment {
  path: string
  label: string
  mediaType: string
  sizeBytes?: number
  thumbnailUri?: string
}

export interface FloorAgent {
  id: string
  host: string          // 'this-mac' for local; remote hostname otherwise. ROUTING key — reply/nudge/reassign target it.
  hostLabel?: string    // DISPLAY name for host: the local machine's real device name (e.g. 'zion') so it isn't shown as 'this-mac'. Falls back to host.
  context?: string      // CLI session context ('terminal' | 'headless' | 'cloud' | 'teams'); drives the bg badge for background runs.
  sessionId?: string    // CLI session id — Focus targets it (`agents sessions focus <id>`).
  pid?: number          // process id (headless/background runs) — Stop kills it.
  project: string       // repo or cwd basename (worktrees folded to their repo)
  name: string          // displayName / branch-derived label
  abbr: AgentAbbr       // agentType -> CC/CX/GX/...
  /** Exact CLI harness id. Resume uses this instead of reverse-mapping the avatar
   *  abbreviation, which is intentionally lossy for aliases and unknown harnesses. */
  agentType?: string
  phase: FloorPhase
  verb: string          // current activity verb, e.g. "Editing"
  target: string        // activity object, e.g. "src/core/tasks.ts"
  tok: number           // output tok/s; 0 when not streaming
  since: string          // human elapsed, e.g. "2s", "14m", "3h"
  lastActivityMs: number // epoch ms of last observed activity; drives the live heartbeat. 0 when unknown.
  startedAtMs?: number   // epoch ms the session started; 0/undefined when unknown. Drives the Sessions "Started" (creation-time) sort, distinct from lastActivityMs. Set by the adapters; fixtures may omit it.
  files: number
  tools: number
  needs: boolean         // has an open CLI attention row (attention.state === 'open'); the CLI decides needs-you, the ext no longer re-derives it (PHNX-2975)
  pinned: boolean        // user-pinned (persisted in globalState)
  pr: string | null      // "#142" when a PR is open
  prUrl: string | null   // full PR URL (https://github.com/…/pull/N) — the real external link to open
  ci: CiStatus           // CI state of the open PR; null when no PR / unknown
  ticket: string | null  // "RUSH-812" when linked (injected/worked-on ticket from prompt or branch)
  createdTickets?: string[] // tracker refs this session CREATED (Linear create_issue / gh issue create); [] / undefined when none
  createdCommits?: string[] // short git commit SHAs this session CREATED; [] / undefined when none
  spawnedTeam?: string   // team name this session SPAWNED via `agents teams create/add`; undefined when none
  plans?: PlanFile[]     // detected ref-*.md / .html plan artifacts available for preview
  attachments?: FloorAttachment[] // session screenshots/files available for thumbnail + preview
  branch: string
  worktreeSlug: string   // "<slug>" under .agents/worktrees/; '' when not a worktree. Disambiguates sibling sessions + labels the card when topic/preview are empty.
  worktreePath: string   // absolute worktree path, for the Reveal-worktree action; '' when not a worktree
  resp: string           // last response text (Anthropic Agent-view style)
  prompt?: string        // the ORIGINAL task (first user message / dispatch prompt / topic); anchors the card, distinct from the last message
  topic?: string         // the session's task/label line from the roster (topic/label/prompt). The Sessions surface's row title + search field. Falls back to prompt/name when absent.
  title?: string         // CLI-authored recap title for the row header; distinct from the request body.
  firstUserMessage?: string // Full genuine first user turn from the CLI index. Undefined means the UI must label its fallback honestly.
  messages: string[]     // the last few assistant messages (from the CLI's last_messages window); [] when none. Drives the detail-pane Activity feed.
  question: StructuredQuestion | null
  /** The CLI attention row's kind, carried verbatim from the stream. Drives the
   *  needs-you section's per-row reason and its ORDER (ATTENTION_KIND_RANK).
   *  Undefined when the CLI raised no attention for this session. */
  attentionKind?: AttentionKind
  attentionSource?: 'hook' | 'declared' | 'lifecycle' | 'heuristic' | 'system'
  attentionState?: 'open' | 'answered' | 'consumed' | 'continued' | 'resolved'
  attentionFingerprint?: string
  reply: ReplyTarget     // how a user reply reaches this agent (host dispatches on kind)
  todos: TodoItem[]      // task checklist from the latest TodoWrite; empty when none
  summary: string        // the "what is it doing" line (CLI-provided); '' when unknown
  recent: RecentToolCall[] // rolling window of this session's recent tool calls; [] when none
  recentEvents?: RecentEvent[] // rolling window of detail timeline events; [] when none
  pane?: string          // tmux `%N` pane handle for unique addressing; undefined for non-tmux
  viewingIn?: string     // "Codium tab 3" / "Ghostty tab 2" / "detached"; undefined when unknown
  /**
   * Per-session rate/usage limit (RUSH-1523). Distinct from account-level
   * usageStatus — set when the session transcript shows 429 / rate-limit text.
   */
  rateLimited?: boolean
  /**
   * Raw CLI lifecycle word ('orphaned' | 'crashed' | 'abandoned' | 'idle' |
   * 'running' | 'waiting' | ...), carried verbatim from the roster because `phase`
   * collapses orphaned/crashed into a state it can't tell apart. The Sessions
   * surface reads this to route a detached-but-alive session into the "needs
   * reconnecting" band. '' / undefined when the CLI supplied no status (e.g. a
   * AGI EXT-owned local tab, which is attached by definition).
   */
  liveStatus?: string
  /** Whether the session's OS process is still alive (from the CLI `pidAlive`).
   *  Undefined for AGI EXT-owned tabs (always live). Distinguishes an orphaned but
   *  running session (resume attaches) from a crashed one (resume relaunches). */
  pidAlive?: boolean
  /**
   * Lifecycle state from the CLI picker join (`SessionPickerJsonRow.state`): the
   * live status word, or 'inactive' for a genuinely ended session. 'inactive' is
   * the load-bearing signal that this is a resumable PREVIOUS row folded in from
   * the durable index rather than a live-roster row. Undefined for a live row.
   */
  sessionState?: string
  /** Whether an ended session can be resumed (`SessionPickerJsonRow.resumable`).
   *  false for a harness with no resume path (grok/gemini/droid/cursor/…) — those
   *  rows expose no dead action. */
  resumable?: boolean
  /** The CLI's own recovery command for this session
   *  (`agents sessions resume <id> --device <device>`). null for non-resumable. */
  recovery?: { command: string; args: string[]; cwd?: string } | null
  /** Canonical device label the session's transcript lives on (`sourceDevice`),
   *  e.g. 'zion', 'yosemite-s0'. Labels every Previous row with its device. */
  sourceDevice?: string
}

// ---------- Sessions surface (manage / recover) ----------

/** Status filter chips on the Sessions surface. All status membership comes from
 *  CLI-supplied phase/attention fields; the view never probes lifecycle itself. */
export type SessionFilter = 'all' | 'active' | 'idle' | 'blocked' | 'favorites'
/** How the Sessions list is grouped into sections. */
export type SessionGroup = 'project' | 'device' | 'status' | 'none'
/** The within-group sort key for the Sessions list. */
export type SessionSort = 'recent' | 'started' | 'status' | 'name' | 'tok'

/**
 * The band a session belongs to when grouped by state. 'previous' is the crashed/
 * ended-but-resumable case folded in from the durable index — the reason this
 * surface exists after a reboot prunes dead PIDs. It is derived from the CLI's own
 * `sessionState === 'inactive'`, never from `phase`. Pure so it is unit-tested.
 */
export type SessionBand = 'attention' | 'active' | 'done' | 'previous'
/** User-facing Sessions taxonomy shared by filters and Group: Status. */
export type SessionStatus = 'active' | 'idle' | 'blocked' | 'previous'

/**
 * True for a resumable PREVIOUS session — a crashed/ended row folded in from the
 * durable transcript index whose CLI lifecycle `state` is exactly `'inactive'`, not a
 * live-roster row. Keyed ONLY on the CLI's own lifecycle word: a session that is still
 * live (any non-inactive `state`, or a watch-stream row with no `state` at all) is
 * NEVER previous, even though the picker fetch tags every fetched row `context:'recent'`
 * — so a session active two seconds ago stays in Active, not Previous (PHNX-3593). The
 * Sessions surface bands these separately and never lets them leak into the live feed.
 */
export function isPrevious(a: Pick<FloorAgent, 'sessionState'>): boolean {
  return (a.sessionState ?? '').toLowerCase() === 'inactive'
}

/**
 * Assign a session to its state band, ranked by PROGRESS (see the root AGENTS.md
 * "Purpose" section): attention (live but stopped progressing — waiting on input,
 * stalled, idle, or failed) > active (running, making progress) > done > previous
 * (ended, resumable). Idle-but-unfinished work is the highest-abandonment risk, so
 * it surfaces ABOVE running rather than below it. Pure so it is unit-tested;
 * classifies the CLI-supplied `phase`/`sessionState`, never derives lifecycle itself.
 */
export function sessionBand(a: FloorAgent): SessionBand {
  if (isPrevious(a)) return 'previous'
  if (a.phase === 'done') return 'done'
  if (a.phase === 'running') return 'active'
  return 'attention'
}

/**
 * Classify a row from the CLI stream only. An open attention item is Blocked;
 * failed sessions are likewise actionable. Waiting folds into Idle until the CLI
 * exposes a more specific status, as does ordinary idle. Ended rows are Previous.
 */
export function sessionStatus(a: FloorAgent): SessionStatus {
  if (isPrevious(a) || a.phase === 'done') return 'previous'
  if (a.needs || a.phase === 'failed') return 'blocked'
  if (a.phase === 'idle' || a.phase === 'waiting') return 'idle'
  return 'active'
}

/**
 * The exact command that resumes a session, sourced from the CLI's own recovery
 * record when present (`agents sessions resume <id> --device <device>`), else built
 * from the row's resumable id + device. Returns null for a non-resumable harness
 * (recovery null, resumable false) so the row renders no dead action.
 * Pure so the built command is unit-tested and quotable.
 */
export function resumeCommand(a: FloorAgent): { command: string; args: string[]; cwd?: string } | null {
  if (a.recovery && a.recovery.command && a.recovery.args.length > 0) return a.recovery
  if (!a.resumable || !a.sessionId) return null
  const device = a.sourceDevice || a.hostLabel || (a.host && a.host !== 'this-mac' ? a.host : '')
  const args = device
    ? ['sessions', 'resume', a.sessionId, '--device', device]
    : ['sessions', 'resume', a.sessionId]
  return { command: 'agents', args }
}

/**
 * Resolve the id targeted by the CLI recovery record. Historical rows should carry
 * `sessionId`, but older stream projections only carried the recovery argv. A row
 * with a real recovery command must still be actionable: the Sessions UI uses this
 * same resolver both to show Resume and to route the click, so it can never display
 * a Resume button whose handler silently falls through to dead-session focus.
 */
export function recoverySessionId(a: Pick<FloorAgent, 'sessionId' | 'recovery'>): string | null {
  const direct = a.sessionId?.trim()
  if (direct) return direct
  const args = a.recovery?.args ?? []
  for (let index = 1; index + 1 < args.length; index++) {
    if (args[index - 1] !== 'sessions' || args[index] !== 'resume') continue
    const recovered = (args[index + 1] ?? '').trim()
    return recovered && !recovered.startsWith('-') ? recovered : null
  }
  return null
}

// ---------- HOSTS sidebar rows ----------

/** One row in the HOSTS sidebar: a machine, its active-agent count, reachability. */
export interface HostRow {
  name: string
  count: number
  offline: boolean
  pinned: boolean
}

/** Canonicalize a host name to its device label. Mirror of core normalizeHost so a
 *  session's host ('mac-mini', 'ZION', a FQDN) folds onto the registry device it
 *  belongs to. Kept local — ui/ cannot import from src/*. */
function normalizeHostKey(raw: string): string {
  return (raw || '')
    .split('.')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Build the HOSTS rows, SCOPED to the machines that actually exist: the registered
 * device fleet + the local machine + any pinned host. A HOST row is NEVER created
 * from an arbitrary session's host — an agent reported on an unregistered host (an
 * ssh-config alias, a tailnet peer) is still counted into a matching device row but
 * can no longer spawn a phantom row of its own (the reported-bug hosts: mark,
 * mark-aws, phoenix, pi, and the same mac triplicated as localhost / mac-mini /
 * "Muqsit's Mac mini").
 *
 * Each agent folds into its DISPLAY host (`hostLabel ?? host`), normalized to the
 * device label, so the local machine's 'this-mac' bucket collapses onto its real
 * name and appears exactly once. Online devices show even with 0 agents. Device
 * reachability is authoritative when a fleet entry exists; `offlineHosts` only
 * decides a host that has no device entry (a pin).
 *
 * `localHost` is the local machine's canonical name; it always gets a row even when
 * it isn't in the registry (the machine you're on must always be visible).
 *
 * `pins` is the user's ordered list of pinned host names. Pinned hosts render FIRST,
 * in `pins` order (drag-reorderable), then the rest auto-sorted. A pinned host stays
 * visible even with 0 agents / offline, since the user asked for it.
 */
export function computeHostRows(
  agents: FloorAgent[],
  devices: { name: string; online: boolean; agents: number }[],
  offlineHosts: string[],
  pins: string[] = [],
  localHost?: string,
): HostRow[] {
  // Agent counts keyed by normalized device label so 'this-mac'/hostLabel, a FQDN,
  // and case variants all land on the same registry row.
  const byHost: Record<string, number> = {}
  for (const a of agents) {
    const raw = a.hostLabel ?? a.host
    // The synthetic local routing key folds onto the local machine before its real
    // device name has been threaded in as hostLabel (the pre-fold transient).
    const key = raw === 'this-mac' && localHost ? normalizeHostKey(localHost) : normalizeHostKey(raw)
    if (!key) continue
    byHost[key] = (byHost[key] || 0) + 1
  }
  const offline = new Set(offlineHosts)
  const pinIndex = new Map(pins.map((n, i) => [n, i]))
  const deviceByName = new Map(devices.map((d) => [d.name, d]))
  // The row set is the REGISTERED FLEET + local machine + pins — not session hosts.
  const names = new Set<string>()
  for (const d of devices) names.add(d.name)
  if (localHost) names.add(localHost)
  for (const p of pins) names.add(p)
  const rows = [...names].sort().map((name) => {
    const dev = deviceByName.get(name)
    const offlineRow = dev ? !dev.online : offline.has(name)
    // Single session collection: counts come only from the live agents list,
    // never a second deviceHealth/runningAgents number (floor performance).
    const count = byHost[normalizeHostKey(name)] ?? 0
    return { name, count, offline: offlineRow, pinned: pinIndex.has(name) }
  })
  // Pinned first (in the user's drag order), then the alphabetical remainder.
  const pinned = rows
    .filter((r) => r.pinned)
    .sort((a, b) => pinIndex.get(a.name)! - pinIndex.get(b.name)!)
  const rest = rows.filter((r) => !r.pinned)
  return [...pinned, ...rest]
}

// ---------- managed projects (curated sidebar list + Projects pane) ----------
//
// The floor's PROJECTS list is a CURATED set of repos the user cares about — not
// whatever happens to be running right now. Persisted host-side; the webview only
// renders + edits via postMessage. This type is mirrored field-for-field by the
// host (the two builds can't share an import), so keep the shapes in lockstep.

export interface ManagedProject {
  id: string                       // stable local id
  name: string                     // label in sidebar + dispatch
  description?: string             // one-line summary from the ProjectDef
  path: string                     // absolute local folder (the FIRST bound directory)
  repoSlug?: string                // "owner/repo" (the FIRST bound directory's repo)
  dirs: ManagedProjectDir[]        // every directory bound to this project, root/defaultPath first
  linearProjectId?: string
  linearProjectName?: string       // for the Linear pill
  autoDispatch?: boolean           // opt-in: factory auto-picks delegated Todo tickets (default off)
  maxAgents?: number               // cap on concurrent auto-dispatched agents for this project
  confidence: 'high' | 'medium' | 'low'
  source: 'detected' | 'manual'
}

/** One directory bound to a project — a repo's checkout, optionally pinned to a monorepo subpath. */
export interface ManagedProjectDir {
  slug?: string                    // "owner/repo", when this dir has a bound repo
  path: string                     // absolute local folder for this dir (subpath already joined in)
}

/** A Linear project reduced to what the picker needs. */
export interface LinearProjectLite {
  id: string
  name: string
}

/** confidence high>medium>low for the count-independent primary sort. */
const CONFIDENCE_RANK: Record<ManagedProject['confidence'], number> = {
  high: 0,
  medium: 1,
  low: 2,
}

/**
 * Order the curated projects for the sidebar's top-3. Precedence:
 *   1. confidence: high > medium > low
 *   2. active-agent count desc (from `agentCountByName`, keyed by project name)
 *   3. name asc (locale) as the final stable tie-break
 * Pure so both the sidebar and its unit test agree. Does not mutate the input.
 */
export function orderManagedProjects(
  projects: ManagedProject[],
  agentCountByName: Record<string, number>,
): ManagedProject[] {
  return [...projects].sort((a, b) => {
    const conf = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]
    if (conf !== 0) return conf
    const countDiff = (agentCountByName[b.name] ?? 0) - (agentCountByName[a.name] ?? 0)
    if (countDiff !== 0) return countDiff
    return a.name.localeCompare(b.name)
  })
}

// ---------- ticket view-model (Backlog) ----------

export type TicketSource = 'LN' | 'GH'
type TicketPriority = 'urgent' | 'high' | 'med' | 'low'
type TicketStatus = 'todo' | 'in-progress' | 'blocked' | 'done'

/** Mirrors prototype TICKETS (factory-floor.html:382-395); built from UnifiedTask. */
export interface FloorTicket {
  id: string           // metadata.identifier ("RUSH-812" / "#412") || id
  title: string
  project: string
  source: TicketSource
  pri: TicketPriority
  status: TicketStatus
  desc: string
  labels: string[]
  owner: string        // metadata.assignee (human or agent) || '' when unassigned
}

// ---------- controls state ----------

export type CenterMode = 'sessions' | 'agents' | 'backlog' | 'host' | 'projects' | 'recap' | 'prs'

// Host detail pane payloads. Mirror of extension/src/core/hostInventory.ts —
// the webview can't import from src/*, so the shape is redeclared here and
// crosses the boundary as JSON via the `hostInventory` message.
export interface HostResourceSummary {
  skills: number
  plugins: number
  mcp: number
  commands: number
  workflows: number
  memory: number
  hooks: number
  drift: number
}
export interface HostAgentVersion {
  version: string
  isDefault: boolean
  signedIn: boolean
  email: string | null
  plan: string | null
  sessionPercent: number | null
  weekPercent: number | null
  lastActive: string | null
  resources: HostResourceSummary | null
}
export interface HostAgentInfo {
  agent: string
  versions: HostAgentVersion[]
}
export interface HostMeta {
  name: string
  enrolled: boolean
  source: string | null
  target: string | null
  user: string | null
  os: string | null
  caps: string[]
  addedAt: string | null
  status: string | null
}
export interface HostInventory {
  host: string
  reachable: boolean
  error: string | null
  meta: HostMeta | null
  agents: HostAgentInfo[]
  fetchedAt: number
}
/**
 * Group axes for the live agent feed. `outcome` collapses agents under the
 * deliverable they serve (ticket > PR > worktree > Unassigned) — the default
 * for a fleet-scale floor so the operator sees dozens of initiatives, not
 * ~1,100 processes (RUSH-1479).
 */
export type FloorGroupBy = 'outcome' | 'host' | 'project' | 'status' | 'agent'
export type FloorSort = 'needs' | 'recent' | 'tok' | 'name'
export type TicketGroupBy = 'project' | 'priority' | 'source' | 'status' | 'owner'
export type TicketSort = 'priority' | 'id'

// ---------- stable rank constants (data — final, not stubs) ----------

/** Phase-progress ordering, ranked by PROGRESS rather than liveness (root AGENTS.md
 *  "Purpose"). Every phase that has STOPPED progressing outranks `running` — a running
 *  agent is making progress and needs nothing from the operator — and `done` is the
 *  terminal state below both; `idle` still sits ABOVE `running`, because idle-but-
 *  unfinished work is the highest-abandonment risk, not the lowest.
 *
 *  This orders a CLI-provided field (`phase`) for the Sessions surface (Sort: Status)
 *  and the feed's idle/running/done lanes. It is NOT the needs-you ranker — the
 *  needs-you section orders by CLI attention KIND (`ATTENTION_KIND_RANK`), because a
 *  question, a permission, a plan-review, and a stall are distinct attention rows that
 *  a single phase cannot express. Shared with `sessionsModel` so the two never drift
 *  into opposite orders (RUSH-2838). */
export const PHASE_PROGRESS_RANK: Record<FloorPhase, number> = {
  waiting: 0,
  failed: 1,
  idle: 2,
  running: 3,
  done: 4,
}

/** Needs-you ordering, sourced entirely from the CLI attention row's `kind`. The
 *  extension classifies nothing: an explicit interactive hand-back (question →
 *  permission → plan_review → declared) leads, then a hard failure, then a genuine
 *  stall the CLI detected, then a review request. This is the ONLY ranker the
 *  needs-you surface sorts on. */
export const ATTENTION_KIND_RANK: Record<AttentionKind, number> = {
  question: 0,
  permission: 1,
  plan_review: 2,
  declared: 3,
  failure: 4,
  stall: 5,
  review: 6,
}

/** Prototype: factory-floor.html:396. */
export const PRI_RANK: Record<TicketPriority, number> = {
  urgent: 0,
  high: 1,
  med: 2,
  low: 3,
}

// ---------- canonical session identity ----------

/**
 * Where a session was observed. 'this-mac' sightings (a local tab OR the local sweep)
 * are 'local'; only a genuinely different host is 'remote'. Cloud tasks are 'cloud'.
 */
type SessionOrigin = 'local' | 'remote' | 'cloud'

/**
 * Raw identity signals for one observed session. Shaped to fit what the adapter has:
 * local terminals carry a lazily-populated CLI UUID + a terminal id; the remote sweep
 * carries a host + a session id (UUID or file stem); cloud carries an opaque task id.
 */
export interface SessionKeyInput {
  origin: SessionOrigin
  host?: string | null
  /** The CLI session UUID — collision-free within an agent type, but populated lazily. */
  cliSessionUuid?: string | null
  /** Remote fallback: the session file's stem, used when the UUID is not yet known. */
  sessionFileStem?: string | null
  /** Provisional (pre-UUID) identity sources, in precedence order. */
  terminalId?: string | null
  cloudTaskId?: string | null
  agentId?: string | null
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * The one "what is this session doing" line, used by BOTH the card and the detail
 * rail so no surface re-derives it or renders blank. Fallback chain: the ORIGINAL
 * task (prompt / first user message — the durable anchor), then the CLI summary /
 * live preview, then the last response, then the worktree slug or branch (a task
 * label when there's no narrative — e.g. "headless-secrets-shadow"). Returns the
 * explicit "No topic" placeholder when the agent carries no task signal at all.
 *
 * prompt is preferred first so a card anchors to what the agent was ASKED to do, not
 * whatever it last said — the last message drifts as work progresses, the task doesn't.
 */
/** Sentinel for a session with no prompt, summary, response, worktree or branch.
 * Exported so callers can suppress it rather than render it as a topic. */
export const NO_TOPIC = 'No topic'

export function sessionTaskLine(a: FloorAgent): string {
  return firstNonEmpty(a.prompt, a.summary, a.resp, a.worktreeSlug, a.branch) ?? NO_TOPIC
}

/** Background/headless runs stay available through an explicit toggle, but do
 * not crowd out interactive operator work on the floor by default. */
export function visibleFloorAgents(agents: FloorAgent[], showBackground: boolean): FloorAgent[] {
  return showBackground ? agents : agents.filter((a) => a.context !== 'headless')
}

/**
 * Fold resumable PREVIOUS (index) rows into the LIVE roster for the Sessions
 * surface, deduped by `sessionId` — a LIVE row always wins over an index row for
 * the same session (PHNX-3593). A previous row that IS currently live is therefore
 * dropped (the live one carries real activity); genuinely-ended sessions survive as
 * the Previous·resumable band. Rows with no sessionId can't be keyed, so they pass
 * through untouched. Pure so it is unit-tested; this merge feeds ONLY the Sessions
 * surface — the live feed/needs-you must never see index rows.
 */
export function mergeSessionAgents(live: FloorAgent[], previous: FloorAgent[]): FloorAgent[] {
  const liveIds = new Set(live.map((a) => a.sessionId).filter((id): id is string => !!id))
  const seen = new Set<string>()
  const extra: FloorAgent[] = []
  for (const a of previous) {
    if (a.sessionId) {
      if (liveIds.has(a.sessionId) || seen.has(a.sessionId)) continue
      seen.add(a.sessionId)
    }
    extra.push(a)
  }
  return [...live, ...extra]
}

/**
 * Partition every visible card exactly once so rendered sections and counts consume
 * the same collections. The buckets are in ATTENTION order — needs > idle > active >
 * done — because the floor ranks by progress, not by liveness (root AGENTS.md
 * "Purpose").
 *
 * `idle` is its own bucket and is never folded into `active`: an idle session is
 * unfinished work that has stopped progressing, the state most likely to be silently
 * abandoned, while a running one needs nothing from the operator. The CLI maps a
 * finished agent to phase 'done', so every agent landing in `idle` here is unfinished.
 */
export function partitionFloorAgents(agents: FloorAgent[]): {
  needs: FloorAgent[]
  idle: FloorAgent[]
  active: FloorAgent[]
  done: FloorAgent[]
} {
  const needs: FloorAgent[] = []
  const idle: FloorAgent[] = []
  const active: FloorAgent[] = []
  const done: FloorAgent[] = []
  for (const agent of agents) {
    if (agent.needs) needs.push(agent)
    else if (agent.phase === 'done') done.push(agent)
    else if (agent.phase === 'idle') idle.push(agent)
    else active.push(agent)
  }
  return { needs, idle, active, done }
}

/**
 * Persist-last-non-empty for a session's todo checklist. The tool-call window that
 * `latestTodos` parses is capped (session.summary.ts keeps only the last 24 calls),
 * so once >24 tool calls follow the last TodoWrite the checklist silently vanishes.
 * Callers thread through the last KNOWN non-empty set (remembered per session id) and
 * fall back to it when the fresh parse is empty — so a still-running agent keeps
 * showing its progress instead of dropping to a blank card. Pure so it's unit-tested.
 */
export function todosWithFallback(fresh: TodoItem[], remembered: TodoItem[] | undefined): TodoItem[] {
  if (fresh.length > 0) return fresh
  return remembered && remembered.length > 0 ? remembered : []
}

/**
 * One canonical identity per session, stable across the origins that report it. Mirrors
 * 02-floor-event-stream.md Decision 1:
 *   remote -> `${host}:${cliSessionUuid ?? sessionFileStem}`
 *   else   -> cliSessionUuid ?? `provisional:${terminalId | cloudTaskId | agentId}`
 * Prefer the CLI UUID (so a session seen as both a local tab and the local sweep collapses
 * to one key); namespace remote by host so the same UUID on two hosts does not collide;
 * fall back to a provisional key while the UUID is unknown and re-key once it arrives.
 */
export function sessionKey(input: SessionKeyInput): string {
  const uuid = firstNonEmpty(input.cliSessionUuid)
  const provisionalId = firstNonEmpty(input.terminalId, input.cloudTaskId, input.agentId) ?? 'unknown'
  if (input.origin === 'remote') {
    const host = firstNonEmpty(input.host) ?? 'unknown-host'
    const id = uuid ?? firstNonEmpty(input.sessionFileStem) ?? provisionalId
    return `${host}:${id}`
  }
  if (uuid) return uuid
  return `provisional:${provisionalId}`
}

// ---------- pure logic (LOGIC fills bodies; signatures are the contract) ----------

/**
 * A straight one-to-one rename of the CLI-reported session status into a FloorPhase,
 * for a LOCAL editor tab the stream has not indexed yet (the transient window before a
 * projection arrives). It invents nothing — no waitingForInput/PR/heartbeat heuristics:
 * needs-you and the awaiting-input/stall states all ride the CLI attention stream, and
 * an indexed session takes its phase straight from `RemotePhase`. Once the stream
 * indexes the tab, the projected path replaces this entirely.
 */
export function phaseFromStatus(status: 'running' | 'completed' | 'failed' | 'stopped' | 'idle'): FloorPhase {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'running':
      return 'running'
    // 'stopped' and 'idle' are both a quiet, unfinished tab.
    default:
      return 'idle'
  }
}

/** Minimal shape of a parsed tool call the checklist reads (name + raw input). */
export interface ToolCallLike {
  name: string
  input?: unknown
}

/**
 * The agent's current task checklist: the todos of its MOST RECENT TodoWrite call.
 * A later TodoWrite fully supersedes earlier ones (the agent rewrites the whole
 * list each time), so we take the newest, not a merge. `recentToolCalls` is stored
 * NEWEST-FIRST (session.summary.ts unshifts each call), so we scan from index 0 and
 * return the FIRST TodoWrite. Returns [] when there is no TodoWrite or the input is
 * malformed. (Caveat: recentToolCalls is capped at 24, so a checklist drops off once
 * >24 tool calls follow the last TodoWrite.) Pure so it's unit-tested.
 */
export function latestTodos(toolCalls: ReadonlyArray<ToolCallLike> | undefined): TodoItem[] {
  if (!toolCalls || toolCalls.length === 0) return []
  for (let i = 0; i < toolCalls.length; i++) {
    if (toolCalls[i]?.name !== 'TodoWrite') continue
    const input = toolCalls[i]?.input
    const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).todos : undefined
    if (!Array.isArray(raw)) return []
    const todos: TodoItem[] = []
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue
      const rec = t as Record<string, unknown>
      const content =
        typeof rec.content === 'string' ? rec.content :
        typeof rec.activeForm === 'string' ? rec.activeForm : ''
      if (!content) continue
      const status: TodoStatus =
        rec.status === 'completed' || rec.status === 'in_progress' ? rec.status : 'pending'
      todos.push({ content, status })
    }
    return todos
  }
  return []
}

/** completed / total tally for a checklist (total 0 when empty). */
export function todoProgress(todos: ReadonlyArray<TodoItem>): { done: number; total: number } {
  return { done: todos.filter((t) => t.status === 'completed').length, total: todos.length }
}

/**
 * Deliverable key for one agent: ticket > PR > worktree slug > Unassigned.
 * Mirrors CLI `deriveOutcome` so Fleet and `agents feed` group the same way.
 */
function outcomeLabel(a: Pick<FloorAgent, 'ticket' | 'pr' | 'worktreeSlug'>): string {
  if (a.ticket) return a.ticket
  if (a.pr) {
    const n = a.pr.replace(/^#/, '')
    return a.pr.startsWith('PR') ? a.pr : `PR#${n}`
  }
  if (a.worktreeSlug) return a.worktreeSlug
  return 'Unassigned'
}

const LINEAR_ID_RE = /\b([A-Z][A-Z0-9]*-\d+)\b/
const LINEAR_URL_ID_RE = /^https?:\/\/(?:www\.)?linear\.app\/\S*?\/issue\/([A-Z][A-Z0-9]*-\d+)\b/i

/** Display label for a Linear issue ref or URL. */
export function linearIssueLabel(ref: string): string {
  const fromUrl = ref.match(LINEAR_URL_ID_RE)?.[1]
  if (fromUrl) return fromUrl.toUpperCase()
  const fromText = ref.match(LINEAR_ID_RE)?.[1]
  return fromText ?? ref
}

/** External URL for a Linear issue ref or URL. Returns null for non-Linear refs. */
export function linearIssueUrl(ref: string | null | undefined): string | null {
  if (!ref) return null
  const trimmed = ref.trim()
  if (!trimmed) return null
  const fromUrl = trimmed.match(LINEAR_URL_ID_RE)
  if (fromUrl) return trimmed
  const id = trimmed.match(LINEAR_ID_RE)?.[1]
  return id ? `https://linear.app/issue/${encodeURIComponent(id)}` : null
}

/** Group agents by the chosen dimension. Prototype groupKey: factory-floor.html:412. */
export function groupAgents(agents: FloorAgent[], by: FloorGroupBy): Map<string, FloorAgent[]> {
  // Coalesce empty keys to a human label (same rule as groupTickets) so a Floor
  // group header is never blank. Host groups by its DISPLAY label so 'this-mac'
  // collapses onto the real device name, matching the HOSTS sidebar.
  const accessor: Record<FloorGroupBy, (a: FloorAgent) => string> = {
    outcome: (a) => outcomeLabel(a),
    host: (a) => (a.hostLabel ?? a.host) || 'Unknown host',
    // Same word the Sessions surface uses for the same state (PHNX-3796) — one
    // concept, one label, rather than 'Unlabeled' here and 'Unassigned' there.
    project: (a) => a.project || UNASSIGNED_LABEL,
    status: (a) => a.phase,
    agent: (a) => a.abbr,
  }
  const get = accessor[by]
  const groups = new Map<string, FloorAgent[]>()
  for (const a of agents) {
    const key = get(a)
    const bucket = groups.get(key)
    if (bucket) bucket.push(a)
    else groups.set(key, [a])
  }
  return groups
}

/** Attention priority of one agent: its CLI attention kind's rank, or last when the
 *  CLI raised no attention. The needs-you surface sorts on this alone. */
function attentionRank(a: Pick<FloorAgent, 'attentionKind'>): number {
  return a.attentionKind ? ATTENTION_KIND_RANK[a.attentionKind] : Number.MAX_SAFE_INTEGER
}

/**
 * Order needs-you rows by the CLI attention kind (question → permission → plan_review →
 * declared → failure → stall → review), tie-broken most-stuck-first (oldest activity)
 * so the highest-abandonment-risk row leads within a kind, then by id for stability.
 * The whole order comes from the CLI attention rows — the extension classifies nothing.
 */
export function sortByAttention(agents: FloorAgent[]): FloorAgent[] {
  return [...agents].sort((a, b) => {
    const rank = attentionRank(a) - attentionRank(b)
    if (rank !== 0) return rank
    const stuck = (a.lastActivityMs || 0) - (b.lastActivityMs || 0)
    if (stuck !== 0) return stuck
    return a.id.localeCompare(b.id)
  })
}

/** Sort within a group. 'needs' uses the phase-progress rank. Prototype: agentsCenter():624-630. */
export function sortAgents(agents: FloorAgent[], by: FloorSort): FloorAgent[] {
  const arr = [...agents]
  switch (by) {
    case 'needs':
      return arr.sort((a, b) => PHASE_PROGRESS_RANK[a.phase] - PHASE_PROGRESS_RANK[b.phase])
    case 'recent':
      return arr.sort((a, b) => sinceSeconds(a.since) - sinceSeconds(b.since))
    case 'tok':
      return arr.sort((a, b) => b.tok - a.tok)
    case 'name':
      return arr.sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** Parse a human elapsed label ("2s", "14m", "3h", "1d") to seconds for recency sort. */
function sinceSeconds(since: string): number {
  const m = /^(\d+)\s*([smhd])/.exec(since.trim())
  if (!m) return Number.MAX_SAFE_INTEGER
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
  return Number(m[1]) * unit[m[2]]
}

/**
 * Cluster waiting agents by StructuredQuestion.clusterKey so N agents asking the
 * same thing collapse into one batch-triage card. Prototype: byQ in agentsCenter()
 * (factory-floor.html:629) + clusterCard() (598-607). Singletons return as [agent].
 */
export function clusterByQuestion(waiting: FloorAgent[]): FloorAgent[][] {
  const byKey = new Map<string, FloorAgent[]>()
  for (const a of waiting) {
    // Agents without a parsed question can never batch with another; key by id.
    const key = a.question ? a.question.clusterKey : a.id
    const bucket = byKey.get(key)
    if (bucket) bucket.push(a)
    else byKey.set(key, [a])
  }
  return [...byKey.values()]
}

/** UnifiedTask -> FloorTicket. status: todo|in_progress|done -> todo|in-progress|done;
 *  priority: 'medium' -> 'med'; source: 'linear'->'LN','github'->'GH'. */
export function toFloorTicket(task: UnifiedTask): FloorTicket {
  return {
    id: task.metadata.identifier ?? task.id,
    title: task.title,
    // The formal project as defined in the source: Linear's `project` (from
    // linear-cli), else the repo scope for GitHub-sourced tickets. Empty when the
    // source declares neither — grouping renders that as 'Unlabeled' (never blank).
    project: task.metadata.project ?? task.metadata.repo ?? '',
    source: task.source === 'linear' ? 'LN' : 'GH',
    pri: toTicketPriority(task.priority),
    status: toTicketStatus(task.status),
    desc: task.description ?? '',
    labels: task.metadata.labels ?? [],
    owner: task.metadata.assignee ?? '',
  }
}

function toTicketPriority(p: UnifiedTask['priority']): TicketPriority {
  switch (p) {
    case 'urgent':
      return 'urgent'
    case 'high':
      return 'high'
    case 'medium':
      return 'med'
    case 'low':
      return 'low'
    default:
      return 'med'
  }
}

function toTicketStatus(s: UnifiedTask['status']): TicketStatus {
  switch (s) {
    case 'in_progress':
      return 'in-progress'
    case 'done':
      return 'done'
    default:
      return 'todo'
  }
}

export function groupTickets(tickets: FloorTicket[], by: TicketGroupBy): Map<string, FloorTicket[]> {
  // Every accessor coalesces an empty key to a human label so a group header is
  // never blank (the "· 76" bug) — one generic rule across all axes.
  const accessor: Record<TicketGroupBy, (t: FloorTicket) => string> = {
    project: (t) => t.project || 'Unlabeled',
    priority: (t) => t.pri,
    source: (t) => (t.source === 'LN' ? 'Linear' : 'GitHub'),
    status: (t) => t.status.replace('-', ' '),
    owner: (t) => t.owner || 'Unassigned',
  }
  const get = accessor[by]
  const groups = new Map<string, FloorTicket[]>()
  for (const t of tickets) {
    const key = get(t)
    const bucket = groups.get(key)
    if (bucket) bucket.push(t)
    else groups.set(key, [t])
  }
  return groups
}

/**
 * Agents grouped by the ticket they carry ("RUSH-812" / "#412" — the same
 * identifier space as FloorTicket.id). The backlog joins on this to show who is
 * already working a ticket; all phases are kept (a done agent with an open PR is
 * still the ticket's worker) so the UI can style by phase.
 */
export function ticketWorkers(agents: FloorAgent[]): Record<string, FloorAgent[]> {
  const by: Record<string, FloorAgent[]> = {}
  for (const a of agents) {
    if (!a.ticket) continue
    ;(by[a.ticket] ??= []).push(a)
  }
  return by
}

/** Per-project activity rollup — what the rail flyout and Projects pane summarize. */
export interface ProjectRollup {
  /** Agents currently on the project. */
  run: number
  /** Of those, agents waiting on the user. */
  wait: number
  /** Open (non-done) backlog tickets for the project. */
  backlog: number
  /** Distinct open-PR URLs carried by the project's agents. */
  prs: number
  /** Most recent agent activity (epoch ms); 0 when unknown/idle. */
  lastActivityMs: number
}

/**
 * Derive every project's rollup from the live feed + backlog in one pass. Keyed by
 * project name (the same key ManagedProject.name / FloorTicket.project use), so a
 * consumer can look up curated and discovered projects alike.
 */
export function projectRollups(agents: FloorAgent[], tickets: FloorTicket[]): Record<string, ProjectRollup> {
  const by: Record<string, ProjectRollup> = {}
  const prSets = new Map<string, Set<string>>()
  const get = (name: string): ProjectRollup => (by[name] ??= { run: 0, wait: 0, backlog: 0, prs: 0, lastActivityMs: 0 })
  for (const a of agents) {
    const r = get(a.project)
    r.run += 1
    if (a.needs) r.wait += 1
    if (a.lastActivityMs > r.lastActivityMs) r.lastActivityMs = a.lastActivityMs
    if (a.prUrl) {
      const set = prSets.get(a.project) ?? new Set<string>()
      set.add(a.prUrl)
      prSets.set(a.project, set)
    }
  }
  for (const t of tickets) {
    if (t.status !== 'done') get(t.project).backlog += 1
  }
  for (const [name, set] of prSets) get(name).prs = set.size
  return by
}

export function sortTickets(tickets: FloorTicket[], by: TicketSort): FloorTicket[] {
  const arr = [...tickets]
  if (by === 'priority') return arr.sort((a, b) => PRI_RANK[a.pri] - PRI_RANK[b.pri])
  return arr.sort((a, b) => a.id.localeCompare(b.id))
}
