// Cross-host session rows — pure types + normalize.
//
// This module has NO VS Code imports so it is unit-testable in isolation. It
// turns rows from `agents feed watch --json` into a normalized RemoteSession,
// the cross-host analog of a local agent.

import { resolveProject, normalizeHost, worktreeSlugOf } from '../shared/project';
import { isHarnessEnvelope } from './harnessEnvelope';
import { normalizePrStatus, type RemotePrStatus } from './prStatus';
import type { PendingItem, SessionPending } from '../shared/sessionState';

export { resolveProject, normalizeHost };

/** The coarse lifecycle the panels sort and color by. */
export type RemotePhase = 'running' | 'idle' | 'waiting' | 'failed' | 'done';

/** Why an agent handed control back — mirrors the CLI AwaitingReason. */
type RemoteAwaitReason = 'question' | 'plan_review' | 'permission';

/** One discrete choice the agent offered (mirror of the CLI QuestionOption). */
interface RemoteQuestionOption {
  label: string;
  description: string;
  /** Selection keystroke for a TUI prompt ('1' … or 'esc'); '' for a free-text choice. */
  key: string;
}

/**
 * The structured decision an agent is waiting on, carried verbatim from the CLI
 * state engine (`agents feed watch --json` → ActiveSession.question). This
 * is the load-bearing "what does it want from me" signal the NEEDS-YOU card renders
 * — the UI no longer has to regex it back out of a truncated preview line.
 */
export interface RemoteQuestion {
  text: string;
  reason: RemoteAwaitReason;
  options: RemoteQuestionOption[];
}

interface RemoteAttention {
  key: string;
  sessionId: string;
  kind: 'question' | 'permission' | 'plan_review' | 'declared' | 'failure' | 'stall' | 'review';
  source: 'hook' | 'declared' | 'lifecycle' | 'heuristic' | 'system';
  state: 'open' | 'answered' | 'consumed' | 'continued' | 'resolved';
  openedAt: string;
  fingerprint: string;
  question?: { text?: string; header?: string; options?: Array<{ label?: string; description?: string; id?: string; deliveryKey?: string }> };
  /** The answers `agents feed answer --choice <id>` takes. */
  choices?: Array<{ id: string; label: string; description?: string; deliveryKey?: string }>;
  /** How soon it needs a person, and why, as agents-cli computed it (absent on an older CLI). */
  urgency?: 'urgent' | 'high' | 'normal' | 'low';
  urgencyReason?: string;
}

interface RemotePullRequest {
  url: string; number: number; title: string; state: 'open' | 'merged' | 'closed'; isDraft: boolean;
  ci: 'passed' | 'failed' | 'running' | null; review: 'approved' | 'changes_requested' | 'review_required' | null;
  mergeable: 'mergeable' | 'conflicting' | 'unknown'; readyToMerge: boolean;
}

export interface RemoteAttachment {
  path: string;
  label: string;
  mediaType: string;
  sizeBytes?: number;
  thumbnailUri?: string;
}

// normalizeHost now lives in src/shared/project.ts (imported + re-exported above).

/**
 * Decide which HOSTS bucket a session belongs to. A bare `agents ps
 * --json` fans out over the whole fleet, so a single query answers for
 * many machines — each row carries its own `machine` id. Bucket by that id, NOT
 * by the host we happened to query (`fallbackHost`), or every remote session
 * collapses onto the querying machine. The local machine's own id maps to
 * `localLabel` ('this-mac') so the webview's `host === 'this-mac'` routing keeps
 * working. Rows with no machine (cloud) fall back to the querying host.
 */
export function resolveSessionHost(
  rawMachine: string | undefined,
  fallbackHost: string,
  localMachineId: string,
  localLabel: string,
): string {
  const norm = normalizeHost(rawMachine || '');
  if (!norm) return fallbackHost;
  return norm === localMachineId ? localLabel : norm;
}

/**
 * Does `host` name THIS machine? The inverse of `resolveSessionHost`: that
 * function folds the local machine id to `localLabel`, so every local row that
 * comes back off the stream carries one of a small set of local identities —
 * the webview sentinel ('this-mac'), the CLI's machine id, this box's real
 * hostname (bare or FQDN), 'localhost', or nothing at all.
 *
 * Every one of them is a value that must NEVER reach a `--device` argument: the
 * CLI resolves `--device this-mac` against the device registry, finds nothing,
 * and the caller fails silently. Callers ask this instead of re-listing the
 * identities inline — that hand-copied list is how `focusSubject` shipped
 * passing 'this-mac' as a device (PHNX-3939 review).
 */
export function isLocalHostIdentity(
  host: string | undefined | null,
  localHost: string,
  localMachineId: string,
  localLabel: string,
): boolean {
  const h = (host ?? '').trim();
  if (!h) return true;
  if (h === localLabel || h === 'localhost') return true;
  if (h === localHost || h === localHost.split('.')[0]) return true;
  return normalizeHost(h) === localMachineId;
}

/** Minimal device-registry shape the dialable-scope filter reads. */
export interface RosterDeviceLite {
  name: string;
  online?: boolean;
  platform?: string;
}

/**
 * Platforms the CLI feed fan-out actually dials — POSIX + Windows. A Tailscale
 * peer whose OS is unrecognized (iPad / phone / empty) is registered as
 * `platform: 'unknown'`, which the CLI skips. Mirrors the set in the CLI's
 * `watchFleetFeed` so the two stay in lockstep.
 */
const DIALABLE_PEER_PLATFORMS: ReadonlySet<string> = new Set(['windows', 'linux', 'macos']);

/**
 * The peer scopes the elected CLI feed will actually dial and therefore resolve
 * — online devices on a dialable platform, excluding the local machine —
 * normalized the same way `watchFleetFeed` scopes a peer (`normalizeHost(name)`).
 *
 * The follower-degraded gate (PHNX-2735) waits on exactly these scopes: waiting
 * on a device the stream will never report for (an approved iPad reads `online`
 * but is never dialed, so it emits neither a `reset` nor a `scope unavailable`)
 * would leave the panels stuck at "connecting" forever. This filter must
 * match the CLI's own peer selection, or the two drift and re-open that hang.
 */
export function dialablePeerScopes(devices: readonly RosterDeviceLite[], localMachineId: string): string[] {
  const local = normalizeHost(localMachineId);
  return devices
    .filter((device) => device.online === true
      && DIALABLE_PEER_PLATFORMS.has(device.platform ?? '')
      && normalizeHost(device.name) !== local)
    .map((device) => normalizeHost(device.name));
}

/**
 * The cross-host analog of a local agent. One record per active session on one
 * machine. `host` is the machine we queried ('this-mac' locally, an ssh/tailscale
 * name remotely) — never the raw `host` field of the CLI payload, which is the
 * terminal-emulator name (e.g. "ghostty").
 */
/** One live checklist item from the CLI's TodoProgress (RUSH-1380). */
interface RemoteTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present-continuous label for the active step (drives the live verb). */
  activeForm?: string;
}

/** One progress checkpoint from the CLI summarizer: a short line + its ISO timestamp. */
export interface RemoteCheckpoint {
  text: string;
  at: string;
}

/**
 * The user's own latest genuine request, tidied by the CLI (PHNX-3939 follow-up).
 * NEVER a rewrite: `text` is the user's prose with whitespace collapsed and the
 * attachment/pasted-terminal noise lifted out into `attachments`/`pastedLines`,
 * and `headline` is its first sentence. Absent on an older CLI — the Request card
 * falls back to `userPromptClean`, then `topic`.
 */
interface RemoteRequestAttachment {
  kind: 'image' | 'file' | 'dir';
  name: string;
}

export interface RemoteRequest {
  text: string;
  headline: string;
  kind: 'text' | 'skill' | 'command' | 'image';
  /** '/continue 8231082e', '$ make test' — the wrapper the turn arrived in. */
  command?: string;
  attachments: RemoteRequestAttachment[];
  /** Lines of the raw turn classified as pasted terminal echo. */
  pastedLines: number;
  /** How many genuine user turns this session has had. */
  turns: number;
  /** The session this one continues, when the request was a /continue. */
  continues?: { id: string; label?: string };
}

/**
 * One narration-anchored step: the agent's own sentence plus the tool calls that
 * ran under it, folded by the CLI daemon. `source` says where the headline came
 * from, so a `derived` step (a harness with no narration) can render muted
 * instead of pretending the agent said it.
 */
interface RemoteTimelineStep {
  text: string;
  /** ISO timestamp. A numeric epoch on the wire is normalized to ISO here. */
  at: string;
  endedAt?: string;
  source: 'narration' | 'thinking' | 'derived' | 'user';
  tools: number;
  /** Commands that RAN and failed. */
  failed: number;
  /** Calls a permission rule / hook / abort stopped before they ran. */
  blocked: number;
  /** Tool count by verb class (read, edit, run, git, test, browser, agent, other). */
  mix?: Record<string, number>;
  /** Milestones the CLI recognized under this step ("worktree created", "PR opened"). */
  marks?: string[];
  /** The newest step while the session is working — renders the amber now-line. */
  live?: boolean;
  /** The harness's own label for the tool running right now, on the live step. */
  now?: string;
}

/**
 * The bounded step list the row carries: the last few steps in full plus one
 * counter for everything older. `state` is honest about harnesses the CLI cannot
 * fold — 'unavailable' with a `reason` beats an empty card that reads as "the
 * agent did nothing".
 */
export interface RemoteTimeline {
  /** Newest LAST, as the CLI emits it. The card reverses for display. */
  steps: RemoteTimelineStep[];
  earlier: { steps: number; tools: number; failed: number };
  tools: number;
  failed: number;
  spanMs: number;
  state: 'ready' | 'partial' | 'unavailable';
  reason?: string;
}

/** One file the session created, modified or deleted. */
interface RemoteFileChange {
  path: string;
  op: 'created' | 'modified' | 'deleted';
  edits: number;
  at: string;
}

/**
 * The files the session touched. `source: 'harness'` means the harness recorded
 * them itself (Codex FileChange, OpenCode patch, Claude file-history); 'tools'
 * means they were derived from Edit/Write calls.
 */
export interface RemoteFiles {
  changes: RemoteFileChange[];
  total: number;
  source: 'harness' | 'tools';
}

export interface RemoteSessionArtifact {
  path: string;
  basename: string;
  bucket: 'artifacts' | 'plans' | 'reports' | 'docs';
  /** Human title from the artifact's `.artifact.json` sidecar, when it has one. */
  title?: string;
  /** When the session last wrote it (or the file's mtime), for newest-first sorting. */
  editedAtMs?: number;
  /** For a rendered page the row also lists the source of: that source's file name. */
  renderedFrom?: string;
}

/** One failed or policy-blocked tool call, newest last (CLI `failures[]`). */
export interface RemoteFailure {
  atMs: number;
  tool: string;
  summary: string;
  error: string;
  blocked: boolean;
}

/** Whole-session activity histogram: 48 equal buckets over [startMs, endMs]. */
export interface RemoteActivity {
  startMs: number;
  endMs: number;
  buckets: { tools: number; failed: number; blocked: number }[];
  userAtMs: number[];
}

/** One genuine user turn, oldest first (CLI `userTurns[]`). */
export interface RemoteUserTurn {
  atMs: number;
  text: string;
  images: number;
}

/** One Claude subagent of the session (CLI `subagents[]`). */
export interface RemoteSubagent {
  id: string;
  agentType: string;
  description: string;
  status: 'running' | 'done' | 'failed';
  startedAtMs?: number;
  endedAtMs?: number;
  toolCount: number;
  resultExcerpt?: string;
  transcriptPath: string;
  /** The model the subagent ran on, when the CLI row reports it. */
  model?: string;
  /** What the subagent was asked (its first turn, clamped by the CLI). */
  prompt?: string;
}

/** One tab showing a session, as the CLI's projection names it. */
interface RemoteObserver {
  device: string;
  viewingIn: string;
  workspaceDir: string;
}

export interface RemoteSession {
  host: string;
  sessionId: string;
  /**
   * `AGENT_TERMINAL_ID` from the CLI active payload when present — how an AGI EXT
   * tab re-identifies its own session on a remote device without inventing ids.
   * '' when the launch did not inherit a terminal id.
   */
  terminalId?: string;
  agentType: string;
  cwd: string;
  project: string;
  /** The registered agents project this row belongs to (CLI `confirmedProject`), or
   *  null when its cwd is in no defined project. The Project sidebar filters on it. */
  confirmedProject: string | null;
  phase: RemotePhase;
  /** The RAW CLI lifecycle status word, lowercased ('running' | 'idle' |
   *  'orphaned' | 'crashed' | 'abandoned' | 'waiting' | 'closed' | ...), carried
   *  verbatim because `phase` collapses it (orphaned/crashed both map to a phase
   *  that can't be told apart). The Sessions surface reads this to route a
   *  detached-but-alive session into the "needs reconnecting" band. '' when the
   *  CLI supplied no status. */
  liveStatus: string;
  /** Live now-line for the card (the CLI's `preview` while the agent is working). */
  activity: string;
  /** Output-token throughput from the CLI payload (`ActiveSession.tokPerSec`), rounded. */
  tokPerSec: number;
  /** Agent-created plans, reports, visuals, and other durable documents. */
  artifacts: RemoteSessionArtifact[];
  /** Plan file singled out by the CLI preview digest. */
  planFile: string;
  /** Number of subagents launched by this session. */
  subAgentCount: number;
  waitingForInput: boolean;
  /** Per-session rate/usage limit from the CLI transcript (RUSH-1523). */
  rateLimited: boolean;
  /** Why the agent handed control back ('question' | 'plan_review' | 'permission'),
   *  from the CLI payload. '' when the session isn't waiting. */
  awaitingReason: string;
  lastResponse: string;
  /** The structured decision the agent is waiting on (question/plan/permission +
   *  options), from the CLI state engine. null when the CLI supplied none — the UI
   *  then falls back to parsing lastResponse for options. */
  question: RemoteQuestion | null;
  attention?: RemoteAttention;
  pullRequest?: RemotePullRequest;
  /** The session's PR as the feed reports it (state, review, mergeable, checks), absent without one. */
  prStatus?: RemotePrStatus;
  /** Last few assistant turns (most-recent last), one line each — panel context. [] when none. */
  tail: string[];
  /** Live plan checklist from the CLI's most recent `TodoWrite` (RUSH-1380). Lets the
   *  panels show an N/M pill + checklist for remote / device-dispatched agents
   *  that have no local tool-call stream. Absent when the session wrote no todo list. */
  todos?: RemoteTodoItem[];
  /** Clean 1–2 line goal distilled by the CLI summarizer from the raw first request
   *  (PHNX-3939). The sidebar shows this as ◈ Goal instead of the rambling request.
   *  Absent on an older CLI — the panel falls back to `topic`. */
  goal?: string;
  /** Live progress checkpoints from the CLI summarizer (most-recent last). [] when none. */
  checkpoints?: RemoteCheckpoint[];
  /** The CLI summarizer's always-on checklist — same item shape as `todos`, but a
   *  separate signal (the distilled plan, not the live TodoWrite). Absent until ready. */
  summaryChecklist?: RemoteTodoItem[];
  /** Summarizer lifecycle for the checklist's always-on empty state:
   *  'pending' → "summarizing…", 'ready'/'skipped' → "No checklist yet". Absent on an
   *  older CLI. */
  summaryState?: 'pending' | 'ready' | 'skipped';
  /** The tidied latest genuine user turn. Absent on an older CLI — the Request
   *  card falls back to `userPromptClean`, then `topic`, and never invents text. */
  request?: RemoteRequest;
  /** The narration-anchored step list the daemon folds. Absent on an older CLI —
   *  the Timeline card falls back to `checkpoints`. */
  timeline?: RemoteTimeline;
  /** Files the session created/modified/deleted. Absent on an older CLI — the
   *  Files card renders nothing rather than guessing from the transcript. */
  files?: RemoteFiles;
  /** Attachment refs/names from the CLI payload, normalized for thumbnail + preview. */
  attachments: RemoteAttachment[];
  prUrl: string | null;
  ticket: string | null;
  /** Team name this session SPAWNED via `agents teams create/add`; '' when none. */
  spawnedTeam: string;
  branch: string;
  /** The `<slug>` under `.agents/worktrees/<slug>/` — the strong per-session
   *  disambiguator (two agents in sibling worktrees of one repo differ only here).
   *  '' when the session isn't in a worktree. */
  worktreeSlug: string;
  /** Absolute worktree path (== cwd for a worktree session), for the Reveal-worktree
   *  action. '' when not a worktree. */
  worktreePath: string;
  /** Elapsed ms since the session started, computed against the fetch clock so
   *  host clock skew does not distort it. */
  sinceMs: number;
  /** Host-reported wall-clock start (epoch ms). Carried verbatim so the UI can
   *  recompute freshness without trusting the remote clock for elapsed. */
  startedAtMs: number;
  /** Epoch ms of the most recent OBSERVED activity (the session file's last write).
   *  File-backed sessions get their mtime from the fan-out after enrichment; it is 0
   *  when there is no activity signal (a status-only remote/ssh session). NEVER
   *  backfilled from startedAtMs — start time is not activity. Consumers read it
   *  directly for freshness/heartbeat; an old value alone never hides a session. */
  lastActivityMs: number;
  /** The session's task/prompt line from the CLI payload (`topic`/`label`). Shown
   *  on the card when Tier-1 has no enriched activity yet (remote hosts). */
  topic: string;
  /** CLI-authored recap title. This is the row header, never the request body. */
  title: string;
  /** What the session was started with ("/continue …"), when the CLI reports it. */
  startedAs?: string;
  /** Model id of the latest assistant reply (e.g. `claude-opus-5-5`). Absent when unknown. */
  model?: string;
  /** Who the session runs for (the CLI's `owner`, an email); the sidebar shows their avatar on the request. */
  owner?: string;
  /** Failed and policy-blocked tool calls, newest last. Absent on an older CLI. */
  failures?: RemoteFailure[];
  /** Whole-session activity histogram for the seek bar. Absent on an older CLI. */
  activityHistogram?: RemoteActivity;
  /** The user's genuine turns, oldest first. Absent on an older CLI. */
  userTurns?: RemoteUserTurn[];
  /** Subagents this session ran. Absent on an older CLI. */
  subagents?: RemoteSubagent[];
  /** Background work running now (subagents, background shells, monitors), from
   *  the feed's `pending`. Absent when nothing is pending or on an older CLI. An
   *  idle row with pending work is Waiting, not Your move (`sessionStateOf`). */
  pending?: SessionPending;
  /** Reasoning effort, when the CLI knows it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Fast mode (the harness's usage.speed is "fast"), when the CLI knows it. */
  fast?: boolean;
  /** Full genuine first user turn from the durable session index. Empty on an
   *  older CLI, where the UI labels its topic fallback as a summary. */
  firstUserMessage: string;
  /** User-set session label from the CLI payload. Kept separate from topic so UI
   *  card headers can prefer explicit names over inferred task lines. */
  label: string;
  /** The CLI record's `context` ('terminal' | 'cloud' | 'teams' | ...). Lets the
   *  webview treat cloud rows differently from terminal-backed agents. */
  context: string;
  /** Foreground/background presence from the CLI (`attached` | `background` |
   *  `parked`), absent when the session isn't on that axis (cloud/team/ad-hoc
   *  headless). Drives the detach/attach affordances. */
  presence?: string;
  /** Team name for `teams`-context sessions (`agents factory answer <team> <text>`
   *  is their reply channel). Empty otherwise. */
  teamName: string;
  /** OS pid of the live process (terminal context), 0 when unknown. */
  pid: number;
  /** Where the session is currently being viewed, pre-formatted by the CLI (e.g.
   *  "Codium tab 3", "Ghostty tab 2", "detached"). '' when the CLI supplies none. */
  viewingIn: string;
  /** The terminal app the process runs under (the CLI payload's raw `host`, e.g.
   *  "ghostty", "vscodium"), '' when unknown. Never the machine: that is `host`. */
  terminalApp: string;
  /** Tabs on any machine showing this session (`observerTerminals`): the device,
   *  the CLI's "Codium tab 3" words, and the workspace folder that tab's window has open. */
  observers: RemoteObserver[];
  /** Lifecycle state from the CLI picker join (`SessionPickerJsonRow.state` —
   *  the live ActiveSession status, or 'inactive' for a genuinely ended session).
   *  'inactive' is the load-bearing signal that a session is a resumable PREVIOUS
   *  row rather than a live one. '' when unknown (a raw live-roster row). */
  state?: string;
  /** Whether an ended/idle session can be resumed (`SessionPickerJsonRow.resumable`).
   *  A harness with no resume path (grok/droid/cursor/…) reports false. */
  resumable?: boolean;
  /** Canonical device label the session's transcript lives on
   *  (`SessionPickerJsonRow.sourceDevice`, e.g. 'zion', 'yosemite-s0'). '' when unknown. */
  sourceDevice?: string;
  /** Outcome metrics from either a live CLI row or a RECENT (historical) row.
   *  Undefined when the owning CLI cannot compute them. */
  durationMs?: number;
  tokenCount?: number;
}

/**
 * The subset of `agents feed watch --json` upsert records we consume. Every
 * field is optional because the payload shape varies by context (terminal /
 * teams / cloud). Unknown fields are ignored.
 */
export interface RawActiveSession {
  context?: string;
  presence?: string;
  kind?: string;
  /** The CLI's own project/repo word for the row. Only read when the row has no
   *  cwd to resolve (PHNX-3796) — for a cwd-bearing row the resolved cwd wins. */
  project?: string;
  confirmedProject?: string | null;
  pid?: number;
  sessionId?: string;
  cwd?: string;
  label?: string;
  topic?: string;
  title?: string;
  startedAs?: string;
  model?: string;
  owner?: string;
  failures?: unknown;
  activityHistogram?: unknown;
  userTurns?: unknown;
  subagents?: unknown;
  pending?: unknown;
  effort?: unknown;
  fast?: unknown;
  /** Compatibility task fields emitted by older/alternate session producers. */
  prompt?: string;
  firstUserMessage?: string;
  sessionFile?: string;
  startedAtMs?: number;
  /** Transcript last-write epoch (ms) stamped by the CLI — the real activity signal. */
  lastActivityMs?: number;
  status?: string;
  teamName?: string;
  agentId?: string;
  cloudTaskId?: string;
  cloudStatus?: string;
  branch?: string;
  prUrl?: string;
  /** Where the session is being viewed right now, pre-formatted by the CLI's
   *  client resolver (e.g. "Codium tab 3", "Ghostty tab 2", "detached"). */
  viewingIn?: string;
  /** The terminal-emulator name the process runs under ("ghostty"). */
  host?: string;
  observerTerminals?: unknown;
  /** The CLI emits these NESTED objects on `sessions watch --json` (agents-cli
   *  ActiveSession: preview / pr / worktree / ticket). Earlier this shape declared
   *  none of them, so normalizeActiveSession silently dropped the worktree slug, the
   *  live preview (activity line), the structured ticket id, and the real branch —
   *  which is why remote/worktree cards showed only "Edit <file>" + a status word. */
  preview?: string;
  /** Inferred live activity from the CLI state engine: 'working' | 'waiting_input'
   *  | 'idle'. The single source for the "is it doing something right now" signal —
   *  the extension no longer re-derives it from the transcript tail (issue #741). */
  activity?: string;
  /** Output-token throughput (tokens/sec, rolling 60s window) computed by the CLI.
   *  Absent when no transcript is resolvable or the agent reports no usage. */
  tokPerSec?: number;
  tokenCount?: number;
  durationMs?: number;
  artifacts?: unknown[];
  planFile?: string;
  subAgentCount?: number;
  /** Why the agent is waiting, when activity is waiting_input. */
  awaitingReason?: string | null;
  /** Structured decision the agent is waiting on (CLI ActiveSession.question). Present
   *  only for waiting_input sessions; the options are the real choices (AskUserQuestion
   *  options, or canonical Approve/Deny for plan/permission). */
  question?: { text?: string; reason?: string; options?: Array<{ label?: string; description?: string; key?: string } | null> } | null;
  attention?: RemoteAttention;
  /** Track B adapter seam for the CLI-projected PR signal. */
  pullRequest?: RemotePullRequest;
  /** Last few assistant turns (most-recent last), from the CLI state engine. */
  tail?: string[];
  /** Live plan progress (CLI ActiveSession.todos, RUSH-1380): the latest TodoWrite
   *  checklist + a done/total tally + the current step. Present only when the session
   *  has written a todo list. */
  todos?: {
    items?: Array<{ content?: string; status?: string; activeForm?: string } | null>;
    done?: number;
    total?: number;
    activeForm?: string;
  } | null;
  /** Clean 1–2 line goal for the session, distilled by the CLI summarizer from the
   *  raw first request (PHNX-3939). Absent on an older CLI — the UI falls back to topic. */
  goal?: string;
  /** Live progress checkpoints the CLI summarizer emits (most-recent last), each a
   *  short line + an ISO timestamp. Absent when the summarizer wrote none. */
  checkpoints?: Array<{ text?: string; at?: string } | null>;
  /** The CLI summarizer's always-on checklist (same item shape as `todos`), distinct
   *  from the live TodoWrite list. Absent until the summarizer produces one. */
  summaryChecklist?: {
    items?: Array<{ content?: string; status?: string; activeForm?: string } | null>;
  } | Array<{ content?: string; status?: string; activeForm?: string } | null> | null;
  /** Summarizer lifecycle: 'pending' (working on the digest), 'ready' (produced),
   *  'skipped' (nothing to summarize). Drives the always-on checklist's empty state. */
  summaryState?: string;
  /** Tidied latest genuine user turn (`SessionRequest`). The CLI never rewrites the
   *  user's words; it only lifts attachments and pasted terminal out of them. */
  request?: unknown;
  /** Narration-anchored fold (`SessionTimeline`): the last steps + an earlier counter. */
  timeline?: unknown;
  /** Files the session created/modified/deleted (`SessionFiles`). */
  files?: unknown;
  attachments?: unknown[];
  pr?: ({ url?: string; number?: number } & Record<string, unknown>) | null;
  worktree?: { slug?: string; path?: string; branch?: string } | null;
  ticket?: string | { id?: string; url?: string } | null;
  /** Team the session SPAWNED, from the CLI session scan. */
  spawnedTeam?: string;
  /** Per-session rate/usage limit from the CLI (RUSH-1523). */
  rateLimited?: boolean;
  /** Normalized device id the CLI attributes this session to (machineId() form,
   *  e.g. 'zion', 'yosemite-s0'). Present on every row of a fanned-out
   *  `sessions watch --json` — the load-bearing signal for which physical
   *  machine a session runs on. Absent for cloud rows (attributed to the querier). */
  machine?: string;
  /** Durable lifecycle fields are also present on the recoverable rows
   * folded into the canonical watch stream. */
  state?: string;
  previous?: boolean;
  resumable?: boolean;
  sourceDevice?: string;
  /**
   * AGI EXT / editor tab id (`AGENT_TERMINAL_ID`) when the launch inherited it.
   * Join key for "which session is MY tab running?" across local/`--device` runs.
   */
  terminalId?: string;
}

const TICKET_RE = /\b[A-Z][A-Z0-9]*-\d+\b/;

/**
 * Normalize the CLI's `ActiveSession.todos` items into the flat checklist the UI
 * renders (RUSH-1380). Drops contentless items; coerces an unknown status to
 * 'pending'. Returns [] when the payload carries no usable list.
 */
function normalizeTodos(raw: RawActiveSession['todos'] | RawActiveSession['summaryChecklist']): RemoteTodoItem[] {
  // The live `todos` payload nests items under `.items`; the summarizer's
  // `summaryChecklist` may arrive as a bare array. Accept either shape.
  const items = Array.isArray(raw) ? raw : raw?.items;
  if (!Array.isArray(items)) return [];
  const out: RemoteTodoItem[] = [];
  for (const it of items) {
    if (!it) continue;
    const content = asStr(it.content);
    if (!content) continue;
    const status: RemoteTodoItem['status'] =
      it.status === 'completed' || it.status === 'in_progress' ? it.status : 'pending';
    const activeForm = asStr(it.activeForm);
    out.push(activeForm ? { content, status, activeForm } : { content, status });
  }
  return out;
}

/**
 * Normalize the CLI summarizer's progress checkpoints (PHNX-3939) into the flat
 * list the sidebar renders. Drops textless entries; keeps the timestamp verbatim
 * ('' when absent). Returns [] when the payload carries no usable checkpoints.
 */
function normalizeCheckpoints(raw: RawActiveSession['checkpoints']): RemoteCheckpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: RemoteCheckpoint[] = [];
  for (const it of raw) {
    if (!it) continue;
    const text = asStr(it.text);
    if (!text) continue;
    out.push({ text, at: asStr(it.at) });
  }
  return out;
}

function normalizeSummaryState(raw: unknown): RemoteSession['summaryState'] {
  return raw === 'pending' || raw === 'ready' || raw === 'skipped' ? raw : undefined;
}

// ── Request / Timeline / Files (PHNX-3939 follow-up) ─────────────────────────
// Pure field copies off the stream row, bounded exactly the way `checkpoints`
// is. Nothing here fetches, parses a transcript, or invents a value: a field the
// CLI did not send comes back `undefined` and the card falls back or says so.

/** Row payload bounds. The mirror caps the row; this caps what reaches a webview. */
const REQUEST_TEXT_MAX = 2_000;
const REQUEST_HEADLINE_MAX = 200;
const REQUEST_ATTACHMENTS_MAX = 8;
const TIMELINE_STEPS_MAX = 8;
const STEP_TEXT_MAX = 200;
const STEP_NOW_MAX = 160;
const STEP_MARKS_MAX = 4;
const FILES_MAX = 8;

/**
 * A CLI timestamp as an ISO string. The contract says `at: string`, but a numeric
 * epoch is a plausible encoding and the renderer only ever `Date.parse`es it, so
 * accept both and normalize rather than dropping a step over its clock format.
 */
function asTimestamp(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return '';
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeRequestAttachments(raw: unknown): RemoteRequestAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: RemoteRequestAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as { kind?: unknown; name?: unknown };
    const name = asStr(value.name).trim();
    if (!name) continue;
    const kind: RemoteRequestAttachment['kind'] =
      value.kind === 'image' || value.kind === 'dir' ? value.kind : 'file';
    out.push({ kind, name });
    if (out.length >= REQUEST_ATTACHMENTS_MAX) break;
  }
  return out;
}

/**
 * Normalize `SessionRequest`. Returns undefined when the payload carries no
 * usable prose AND no command — an empty Request card must fall back to the
 * topic rather than render a blank headline.
 */
export function normalizeRequest(raw: unknown): RemoteRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as {
    text?: unknown; headline?: unknown; kind?: unknown; command?: unknown;
    attachments?: unknown; pastedLines?: unknown; turns?: unknown; continues?: unknown;
  };
  const text = clamp(asStr(value.text).trim(), REQUEST_TEXT_MAX);
  const command = asStr(value.command).trim();
  // The headline is the CLI's first sentence of `text`; fall back to the text or
  // the command so a command-only turn still reads as something.
  const headline = clamp(asStr(value.headline).trim() || text || command, REQUEST_HEADLINE_MAX);
  const attachments = normalizeRequestAttachments(value.attachments);
  if (!headline && !attachments.length) return undefined;
  const kind: RemoteRequest['kind'] =
    value.kind === 'skill' || value.kind === 'command' || value.kind === 'image' ? value.kind : 'text';
  const continuesRaw = value.continues && typeof value.continues === 'object'
    ? value.continues as { id?: unknown; label?: unknown }
    : undefined;
  const continuesId = asStr(continuesRaw?.id).trim();
  const continuesLabel = asStr(continuesRaw?.label).trim();
  return {
    text,
    headline,
    kind,
    ...(command ? { command } : {}),
    attachments,
    pastedLines: Math.max(0, Math.round(asNum(value.pastedLines))),
    turns: Math.max(0, Math.round(asNum(value.turns))),
    ...(continuesId
      ? { continues: { id: continuesId, ...(continuesLabel ? { label: continuesLabel } : {}) } }
      : {}),
  };
}

function normalizeStepMix(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const count = Math.round(asNum(value));
    if (key && count > 0) out[key] = count;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeStep(raw: unknown): RemoteTimelineStep | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as {
    text?: unknown; at?: unknown; endedAt?: unknown; source?: unknown;
    tools?: unknown; failed?: unknown; blocked?: unknown; mix?: unknown;
    marks?: unknown; live?: unknown; now?: unknown;
  };
  const text = clamp(asStr(value.text).trim(), STEP_TEXT_MAX);
  if (!text || isHarnessEnvelope(text)) return null;
  const source: RemoteTimelineStep['source'] =
    value.source === 'thinking' || value.source === 'derived' || value.source === 'user'
      ? value.source
      : 'narration';
  const mix = normalizeStepMix(value.mix);
  const marks = Array.isArray(value.marks)
    ? value.marks.map((m) => asStr(m).trim()).filter(Boolean).slice(0, STEP_MARKS_MAX)
    : [];
  const endedAt = asTimestamp(value.endedAt);
  const nowText = clamp(asStr(value.now).trim(), STEP_NOW_MAX);
  const now = isHarnessEnvelope(nowText) ? '' : nowText;
  return {
    text,
    at: asTimestamp(value.at),
    ...(endedAt ? { endedAt } : {}),
    source,
    tools: Math.max(0, Math.round(asNum(value.tools))),
    failed: Math.max(0, Math.round(asNum(value.failed))),
    blocked: Math.max(0, Math.round(asNum(value.blocked))),
    ...(mix ? { mix } : {}),
    ...(marks.length ? { marks } : {}),
    ...(value.live === true ? { live: true } : {}),
    ...(now ? { now } : {}),
  };
}

/**
 * Normalize `SessionTimeline`. Returns undefined when the CLI sent nothing —
 * the card then falls back to `checkpoints`. A payload that IS present but has
 * no steps is kept when it explains itself (`state`/`reason`), because
 * "unavailable for this harness" is a real answer the card must show.
 */
export function normalizeTimeline(raw: unknown): RemoteTimeline | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as {
    steps?: unknown; earlier?: unknown; tools?: unknown; failed?: unknown;
    spanMs?: unknown; state?: unknown; reason?: unknown;
  };
  const steps = (Array.isArray(value.steps) ? value.steps : [])
    .map(normalizeStep)
    .filter((s): s is RemoteTimelineStep => Boolean(s))
    .slice(-TIMELINE_STEPS_MAX);
  const state: RemoteTimeline['state'] =
    value.state === 'partial' || value.state === 'unavailable' ? value.state : 'ready';
  const reason = asStr(value.reason).trim();
  if (!steps.length && state === 'ready' && !reason) return undefined;
  const earlierRaw = value.earlier && typeof value.earlier === 'object'
    ? value.earlier as { steps?: unknown; tools?: unknown; failed?: unknown }
    : {};
  return {
    steps,
    earlier: {
      steps: Math.max(0, Math.round(asNum(earlierRaw.steps))),
      tools: Math.max(0, Math.round(asNum(earlierRaw.tools))),
      failed: Math.max(0, Math.round(asNum(earlierRaw.failed))),
    },
    tools: Math.max(0, Math.round(asNum(value.tools))),
    failed: Math.max(0, Math.round(asNum(value.failed))),
    spanMs: Math.max(0, Math.round(asNum(value.spanMs))),
    state,
    ...(reason ? { reason } : {}),
  };
}

/** Normalize `SessionFiles`. Returns undefined when no usable change survives. */
export function normalizeFiles(raw: unknown): RemoteFiles | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as { changes?: unknown; total?: unknown; source?: unknown };
  const changes: RemoteFileChange[] = [];
  for (const entry of Array.isArray(value.changes) ? value.changes : []) {
    if (!entry || typeof entry !== 'object') continue;
    const change = entry as { path?: unknown; op?: unknown; edits?: unknown; at?: unknown };
    const filePath = asStr(change.path).trim();
    if (!filePath) continue;
    const op: RemoteFileChange['op'] =
      change.op === 'created' || change.op === 'deleted' ? change.op : 'modified';
    changes.push({ path: filePath, op, edits: Math.max(0, Math.round(asNum(change.edits))), at: asTimestamp(change.at) });
    if (changes.length >= FILES_MAX) break;
  }
  if (!changes.length) return undefined;
  return {
    changes,
    total: Math.max(changes.length, Math.round(asNum(value.total))),
    source: value.source === 'harness' ? 'harness' : 'tools',
  };
}

function normalizeSessionArtifacts(raw: unknown): RemoteSessionArtifact[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    const path = asStr(value.path);
    const basename = asStr(value.basename);
    const bucket = value.bucket;
    if (!path || !basename) return [];
    if (bucket !== 'artifacts' && bucket !== 'plans' && bucket !== 'reports' && bucket !== 'docs') return [];
    const title = asStr(value.title);
    const editedAtMs = finiteNum(value.editedAtMs);
    return [{ path, basename, bucket, ...(title ? { title } : {}), ...(editedAtMs !== undefined ? { editedAtMs } : {}) }];
  });
}

function finiteNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeFailures(raw: unknown): RemoteFailure[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const v = entry as Record<string, unknown>;
    const atMs = finiteNum(v.atMs);
    if (atMs === undefined) return [];
    return [{ atMs, tool: asStr(v.tool), summary: asStr(v.summary), error: asStr(v.error), blocked: v.blocked === true }];
  });
}

function normalizeActivityHistogram(raw: unknown): RemoteActivity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const startMs = finiteNum(v.startMs);
  const endMs = finiteNum(v.endMs);
  if (startMs === undefined || endMs === undefined || endMs < startMs || !Array.isArray(v.buckets)) return undefined;
  const buckets = v.buckets.map((b) => {
    const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    return { tools: finiteNum(o.tools) ?? 0, failed: finiteNum(o.failed) ?? 0, blocked: finiteNum(o.blocked) ?? 0 };
  });
  const userAtMs = Array.isArray(v.userAtMs) ? v.userAtMs.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)) : [];
  return { startMs, endMs, buckets, userAtMs };
}

// A turn the harness wrote for itself is not one of your messages: its marker
// leaves the strip along with its row, so marker N and "turn N" stay the same turn.
function withoutEnvelopeTurns(h: RemoteActivity | undefined, turns: RemoteUserTurn[] | undefined): RemoteActivity | undefined {
  if (!h || !turns) return h;
  // One marker per envelope turn: a real message stamped the same millisecond keeps its own.
  const pending = new Map<number, number>();
  for (const t of turns) if (isHarnessEnvelope(t.text)) pending.set(t.atMs, (pending.get(t.atMs) ?? 0) + 1);
  if (!pending.size) return h;
  const userAtMs = h.userAtMs.filter((t) => {
    const left = pending.get(t) ?? 0;
    if (!left) return true;
    pending.set(t, left - 1);
    return false;
  });
  return { ...h, userAtMs };
}

function normalizeUserTurns(raw: unknown): RemoteUserTurn[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry): RemoteUserTurn[] => {
    if (!entry || typeof entry !== 'object') return [];
    const v = entry as Record<string, unknown>;
    const atMs = finiteNum(v.atMs);
    const text = asStr(v.text);
    if (atMs === undefined || !text) return [];
    return [{ atMs, text, images: finiteNum(v.images) ?? 0 }];
  });
}

const SUBAGENT_PROMPT_MAX = 400;

/** The feed's `pending`: each list keeps entries with an id; an empty result is absent. */
function normalizePending(raw: unknown): SessionPending | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const list = (xs: unknown): PendingItem[] => (Array.isArray(xs) ? xs : []).flatMap((e) => {
    if (!e || typeof e !== 'object') return [];
    const o = e as Record<string, unknown>;
    const id = asStr(o.id);
    if (!id) return [];
    const startedAtMs = finiteNum(o.startedAtMs);
    return [{ id, description: asStr(o.description), ...(startedAtMs ? { startedAtMs } : {}) }];
  });
  const out: SessionPending = {};
  for (const k of ['subagents', 'shells', 'monitors'] as const) {
    const xs = list(v[k]);
    if (xs.length) out[k] = xs;
  }
  return Object.keys(out).length ? out : undefined;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeSubagents(raw: unknown): RemoteSubagent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const v = entry as Record<string, unknown>;
    const id = asStr(v.id);
    if (!id) return [];
    const status = v.status === 'running' || v.status === 'failed' ? v.status : 'done';
    return [{
      id,
      agentType: asStr(v.agentType),
      description: asStr(v.description),
      status,
      startedAtMs: finiteNum(v.startedAtMs),
      endedAtMs: finiteNum(v.endedAtMs),
      toolCount: finiteNum(v.toolCount) ?? 0,
      resultExcerpt: asStr(v.resultExcerpt) || undefined,
      transcriptPath: asStr(v.transcriptPath),
      ...(asStr(v.model) ? { model: asStr(v.model) } : {}),
      ...(asStr(v.prompt).trim() ? { prompt: clamp(asStr(v.prompt).trim(), SUBAGENT_PROMPT_MAX) } : {}),
    }];
  });
}

/**
 * Coerce an untyped JSON field to a string. The session JSON is not schema-validated,
 * so a field TypeScript believes is a string (ticket/branch/topic/label/prUrl) can
 * arrive as an object (e.g. a linked-ticket `{ id }`). Anything non-string becomes ''
 * here so it can never flow through to the webview and get rendered as a React child
 * (which throws "Objects are not valid as a React child"). Normalize at the boundary.
 */
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Coerce a CLI-emitted numeric field (number, or numeric string) to a number; 0 otherwise. */
function asNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * Normalize the CLI's `question` object across the postMessage boundary. Returns
 * null when there is no usable question (no text), so the webview falls back to
 * parsing `lastResponse`. `reason` is clamped to the known set; options with no
 * label are dropped.
 */
export function normalizeQuestion(raw: RawActiveSession['question']): RemoteQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const text = asStr(raw.text);
  if (!text) return null;
  const reason: RemoteAwaitReason =
    raw.reason === 'plan_review' || raw.reason === 'permission' ? raw.reason : 'question';
  const options: RemoteQuestionOption[] = Array.isArray(raw.options)
    ? raw.options
        .filter((o): o is { label?: string; description?: string; key?: string } => !!o && typeof o === 'object')
        .map((o) => ({ label: asStr(o.label), description: asStr(o.description), key: asStr(o.key) }))
        .filter((o) => o.label)
    : [];
  return { text, reason, options };
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function normalizeAttachment(raw: unknown): RemoteAttachment | null {
  if (typeof raw === 'string') {
    const path = raw.trim();
    return path ? { path, label: basename(path), mediaType: 'application/octet-stream' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    path?: unknown;
    ref?: unknown;
    label?: unknown;
    name?: unknown;
    mediaType?: unknown;
    media_type?: unknown;
    sizeBytes?: unknown;
    size?: unknown;
    thumbnailUri?: unknown;
  };
  const path = asStr(obj.path) || asStr(obj.ref);
  if (!path) return null;
  const sizeBytes =
    typeof obj.sizeBytes === 'number' ? obj.sizeBytes :
    typeof obj.size === 'number' ? obj.size :
    undefined;
  return {
    path,
    label: asStr(obj.label) || asStr(obj.name) || basename(path),
    mediaType: asStr(obj.mediaType) || asStr(obj.media_type) || 'application/octet-stream',
    sizeBytes,
    thumbnailUri: asStr(obj.thumbnailUri) || undefined,
  };
}

/**
 * Map the CLI `status` string onto a RemotePhase.
 *   running            -> running
 *   input_required     -> waiting   (the cheap Tier-1 "needs you" signal)
 *   queued             -> running   (dispatched, work in the pipeline)
 *   failed / error     -> failed
 *   abandoned          -> failed    (dangling: dead/stuck for days — needs attention)
 *   completed / done   -> done
 *   closed / exited    -> done      (the process has exited cleanly)
 *   idle / stopped / _ -> idle
 */
export function mapStatusToPhase(status: string | undefined): RemotePhase {
  switch ((status || '').toLowerCase()) {
    case 'running':
    case 'queued':
    case 'in_progress':
      return 'running';
    case 'input_required':
    case 'waiting':
    case 'waiting_for_input':
      return 'waiting';
    case 'failed':
    case 'error':
    case 'abandoned':
      return 'failed';
    case 'completed':
    case 'done':
    case 'success':
    case 'closed':
    case 'exited':
      return 'done';
    case 'idle':
    case 'stopped':
    default:
      return 'idle';
  }
}

// projectGlobToRegExp / matchesProjectRule / pathBasename / resolveProject now
// live in src/shared/project.ts (imported + re-exported above) — one impl shared
// with the webview, no lockstep-mirrored copy.

/** Pull the session UUID out of a session-file path (Codex rollout stem → UUID). */
function sessionIdFromFile(sessionFile: string | undefined): string {
  if (!sessionFile) return '';
  const base = (sessionFile.split('/').pop() || '').replace(/\.[^.]+$/, '');
  const m = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m?.[0] || base;
}

/**
 * Turn one raw CLI record into a RemoteSession. `host` is the machine we queried;
 * `fetchedAt` is our local clock at fetch time (used for skew-free elapsed).
 */
export function normalizeActiveSession(
  raw: RawActiveSession,
  host: string,
  fetchedAt: number
): RemoteSession {
  const status = raw.status;
  const phase = mapStatusToPhase(status);
  let sessionId =
    raw.sessionId ||
    sessionIdFromFile(raw.sessionFile) ||
    raw.agentId ||
    raw.cloudTaskId ||
    '';
  // Prefer UUID when the payload still carries a Codex rollout stem.
  if (/^rollout-/i.test(sessionId)) {
    const uuid = sessionId.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    if (uuid) sessionId = uuid[0];
  }
  const cwd = raw.cwd || '';
  const startedAtMs = typeof raw.startedAtMs === 'number' ? raw.startedAtMs : 0;
  // Ticket can arrive as a structured object ({ id }) OR a bare string; read the id
  // first, then fall back to scanning ticket/label/topic text for a RUSH-123 token.
  const rawTicket =
    raw.ticket && typeof raw.ticket === 'object' ? asStr(raw.ticket.id) : asStr(raw.ticket);
  const ticketText = `${rawTicket} ${asStr(raw.label)} ${asStr(raw.topic)}`;
  const ticketMatch = rawTicket || ticketText.match(TICKET_RE)?.[0] || null;
  // The live preview (latest agent turn/tool action) is the human "what is it doing"
  // line; it was previously never read, leaving remote cards blank.
  const preview = asStr(raw.preview);
  const allUserTurns = normalizeUserTurns(raw.userTurns);
  const worktreeSlug = asStr(raw.worktree?.slug) || worktreeSlugOf(cwd);
  const todos = normalizeTodos(raw.todos);
  const summaryChecklist = normalizeTodos(raw.summaryChecklist);
  const checkpoints = normalizeCheckpoints(raw.checkpoints);
  const terminalId = asStr(raw.terminalId);

  return {
    host,
    sessionId,
    terminalId,
    agentType: (raw.kind || '').toLowerCase(),
    cwd,
    // Resolve the cwd first (user rules + worktree fold), then fall back to the
    // project word the CLI already put on the row. That fallback matters only for a
    // cwd-less row — a cloud/factory run — where dropping it threw away the one repo
    // hint the CLI had (PHNX-3796). The webview filters run-CONTEXT words like
    // "cloud" out of it, so this never invents a project named after a context.
    project: resolveProject(cwd) || asStr(raw.project),
    confirmedProject: asStr(raw.confirmedProject) || null,
    phase,
    // Raw lifecycle word kept verbatim (phase loses orphaned/crashed). Absent -> ''.
    liveStatus: (status || '').toLowerCase(),
    // The now-line is live only while the CLI says the agent is working; an idle
    // or waiting session must not keep showing its last tool action as current.
    activity: raw.activity === 'working' && !isHarnessEnvelope(preview) ? preview : '',
    tokPerSec: Math.round(asNum(raw.tokPerSec)),
    tokenCount: raw.tokenCount === undefined ? undefined : asNum(raw.tokenCount),
    durationMs: raw.durationMs === undefined ? undefined : asNum(raw.durationMs),
    artifacts: normalizeSessionArtifacts(raw.artifacts),
    planFile: asStr(raw.planFile),
    subAgentCount: Math.max(0, Math.round(asNum(raw.subAgentCount))),
    waitingForInput: phase === 'waiting',
    rateLimited: raw.rateLimited === true,
    awaitingReason: asStr(raw.awaitingReason),
    lastResponse: preview,
    question: normalizeQuestion(raw.question),
    attention: raw.attention,
    pullRequest: raw.pullRequest,
    prStatus: normalizePrStatus(raw.pr),
    tail: Array.isArray(raw.tail) ? raw.tail.map((t) => asStr(t)).filter(Boolean) : [],
    todos: todos.length ? todos : undefined,
    // Summarizer signals (PHNX-3939) — pure field copies, no fetch. goal falls back
    // to topic at the render layer, not here, so the raw absence stays visible.
    goal: asStr(raw.goal) || undefined,
    checkpoints,
    summaryChecklist: summaryChecklist.length ? summaryChecklist : undefined,
    summaryState: normalizeSummaryState(raw.summaryState),
    // Request / Timeline / Files ride the same stream row, bounded like the
    // checkpoints above. Absent on an older CLI: the cards fall back (request →
    // userPromptClean → topic, timeline → checkpoints, files → nothing) and
    // never fabricate a value.
    request: normalizeRequest(raw.request),
    timeline: normalizeTimeline(raw.timeline),
    files: normalizeFiles(raw.files),
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments.map(normalizeAttachment).filter((a): a is RemoteAttachment => Boolean(a))
      : [],
    // pr is a { url, number } object on the CLI payload; keep top-level prUrl as a
    // fallback for older shapes.
    prUrl: asStr(raw.prUrl) || asStr(raw.pr?.url) || null,
    ticket: ticketMatch,
    spawnedTeam: asStr(raw.spawnedTeam),
    // The remote branch lives at worktree.branch; the top-level `branch` is usually
    // absent, which is why remote branch was always empty.
    branch: asStr(raw.branch) || asStr(raw.worktree?.branch),
    worktreeSlug,
    worktreePath: asStr(raw.worktree?.path) || (worktreeSlug ? cwd : ''),
    sinceMs: startedAtMs > 0 ? Math.max(0, fetchedAt - startedAtMs) : 0,
    startedAtMs,
    // The CLI stamps the transcript's last-write epoch (`active.ts` sessionFileTimes)
    // on every file-backed session — the real activity signal, present for remote
    // hosts too. The local fan-out still re-stats as a fallback. Deliberately NOT
    // startedAtMs — start time is not activity.
    lastActivityMs: typeof raw.lastActivityMs === 'number' ? raw.lastActivityMs : 0,
    topic: asStr(raw.topic) || asStr(raw.prompt) || asStr(raw.firstUserMessage) || asStr(raw.label),
    title: asStr(raw.title),
    startedAs: asStr(raw.startedAs) || undefined,
    model: asStr(raw.model) || undefined,
    owner: asStr(raw.owner) || undefined,
    failures: normalizeFailures(raw.failures),
    activityHistogram: withoutEnvelopeTurns(normalizeActivityHistogram(raw.activityHistogram), allUserTurns),
    userTurns: allUserTurns?.filter((t) => !isHarnessEnvelope(t.text)),
    subagents: normalizeSubagents(raw.subagents),
    pending: normalizePending(raw.pending),
    effort: typeof raw.effort === 'string' && EFFORTS.has(raw.effort) ? (raw.effort as RemoteSession['effort']) : undefined,
    fast: typeof raw.fast === 'boolean' ? raw.fast : undefined,
    firstUserMessage: asStr(raw.firstUserMessage),
    label: asStr(raw.label),
    // Current watch rows mark index-backed history explicitly; older picker-shaped
    // rows used lifecycle state='inactive'. Present one stable word to the UI.
    state: raw.previous === true ? 'inactive' : asStr(raw.state),
    resumable: raw.resumable === undefined ? undefined : raw.resumable === true,
    sourceDevice: asStr(raw.sourceDevice) || host,
    context: asStr(raw.context),
    presence: asStr(raw.presence),
    teamName: raw.teamName || '',
    pid: typeof raw.pid === 'number' ? raw.pid : 0,
    viewingIn: asStr(raw.viewingIn),
    terminalApp: asStr(raw.host),
    observers: normalizeObservers(raw.observerTerminals),
  };
}

function normalizeObservers(value: unknown): RemoteObserver[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    const device = asStr(e.device);
    if (!device) return [];
    return [{ device, viewingIn: asStr(e.viewingIn), workspaceDir: asStr(e.workspaceDir) }];
  });
}

/**
 * True for Claude's auto-derived `<dirname>-<n>` session name (e.g. a session in
 * `~/src/agents-cli` named "agents-cli-55").
 *
 * Anchored on the session's own cwd rather than a shape like `<word>-<digits>`,
 * which would also swallow a real ticket-style title ("RUSH-2058") and silently
 * replace it with a summarized one.
 */
export function isDerivedSessionName(name: string, cwd: string): boolean {
  const dir = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  if (!dir) return false;
  return new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(name);
}
