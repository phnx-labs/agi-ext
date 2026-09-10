// Cross-host session aggregation — pure types + normalize/group.
//
// This module has NO VS Code imports so it is unit-testable in isolation. The
// SSH fan-out + host discovery live in src/vscode/remoteSessions.vscode.ts;
// this file only turns rows from `agents sessions watch --json` into a
// normalized RemoteSession and groups records by host.
//
// A RemoteSession is the cross-host analog of a local agent, shaped so the
// webview can fold it into a FloorAgent (ui/settings/components/mission-control/
// floorModel.ts). Field names are mirrored, but the two types are NOT shared —
// data crosses the webview boundary via postMessage.

import { resolveProject, normalizeHost, worktreeSlugOf } from '../shared/project';
import type { ProjectRule } from '../shared/project';
import { shellQuote } from './deviceDispatchShell';

// Re-exported so existing host importers keep their `from '../core/remoteSessions'`
// path. The impls now live in src/shared/project so the webview (@shared) imports
// the SAME source instead of a hand-mirrored copy that silently drifts.
export { resolveProject, normalizeHost };
export type { ProjectRule } from '../shared/project';

/** Mirror of floorModel.FloorPhase (kept in sync by hand; not imported). */
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
 * state engine (`agents sessions watch --json` → ActiveSession.question). This
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
  question?: { text?: string; options?: Array<{ label?: string; description?: string; id?: string; deliveryKey?: string }> };
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

/** Agent types whose session files session.activity.ts knows how to parse. */
type ParsableAgentType = 'claude' | 'codex' | 'gemini';

// normalizeHost now lives in src/shared/project.ts (imported + re-exported above).

/**
 * Decide which HOSTS bucket a session belongs to. A bare `agents sessions
 * --active --json` fans out over the whole fleet, so a single query answers for
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

/** A registered device as seen by the host reconciler (from `agents devices list`). */
export interface RegisteredDeviceInput {
  name: string;
  /** SSH target (the device's Tailscale dnsName). Falls back to `name` when absent. */
  address?: string;
  online?: boolean;
}

/** A host after reconciliation against the device registry. */
export interface ReconciledHost {
  /** Canonical device label (normalizeHost of the registry name). Grouping + sidebar key. */
  name: string;
  /** SSH target for the Tier-1 fetch; '' for the local machine (queried directly). */
  address: string;
  online: boolean;
  isLocal: boolean;
}

/**
 * Scope the swept host roster to the DEVICE REGISTRY + the local machine — never
 * ssh-config aliases or raw tailnet peers, which are not dev machines and used to
 * flood the sidebar with phantom hosts (mark, mark-aws, phoenix, pi, plus the same
 * mac listed as localhost / mac-mini / "Muqsit's Mac mini"). The local machine is
 * always present and online (queried directly, no ssh); a registry entry that IS the
 * local machine is folded into it via normalizeHost so the machine appears exactly
 * once under its canonical name. Pure so it is unit-tested against real `agents
 * devices` shapes.
 */
export function reconcileHosts(devices: RegisteredDeviceInput[], localHost: string): ReconciledHost[] {
  const localKey = normalizeHost(localHost);
  const byName = new Map<string, ReconciledHost>();
  if (localKey) byName.set(localKey, { name: localKey, address: '', online: true, isLocal: true });
  for (const d of devices) {
    const key = normalizeHost(d.name);
    if (!key || key === localKey) continue;
    byName.set(key, { name: key, address: (d.address || d.name || '').trim(), online: d.online === true, isLocal: false });
  }
  return [...byName.values()];
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
 * would leave the merged Floor stuck at "connecting" forever. This filter must
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
export interface RemoteTodoItem {
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
}

/**
 * The CLI's own recovery command for a resumable session
 * (`SessionPickerJsonRow.recovery`): `agents sessions resume <id> --device <device>`.
 * Carried verbatim so the Sessions surface runs the CLI's recommended command
 * instead of re-deriving one. null for a harness with no resume path.
 */
interface RemoteRecovery {
  command: 'agents' | string;
  args: string[];
  cwd?: string;
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
  phase: RemotePhase;
  /** The RAW CLI lifecycle status word, lowercased ('running' | 'idle' |
   *  'orphaned' | 'crashed' | 'abandoned' | 'waiting' | 'closed' | ...), carried
   *  verbatim because `phase` collapses it (orphaned/crashed both map to a phase
   *  that can't be told apart). The Sessions surface reads this to route a
   *  detached-but-alive session into the "needs reconnecting" band. '' when the
   *  CLI supplied no status. */
  liveStatus: string;
  /** Whether the session's OS process is still alive, from the CLI payload
   *  (`pidAlive`). Distinguishes an orphaned-but-running session (resume attaches)
   *  from a crashed one (resume relaunches via /continue). Defaults true when the
   *  CLI omits it (a live roster row). */
  pidAlive: boolean;
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
  /** Last few assistant turns (most-recent last), one line each — panel context. [] when none. */
  tail: string[];
  /** Live plan checklist from the CLI's most recent `TodoWrite` (RUSH-1380). Lets the
   *  Fleet show an N/M pill + checklist for remote / device-dispatched agents
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
  /** Raw CLI output text, when the active-session payload carries it. */
  output: string;
  /** Attachment refs/names from the CLI payload, normalized for thumbnail + preview. */
  attachments: RemoteAttachment[];
  prUrl: string | null;
  ticket: string | null;
  /** Tracker refs this session CREATED (Linear create_issue / gh issue create). */
  createdTickets: string[];
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
   *  backfilled from startedAtMs — start time is not activity. Drives staleness
   *  (isStaleSession) so an idle-for-days session stops being reported running /
   *  needs-you, WITHOUT hiding a remote agent that merely started long ago. */
  lastActivityMs: number;
  /** The session's task/prompt line from the CLI payload (`topic`/`label`). Shown
   *  on the card when Tier-1 has no enriched activity yet (remote hosts). */
  topic: string;
  /** CLI-authored recap title. This is the row header, never the request body. */
  title: string;
  /** Full genuine first user turn from the durable session index. Empty on an
   *  older CLI, where the UI labels its topic fallback as a summary. */
  firstUserMessage: string;
  /** User-set session label from the CLI payload. Kept separate from topic so UI
   *  card headers can prefer explicit names over inferred task lines. */
  label: string;
  /** Absolute session-file path, kept so the fan-out can enrich the deduped
   *  survivor without re-reading the raw record. */
  sessionFile: string;
  /** The CLI record's `context` ('terminal' | 'cloud' | 'teams' | ...). Lets the
   *  webview treat cloud rows differently from terminal-backed agents. */
  context: string;
  /** Foreground/background presence from the CLI (`attached` | `background` |
   *  `parked`), absent when the session isn't on that axis (cloud/team/ad-hoc
   *  headless). Drives the detach/attach affordances. */
  presence?: string;
  /** Cloud task id (`agents cloud message <id> <text>` is the reply channel for
   *  cloud rows). Empty for non-cloud sessions. */
  cloudTaskId: string;
  /** Cloud provider ('rush' | 'codex' | 'factory' | ...), informational. Empty otherwise. */
  cloudProvider: string;
  /** Team name for `teams`-context sessions (`agents factory answer <team> <text>`
   *  is their reply channel). Empty otherwise. */
  teamName: string;
  /** OS pid of the live process (terminal context), 0 when unknown. */
  pid: number;
  /** Transport the CLI reached this session over ('ssh' remote, 'local', or ''). */
  transport: string;
  /** Reply rail from `provenance.reply.rail`: 'tmux' means drive the pane below with
   *  `tmux send-keys`; '' means no programmatic channel (raw TTY) unless cloud/team. */
  replyRail: string;
  /** tmux pane target (e.g. '%65') for the tmux rail. Empty otherwise. */
  replyMuxTarget: string;
  /** tmux socket path for the tmux rail. Empty otherwise. */
  replyMuxSocket: string;
  /** The session's own tmux `%N` pane handle (from `provenance.mux.pane`), shown
   *  on the card for unique addressing. Falls back to the reply-rail pane when the
   *  CLI hasn't populated mux yet. Empty for non-tmux sessions. */
  tmuxPane: string;
  /** Where the session is currently being viewed, pre-formatted by the CLI (e.g.
   *  "Codium tab 3", "Ghostty tab 2", "detached"). '' when the CLI supplies none. */
  viewingIn: string;
  /** Lifecycle state from the CLI picker join (`SessionPickerJsonRow.state` —
   *  the live ActiveSession status, or 'inactive' for a genuinely ended session).
   *  'inactive' is the load-bearing signal that a session is a resumable PREVIOUS
   *  row rather than a live one. '' when unknown (a raw live-roster row). */
  state?: string;
  /** Whether an ended/idle session can be resumed (`SessionPickerJsonRow.resumable`).
   *  A harness with no resume path (grok/gemini/droid/cursor/…) reports false. */
  resumable?: boolean;
  /** The CLI's own recovery command (`SessionPickerJsonRow.recovery`):
   *  `agents sessions resume <id> --device <device>`. null for non-resumable. */
  recovery?: RemoteRecovery | null;
  /** Canonical device label the session's transcript lives on
   *  (`SessionPickerJsonRow.sourceDevice`, e.g. 'zion', 'yosemite-s0'). '' when unknown. */
  sourceDevice?: string;
  /** Outcome metrics from either a live CLI row or a RECENT (historical) row.
   *  Undefined when the owning CLI cannot compute them. */
  durationMs?: number;
  costUsd?: number;
  tokenCount?: number;
}

/** One machine's worth of sessions plus its reachability + freshness stamp. */
export interface HostGroup {
  host: string;
  online: boolean;
  /** When this host's data was fetched (epoch ms) — freshness for the UI. */
  fetchedAt: number;
  sessions: RemoteSession[];
}

/** Live load bucket for a host. Mirrors dispatch.types.ts HostLoad (webview
 *  contract) — kept in sync by hand; the two are NOT shared across the boundary. */
export type HostLoad = 'idle' | 'free' | 'busy' | 'hot' | 'off' | 'unavailable';

/** Reachability + live load of a discovered host. `agents`/`load`/`uses` are the
 *  live-load fields the Dispatch panel reads; they ride the existing hostSessions
 *  message. During discovery (before the host is probed) they hold their pre-probe
 *  values (agents 0, load idle/off, uses 0); the presentation store supplies
 *  measured values before the payload leaves the extension host. */
export interface HostInfo {
  name: string;
  online: boolean;
  /** Active agent sessions on this host (HostGroup.sessions.length). */
  agents: number;
  /** Load bucket derived from CPU load + agent count; 'off' when offline. */
  load: HostLoad;
  /** Usage weight for the ranking tiebreak (active-session count). */
  uses: number;
}

/**
 * The subset of `agents sessions watch --json` upsert records we consume. Every
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
  pid?: number;
  /** Whether the CLI's process probe found the pid alive. */
  pidAlive?: boolean;
  sessionId?: string;
  cwd?: string;
  label?: string;
  topic?: string;
  title?: string;
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
  cloudProvider?: string;
  cloudTaskId?: string;
  cloudStatus?: string;
  branch?: string;
  prUrl?: string;
  /** Where the session is being viewed right now, pre-formatted by the CLI's
   *  client resolver (e.g. "Codium tab 3", "Ghostty tab 2", "detached"). */
  viewingIn?: string;
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
  output?: string;
  attachments?: unknown[];
  pr?: { url?: string; number?: number } | null;
  worktree?: { slug?: string; path?: string; branch?: string } | null;
  ticket?: string | { id?: string; url?: string } | null;
  /** Tracker refs the session CREATED + team it SPAWNED, from the CLI session scan. */
  createdTickets?: string[];
  spawnedTeam?: string;
  /** Per-session rate/usage limit from the CLI (RUSH-1523). */
  rateLimited?: boolean;
  /** Normalized device id the CLI attributes this session to (machineId() form,
   *  e.g. 'zion', 'yosemite-s0'). Present on every row of a fanned-out
   *  `sessions watch --json` — the load-bearing signal for which physical
   *  machine a session runs on. Absent for cloud rows (attributed to the querier). */
  machine?: string;
  /** Durable lifecycle/recovery fields are also present on the recoverable rows
   * folded into the canonical watch stream. */
  state?: string;
  previous?: boolean;
  resumable?: boolean;
  sourceDevice?: string;
  recovery?: { command?: string; args?: unknown[]; cwd?: string } | null;
  /**
   * AGI EXT / editor tab id (`AGENT_TERMINAL_ID`) when the launch inherited it.
   * Join key for "which session is MY tab running?" across local/`--device` runs.
   */
  terminalId?: string;
  /** How the CLI says a reply reaches this session. `reply` is null for raw TTYs
   *  (e.g. bare Ghostty) with no programmatic input channel; a tmux-backed session
   *  carries the socket + pane to drive via `tmux send-keys` (over ssh when remote).
   *  `mux` carries the session's OWN pane/socket (its authoritative %pane handle),
   *  distinct from the reply rail which may target a different pane. */
  provenance?: {
    transport?: string;
    reply?: { rail?: string; target?: string; socket?: string } | null;
    mux?: { pane?: string; socket?: string; session?: string } | null;
  } | null;
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
  if (!text) return null;
  const source: RemoteTimelineStep['source'] =
    value.source === 'thinking' || value.source === 'derived' || value.source === 'user'
      ? value.source
      : 'narration';
  const mix = normalizeStepMix(value.mix);
  const marks = Array.isArray(value.marks)
    ? value.marks.map((m) => asStr(m).trim()).filter(Boolean).slice(0, STEP_MARKS_MAX)
    : [];
  const endedAt = asTimestamp(value.endedAt);
  const now = clamp(asStr(value.now).trim(), STEP_NOW_MAX);
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
    return [{ path, basename, bucket }];
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
 * Map the CLI `status` string onto a FloorPhase.
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

/**
 * Derive a display project from a working directory with no user rules — the
 * legacy default: worktrees fold to their repo, otherwise the cwd basename.
 * Thin wrapper over resolveProject so the two never diverge.
 */
export function projectFromCwd(cwd: string): string {
  return resolveProject(cwd);
}

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
  fetchedAt: number,
  projectRules: ProjectRule[] = []
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
    project: resolveProject(cwd, projectRules) || asStr(raw.project),
    phase,
    // Raw lifecycle word kept verbatim (phase loses orphaned/crashed). Absent -> ''.
    liveStatus: (status || '').toLowerCase(),
    // The CLI omits pidAlive for some rows (cloud/team) — treat a live roster row as alive.
    pidAlive: raw.pidAlive !== false,
    // The now-line is live only while the CLI says the agent is working; an idle
    // or waiting session must not keep showing its last tool action as current.
    activity: raw.activity === 'working' ? preview : '',
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
    output: asStr(raw.output),
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments.map(normalizeAttachment).filter((a): a is RemoteAttachment => Boolean(a))
      : [],
    // pr is a { url, number } object on the CLI payload; keep top-level prUrl as a
    // fallback for older shapes.
    prUrl: asStr(raw.prUrl) || asStr(raw.pr?.url) || null,
    ticket: ticketMatch,
    createdTickets: Array.isArray(raw.createdTickets) ? raw.createdTickets.map((t: unknown) => String(t)) : [],
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
    firstUserMessage: asStr(raw.firstUserMessage),
    label: asStr(raw.label),
    // Current watch rows mark index-backed history explicitly; older picker-shaped
    // rows used lifecycle state='inactive'. Present one stable word to the UI.
    state: raw.previous === true ? 'inactive' : asStr(raw.state),
    resumable: raw.resumable === undefined ? undefined : raw.resumable === true,
    recovery: normalizeRecovery(raw.recovery),
    sourceDevice: asStr(raw.sourceDevice) || host,
    sessionFile: asStr(raw.sessionFile),
    context: asStr(raw.context),
    presence: asStr(raw.presence),
    cloudTaskId: raw.cloudTaskId || '',
    cloudProvider: raw.cloudProvider || '',
    teamName: raw.teamName || '',
    pid: typeof raw.pid === 'number' ? raw.pid : 0,
    transport: raw.provenance?.transport || '',
    replyRail: raw.provenance?.reply?.rail || '',
    replyMuxTarget: raw.provenance?.reply?.target || '',
    replyMuxSocket: raw.provenance?.reply?.socket || '',
    // Prefer the session's own pane (provenance.mux.pane); fall back to the
    // reply-rail pane, which today already carries a %pane for tmux sessions.
    tmuxPane: raw.provenance?.mux?.pane || raw.provenance?.reply?.target || '',
    viewingIn: asStr(raw.viewingIn),
  };
}

/**
 * The FLAT `SessionMeta` shape emitted by `agents sessions --json` (recent, not
 * --active). Field names differ from the active payload (ticketId vs ticket,
 * gitBranch vs worktree.branch, lastActivity ISO vs startedAtMs), so recent sessions
 * get their own normalizer that lands on the SAME RemoteSession shape — one card path
 * for active AND recent. Unknown fields ignored.
 */
export interface RawRecentSession {
  id?: string;
  shortId?: string;
  agent?: string;
  timestamp?: string;
  lastActivity?: string;
  project?: string;
  cwd?: string;
  gitBranch?: string;
  worktreeSlug?: string;
  ticketId?: string;
  createdTickets?: string[];
  spawnedTeam?: string;
  prUrl?: string;
  prNumber?: number;
  topic?: string;
  title?: string;
  firstUserMessage?: string;
  label?: string;
  machine?: string;
  // SessionPickerJsonRow lifecycle/recovery fields (agents sessions --json): the
  // CLI already joins the durable index against the live roster, so every row
  // arrives with its resumability + the exact command to recover it.
  state?: string;
  resumable?: boolean;
  sourceDevice?: string;
  pid?: number | null;
  recovery?: { command?: string; args?: unknown[]; cwd?: string } | null;
  // Outcome metrics the CLI computes per session (may arrive as numeric strings).
  durationMs?: number | string;
  costUsd?: number | string;
  tokenCount?: number | string;
  messageCount?: number | string;
}

/**
 * Normalize the CLI's `recovery` object (SessionPickerJsonRow.recovery) into the
 * flat RemoteRecovery the UI runs. Returns null for a non-resumable harness (the
 * CLI emits null) or a malformed payload, so the row renders no dead action.
 */
function normalizeRecovery(raw: RawRecentSession['recovery']): RemoteRecovery | null {
  if (!raw || typeof raw !== 'object') return null;
  const command = asStr(raw.command);
  const args = Array.isArray(raw.args) ? raw.args.map((a) => asStr(a)).filter((a) => a.length > 0) : [];
  if (!command || args.length === 0) return null;
  const cwd = asStr(raw.cwd);
  return cwd ? { command, args, cwd } : { command, args };
}

/**
 * Build the CLI's device-targeted resume command for a PREVIOUS (crashed/ended)
 * session (PHNX-3593): `agents sessions resume <id> [--device <device>] --vscodium`.
 * Host-owned so a webview payload can only pick the session, never inject — every
 * interpolated value is single-quote escaped. `--device` is included only when a
 * real (non-local) device is given; `--vscodium` opens the resumed session as an
 * editor tab. Pure so the built command is unit-tested and quotable.
 */
export function buildRecoveryResumeCommand(sessionId: string, device?: string): string {
  const parts = ['agents', 'sessions', 'resume', shellQuote(sessionId)];
  const d = (device || '').trim();
  if (d) parts.push('--device', shellQuote(d));
  parts.push('--vscodium');
  return parts.join(' ');
}

/**
 * Move a historical session to another device through the CLI's existing
 * transcript-transport seam, then focus the confirmed-live target pane. Direct
 * `sessions resume --device <different-device>` is intentionally invalid: that
 * flag names the transcript's origin. When the origin is remote, migration must
 * execute there because that is where the indexed transcript lives.
 */
export function buildRecoveryMigrationCommand(
  sessionId: string,
  sourceDevice: string,
  targetDevice: string,
  sourceIsLocal = false,
): string {
  const migrate = [
    'agents', 'sessions', 'migrate', shellQuote(sessionId),
    '--device', shellQuote(targetDevice), '--mode', 'resume', '--keep',
  ];
  const source = sourceDevice.trim();
  const migrateCommand = source && !sourceIsLocal
    ? ['agents', 'ssh', shellQuote(source), ...migrate].join(' ')
    : migrate.join(' ');
  const focus = ['agents', 'sessions', 'focus', shellQuote(sessionId), '--device', shellQuote(targetDevice)].join(' ');
  return `${migrateCommand} && ${focus}`;
}

/** Map a recent (historical, non-active) SessionMeta onto RemoteSession. Recent =
 *  not live, so phase is always 'idle'; lastActivity drives the "…ago" stamp. */
export function normalizeRecentSession(
  raw: RawRecentSession,
  host: string,
  fetchedAt: number,
  projectRules: ProjectRule[] = []
): RemoteSession {
  const cwd = asStr(raw.cwd);
  const worktreeSlug = asStr(raw.worktreeSlug) || worktreeSlugOf(cwd);
  const lastActivityMs = raw.lastActivity ? Date.parse(raw.lastActivity) || 0 : 0;
  const startedAtMs = raw.timestamp ? Date.parse(raw.timestamp) || 0 : 0;
  return {
    host,
    sessionId: asStr(raw.id),
    agentType: asStr(raw.agent).toLowerCase(),
    cwd,
    // Same precedence as the live path (PHNX-3796): the cwd resolves first, so a
    // user project RULE always wins, and the CLI's own project word is the fallback
    // for a row with no cwd. This used to be reversed here, which silently ignored
    // rules for historical rows.
    project: resolveProject(cwd, projectRules) || asStr(raw.project),
    phase: 'idle',
    // A recent (historical, not-live) session is a resumable transcript, not a
    // running process — surface it as such rather than inventing an orphan state.
    liveStatus: 'idle',
    pidAlive: false,
    activity: '',
    tokPerSec: 0,
    artifacts: [],
    planFile: '',
    subAgentCount: 0,
    waitingForInput: false,
    rateLimited: false,
    awaitingReason: '',
    lastResponse: '',
    // Recent (historical) sessions are idle — no live decision to surface.
    question: null,
    tail: [],
    output: '',
    attachments: [],
    prUrl: asStr(raw.prUrl) || null,
    ticket: asStr(raw.ticketId) || null,
    createdTickets: Array.isArray(raw.createdTickets) ? raw.createdTickets.map((t: unknown) => String(t)) : [],
    spawnedTeam: asStr(raw.spawnedTeam),
    branch: asStr(raw.gitBranch),
    worktreeSlug,
    worktreePath: worktreeSlug ? cwd : '',
    sinceMs: startedAtMs > 0 ? Math.max(0, fetchedAt - startedAtMs) : 0,
    startedAtMs,
    lastActivityMs,
    topic: asStr(raw.topic) || asStr(raw.label),
    title: asStr(raw.title),
    firstUserMessage: asStr(raw.firstUserMessage),
    label: asStr(raw.label),
    sessionFile: '',
    context: 'recent',
    cloudTaskId: '',
    cloudProvider: '',
    teamName: '',
    pid: 0,
    transport: '',
    replyRail: '',
    replyMuxTarget: '',
    replyMuxSocket: '',
    // Recent sessions are historical/idle, not live — no tmux pane or "viewing in"
    // client to resolve, so both are empty (the required-string default).
    tmuxPane: '',
    viewingIn: '',
    // Lifecycle + recovery from the CLI picker join. `state` defaults to 'inactive'
    // (an ended session) so the Sessions surface can classify it as Previous; the
    // recovery command is the CLI's own `sessions resume … --device <device>`.
    state: asStr(raw.state) || 'inactive',
    resumable: raw.resumable === true,
    recovery: normalizeRecovery(raw.recovery),
    sourceDevice: asStr(raw.sourceDevice) || host,
    // Outcome metrics for the Recap ledger. The CLI emits these on the flat
    // SessionMeta payload; coerce defensively (numeric strings observed in the wild).
    durationMs: asNum(raw.durationMs),
    costUsd: asNum(raw.costUsd),
    tokenCount: asNum(raw.tokenCount),
  };
}

/** Phase precedence for dedup — the most attention-worthy record wins. */
const DEDUPE_PHASE_RANK: Record<RemotePhase, number> = {
  waiting: 0,
  failed: 1,
  running: 2,
  done: 3,
  idle: 4,
};

/**
 * Collapse records that describe the SAME session into one.
 *
 * `agents sessions --active` reports one record per live *process*, but many
 * processes (login shell, node, the agent binary, extra tabs) attach to a single
 * session file — locally we've seen 9 pids resolve to one session. Left alone,
 * the header counts every process while the feed (keyed by session id) renders
 * only the distinct ids, so the count and the list diverge wildly. Dedup by
 * `sessionId` here so a "session" means a session, and keep the record whose phase
 * most needs the user (waiting > failed > running > done > idle) — e.g. one
 * waiting pane among eight running ones surfaces the whole session as waiting.
 * Records with an empty `sessionId` are passed through untouched (can't key them).
 */
export function dedupeSessions(sessions: RemoteSession[]): RemoteSession[] {
  const byId = new Map<string, RemoteSession>();
  const passthrough: RemoteSession[] = [];
  for (const s of sessions) {
    if (!s.sessionId) {
      passthrough.push(s);
      continue;
    }
    const existing = byId.get(s.sessionId);
    if (!existing || DEDUPE_PHASE_RANK[s.phase] < DEDUPE_PHASE_RANK[existing.phase]) {
      byId.set(s.sessionId, s);
    }
  }
  return [...byId.values(), ...passthrough];
}

/**
 * A session whose last OBSERVED ACTIVITY was this long ago is treated as dead and
 * dropped from the live roster so it can't be reported running or needs-you. Six
 * hours comfortably clears an idle-overnight agent while killing sessions abandoned
 * for days (e.g. an 11-day-old file-backed session last written to 11 days ago).
 */
export const STALE_SESSION_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * A session's last-activity epoch — the enriched session-file mtime (set by the
 * fan-out for file-backed sessions). This is a GENUINE activity signal: the *last
 * write*, not the session start. It is deliberately NOT backfilled from startedAtMs,
 * because start time says nothing about recent activity — a remote agent that started
 * days ago may be working right now. 0 means we have no activity signal (a status-only
 * remote/ssh session, or a session with no file), and such a session is never aged out.
 */
export function sessionLastActivityMs(s: RemoteSession): number {
  return s.lastActivityMs || 0;
}

/**
 * True when a session's last observed activity is older than `thresholdMs`. A session
 * with no activity signal at all (0) is NEVER forced stale — we can't age what we
 * can't see, and a false positive would hide a live agent that merely STARTED long
 * ago (the key distinction: start time is not activity).
 */
export function isStaleSession(
  s: RemoteSession,
  now: number,
  thresholdMs: number = STALE_SESSION_THRESHOLD_MS
): boolean {
  const last = sessionLastActivityMs(s);
  if (last <= 0) return false;
  return now - last >= thresholdMs;
}

/**
 * Drop stale sessions so counts, the feed, and needs-you all exclude long-dead
 * sessions. Pure; the fan-out applies it to the merged cross-host set.
 */
export function filterStaleSessions(
  sessions: RemoteSession[],
  now: number,
  thresholdMs: number = STALE_SESSION_THRESHOLD_MS
): RemoteSession[] {
  return sessions.filter((s) => !isStaleSession(s, now, thresholdMs));
}

/**
 * Parse session rows from the CLI payload (string or array) into
 * RemoteSessions for one host. Malformed input yields an empty array rather than
 * throwing, so one bad host never sinks the whole fan-out.
 */
export function normalizeActiveSessions(
  payload: string | unknown[],
  host: string,
  fetchedAt: number,
  projectRules: ProjectRule[] = []
): RemoteSession[] {
  let arr: unknown[];
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      arr = Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  } else if (Array.isArray(payload)) {
    arr = payload;
  } else {
    return [];
  }
  return arr
    .filter((r): r is RawActiveSession => !!r && typeof r === 'object')
    .map((r) => normalizeActiveSession(r, host, fetchedAt, projectRules));
}

/**
 * Group normalized sessions by host into HostGroups. `hosts` supplies the full
 * roster + reachability so offline hosts still appear (with an empty session
 * list) instead of silently vanishing. `fetchedAt` stamps freshness.
 */
export function groupByHost(
  sessions: RemoteSession[],
  hosts: HostInfo[],
  fetchedAt: number
): HostGroup[] {
  const byHost = new Map<string, RemoteSession[]>();
  for (const s of sessions) {
    const list = byHost.get(s.host);
    if (list) list.push(s);
    else byHost.set(s.host, [s]);
  }
  const groups: HostGroup[] = [];
  const seen = new Set<string>();
  for (const h of hosts) {
    seen.add(h.name);
    groups.push({
      host: h.name,
      online: h.online,
      fetchedAt,
      sessions: byHost.get(h.name) || [],
    });
  }
  // Any host that produced sessions but was not in the roster (defensive).
  for (const [host, list] of byHost) {
    if (seen.has(host)) continue;
    groups.push({ host, online: true, fetchedAt, sessions: list });
  }
  return groups;
}

/** The two label-bearing fields of one `agents sessions <id> --json` record. */
export interface SessionLabelSource {
  /** The session's persisted name, when it has a real one. */
  label: string | null;
  /** The session's first user message — the summarizer's input. */
  topic: string | null;
}

/**
 * Pull the label inputs out of `agents sessions <id> --json`.
 *
 * A tab whose agent runs on another machine has no local transcript to read, so
 * this is the only way it can ever show anything but the bare agent prefix. The
 * CLI already resolves both fields on whichever host owns the session.
 *
 * **The payload has two shapes, and the remote one is the shape that matters
 * here.** Locally, `agents sessions <id> --json` renders the detail view and
 * emits `{ session, events }`. With `--device` the lookup is routed to the peer
 * and comes back as the FLAT array of `SessionMeta` records instead (the same
 * shape `fetchRecentForHost` consumes). Reading only `.session` therefore found
 * nothing for exactly the offloaded tabs this exists to label. Both are handled;
 * `sessionId` disambiguates when an array carries more than one record.
 *
 * `label` is dropped when it is Claude's derived `<dirname>-<n>` placeholder —
 * that names the repo, not the work, and surfacing it would also stop the caller
 * from falling through to the summarizer (same rule as readClaudeSessionName).
 */
export function parseSessionLabelSource(rawJson: string, sessionId?: string): SessionLabelSource | null {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch {
    return null;
  }
  const record = pickSessionRecord(data, sessionId);
  if (!record) return null;
  const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim() : null;
  let topic = typeof record.topic === 'string' && record.topic.trim() ? record.topic.trim() : null;
  // `agents sessions <id> --json` is `{ session, events }` and the session
  // object often has no topic/label (those live on the list/active shapes).
  // The events array still has the first real user turn — use it so an
  // offloaded tab can be labelled without a second query.
  if (!topic) {
    const events = !Array.isArray(data) && data && typeof data === 'object'
      ? (data as { events?: unknown }).events
      : record.events;
    topic = topicFromUserEvents(events);
  }
  const cwd = typeof record.cwd === 'string' ? record.cwd : '';
  return { label: label && isDerivedSessionName(label, cwd) ? null : label, topic };
}

/** First non-synthetic user message in a `sessions <id> --json` events array. */
function topicFromUserEvents(events: unknown): string | null {
  if (!Array.isArray(events)) return null;
  for (const item of events) {
    if (!item || typeof item !== 'object') continue;
    const event = item as { type?: unknown; role?: unknown; content?: unknown; _synthetic?: unknown };
    if (event.type !== 'message' || event.role !== 'user') continue;
    if (event._synthetic === true) continue;
    const content = typeof event.content === 'string' ? event.content.trim() : '';
    if (!content) continue;
    if (/^Base directory for this skill:/i.test(content)) continue;
    return content;
  }
  return null;
}

/** The one session record out of either payload shape, or null when absent. */
function pickSessionRecord(data: unknown, sessionId?: string): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    const records = data.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
    if (records.length === 0) return null;
    // A by-id lookup normally returns exactly one row; match explicitly anyway so
    // a wider payload can never label a tab from someone else's session.
    if (sessionId) return records.find((r) => r.id === sessionId) ?? null;
    return records.length === 1 ? records[0] : null;
  }
  if (!data || typeof data !== 'object') return null;
  const session = (data as Record<string, unknown>).session;
  return session && typeof session === 'object' ? (session as Record<string, unknown>) : null;
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
