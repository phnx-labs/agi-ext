// Agent Panel: the activity-bar sidebar view that is the ONE session preview in
// the extension (PHNX-3939). The Fleet webview's detail rail is gone; everything
// that described a session lives here.
//
// Subject model — two triggers, one subject, last wins:
//   an agent terminal takes focus       -> onDidChangeActiveTerminal
//   a Fleet row is clicked              -> webview 'session.select' {sessionId, host}
// The subject is PRESENTATION STATE ONLY: never persisted, never written to a
// config or workspaceState. A subject with no local terminal still renders — the
// stream row alone is enough for a remote or finished session.
//
// Shows:
//   - Agent logo + name + version + session chunk + label (manual or auto)
//   - Worktree path with branch + dirty count and Commit / Cleanup / Wrap buttons
//   - Conversation topic + recent tool calls (read/edit/run)
//   - Linear ticket + PR URL extracted from the session, when present
//   - Quick prompts (favorites first) — click to send into the focused terminal
//   - Teams whose workspace_dir is related to the terminal's cwd
//
// Detection model:
//   active terminal -> terminals.getByTerminal(t) -> EditorTerminal struct
//   cwd            -> terminal.creationOptions.cwd
//   teams          -> agents teams list --json + agents teams status <t> --json
//                     filtered by pathsRelated(workspace_dir, cwd)
//   git info       -> vscode.git extension repository state
//   linear/PR      -> regex scan over the session preview + tail
//
// Refresh signals:
//   onDidChangeActiveTerminal               -> re-render immediately
//   onDidCloseTerminal / onDidOpenTerminal  -> re-render
//   session CLI stream fact (agents-cli daemon) -> re-render, trailing-coalesced
//     (PHNX-2833: no local poll timer — the daemon is the only scheduler)

import * as vscode from 'vscode';
import { isHarnessEnvelope } from '../core/harnessEnvelope';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import * as os from 'os';
import { displayPath } from '../core/displayPath';
import * as terminals from './terminals.vscode';
import { buildAgentTerminalEnv } from '../core/terminals';
import { TeamWithMates } from './foreman.sources';
import { BUILT_IN_AGENTS } from '../core/agents';
import { openExternalUrl } from './webviewSecurity';
import { parseLineForActivity, formatActivity, todoProgressFromItems, type TodoProgress } from '../core/session.activity';
import {
  extractPrUrls as extractPrUrlsHelper,
  type PullRequestRef as SharedPullRequestRef,
  type WorktreeRef as SharedWorktreeRef,
} from '../core/panel.helpers';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import { sessionStreamDemand } from '../monitor/sessionDemand';
import { LOCAL_MACHINE_ID, LOCAL_LABEL, remoteDeviceArg } from './remoteSessions.vscode';
import type {
  RemoteActivity,
  RemoteAttachment,
  RemoteCheckpoint,
  RemoteFailure,
  RemoteSubagent,
  RemoteUserTurn,
  RemoteFiles,
  RemoteRequest,
  RemoteSession,
  RemoteSessionArtifact,
  RemoteTimeline,
  RemoteTodoItem,
} from '../core/remoteSessions';
import { normalizeHost } from '../core/remoteSessions';
import { createTrailingCoalesce, coalesceTrailing } from '../core/cachedInFlight';
import { sessionPathUriString } from '../core/sessionPath';
import { sendReplyToTerminal } from './sessionReply';
import { runAgents } from '../core/agentsBin';
import { prAction, prRepo, type PrAction, type RemotePrStatus } from '../core/prStatus';
import { shellQuote } from '../core/deviceDispatchShell';
import { SESSION_CARDS_SCRIPT, sessionPanelCss, sessionPanelFontFaces } from '../shared/sessionCards';
import { requestImageThumbs, sessionCardFields } from '../core/sessionCardFields';
import { SESSION_STATE_WORD, sessionStateOf, type SessionStateKey } from '../shared/sessionState';
import { VERB_FILTER_ROLES, fetchTimelineFilter, openSessionArtifact } from './sessionCardActions';
import { isInside } from '../core/displayPath';

/** Where the CLI materializes pasted images; the only image root the webview may read. */
const ATTACHMENT_CACHE_DIR = path.join(os.homedir(), '.agents', '.cache', 'attachments');
// Where the CLI saves images pasted on this machine; a request names them by file name.
const PASTED_ATTACHMENT_DIR = path.join(os.homedir(), '.agents', '.history', 'attachments');

const AGENT_PANEL_VIEW_ID = 'agentsPanel.terminal';

interface ConversationSummary {
  topic?: string;            // first user prompt — what this session is about
  lastMessage?: string;      // most recent user message
  messageCount: number;
  lastActivityMs?: number;
}

interface ActivityItem {
  kind: string;   // 'reading' | 'editing' | 'running' | 'thinking' | 'completed' | ...
  summary: string;
  ts: number;
}

interface GitInfo {
  branch?: string;
  dirtyCount?: number;
}

// Derived from session mtime + git + PRs. Drives which Quick Actions render.
// Deterministic — no LLM call. See computeAgentState().
type AgentState =
  | 'streaming'         // session JSONL touched recently — agent is producing output
  | 'pr_open'           // a PR URL was extracted from the session
  | 'idle_dirty'        // idle, working tree has changes
  | 'idle_clean_wt'     // idle, clean tree, terminal is in a worktree
  | 'idle_clean';       // idle, clean tree, no worktree

// "Streaming" window: how recently the session file must have been touched
// to still count as actively producing output.
const STREAMING_MS = 10_000;

// Re-export shared types so the rest of this file doesn't need to switch on
// `SharedFoo` everywhere. Keeps the snapshot interface readable.
type PullRequestRef = SharedPullRequestRef;
type WorktreeRef = SharedWorktreeRef;

interface PanelSnapshot {
  /** A local agent terminal backs the subject (drives terminal-only actions). */
  hasTerminal: boolean;
  /** There is a session to render at all — from a terminal OR a Fleet row click. */
  hasSubject?: boolean;
  /** Where the subject came from; a Fleet subject shows "following the Fleet row". */
  subjectSource?: 'terminal' | 'fleet';
  // Terminal facts
  terminalId?: string;       // internal id for action commands
  agentName?: string;        // "Claude"
  agentPrefix?: string;      // "CC"
  agentType?: string;        // "claude" | "codex" | ... — used for usage lookup
  agentIconUri?: string;     // webview URI to PNG logo
  sessionChunk?: string;     // first 8 of session UUID
  fullSessionId?: string;
  /** Owning CLI device; remote paths must open over Remote SSH. */
  sessionHost?: string;
  version?: string;
  label?: string;
  autoLabel?: string;
  account?: string;
  accountLabel?: string;
  // Filesystem
  cwd?: string;
  worktreePath?: string;     // when distinguishable from workspace root
  worktreeName?: string;     // basename shown compactly in the terminal card
  workspaceRoot?: string;
  // Git
  git?: GitInfo;
  // Conversation
  conversation?: ConversationSummary;
  recentActivity?: ActivityItem[];
  // Clean 1–2 line goal (◈ GOAL), distilled by the CLI summarizer from the raw
  // request (PHNX-3939). Falls back to the conversation topic when the CLI has none.
  goal?: string;
  // Live progress checkpoints from the CLI summarizer (most-recent last).
  checkpoints?: RemoteCheckpoint[];
  // The always-on summarizer checklist + its lifecycle. summaryState drives the
  // empty state ('pending' → "summarizing…", else "No checklist yet").
  summaryChecklist?: RemoteTodoItem[];
  summaryState?: 'pending' | 'ready' | 'skipped';
  // The user's own latest genuine request, tidied by the CLI. Falls back to
  // userPromptClean, then the conversation topic — never a synthesized sentence.
  request?: RemoteRequest;
  // The narration-anchored step list the CLI daemon folds. Falls back to
  // `checkpoints` on an older CLI (renderTimelineCard does the fold).
  timeline?: RemoteTimeline;
  // Files the session created / modified / deleted, from the harness's own record.
  files?: Omit<RemoteFiles, 'changes'> & { changes: (RemoteFiles['changes'][number] & { display: string })[] };
  // The FIRST genuine turn, shown inside the Request fold beside the latest one.
  firstRequest?: string;
  // True while the presentation store has seen no `reset` for this subject's
  // scope: the panel says "waiting for the session stream" instead of rendering
  // an authoritative-looking empty card (the 0.9.361-0.9.364 defect).
  streamDegraded?: boolean;
  // The scope the panel is waiting on, named in the degraded card ('local' or a device).
  streamScope?: string;
  // Fine-grained task checklist + done/total, from the agent's latest plan write.
  // Rides the transcript tail already read for recentActivity (no extra I/O).
  todoProgress?: TodoProgress;
  durationMs?: number;
  tokenCount?: number;
  tokPerSec?: number;
  subAgentCount?: number;
  spawnedTeam?: string;
  // Glance header (v3): the session's own title, the running model, and where it runs.
  sessionTitle?: string;
  model?: string;
  project?: string;
  hostLabel?: string;
  // The heavy timeline filters read this machine's session index, so they exist only here.
  sessionLocal?: boolean;
  inWorktree?: boolean;
  startedAtMs?: number;
  lastActivityMs?: number;
  /** The CLI row's lifecycle phase (running, waiting, idle, failed, done). */
  phase?: string;
  /** The session's state and its word, from the shared mapping (`sessionStateOf`). */
  state?: { key: SessionStateKey; word: string };
  // The open attention item in the harness's own words; absent when nothing waits on the user.
  needsYou?: { kind: string; text: string; openedAtMs?: number };
  failures?: RemoteFailure[];
  failedCount?: number;
  blockedCount?: number;
  activityHistogram?: RemoteActivity;
  userTurns?: RemoteUserTurn[];
  subagents?: RemoteSubagent[];
  // Local image attachments the webview may load (inside the CLI's attachment cache).
  imageThumbs?: { path: string; label: string; uri: string }[];
  // Who asked: the owner's name and the Gravatar artifacts-cli also uses.
  requester?: { name: string; avatar: string };
  // `uri` is set for an image on this machine, so the card can show its thumbnail.
  artifacts?: (RemoteSessionArtifact & { display: string; uri?: string })[];
  attachments?: RemoteAttachment[];
  // Linked artifacts — multi-PR (the agent may have opened several in one session)
  linearIssue?: string;
  pullRequests?: PullRequestRef[];
  /** The session's PR as the feed reports it, and the one action the card may offer. */
  prStatus?: RemotePrStatus;
  prAction?: PrAction;
  prRepo?: string;
  // All worktrees attached to the workspace, including the main checkout
  worktrees?: WorktreeRef[];
  // Account usage state — surfaces "out of credits" / "rate limited"
  usageStatus?: 'available' | 'rate_limited' | 'out_of_credits' | null;
  // Plan files
  plan?: { path: string; display: string };
  // Teams
  teams: TeamWithMates[];
  // Derived state — drives state-driven Quick Actions
  agentState?: AgentState;
  // Errors / diagnostics
  teamsError?: string;
}

/**
 * The sidebar's subject: the LAST of { the focused agent terminal's session, a
 * clicked Fleet row }. Presentation state only — module-local, never persisted,
 * never round-tripped through settings or workspaceState. It is stored rather
 * than recomputed so a redraw triggered by something else (a stream fact, a
 * stream row update) cannot silently snap the panel back to the active terminal
 * after the user picked a different session in the Fleet list.
 */
interface PanelSubject {
  sessionId: string;
  /** Stable editor-terminal identity for a terminal-origin subject. */
  terminalId?: string;
  /** Owning device for a Fleet subject; '' when the row is on this machine. */
  host?: string;
  source: 'terminal' | 'fleet';
}

let panelSubject: PanelSubject | undefined;

/** The focused agent terminal, when one is focused and it is an agent tab. */
function activeAgentEntry(): terminals.EditorTerminal | undefined {
  const active = vscode.window.activeTerminal;
  if (!active) return undefined;
  const entry = terminals.getByTerminal(active);
  return entry && entry.agentConfig ? entry : undefined;
}

/**
 * Resolve the subject to render: the stored subject when it still resolves to
 * something (a live terminal, or a row the stream still carries), else the
 * focused agent terminal. `entry` is undefined for a session with no local tab —
 * that renders from the stream row alone.
 */
function resolveSubject(): { sessionId: string; entry?: terminals.EditorTerminal; host?: string; source: 'terminal' | 'fleet' } | undefined {
  const byId = (sessionId: string) =>
    terminals.getAllTerminals().find((e) => e.agentConfig && e.sessionId === sessionId);
  if (panelSubject) {
    if (panelSubject.source === 'terminal') {
      const entry = panelSubject.terminalId ? terminals.getById(panelSubject.terminalId) : undefined;
      if (entry?.agentConfig) {
        return { sessionId: entry.sessionId ?? '', entry, source: 'terminal' };
      }
      // A terminal subject whose exact tab is gone stops being the subject:
      // fall through to whatever is focused now rather than finding a different
      // tab that happens to carry the same session id.
      panelSubject = undefined;
    } else {
      const entry = byId(panelSubject.sessionId);
      return {
        sessionId: panelSubject.sessionId,
        entry,
        ...(panelSubject.host ? { host: panelSubject.host } : {}),
        source: panelSubject.source,
      };
    }
  }
  const entry = activeAgentEntry();
  if (!entry) return undefined;
  return { sessionId: entry.sessionId ?? '', entry, source: 'terminal' };
}

/**
 * Point the sidebar at a session the user clicked in the Fleet list. Called by
 * the settings webview host on the 'session.select' message; the Fleet list keeps
 * the click/expand split (PHNX-3879) so the chevron still expands in place.
 */
export function setAgentPanelSubjectFromFleet(sessionId: string, host?: string): void {
  const id = (sessionId || '').trim();
  if (!id) return;
  panelSubject = { sessionId: id, source: 'fleet', ...(host ? { host } : {}) };
  // Reveal WITHOUT stealing focus, so the click keeps the user in the Fleet list
  // while the preview updates beside it. A direct user action gets a direct
  // refresh (one shot, no timer) rather than the stream-fact coalescer, which
  // would skip entirely while the view was hidden.
  activeProvider?.revealPreservingFocus();
  void activeProvider?.refresh();
}

/**
 * Point the sidebar at the focused agent terminal (the other subject trigger).
 * A tab without a session id yet (Codex, Grok) still takes the subject: the
 * subject is the tab, and resolveSubject reads its id when it lands.
 */
function setSubjectFromActiveTerminal(): void {
  const entry = activeAgentEntry();
  if (!entry) return;
  panelSubject = { sessionId: entry.sessionId ?? '', terminalId: entry.id, source: 'terminal' };
}

/** Forget the subject entirely (dispose, and the reset point for tests). */
export function clearAgentPanelSubject(): void {
  panelSubject = undefined;
}

/**
 * What the sidebar is currently showing, after last-wins resolution: the session,
 * the device that owns it, which trigger picked it, and whether a local terminal
 * backs it. Read-only — this is the same resolution `buildSnapshot` runs, exposed
 * so another surface (and the subject tests) can ask without rebuilding a
 * snapshot. undefined when nothing is focused and nothing was clicked.
 */
export function currentAgentPanelSubject():
  | { sessionId: string; host?: string; source: 'terminal' | 'fleet'; hasTerminal: boolean }
  | undefined {
  const subject = resolveSubject();
  if (!subject) return undefined;
  return {
    sessionId: subject.sessionId,
    ...(subject.host ? { host: subject.host } : {}),
    source: subject.source,
    hasTerminal: !!subject.entry,
  };
}

function computeAgentState(snap: PanelSnapshot): AgentState {
  // Streaming wins over everything: while the session file is actively being
  // written, the agent owns the input — show "Working", hide actions.
  const lastMs = snap.conversation?.lastActivityMs;
  if (lastMs && Date.now() - lastMs < STREAMING_MS) return 'streaming';
  // PR open: once a PR is in flight, the primary action is to surface it.
  if (snap.pullRequests && snap.pullRequests.length > 0) return 'pr_open';
  const dirty = snap.git?.dirtyCount ?? 0;
  if (dirty > 0) return 'idle_dirty';
  if (snap.worktreePath) return 'idle_clean_wt';
  return 'idle_clean';
}

class AgentPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private snapshot: PanelSnapshot = { hasTerminal: false, teams: [] };
  // IN-FLIGHT GUARD (#71): overlapping refreshes (4s poll racing an event-driven
  // refresh, or a slow local-fallback `agents view`) coalesce onto one running
  // build so two snapshot computations never run concurrently.
  private buildInFlight: Promise<PanelSnapshot> | undefined;
  private visible = false;
  private planWatcher: vscode.FileSystemWatcher | undefined;
  private lastWatchedDir: string | undefined;
  // The webview script signals 'ready' once its message listener is attached.
  // Until then, postMessage calls race the iframe load and get dropped — so we
  // queue a single "send current snapshot when ready" flag.
  private webviewReady = false;
  // Handshake-fallback timer (PHNX-3517): re-posts the snapshot until the webview
  // acks, so a single dropped 'ready' can never wedge the panel on "Loading…".
  private readyFallbackTimer: ReturnType<typeof setTimeout> | undefined;

  /** Needed by the Focus / Resume host entry points; set by registerAgentPanel. */
  context?: vscode.ExtensionContext;

  constructor(private readonly extensionUri: vscode.Uri) {}

  // The webview signals 'ready' once its message listener attaches; every
  // refresh() post is gated on it, and postMessage before that attach is
  // silently dropped. If that single 'ready' is ever lost (a script exception,
  // a re-resolve resetting the flag, a dropped message) the old code left
  // "Loading…" up forever with no recovery. Re-post the current snapshot on a
  // short timer, a bounded number of times, until the webview acks — bridging a
  // lost handshake or a listener that attached a beat after our first post.
  private scheduleReadyFallback(attempt = 0): void {
    if (this.readyFallbackTimer) { clearTimeout(this.readyFallbackTimer); this.readyFallbackTimer = undefined; }
    if (this.webviewReady || !this.view || attempt >= 8) return;
    this.readyFallbackTimer = setTimeout(() => {
      this.readyFallbackTimer = undefined;
      if (this.webviewReady || !this.view) return;
      this.view.webview.postMessage({ type: 'snapshot', data: this.snapshot });
      this.scheduleReadyFallback(attempt + 1);
    }, 250);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;
    // Each fresh resolve gets a fresh iframe — its listener has not attached
    // yet, so any cached "ready" state from a previous mount is invalid.
    this.webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      // Pasted images live in the CLI's attachment cache; artifact thumbnails are
      // images under home that the stream row names. Roots are fixed here because
      // changing them later reloads the webview.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'assets'), vscode.Uri.file(ATTACHMENT_CACHE_DIR), vscode.Uri.file(os.homedir())],
    };

    webviewView.webview.html = this.renderShell(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));

    webviewView.onDidChangeVisibility(() => {
      this.visible = webviewView.visible;
      // A visible active-session sidebar is demand for the canonical session
      // stream (PHNX-3939) even with no terminals in this window.
      sessionStreamDemand.setSidebarVisible(webviewView.visible);
      if (webviewView.visible) void this.refresh();
    });

    webviewView.onDidDispose(() => {
      this.disposePlanWatcher();
      if (this.readyFallbackTimer) { clearTimeout(this.readyFallbackTimer); this.readyFallbackTimer = undefined; }
      this.view = undefined;
      this.visible = false;
      sessionStreamDemand.setSidebarVisible(false);
    });

    this.visible = webviewView.visible;
    sessionStreamDemand.setSidebarVisible(webviewView.visible);
    void this.refresh();
    // Guarantee a paint even if the webview's 'ready' handshake is lost.
    this.scheduleReadyFallback();
  }

  private async handleMessage(msg: any): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        this.webviewReady = true;
        if (this.readyFallbackTimer) { clearTimeout(this.readyFallbackTimer); this.readyFallbackTimer = undefined; }
        this.view?.webview.postMessage({ type: 'snapshot', data: this.snapshot });
        void this.refresh();
        return;
      case 'openPath':
        if (typeof msg.path === 'string') {
          // A pasted image is on this machine even when the agent runs elsewhere.
          const uri = isInside(msg.path, PASTED_ATTACHMENT_DIR) ? vscode.Uri.file(msg.path) : sessionPathUri(msg.path, this.snapshot.sessionHost);
          vscode.commands.executeCommand('vscode.open', uri);
        }
        return;
      case 'openArtifact':
        if (typeof msg.path === 'string') {
          const named = (this.snapshot.artifacts ?? []).some((a) => a.path === msg.path) || this.snapshot.plan?.path === msg.path;
          await openSessionArtifact(msg.path, this.snapshot.sessionHost, named);
        }
        return;
      case 'loadTimelineFilter':
        await this.loadTimelineFilter(msg.role, msg.sessionId);
        return;
      case 'prAction':
        await this.runPrAction(msg.action);
        return;
      case 'openWorktree':
        // Worktree paths are DIRECTORIES — `vscode.open` shows an error toast
        // for directories. Open as a folder in a new window instead so the
        // user lands inside the parallel agent's checkout.
        if (typeof msg.path === 'string') {
          vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.path), {
            forceNewWindow: true,
          });
        }
        return;
      case 'revealCwd':
        if (typeof msg.path === 'string') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
        }
        return;
      case 'copySessionId':
        if (this.snapshot.fullSessionId) {
          await vscode.env.clipboard.writeText(this.snapshot.fullSessionId);
          this.view?.webview.postMessage({ type: 'sessionIdCopied' });
        }
        return;
      case 'openUrl':
        if (typeof msg.url === 'string') {
          openExternalUrl(msg.url);
        }
        return;
      case 'openSourceControl':
        vscode.commands.executeCommand('workbench.view.scm');
        return;
      case 'refresh':
        void this.refresh();
        return;
      case 'runQuickAction':
        await this.runQuickAction(msg.action, msg.terminalId, msg.url);
        return;
      case 'replyToSession':
        await this.replyToSession(
          typeof msg.text === 'string' ? msg.text : '',
          typeof msg.terminalId === 'string' ? msg.terminalId : undefined,
        );
        return;
      case 'insertPathInTerminal':
        if (typeof msg.path === 'string' && msg.path) {
          const t = msg.terminalId ? terminals.getById(msg.terminalId)?.terminal : vscode.window.activeTerminal;
          if (t) {
            t.show(true);
            t.sendText(msg.path, false);
          }
        }
        return;
    }
  }

  /**
   * A heavy timeline filter (agent messages, reasoning, tool calls) is too big to
   * ride every stream row, so it is one `agents sessions <id> --include <role>`
   * call per explicit click, never per selection. The result goes back to the
   * webview as-is; a CLI error is shown, not hidden.
   */
  private async loadTimelineFilter(role: unknown, requested: unknown): Promise<void> {
    const sessionId = typeof requested === 'string' ? requested : '';
    const reply = (body: { items?: unknown; error?: string }) => {
      if (typeof role !== 'string' || !sessionId) return;
      this.view?.webview.postMessage({ type: 'timelineFilter', role, sessionId, ...body });
    };
    // Every return answers the webview. A cleared cache paints "Loading…", and
    // a silent return leaves that line up with no fetch in flight.
    if (typeof role !== 'string' || !VERB_FILTER_ROLES.has(role) || !sessionId) {
      reply({ error: 'That filter is not available.' });
      return;
    }
    if (requested !== this.snapshot.fullSessionId) {
      reply({ error: 'Session changed before the filter loaded.' });
      return;
    }
    if (!this.snapshot.sessionLocal) {
      reply({ error: 'This session is on another machine.' });
      return;
    }
    reply(await fetchTimelineFilter(role, sessionId));
  }

  /**
   * One verb per click, pinned to the head commit the panel showed. The host
   * re-decides the action from its own snapshot (the webview only asks), confirms
   * in a modal, then runs `agents projects prs merge|automerge … --sha <head>`.
   * Never --admin: branch protection stays in force.
   */
  private async runPrAction(requested: unknown): Promise<void> {
    // One action at a time: a second click while a dialog or a merge is open is ignored.
    if (this.prActionBusy) return;
    this.prActionBusy = true;
    try {
      await this.decideAndRunPrAction(requested);
    } finally {
      this.prActionBusy = false;
    }
  }

  private async decideAndRunPrAction(requested: unknown): Promise<void> {
    const pr = this.snapshot.prStatus;
    const plan = prAction(pr);
    if (!pr || !pr.headSha || (requested !== 'merge' && requested !== 'automerge') || plan.kind !== requested) {
      void vscode.window.showWarningMessage('That pull request action is no longer available' + (plan.reason ? ': ' + plan.reason : '') + '.');
      return;
    }
    const repo = prRepo(pr.url);
    const project = this.snapshot.project;
    if (!repo || !project) {
      void vscode.window.showWarningMessage(`Cannot ${requested === 'merge' ? 'merge' : 'turn on auto-merge for'} #${pr.number}: ${!repo ? 'its URL is not a GitHub pull request' : 'this session has no project'}.`);
      return;
    }
    const head = pr.headSha.slice(0, 7);
    const label = requested === 'merge' ? 'Merge' : 'Turn on auto-merge';
    const ask = requested === 'merge'
      ? `Merge ${repo}#${pr.number}${pr.title ? ` "${pr.title}"` : ''} at ${head}?`
      : `Merge ${repo}#${pr.number} by itself once its required checks pass? Pinned to ${head}; GitHub refuses if the branch moves.`;
    if (await vscode.window.showWarningMessage(ask, { modal: true }, label) !== label) return;
    // The row may have moved while the dialog was open (a check went red, changes
    // were requested, a new commit landed): run only if it is still the same PR at
    // the same head and the same action is still the right one.
    const now = this.snapshot.prStatus;
    const still = prAction(now);
    if (!now || now.url !== pr.url || now.headSha !== pr.headSha || still.kind !== requested) {
      void vscode.window.showWarningMessage(`Did not ${requested === 'merge' ? 'merge' : 'turn on auto-merge for'} ${repo}#${pr.number}: it changed while the dialog was open${still.reason ? ' (' + still.reason + ')' : ''}.`);
      return;
    }
    try {
      await runAgents(`projects prs ${requested} ${shellQuote(project)} --repo ${shellQuote(repo)} --number ${pr.number} --sha ${shellQuote(pr.headSha)}`, { timeout: 60_000 });
      void vscode.window.showInformationMessage(requested === 'merge' ? `Merged ${repo}#${pr.number}.` : `Auto-merge is on for ${repo}#${pr.number}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n').slice(0, 3).join(' ') : String(err);
      void vscode.window.showErrorMessage(`${label} failed: ${message}`);
    }
  }

  private prActionBusy = false;

  private async runQuickAction(
    action: string,
    terminalId: string | undefined,
    url: string | undefined,
  ): Promise<void> {
    const entry = terminalId ? terminals.getById(terminalId) : undefined;
    const terminal = entry?.terminal ?? vscode.window.activeTerminal;
    // Claude's Ink TUI submits on \r; Codex submit on the \n that
    // sendText(_, true) appends. Centralized here so action handlers below
    // don't duplicate the gotcha.
    const sendSlash = (slash: string) => {
      if (!terminal) return false;
      terminal.show(true);
      if (entry?.agentType === 'claude') {
        terminal.sendText(slash, false);
        terminal.sendText('\r', false);
      } else {
        terminal.sendText(slash, true);
      }
      return true;
    };
    switch (action) {
      case 'setSessionId':
        if (this.snapshot.hasTerminal && terminalId) {
          try {
            await vscode.commands.executeCommand('agents.setSessionId', { terminalId });
          } catch {
            void vscode.window.showWarningMessage('Set Session ID failed. Check that the extension build includes this command.');
          }
        }
        return;
      // Focus shows the panel's own tab, even one whose session id has not resolved.
      // Otherwise Focus and ↻ Resume are the one resume action the picker and Fleet
      // use (resumeSession.vscode.ts): a tab already showing the session comes to the
      // front, else the live agent opens in the window that owns its project.
      case 'focusSubject':
      case 'resumeSubject': {
        if (action === 'focusSubject' && terminal) { terminal.show(true); return; }
        const sessionId = this.snapshot.fullSessionId;
        if (!sessionId) return;
        const { resumeAndNotify } = require('./resumeSession.vscode') as typeof import('./resumeSession.vscode');
        await resumeAndNotify({ sessionId, host: this.snapshot.sessionHost ?? '', title: this.snapshot.sessionTitle ?? '' });
        return;
      }
      case 'openPr':
        if (typeof url === 'string') {
          openExternalUrl(url);
        }
        return;
      case 'diff':
        vscode.commands.executeCommand('workbench.view.scm');
        return;
      case 'slash':
        // url field carries the slash command text (e.g. "/commit", "/done").
        // Reused over a new field so the existing webview->host message shape
        // stays unchanged.
        if (typeof url === 'string' && url.startsWith('/')) {
          if (!sendSlash(url)) {
            vscode.window.showInformationMessage('No active agent terminal.');
          }
        }
        return;
    }
  }

  /**
   * Deliver a reply into the subject session. The only injectable channel the
   * sidebar owns is the session's own editor-tab terminal, over the shared rail
   * the Fleet reply box used (`sessionReply.ts`). A subject with no local tab has
   * no channel: say so inline rather than dropping the text silently.
   */
  private async replyToSession(text: string, terminalId: string | undefined): Promise<void> {
    const body = text.trim();
    const post = (ok: boolean, error?: string) =>
      this.view?.webview.postMessage({ type: 'replyResult', ok, ...(error ? { error } : {}) });
    if (!body) { post(false, 'Reply text is empty'); return; }
    const entry = terminalId ? terminals.getById(terminalId) : undefined;
    if (!entry) {
      post(false, 'This session has no terminal here — press Focus first, then reply.');
      return;
    }
    try {
      sendReplyToTerminal(entry, body);
      post(true);
    } catch (err) {
      post(false, err instanceof Error ? err.message : String(err));
    }
  }

  // Public so the extension can poke a refresh on terminal lifecycle events
  // (open / close / active change) without us subscribing to them here.
  async refresh(): Promise<void> {
    if (!this.view) return;
    this.snapshot = await this.runBuildSnapshot();
    this.syncPlanWatcher(this.snapshot.cwd);
    if (this.webviewReady) {
      this.view.webview.postMessage({ type: 'snapshot', data: this.snapshot });
    }
    // If not ready, snapshot stays cached; the 'ready' handler will push it.
  }

  /** Show the sidebar without taking keyboard focus from whatever opened it. */
  revealPreservingFocus(): void {
    this.view?.show(true);
  }

  // Called from the session CLI stream fact handler (PHNX-2833) — skip the
  // rebuild when nothing is on screen to see it, same gate the removed 4s
  // poll timer used to apply via startPolling/stopPolling.
  async refreshIfVisible(): Promise<void> {
    if (!this.visible) return;
    await this.refresh();
  }

  private disposePlanWatcher(): void {
    if (this.planWatcher) {
      this.planWatcher.dispose();
      this.planWatcher = undefined;
      this.lastWatchedDir = undefined;
    }
  }

  // Reset the PLAN.md watcher when the focused terminal's cwd changes.
  private syncPlanWatcher(cwd: string | undefined): void {
    if (cwd === this.lastWatchedDir) return;
    this.disposePlanWatcher();
    if (!cwd) return;
    const pattern = new vscode.RelativePattern(cwd, 'PLAN.md');
    this.planWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = () => void this.refresh();
    this.planWatcher.onDidChange(onChange);
    this.planWatcher.onDidCreate(onChange);
    this.planWatcher.onDidDelete(onChange);
    this.lastWatchedDir = cwd;
  }

  // Coalesce concurrent builds onto one running computation (in-flight guard).
  private runBuildSnapshot(): Promise<PanelSnapshot> {
    if (this.buildInFlight) return this.buildInFlight;
    const p = this.buildSnapshot().finally(() => {
      if (this.buildInFlight === p) this.buildInFlight = undefined;
    });
    this.buildInFlight = p;
    return p;
  }

  private async buildSnapshot(): Promise<PanelSnapshot> {
    // The subject — the focused agent terminal OR the clicked Fleet row, last
    // wins. A Fleet subject with no local tab still renders: everything the card
    // needs is on the stream row.
    const subject = resolveSubject();
    if (!subject) {
      return { hasTerminal: false, hasSubject: false, teams: [] };
    }
    const entry = subject.entry;

    const opts = entry?.terminal.creationOptions as vscode.TerminalOptions | undefined;
    const env = opts?.env as Record<string, string | undefined> | undefined;
    const envWorkspaceDir = env?.AGENT_WORKSPACE_DIR?.trim() || undefined;
    const cwdRaw = opts?.cwd;
    let cwd =
      typeof cwdRaw === 'string'
        ? cwdRaw
        : cwdRaw && 'fsPath' in cwdRaw
          ? (cwdRaw as vscode.Uri).fsPath
          : envWorkspaceDir;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const worktreePath = cwd && workspaceRoot && path.resolve(cwd) !== path.resolve(workspaceRoot) ? cwd : undefined;
    const worktreeName = cwd ? path.basename(cwd) : undefined;


    const sessionId = subject.sessionId || entry?.sessionId;
    const sessionChunk = sessionId ? sessionId.slice(0, 8) : undefined;

    const snapshot: PanelSnapshot = {
      hasTerminal: !!entry,
      hasSubject: true,
      subjectSource: subject.source,
      terminalId: entry?.id,
      agentName: entry?.agentConfig?.title,
      agentPrefix: entry?.agentConfig?.prefix,
      agentType: entry?.agentType,
      agentIconUri: this.iconUriFor(entry?.agentConfig?.prefix),
      sessionChunk,
      fullSessionId: sessionId,
      sessionHost: subject.host,
      version: entry?.statusVersion || entry?.version,
      label: entry?.label,
      autoLabel: entry?.autoLabel,
      account: entry?.statusAccount || entry?.account,
      cwd,
      worktreePath,
      worktreeName,
      workspaceRoot,
      teams: [],
    };

    // ── Fill from the CLI-normalized session stream (PHNX-3517) ─────────────
    // Everything a tab-switch needs to paint — what the agent is doing now, its
    // todo checklist, topic, last message, PR, branch — is already in memory,
    // NORMALIZED by the CLI-mirror (`presentedSessions` → RemoteSession), off the
    // `agents sessions watch --json` stream the Fleet already consumes. Read it
    // SYNCHRONOUSLY (no subprocess) and reuse the SAME normalized fields every
    // other surface reads — the ext never re-derives them from the raw row. The
    // old path spawned `agents sessions … --include tools` + `agents teams
    // status` per team on EVERY switch (2-8 subprocesses), which behind the
    // all-or-nothing snapshot wedged the panel on "Loading…" for seconds.
    if (sessionId) {
      const live = findLiveSession(sessionId, subject.host);
      if (live) {
        // The card fields the Fleet card shares (src/core/sessionCardFields.ts).
        const view = this.view;
        const card = sessionCardFields(live, {
          sessionId, cwd, home: os.homedir(), remoteDevice: remoteDeviceArg(live.host),
          previewUri: view ? (p) => view.webview.asWebviewUri(vscode.Uri.file(p)).toString() : undefined,
        });
        snapshot.sessionHost = live.host;
        snapshot.conversation = {
          topic: live.topic || undefined,
          lastMessage: live.lastResponse || undefined,
          messageCount: 0,
          lastActivityMs: live.lastActivityMs || undefined,
        };
        if (card.linearIssue) snapshot.linearIssue = card.linearIssue;

        // Goal + Checklist (PHNX-3939) — synchronous field copies from the warm
        // row. NO await, NO fetch: the tab-switch path must stay instant, so these
        // read only what the stream already carries (the checklist falls back to
        // the live TodoWrite list).
        //
        // Goal NO LONGER falls back to the topic: the Request card below now shows
        // the user's own words, so a Goal that is just the topic re-stated the same
        // line twice. Goal is the summarizer's distillation or nothing.
        snapshot.goal = live.goal || undefined;
        snapshot.checkpoints = live.checkpoints ?? [];
        snapshot.summaryState = live.summaryState;

        // Request / Timeline / Files (PHNX-3939 follow-up) — the same synchronous
        // field copy. Each falls back honestly when the CLI is older: the Request
        // card drops to userPromptClean then topic, the Timeline card to
        // `checkpoints`, and the Files card renders nothing at all rather than
        // guessing from the filesystem.
        snapshot.request = live.request;
        snapshot.timeline = live.timeline;
        const pathOptions = card.pathOptions;
        snapshot.files = live.files ? { ...live.files, changes: live.files.changes.map((change) => ({ ...change, display: displayPath(change.path, pathOptions) })) } : undefined;
        snapshot.firstRequest = live.firstUserMessage || undefined;
        const summaryChecklist = live.summaryChecklist ?? live.todos ?? [];
        snapshot.summaryChecklist = summaryChecklist;

        // Checklist — already the CLI-normalized RemoteTodoItem[]; just tally it.
        const todos = todoProgressFromItems(summaryChecklist);
        if (todos) snapshot.todoProgress = todos;

        // "What's being worked on": the CLI's computed one-line `activity`, else
        // the recent-turn tail.
        if (live.activity && live.activity.trim()) {
          snapshot.recentActivity = [{ kind: 'working', summary: live.activity.trim(), ts: Date.now() }];
        } else if (live.tail.length && (entry?.agentType || live.agentType)) {
          snapshot.recentActivity = collectRecentActivity(live.tail, entry?.agentType || live.agentType, 5);
        }

        // PR: the CLI already extracted the url — structure it, don't re-scan.
        if (card.pullRequests) snapshot.pullRequests = card.pullRequests;
        if (live.prStatus) {
          snapshot.prStatus = live.prStatus;
          snapshot.prAction = prAction(live.prStatus);
          snapshot.prRepo = prRepo(live.prStatus.url);
        }

        // A Fleet subject has no local tab, so the agent identity, cwd and host
        // come off the same row instead of the terminal's creation options.
        if (!entry) {
          snapshot.agentType = snapshot.agentType || live.agentType;
          const def = BUILT_IN_AGENTS.find((a) => a.key === live.agentType);
          if (def) {
            snapshot.agentName = snapshot.agentName || def.title;
            snapshot.agentPrefix = snapshot.agentPrefix || def.prefix;
            snapshot.agentIconUri = snapshot.agentIconUri || this.iconUriFor(def.prefix);
          }
          snapshot.label = snapshot.label || live.label || undefined;
          if (!snapshot.cwd && live.cwd) {
            cwd = live.cwd;
            snapshot.cwd = live.cwd;
            snapshot.worktreeName = path.basename(live.cwd);
          }
        }
        if (live.branch) snapshot.git = { branch: live.branch };
        snapshot.durationMs = live.durationMs ?? live.sinceMs;
        snapshot.tokenCount = live.tokenCount;
        snapshot.tokPerSec = live.tokPerSec;
        snapshot.subAgentCount = live.subAgentCount;
        snapshot.spawnedTeam = live.spawnedTeam || live.teamName || undefined;
        snapshot.artifacts = card.artifacts;
        if (card.plan) snapshot.plan = card.plan;
        snapshot.attachments = live.attachments;
        const remoteDevice = remoteDeviceArg(live.host);
        snapshot.sessionTitle = live.title || live.label || undefined;
        snapshot.model = live.model;
        snapshot.project = live.project || undefined;
        snapshot.hostLabel = remoteDevice || os.hostname().split('.')[0];
        snapshot.sessionLocal = card.sessionLocal;
        snapshot.inWorktree = !!live.worktreeSlug;
        snapshot.startedAtMs = live.startedAtMs || undefined;
        snapshot.lastActivityMs = live.lastActivityMs || undefined;
        snapshot.phase = live.phase;
        const stateKey = sessionStateOf(live);
        snapshot.state = { key: stateKey, word: SESSION_STATE_WORD[stateKey] };
        if (card.needsYou) snapshot.needsYou = card.needsYou as PanelSnapshot['needsYou'];
        snapshot.failures = live.failures;
        snapshot.failedCount = live.failures ? live.failures.filter((f) => !f.blocked).length : live.timeline?.failed;
        snapshot.blockedCount = live.failures ? live.failures.filter((f) => f.blocked).length : undefined;
        snapshot.activityHistogram = live.activityHistogram;
        snapshot.userTurns = live.userTurns;
        snapshot.subagents = live.subagents;
        if (live.subagents) snapshot.subAgentCount = live.subagents.length;
        const webview = this.view?.webview;
        if (live.owner && live.owner.includes('@')) {
          const email = live.owner.trim().toLowerCase();
          snapshot.requester = {
            name: email.split('@')[0],
            avatar: 'https://www.gravatar.com/avatar/' + createHash('sha256').update(email).digest('hex') + '?d=404&s=40',
          };
        }
        if (webview) {
          snapshot.imageThumbs = requestImageThumbs(live, {
            home: os.homedir(),
            remoteDevice,
            exists: (p) => fs.existsSync(p),
            previewUri: (p) => webview.asWebviewUri(vscode.Uri.file(p)).toString(),
          });
        }
      }

      // version + account aren't on the normalized RemoteSession; the store
      // exposes them per id from the same stream (RUSH-2205 / RUSH-3184), moved
      // off a per-tab spawn to kill the 2026-08-25 CPU incident.
      const identity = sessionPresentationStore.liveSession(sessionId);
      if (identity) {
        if (identity.version) snapshot.version = identity.version;
        if (identity.account) snapshot.account = identity.account;
        snapshot.accountLabel = identity.accountLabel ?? undefined;
        if (!snapshot.conversation?.topic && identity.topic) {
          snapshot.conversation = { ...(snapshot.conversation ?? { messageCount: 0 }), topic: identity.topic };
        }
      }
    }

    // git dirtyCount drives the idle_dirty state; branch came warm above. This is
    // the in-process vscode.git API (no subprocess), so it stays on the fast path.
    if (cwd) {
      try {
        const git = await readGitInfo(cwd);
        snapshot.git = { branch: snapshot.git?.branch ?? git?.branch, dirtyCount: git?.dirtyCount };
      } catch { /* best-effort */ }
    }

    // Worktrees + usage are STORE reads (no spawn) — kept on the fast path.
    if (workspaceRoot) {
      try {
        snapshot.worktrees = await getWorktreesRouted(workspaceRoot, cwd);
      } catch { /* best-effort */ }
    }
    if (snapshot.agentType) {
      try {
        snapshot.usageStatus = getUsageStatusFromCli(sessionId);
      } catch { /* best-effort */ }
    }

    // Degraded state (PHNX-3939): the store has heard no `reset` for the scope
    // this session lives on, so nothing here is authoritative yet. Say so —
    // 0.9.361-0.9.364 rendered "No checklist yet" for a stream that was not
    // running at all. Scope names the device the row would arrive from, matching
    // how the CLI scopes a peer (`normalizeHost(device.name)`).
    // A REMOTE subject is asked for by name: its rows only ever arrive on that
    // device's own scope, so "some other scope reset" says nothing about it. A
    // local subject uses the bare form, because the local scope key on the wire
    // is the CLI's `machineId()` (e.g. 'yosemite-s1'), which the extension has no
    // business re-deriving — "has the stream established at all" is the honest
    // question there.
    const deviceScope = normalizeHost(subject.host || '');
    const isRemote = !!deviceScope
      && deviceScope !== LOCAL_MACHINE_ID
      && deviceScope !== normalizeHost(LOCAL_LABEL);
    snapshot.streamScope = isRemote ? deviceScope : 'this machine';
    snapshot.streamDegraded = isRemote
      ? !sessionPresentationStore.hasSeenReset(deviceScope)
      : !sessionPresentationStore.hasSeenReset();

    // The full teammate DAG is NOT on the warm stream, and its per-team
    // `agents teams status` spawns are exactly what made a tab-switch slow. It is
    // dropped from the hot render path (PHNX-3517): `spawnedTeam`/`teamName` on
    // the stream already flag membership, and the Fleet panel owns the DAG view.
    snapshot.teams = [];

    snapshot.agentState = computeAgentState(snapshot);
    return snapshot;
  }

  private iconUriFor(prefix: string | undefined): string | undefined {
    if (!prefix || !this.view) return undefined;
    const def = BUILT_IN_AGENTS.find(
      (a) => a.prefix === prefix || a.prefix.toUpperCase() === (prefix ?? '').toUpperCase(),
    );
    if (!def) return undefined;
    const onDisk = vscode.Uri.joinPath(this.extensionUri, 'assets', def.icon);
    return this.view.webview.asWebviewUri(onDisk).toString();
  }

  private renderShell(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const cspSource = webview.cspSource;
    const fontUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'fonts', file)).toString();
    const fontJost = fontUri('jost-var.woff2');
    const fontInter = fontUri('InterVariable.woff2');
    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${cspSource} https: data:; font-src ${cspSource}; connect-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
${sessionPanelCss(sessionPanelFontFaces(fontJost, fontInter))}
</style>
</head>
<body>
<div id="root">
  <div class="empty">Loading...</div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const viewState = vscode.getState() || {};
const root = document.getElementById('root');

${SESSION_CARDS_SCRIPT}
function compactTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1) + 'm tok';
  if (value >= 1000) return Math.round(value / 1000) + 'k tok';
  return Math.round(value) + ' tok';
}

function prettyModel(id) {
  if (!id) return '';
  const m = id.match(/^claude-(opus|sonnet|haiku|fable)-(\\d+)-(\\d+)/);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2] + '.' + m[3];
  return id;
}

function renderTerminalCard(s) {
  const logo = s.agentIconUri
    ? '<img class="agent-logo" src="' + esc(s.agentIconUri) + '" alt="' + esc(s.agentName || '') + '" title="' + esc(s.agentName || '') + '" />'
    : '';
  // The title is WHAT the session is: a /rename, else the generated title, else
  // the tab label. The harness icon already says which agent it is.
  const title = s.sessionTitle || s.label || s.autoLabel || s.agentName || 'Agent';
  let usageBadge = '';
  if (s.usageStatus === 'out_of_credits') {
    usageBadge = '<span class="usage-badge usage-out">⚠ out of credits</span>';
  } else if (s.usageStatus === 'rate_limited') {
    usageBadge = '<span class="usage-badge usage-rate">⚠ rate-limited</span>';
  }
  const who = [];
  if (s.model) who.push('<b class="model-name" title="' + esc(s.model) + '">' + esc(prettyModel(s.model)) + '</b>');
  if (s.accountLabel || s.account) who.push('<span title="' + esc(s.account || '') + '">' + esc(s.accountLabel ?? s.account) + '</span>');
  // The host stays on the face of the card: where it runs is what you act on.
  const host = s.hostLabel ? '<span class="where-chip mono">' + esc(s.hostLabel) + '</span>' : '';
  const whoRow = who.length || usageBadge || host ? '<div class="account-row">' + who.join(' · ') + host + usageBadge + '</div>' : '';
  const following = s.subjectSource === 'fleet' && !s.hasTerminal
    ? '<div class="account-row">following the Fleet selection</div>'
    : '';

  // ⋯ menu: the session id (copy, and the pencil that rebinds a tab, offered even
  // before the harness reports an id), project, branch, worktree, start time,
  // tokens, and the raw identity lines. Its open state is remembered.
  const menu = [];
  const pencil = s.hasTerminal && s.terminalId
    ? '<button type="button" class="head-btn small" data-action="setSessionId" title="Set session ID for terminal" aria-label="Set session ID for terminal">✎</button>'
    : '';
  if (s.sessionChunk || pencil) {
    menu.push(['Session', (s.sessionChunk ? '<button type="button" class="session-chunk" id="copy-session" title="Copy full session ID" aria-label="Copy full session ID">' + esc(s.sessionChunk) + '</button>' : '<span class="menu-v">not reported yet</span>') + pencil]);
  }
  const branch = s.git && s.git.branch;
  const chips = [];
  if (s.project) chips.push('<span class="where-chip proj">' + esc(s.project) + '</span>');
  if (branch) chips.push('<button type="button" class="where-chip mono" data-scm title="Open Source Control">⎇ ' + esc(branch) + '</button>');
  if (s.inWorktree) chips.push('<span class="where-chip wt" title="' + esc(s.cwd || '') + '">worktree</span>');
  if (s.git && s.git.dirtyCount > 0) chips.push('<button type="button" class="dirty-pill" data-scm>' + s.git.dirtyCount + ' changed</button>');
  if (chips.length) menu.push(['Where', '<span class="where-row">' + chips.join('') + '</span>']);
  if (s.startedAtMs) menu.push(['Started', esc(clockTime(s.startedAtMs))]);
  const tokens = [compactTokens(s.tokenCount), s.tokPerSec > 0 ? Math.round(s.tokPerSec) + ' tok/s' : ''].filter(Boolean).join(' · ');
  if (tokens) menu.push(['Tokens', esc(tokens)]);
  const identity = [((s.agentType || s.agentName || '') + ' ' + (s.version || '')).trim(), s.model, s.fullSessionId, s.cwd, s.sessionHost].filter(Boolean);
  const menuBody =
    menu.map((row) => '<div class="menu-row"><span class="menu-k">' + esc(row[0]) + '</span><span class="menu-v">' + row[1] + '</span></div>').join('') +
    (identity.length ? '<div class="session-details">' + identity.map((value) => '<div>' + esc(value) + '</div>').join('') + '</div>' : '');
  const menuBtn = menuBody
    ? '<summary class="head-btn menu-btn" aria-label="Session details" title="Session details">⋯</summary>'
    : '';
  const actions =
    '<div class="head-actions">' +
      (s.fullSessionId
        ? '<button type="button" class="head-btn" data-action="focusSubject" aria-label="Focus session" title="Focus session">◎</button>' +
          '<button type="button" class="head-btn" data-action="resumeSubject" aria-label="Resume session" title="Resume session">↻</button>'
        : '') +
    '</div>';
  return (
    '<div class="card head-card">' +
      '<div class="agent-head">' +
        '<div class="agent-head-text">' +
          '<div class="title-line">' + logo + '<div class="title-row session-title" title="' + esc(title) + '">' + esc(title) + '</div></div>' +
          whoRow +
          following +
        '</div>' +
        actions +
      '</div>' +
      '<details id="session-details" class="head-menu"' + (viewState.detailsOpen ? ' open' : '') + '>' +
        menuBtn +
        '<div class="menu-panel">' + menuBody + '</div>' +
      '</details>' +
    '</div>'
  );
}

const NEEDS_YOU_LABEL = { question: 'Asks', permission: 'Needs permission', plan_review: 'Plan ready for review', declared: 'Needs you', failure: 'Failed', stall: 'Stalled', review: 'Ready for review' };

// The harness's own open ask, under the header so you see who is asking first.
function renderNeedsYou(s) {
  const n = s.needsYou;
  if (!n) return '';
  const label = NEEDS_YOU_LABEL[n.kind] || 'Needs you';
  const waited = n.openedAtMs ? ' · waiting ' + relTime(n.openedAtMs).replace(' ago', '') : '';
  return (
    '<div class="needs-you">' +
      '<div class="needs-you-k">' + esc(label.toUpperCase() + waited.toUpperCase()) + '</div>' +
      (n.text ? '<div class="needs-you-t">' + renderInlineMarkdown(truncate(n.text, 400)) + '</div>' : '') +
      '<div class="needs-you-btns">' +
        '<button type="button" class="ny-btn primary" id="needs-you-reply">Reply…</button>' +
        (s.hasTerminal ? '<button type="button" class="ny-btn" data-action="focusSubject">Focus terminal</button>' : '') +
      '</div>' +
    '</div>'
  );
}
// The word comes from the host (sessionStateOf, src/shared/sessionState.ts) so the
// sidebar, the Project panel and Fleet say the same thing for the same row.
function sessionState(s) {
  const st = s.state || { key: 'unknown', word: 'Unknown' };
  const cls = st.key === 'asks' ? 'waiting' : st.key === 'working' ? 'running' : st.key === 'stopped' ? 'failed' : 'idle';
  return { cls, word: st.word };
}

function renderSessionStats(s) {
  const span = s.durationMs > 0 ? s.durationMs : (s.startedAtMs ? Date.now() - s.startedAtMs : 0);
  const age = compactDuration(span);
  if (!age && !s.lastActivityMs) return '';
  const st = sessionState(s);
  const ran = age ? (st.cls === 'running' ? ' <b>' + esc(age) + '</b>' : ' · ran <b>' + esc(age) + '</b>') : '';
  const active = s.lastActivityMs ? ' · active <b>' + esc(relTime(s.lastActivityMs)) + '</b>' : '';
  return '<div class="session-stats state-' + st.cls + '"><span class="state-dot"></span>' + esc(st.word) + ran + active + '</div>';
}

// Failures stay out of the way: one quiet line only when something failed, and
// the list opens on a click. A clean session shows nothing here.
function renderFailures(s) {
  const failed = s.failedCount || 0;
  const blocked = s.blockedCount || 0;
  if (!failed && !blocked) return '';
  const bits = [];
  if (failed) bits.push(failed + ' failed');
  if (blocked) bits.push(blocked + ' blocked');
  const list = s.failures || [];
  const row = (f) => (
    '<div class="fail-row">' +
      '<span class="fail-at" title="' + esc(new Date(f.atMs).toLocaleString()) + '">' + esc(clockTime(f.atMs)) + '</span>' +
      '<div class="fail-body"><div class="fail-cmd" title="' + esc(f.summary) + '">' + esc((f.tool ? f.tool + ': ' : '') + f.summary) + '</div>' +
      '<div class="fail-err">' + esc(f.error) + '</div></div>' +
    '</div>'
  );
  const realRows = list.filter((f) => !f.blocked).slice().reverse().map(row).join('');
  const blockedList = list.filter((f) => f.blocked);
  const blockedRows = blockedList.length
    ? '<details class="fail-blocked"><summary>' + blockedList.length + ' blocked by policy or permission</summary>' + blockedList.slice().reverse().map(row).join('') + '</details>'
    : '';
  const body = list.length ? realRows + blockedRows : '<div class="card-note">This CLI reports only the counts. Upgrade agents-cli for the list.</div>';
  return (
    '<details class="failures"' + (viewState.failuresOpen ? ' open' : '') + ' id="failures">' +
      '<summary>⚠ ' + esc(bits.join(' · ')) + ' <span class="failures-show">Show</span></summary>' +
      '<div class="fail-list">' + body + '</div>' +
    '</details>'
  );
}
function renderActionsCard(s) {
  if (!s.cwd) return '';
  const state = s.agentState || 'idle_clean';

  // Streaming: agent is actively producing output. Sending a slash command
  // mid-stream would corrupt the prompt. Render a passive "Working..." pill
  // so the slot doesn't collapse.
  if (state === 'streaming') {
    return (
      '<h2>Quick actions</h2>' +
      '<div class="card"><div class="working-pill"><span class="pulse-dot"></span>Working...</div></div>'
    );
  }

  const dirty = (s.git && s.git.dirtyCount) || 0;

  // Chips are the slash commands they actually send. Click injects the
  // command into the focused terminal via the 'slash' action (handled in
  // runQuickAction). One chip is marked primary based on the current
  // agent state so the recommended next step stands out.
  const SLASH_COMMANDS = ['/commit', '/done', '/next', '/finish', '/test', '/review'];

  // Recommended chip by state:
  //   dirty tree         -> /commit
  //   in worktree, clean -> /done (wrap up)
  //   plain idle         -> /next
  let recommended;
  switch (state) {
    case 'idle_dirty': recommended = '/commit'; break;
    case 'idle_clean_wt': recommended = '/done'; break;
    case 'pr_open': recommended = '/done'; break;
    case 'idle_clean':
    default: recommended = '/next'; break;
  }

  const dirtyHint = dirty > 0
    ? '<div class="actions-hint">' + dirty + ' uncommitted ' + (dirty === 1 ? 'change' : 'changes') + '</div>'
    : '';

  const chips = SLASH_COMMANDS.map((cmd) => {
    const cls = cmd === recommended ? 'action-btn slash primary' : 'action-btn slash';
    return '<button class="' + cls + '" data-action="slash" data-url="' + esc(cmd) + '">' + esc(cmd) + '</button>';
  }).join('');

  // Keep the PR shortcut visible when one exists — it's not a slash command
  // but it's the most useful jump when a PR is open.
  const prs = s.pullRequests || [];
  const pr = state === 'pr_open' ? prs[prs.length - 1] : undefined;
  const prRow = pr
    ? '<div class="actions-pr"><button class="action-btn primary" data-action="openPr" data-url="' + esc(pr.url) + '">Open PR #' + pr.number + '</button></div>'
    : '';

  return (
    '<h2>Quick actions</h2>' +
    '<div class="card">' +
      prRow +
      '<div class="slash-grid">' + chips + '</div>' +
      dirtyHint +
    '</div>'
  );
}

function renderLinksCard(s) {
  // Linear ticket gets its own compact row above the multi-PR card so the
  // "Pull Requests" header can stay focused on PRs (which can be many).
  const prs = (s.pullRequests || []);
  if (!s.linearIssue && prs.length === 0) return '';

  const linearRow = s.linearIssue
    ? '<div class="link-row"><span class="link-tag">linear</span>' +
        '<a data-url="' + esc('https://linear.app/issue/' + encodeURIComponent(s.linearIssue)) + '">' +
          esc(s.linearIssue) +
        '</a></div>'
    : '';

  const prRows = prs.map((pr) => (
    '<div class="link-row"><span class="link-tag">pr</span>' +
      '<a data-url="' + esc(pr.url) + '">' +
        esc(pr.ownerRepo) + ' #' + pr.number +
      '</a></div>'
  )).join('');

  let html = '';
  if (linearRow) {
    html += '<h2>Linear</h2>' +
      '<div class="card"><div class="links-list">' + linearRow + '</div></div>';
  }
  if (prRows) {
    const heading = prs.length === 1 ? 'Pull request' : 'Pull requests (' + prs.length + ')';
    html += '<h2>' + heading + '</h2>' +
      '<div class="card"><div class="links-list">' + prRows + '</div></div>';
  }
  return html;
}

// ── Request ─────────────────────────────────────────────────────────────────
// The user's OWN latest genuine turn: headline in bold, attachment / pasted-
// terminal noise lifted into chips, the whole thing folded away behind
// "Full request". The card NEVER synthesizes a sentence — when the CLI carries no
// tidied 'request' it falls back to the conversation topic and says nothing more.
function requestChips(s) {
  const req = s.request;
  const chips = [];
  if (req && req.command) {
    chips.push('<span class="chip mono">' + esc(req.command) + '</span>');
  }
  const atts = (req && req.attachments) || [];
  const images = atts.filter((a) => a.kind === 'image');
  const dirs = atts.filter((a) => a.kind === 'dir');
  const others = atts.filter((a) => a.kind !== 'image' && a.kind !== 'dir');
  // A count only for images without a thumbnail above it.
  if (images.length > (s.imageThumbs || []).length) {
    chips.push('<span class="chip">' + images.length + ' image' + (images.length === 1 ? '' : 's') + '</span>');
  }
  if (others.length) {
    chips.push('<span class="chip">' + others.length + ' file' + (others.length === 1 ? '' : 's') + '</span>');
  }
  for (const dir of dirs) chips.push('<span class="chip mono">' + esc(dir.name) + '</span>');
  const pasted = (req && req.pastedLines) || 0;
  if (pasted > 0) {
    chips.push('<span class="chip">pasted terminal · ' + pasted + ' line' + (pasted === 1 ? '' : 's') + '</span>');
  }
  // Attachments the CLI resolved to real paths stay clickable (they open in an
  // editor); the tidier's names above are just labels.
  const thumbed = new Set((s.imageThumbs || []).map((t) => t.path));
  for (const a of (s.attachments || [])) {
    if (thumbed.has(a.path)) continue;
    chips.push('<a class="chip path-link" data-path="' + esc(a.path) + '">' + esc(a.label || a.path) + '</a>');
  }
  return chips.length ? '<div class="chips">' + chips.join('') + '</div>' : '';
}

function renderImageThumbs(s) {
  const thumbs = s.imageThumbs || [];
  if (!thumbs.length) return '';
  return '<div class="thumbs">' + thumbs.map((t, i) => (
    '<button type="button" class="thumb path-link" data-path="' + esc(t.path) + '" title="' + esc(t.label) + '">' +
      thumbImg(t) + '<span class="thumb-n">' + (i + 1) + '</span>' +
    '</button>'
  )).join('') + '</div>';
}

function renderRequestCard(s) {
  const req = s.request;
  const topic = ((s.conversation && s.conversation.topic) || '').trim();
  // Fallback chain, in order and no further: the CLI's tidied request, then the
  // already-cleaned prompt line, then the raw topic. Never a rewrite.
  const headline = (req && req.headline) || topic;
  if (!headline) return '';
  const full = (req && req.text) || topic;
  const first = (s.firstRequest || '').trim();
  const turns = (req && req.turns) || 0;
  const continues = req && req.continues
    ? '<span class="request-continues">  ·  continues ' + esc(req.continues.label || req.continues.id) + '</span>'
    : '';
  const headlineCls = req && (req.kind === 'skill' || req.kind === 'command')
    ? 'request-headline request-command'
    : 'request-headline';

  const foldBits = [];
  if (full) foldBits.push(full.length.toLocaleString() + ' chars');
  if (turns > 1) foldBits.push(turns + ' turns');
  // The fold carries the WHOLE latest turn, and the first turn beneath it when
  // the session has moved on from it (a /continue, a redirect).
  const foldBody =
    (full ? '<div class="conv-topic">' + renderMarkdownPreview(full) + '</div>' : '') +
    (first && first !== full
      ? '<div class="request-first"><div class="request-first-label">First turn</div>' +
        '<div class="conv-topic">' + renderMarkdownPreview(truncate(first, 1200)) + '</div></div>'
      : '');
  const fold = foldBody
    ? '<details class="request-details">' +
        '<summary><h2>Full request' + (foldBits.length ? ' · ' + esc(foldBits.join(' · ')) : '') + '</h2></summary>' +
        foldBody +
      '</details>'
    : '';

  // The asker's avatar (Gravatar, as artifacts-cli shows it) over their initial,
  // which stays visible when the address has no Gravatar.
  const who = s.requester
    ? '<div class="requester"><span class="avatar" aria-hidden="true">' + esc(s.requester.name.charAt(0).toUpperCase()) +
        '<img data-avatar src="' + esc(s.requester.avatar) + '" alt=""></span>' + esc(s.requester.name) + '</div>'
    : '';
  return (
    '<h2>Request</h2>' +
    '<div class="card">' +
      who +
      '<div class="' + headlineCls + '">' + esc(truncate(headline, 240)) + continues + '</div>' +
      renderImageThumbs(s) +
      requestChips(s) +
      fold +
    '</div>'
  );
}

// ── Pull request ────────────────────────────────────────────────────────────
// The session's PR as the feed reports it, read at a glance: a state ring and
// one status word, then one icon strip (a segmented check bar, a review glyph,
// a merge glyph) whose words live in each icon's title and aria-label. The
// per-check list folds under the bar. At most one action the host decided
// (Merge, or Merge when green), which it confirms before running.
const PR_CHECK_MARK = { passed: '✓', failed: '✕', running: '◌', skipped: '–' };
const PR_SEGMENT_ORDER = { passed: 0, running: 1, failed: 2, skipped: 3 };
const prSeenChecks = new Map();

// One word for where the PR stands, and the ring that draws it.
function prVerdict(pr) {
  if (pr.state === 'merged') return { ring: 'ok', word: 'Merged', tone: 'ok' };
  if (pr.state === 'closed') return { ring: 'none', word: 'Closed', tone: 'idle' };
  if (pr.checks === 'failing') return { ring: 'bad', word: 'Failing', tone: 'bad' };
  if (pr.isDraft) return { ring: 'draft', word: 'Draft', tone: 'idle' };
  if (pr.mergeable === 'conflicting') return { ring: 'bad', word: 'Conflicts', tone: 'bad' };
  if (pr.review === 'changes_requested') return { ring: 'bad', word: 'Changes requested', tone: 'bad' };
  if (pr.checks === 'pending') return { ring: 'running', word: 'Checks running', tone: 'warn' };
  if (pr.checks === 'passing') {
    // Green checks alone are not "Ready": a required review or an unknown merge
    // state still stands between the PR and a merge.
    if (pr.review === 'review_required') return { ring: 'ok', word: 'Needs review', tone: 'warn' };
    if (pr.mergeable !== 'mergeable') return { ring: 'ok', word: 'Checks passed', tone: 'ok' };
    return { ring: 'ok', word: 'Ready', tone: 'ok' };
  }
  return { ring: 'none', word: 'Open', tone: 'idle' };
}

// One bar segment per check the row lists, greens first so the bar fills like
// progress; a row with only the rolled-up verdict draws one segment for it.
// passed/counted leave skipped checks out of the fraction.
function prCheckSegments(pr) {
  const items = pr.checkItems || [];
  if (!items.length) {
    const state = pr.checks === 'passing' ? 'passed' : pr.checks === 'failing' ? 'failed' : pr.checks === 'pending' ? 'running' : '';
    return { segments: state ? [{ state: state, name: 'checks ' + pr.checks }] : [], passed: 0, running: 0, failed: 0, counted: 0 };
  }
  const segments = items.map((c, i) => ({ state: c.state, name: c.name, i: i }))
    .sort((a, b) => (PR_SEGMENT_ORDER[a.state] - PR_SEGMENT_ORDER[b.state]) || (a.i - b.i))
    .map((c) => ({ state: c.state, name: c.name }));
  const count = (state) => items.filter((c) => c.state === state).length;
  return { segments: segments, passed: count('passed'), running: count('running'), failed: count('failed'), counted: items.filter((c) => c.state !== 'skipped').length };
}

// The ring closes into a check once, when this PR's checks turn green between
// two renders the viewer saw; the first sight of a green PR does not animate.
function prJustReady(prev, pr) {
  return !!pr && pr.checks === 'passing' && pr.state !== 'merged' && prev !== undefined && prev !== 'passing';
}

function prRing(v) {
  return '<span class="pr-ring ' + v.ring + '" role="img" aria-label="' + esc(v.word) + '">' +
    '<svg viewBox="0 0 18 18" aria-hidden="true"><circle class="trk" cx="9" cy="9" r="7"/><circle class="arc" cx="9" cy="9" r="7"/>' +
    (v.ring === 'ok' ? '<path class="chk" d="M5.8 9.2l2.2 2.2 4.2-4.6"/>' : '') +
    (v.ring === 'bad' ? '<path class="x" d="M6.5 6.5l5 5M11.5 6.5l-5 5"/>' : '') + '</svg></span>';
}

function prReviewGlyph(pr) {
  const review = pr.review;
  const tone = review === 'approved' ? 'ok' : review === 'changes_requested' ? 'bad' : 'idle';
  const words = review === 'approved' ? 'Approved' : review === 'changes_requested' ? 'Changes requested' : review === 'review_required' ? 'Review required' : 'No review yet';
  const badge = review === 'approved' ? '<path class="badge" d="M9.6 12.2l1.6 1.6 3-3.3"/>' : review === 'changes_requested' ? '<path class="badge" d="M10.3 10.3l3.6 3.6M13.9 10.3l-3.6 3.6"/>' : '';
  return '<span class="pr-glyph ' + tone + '" role="img" title="' + esc(words) + '" aria-label="' + esc(words) + '">' +
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="5" r="2.6"/><path d="M1.6 14c.5-2.8 2.4-4.4 4.9-4.4 1 0 1.9.2 2.6.7"/>' + badge + '</svg></span>';
}

function prMergeGlyph(pr) {
  const tone = pr.state === 'merged' || pr.mergeable === 'mergeable' ? 'ok' : pr.mergeable === 'conflicting' ? 'bad' : 'idle';
  const words = pr.state === 'merged' ? 'Merged' : pr.mergeable === 'mergeable' ? 'No conflicts' : pr.mergeable === 'conflicting' ? 'Has conflicts' : 'Mergeability not known yet';
  return '<span class="pr-glyph ' + tone + '" role="img" title="' + esc(words) + '" aria-label="' + esc(words) + '">' +
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.7"/><circle cx="4.5" cy="12.5" r="1.7"/><circle cx="11.5" cy="8" r="1.7"/>' +
    '<path d="M4.5 5.2v5.6M4.5 5.6c.2 1.8 2 2.4 5.3 2.4"/></svg></span>';
}

function renderPullRequestCard(s, justReady) {
  const pr = s.prStatus;
  if (!pr) return '';
  const act = s.prAction || { kind: 'none', reason: '' };
  const v = prVerdict(pr);
  const bar = prCheckSegments(pr);
  const open = viewState.prChecksOpen === pr.url;
  const items = pr.checkItems || [];
  const checkWords = bar.counted
    ? bar.passed + ' of ' + bar.counted + ' checks passed' + (bar.running ? ', ' + bar.running + ' running' : '') + (bar.failed ? ', ' + bar.failed + ' failed' : '')
    : pr.checks ? (pr.checks === 'passing' ? 'Checks passed' : pr.checks === 'failing' ? 'A check failed' : 'Checks running') : 'No checks reported';
  const segs = bar.segments.map((c) => '<i class="seg ' + esc(c.state) + '" title="' + esc(c.name + ': ' + c.state) + '"></i>').join('');
  const barBody = '<span class="pr-bar" aria-hidden="true">' + (segs || '<i class="seg none"></i>') + '</span>' +
    (bar.counted ? '<span class="pr-frac">' + bar.passed + '/' + bar.counted + '</span>' : '');
  const barEl = items.length
    ? '<button type="button" class="pr-bar-btn" data-pr-checks="' + esc(pr.url) + '" aria-expanded="' + open + '" title="' + esc(checkWords) + '" aria-label="' + esc(checkWords + (open ? ', hide checks' : ', show checks')) + '">' + barBody + '</button>'
    : '<span class="pr-bar-btn" role="img" title="' + esc(checkWords) + '" aria-label="' + esc(checkWords) + '">' + barBody + '</span>';
  const checks = items.length && open
    ? '<div class="pr-checks">' + items.map((c) =>
        '<div class="pr-check pr-' + esc(c.state) + '"><span class="pr-mark">' + esc(PR_CHECK_MARK[c.state] || '·') + '</span>' +
        '<span class="pr-check-name">' + esc(c.name) + '</span>' +
        (c.url ? '<button type="button" class="pr-run" data-url="' + esc(c.url) + '" title="' + esc(c.url) + '">run ↗</button>' : '') + '</div>').join('') +
      '</div>'
    : '';
  const branch = s.git && s.git.branch ? '<span class="pr-branch" title="Branch">⎇ ' + esc(s.git.branch) + '</span>' : '';
  const primary = act.kind === 'merge'
    ? '<button type="button" class="action-btn primary" data-pr-action="merge">Merge</button>'
    : act.kind === 'automerge'
      ? '<button type="button" class="action-btn" data-pr-action="automerge" title="Turn on GitHub auto-merge">Merge when green</button>'
      : '';
  const note = act.kind === 'none' && act.reason && pr.state === 'open' ? '<div class="card-note pr-note">' + esc(act.reason) + '</div>' : '';
  return (
    '<h2>Pull request' + (s.prRepo ? '<span class="head-meta">' + esc(s.prRepo) + '</span>' : '') + '</h2>' +
    '<div class="card pr-card' + (justReady ? ' just-ready' : '') + '">' +
      '<div class="pr-head">' + prRing(v) +
        '<div class="pr-text"><div class="pr-title">#' + esc(pr.number) + (pr.title ? ' ' + esc(pr.title) : '') + '</div>' +
        '<div class="pr-sub"><span class="pr-word pr-tone-' + v.tone + '">' + esc(v.word) + '</span>' + branch + '</div></div></div>' +
      '<div class="pr-strip">' + barEl + prReviewGlyph(pr) + prMergeGlyph(pr) + '</div>' +
      checks +
      '<div class="actions-row pr-actions">' + primary + '<button type="button" class="action-btn" data-url="' + esc(pr.url) + '">Open on GitHub ↗</button></div>' +
      note +
    '</div>'
  );
}

// ── Files ───────────────────────────────────────────────────────────────────
// The paths the HARNESS recorded as created / modified / deleted. Nothing is
// inferred from the filesystem: no 'files' on the row means no card.
const FILE_OP_SYMBOL = { created: 'A', modified: 'M', deleted: 'D' };

function fileRow(change, label, depth) {
  return (
    '<div class="file-row" style="padding-left:' + (depth * 12) + 'px">' +
      '<span class="file-op ' + esc(change.op) + '">' + esc(FILE_OP_SYMBOL[change.op] || 'M') + '</span>' +
      '<button type="button" class="path-link" data-path="' + esc(change.path) + '" title="' + esc(change.path) + '">' + esc(label) + '</button>' +
    '</div>'
  );
}

// Folders the way the explorer shows them: a folder with a single child folder
// and no files folds into one row ("rush/api/scripts"), so a long worktree
// prefix appears once instead of on every file.
function fileTree(changes) {
  const root = { dirs: {}, files: [] };
  for (const change of changes) {
    const shown = change.display || change.path;
    const parts = shown.split('/').filter(Boolean);
    if (shown.charAt(0) === '/' && parts.length) parts[0] = '/' + parts[0];
    let node = root;
    for (const part of parts.slice(0, -1)) node = node.dirs[part] = node.dirs[part] || { dirs: {}, files: [] };
    node.files.push({ change: change, name: parts[parts.length - 1] || shown });
  }
  const count = (node) => node.files.length + Object.keys(node.dirs).reduce((n, k) => n + count(node.dirs[k]), 0);
  const draw = (node, depth) => Object.keys(node.dirs).sort().map((name) => {
    let label = name;
    let dir = node.dirs[name];
    while (!dir.files.length && Object.keys(dir.dirs).length === 1) {
      const only = Object.keys(dir.dirs)[0];
      label += '/' + only;
      dir = dir.dirs[only];
    }
    return (
      '<details class="ft-dir" open>' +
        '<summary style="padding-left:' + (depth * 12) + 'px"><span class="caret"></span><span class="ft-name">' + esc(label) + '</span><span class="ft-count">' + count(dir) + '</span></summary>' +
        draw(dir, depth + 1) +
      '</details>'
    );
  }).join('') + node.files.map((f) => fileRow(f.change, f.name, depth)).join('');
  return draw(root, 0);
}

function renderFilesCard(s) {
  const files = s.files;
  if (!files || !(files.changes || []).length) return '';
  const counts = { created: 0, modified: 0, deleted: 0 };
  for (const change of files.changes) counts[change.op] = (counts[change.op] || 0) + 1;
  const head = [];
  if (counts.created) head.push(counts.created + ' created');
  if (counts.modified) head.push(counts.modified + ' modified');
  if (counts.deleted) head.push(counts.deleted + ' deleted');
  if (files.total > files.changes.length) head.push('of ' + files.total);
  const asList = viewState.filesView === 'list';
  const toggle =
    '<span class="ft-toggle" role="group" aria-label="Files view">' +
      '<button type="button" data-files-view="tree" aria-pressed="' + !asList + '">Tree</button>' +
      '<button type="button" data-files-view="list" aria-pressed="' + asList + '">List</button>' +
    '</span>';
  const body = asList ? files.changes.map((change) => fileRow(change, change.display, 0)).join('') : fileTree(files.changes);
  return (
    '<h2>Files' + (head.length ? '<span class="head-meta">' + esc(head.join(' · ')) + '</span>' : '') + '</h2>' +
    '<div class="card files-card">' + toggle + body + '</div>'
  );
}

// The reply rail the removed Fleet "Ask Foreman" box owned: type, press Enter,
// the host injects it into the session over the same channel the Fleet used.
function renderReplyBox(s) {
  if (!s.fullSessionId) return '';
  return (
    '<div class="reply-box">' +
      '<textarea id="reply-input" rows="1" placeholder="Reply to this session… (Enter to send)"></textarea>' +
      '<div class="reply-err" id="reply-err" hidden></div>' +
    '</div>'
  );
}

const SUBAGENTS_FINISHED_SHOWN = 3;

function renderSubagentRow(x, now) {
  const running = x.status === 'running';
  const dur = running
    ? (typeof x.startedAtMs === 'number' ? 'running ' + compactDuration(now - x.startedAtMs) : 'running')
    : (typeof x.startedAtMs === 'number' && typeof x.endedAtMs === 'number' ? compactDuration(x.endedAtMs - x.startedAtMs) : '');
  const meta = [x.agentType, x.model ? prettyModel(x.model) : '', dur, x.toolCount ? x.toolCount + ' tools' : ''].filter(Boolean).join(' · ');
  return (
    '<details class="subagent status-' + esc(x.status) + '">' +
      '<summary><span class="sub-dot"></span>' +
        '<span class="sub-body"><span class="sub-name">' + esc(x.description || x.id) + '</span>' +
        (meta ? '<span class="sub-meta">' + esc(meta) + '</span>' : '') + '</span>' +
        '<span class="sub-status">' + esc(x.status) + '</span></summary>' +
      (x.prompt ? '<div class="sub-label">Asked</div><div class="sub-asked">' + esc(x.prompt) + '</div>' : '') +
      (x.resultExcerpt ? '<div class="sub-label">Result</div><div class="sub-result">' + esc(x.resultExcerpt) + '</div>' : '') +
      (x.transcriptPath ? '<button type="button" class="sub-open path-link" data-path="' + esc(x.transcriptPath) + '">Open transcript ▸</button>' : '') +
    '</details>'
  );
}

function renderSpawnedTeamCard(s) {
  const subs = s.subagents || [];
  if (subs.length) {
    const now = Date.now();
    // Running first, then the newest finished; older finished ones fold away.
    const ordered = subs.slice().sort((a, b) =>
      ((a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1)) || ((b.startedAtMs || 0) - (a.startedAtMs || 0)));
    const running = ordered.filter((x) => x.status === 'running');
    const finished = ordered.filter((x) => x.status !== 'running');
    const shown = running.concat(finished.slice(0, SUBAGENTS_FINISHED_SHOWN)).map((x) => renderSubagentRow(x, now)).join('');
    const older = finished.slice(SUBAGENTS_FINISHED_SHOWN);
    const more = older.length
      ? '<details class="sub-more"><summary class="timeline-more">' + older.length + ' more finished</summary>' + older.map((x) => renderSubagentRow(x, now)).join('') + '</details>'
      : '';
    const head = subs.length + (running.length ? ' · ' + running.length + ' running' : ' · all finished');
    return '<h2>Subagents<span class="head-meta">' + esc(head) + '</span></h2><div class="card subagents">' + shown + more + '</div>';
  }
  if (!s.spawnedTeam && !s.subAgentCount) return '';
  const count = s.subAgentCount > 0
    ? s.subAgentCount + ' subagent' + (s.subAgentCount === 1 ? '' : 's')
    : 'team spawned';
  return (
    '<h2>Team</h2><div class="card team-summary">' +
      '<span class="pulse-dot"></span>' +
      '<span class="team-summary-name">' + esc(s.spawnedTeam || 'Subagents') + '</span>' +
      '<span class="team-summary-count">' + esc(count) + '</span>' +
    '</div>'
  );
}
function renderActivityCard(s) {
  const items = s.recentActivity || [];
  if (!items.length) return '';
  const rows = items.map((it) => (
    '<div class="activity">' +
      '<span class="activity-kind">' + esc(it.kind) + '</span>' +
      '<span class="activity-summary">' + esc(truncate(it.summary, 80)) + '</span>' +
    '</div>'
  )).join('');
  return (
    '<h2>Recent activity</h2>' +
    '<div class="card">' + rows + '</div>'
  );
}

function renderGoalCard(s) {
  const goal = (s.goal || '').trim();
  if (!goal) return '';
  return (
    '<h2>Goal</h2>' +
    '<div class="card goal-card">' +
      '<span class="goal-mk">◈</span>' +
      '<span class="goal-txt">' + esc(truncate(goal, 240)) + '</span>' +
    '</div>'
  );
}

// The checklist is ALWAYS on (PHNX-3939): a populated list renders the progress
// bar + rows; an empty one still renders a card so the summarizer's state is
// visible — "summarizing…" while pending, "No checklist yet" once it settles.
function renderChecklistCard(s) {
  const p = s.todoProgress;
  if (!p || !p.total) {
    const msg = s.summaryState === 'pending' ? 'Summarizing…' : 'No checklist yet';
    return (
      '<h2>Checklist</h2>' +
      '<div class="card"><div class="todo-empty">' + esc(msg) + '</div></div>'
    );
  }
  const pct = Math.round((p.done / p.total) * 100);
  const rows = p.todos.map((t) => (
    '<div class="todo status-' + esc(t.status) + '">' +
      '<span class="todo-mk"></span>' +
      '<span class="todo-txt">' + esc(truncate(t.content, 100)) + '</span>' +
    '</div>'
  )).join('');
  return (
    '<h2>Checklist <span class="todo-frac">' + p.done + '/' + p.total + '</span></h2>' +
    '<div class="card">' +
      '<div class="todo-track"><i style="width:' + pct + '%"></i></div>' +
      rows +
    '</div>'
  );
}

function renderInlineMarkdown(s) {
  let out = esc(s);
  out = out.replace(/\\[([^\\]]+)\\]\\([^\\)]+\\)/g, '$1');
  out = out.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  return out;
}

function renderMarkdownPreview(s) {
  const lines = String(s || '').split(/\\r?\\n/);
  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push('<p>' + renderInlineMarkdown(paragraph.join(' ')) + '</p>');
    paragraph = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^#{1,6}\\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push('<div class="md-heading">' + renderInlineMarkdown(heading[1]) + '</div>');
      continue;
    }
    const bullet = line.match(/^[-*]\\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      blocks.push('<div class="md-bullet">- ' + renderInlineMarkdown(bullet[1]) + '</div>');
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks.join('');
}

function renderWorktreesCard(s) {
  const wts = s.worktrees || [];
  // Suppress the card when there's only the main checkout — no useful list
  // to show. Once any extra worktree exists it's worth surfacing all of them.
  if (wts.length < 2) return '';
  const rows = wts.map((w) => {
    const marker = w.isActive
      ? '<span class="wt-dot active" title="active terminal"></span>'
      : '<span class="wt-dot"></span>';
    const nameClass = w.isActive ? 'wt-name active' : 'wt-name';
    const tag = w.isMain ? '<span class="wt-tag main">main</span>' : '';
    const branch = w.branch ? '<span class="wt-branch">' + esc(w.branch) + '</span>' : '';
    // wt-link (not path-link) so the click dispatches openWorktree, which
    // opens the directory as a folder in a new window. vscode.open on a
    // directory shows an error toast.
    return (
      '<div class="worktree">' +
        marker +
        '<a class="' + nameClass + ' wt-link" data-worktree-path="' + esc(w.path) + '" title="' + esc(w.path) + '">' +
          esc(w.name) +
        '</a>' +
        tag + branch +
      '</div>'
    );
  }).join('');
  return (
    '<h2>Worktrees (' + wts.length + ')</h2>' +
    '<div class="card">' + rows + '</div>'
  );
}

function renderCwdCard(s) {
  if (!s.cwd) return '';
  const rows = [];
  rows.push(
    '<dt>cwd</dt><dd><a class="path-link" data-path="' + esc(s.cwd) + '">' + esc(s.cwd) + '</a></dd>'
  );
  if (s.worktreePath && s.workspaceRoot && s.worktreePath !== s.workspaceRoot) {
    rows.push(
      '<dt>worktree</dt><dd><a class="path-link" data-path="' + esc(s.worktreePath) + '">' + esc(s.worktreePath) + '</a></dd>'
    );
  }
  return (
    '<h2>Working dir</h2>' +
    '<div class="card"><dl class="row-grid">' + rows.join('') + '</dl></div>'
  );
}

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running' || s === 'in_progress') return 'running';
  if (s === 'completed' || s === 'done')      return 'completed';
  if (s === 'pending' || s === 'queued')      return 'pending';
  if (s === 'failed' || s === 'error')        return 'failed';
  if (s === 'stopped' || s === 'cancelled')   return 'stopped';
  return 'pending';
}

function renderTeammate(m) {
  return (
    '<div class="mate">' +
      '<span class="mate-dot ' + statusClass(m.status) + '"></span>' +
      '<span class="mate-name">' + esc(m.name) + '</span>' +
      '<span class="mate-agent">' + esc(m.agent_type) + '</span>' +
      '<span class="mate-status">' + esc(m.status) + '</span>' +
    '</div>'
  );
}

function renderTeam(t) {
  const counts = [];
  if (t.running)   counts.push(t.running + ' run');
  if (t.pending)   counts.push(t.pending + ' pend');
  if (t.completed) counts.push(t.completed + ' done');
  if (t.failed)    counts.push(t.failed + ' fail');
  const headRight = counts.length ? counts.join(' · ') : (t.agent_count + ' agent' + (t.agent_count === 1 ? '' : 's'));
  const mates = (t.teammates || []).map(renderTeammate).join('');
  return (
    '<div class="team">' +
      '<div class="team-head">' +
        '<span class="team-name">' + esc(t.task_name) + '</span>' +
        '<span class="team-counts">' + esc(headRight) + '</span>' +
      '</div>' +
      mates +
    '</div>'
  );
}

function renderTeamsCard(s) {
  const teams = s.teams || [];
  if (!teams.length) {
    if (s.teamsError) {
      return (
        '<h2>Teams in this directory</h2>' +
        '<div class="card"><div class="plan-meta">' + esc(s.teamsError) + '</div></div>'
      );
    }
    return '';
  }
  return (
    '<h2>Teams in this directory</h2>' +
    teams.map(renderTeam).join('')
  );
}

let lastSnapshot = null;

function render(snap) {
  lastSnapshot = snap;
  const stripScroll = saveStripScroll();
  // The empty state is about having NO SUBJECT — not about having no terminal.
  // A session picked in the Fleet list renders here with no local tab at all.
  if (!snap || !snap.hasSubject) {
    root.innerHTML = (
      '<div class="empty">No session selected.<br><br>' +
      'Click an agent tab in the editor, open one with <b>Cmd+Shift+A</b>, ' +
      'or click a row in the Fleet list.</div>'
    );
    return;
  }
  // What the session produced leads: its artifacts as previews, then its PR.
  // Then what was asked, what the agent has done, the checklist and the files it
  // touched, its helpers — and a reply field last (PHNX-4289).
  const pr = snap.prStatus;
  const prKey = pr ? (snap.fullSessionId || '') + '#' + pr.number : '';
  const justReady = pr ? prJustReady(prSeenChecks.get(prKey), pr) : false;
  if (pr) prSeenChecks.set(prKey, pr.checks || '');
  root.innerHTML = (
    renderTerminalCard(snap) +
    renderNeedsYou(snap) +
    renderSessionStats(snap) +
    renderFailures(snap) +
    renderArtifactsCard(snap) +
    renderPullRequestCard(snap, justReady) +
    renderGoalCard(snap) +
    renderRequestCard(snap) +
    renderTimelineCard(snap) +
    renderChecklistCard(snap) +
    renderFilesCard(snap) +
    renderSpawnedTeamCard(snap) +
    renderActivityCard(snap) +
    renderReplyBox(snap) +
    '<div class="footer"><button id="refresh-btn">Refresh</button></div>'
  );
  const details = root.querySelector('#session-details');
  if (details) details.addEventListener('toggle', () => { viewState.detailsOpen = details.open; vscode.setState(viewState); });
  const failures = root.querySelector('#failures');
  if (failures) failures.addEventListener('toggle', () => { viewState.failuresOpen = failures.open; vscode.setState(viewState); });
  const nyReply = root.querySelector('#needs-you-reply');
  if (nyReply) nyReply.addEventListener('click', () => {
    const r = root.querySelector('#reply-input');
    if (r) { r.scrollIntoView({ block: 'center' }); r.focus(); }
  });
  restoreStripScroll(stripScroll);
  for (const img of root.querySelectorAll('img[data-avatar]')) img.addEventListener('error', () => img.remove());
  bindSessionCards();
  for (const el of root.querySelectorAll('[data-files-view]')) {
    el.addEventListener('click', () => {
      viewState.filesView = el.getAttribute('data-files-view');
      vscode.setState(viewState);
      render(lastSnapshot);
    });
  }
  const copy = root.querySelector('#copy-session');
  if (copy) copy.addEventListener('click', () => vscode.postMessage({ type: 'copySessionId' }));
  for (const el of root.querySelectorAll('.path-link')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openPath', path: el.getAttribute('data-path') });
    });
  }
  // Worktree paths are DIRECTORIES — they need vscode.openFolder, not the
  // file-only vscode.open that openPath uses. Distinct selector + message
  // type so the extension can branch on intent without sniffing the path.
  for (const el of root.querySelectorAll('.wt-link')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openWorktree', path: el.getAttribute('data-worktree-path') });
    });
  }
  const prChecks = root.querySelector('[data-pr-checks]');
  if (prChecks) prChecks.addEventListener('click', () => {
    const url = prChecks.getAttribute('data-pr-checks');
    viewState.prChecksOpen = viewState.prChecksOpen === url ? '' : url;
    vscode.setState(viewState);
    render(lastSnapshot);
    // The card re-renders; keep the keyboard on the bar that was just toggled.
    const again = root.querySelector('[data-pr-checks]');
    if (again) again.focus();
  });
  for (const el of root.querySelectorAll('[data-pr-action]')) {
    el.addEventListener('click', () => vscode.postMessage({ type: 'prAction', action: el.getAttribute('data-pr-action') }));
  }
  for (const el of root.querySelectorAll('[data-scm]')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openSourceControl' });
    });
  }
  for (const el of root.querySelectorAll('[data-action]')) {
    el.addEventListener('click', () => {
      vscode.postMessage({
        type: 'runQuickAction',
        action: el.getAttribute('data-action'),
        terminalId: lastSnapshot && lastSnapshot.terminalId,
        workspaceRoot: lastSnapshot && lastSnapshot.workspaceRoot,
        url: el.getAttribute('data-url') || undefined,
      });
    });
  }
  const reply = root.querySelector('#reply-input');
  if (reply) {
    reply.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter is a newline. Same convention as the reply box
      // the Fleet rail used, so muscle memory carries over.
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      const text = reply.value.trim();
      if (!text) return;
      vscode.postMessage({
        type: 'replyToSession',
        text: text,
        sessionId: lastSnapshot && lastSnapshot.fullSessionId,
        terminalId: lastSnapshot && lastSnapshot.terminalId,
      });
      reply.value = '';
    });
  }
  const btn = root.querySelector('#refresh-btn');
  if (btn) btn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
}

// The host answers a reply with its outcome; show a failure inline (never a
// toast) exactly where the user typed.
function showReplyError(message) {
  const box = root.querySelector('#reply-err');
  if (!box) return;
  box.textContent = message || '';
  box.hidden = !message;
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg && msg.type === 'sessionIdCopied') {
    const copy = root.querySelector('#copy-session');
    if (copy) { copy.textContent = 'Copied'; setTimeout(() => { if (lastSnapshot) copy.textContent = lastSnapshot.sessionChunk; }, 1200); }
  }
  else if (msg && msg.type === 'snapshot') render(msg.data);
  else if (msg && msg.type === 'timelineFilter') {
    if (applyTimelineFilter(msg, lastSnapshot)) render(lastSnapshot);
  }
  else if (msg && msg.type === 'replyResult') showReplyError(msg.ok ? '' : (msg.error || 'Reply failed'));
});

// The panel keeps retainContextWhenHidden so quick tab switches preserve scroll
// + DOM state, and the heavy snapshot polling is already gated on visibility
// (startPolling/stopPolling). The one thing retain leaves running is the
// .pulse-dot's "animation: pulse ... infinite" — off-screen it still forces
// layout/paint every frame and burns CPU. Remove the element from the DOM while
// hidden (CSS-hiding alone doesn't stop the animation); the next snapshot on
// reveal (onDidChangeVisibility -> refresh) re-renders it if still streaming.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const el of root.querySelectorAll('.pulse-dot')) el.remove();
  }
});

// Drag a file from the explorer/editor onto the panel -> paste its absolute
// path into the focused agent terminal instead of letting VS Code's editor
// host catch the drop and open the file.
document.body.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!e.dataTransfer) return;
  const uriList = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (!uriList) return;
  // RFC 2483: newline-delimited; '#' lines are comments. Take the first uri.
  const firstUri = uriList.split(/\\r?\\n/).find((line) => line && !line.startsWith('#'));
  if (!firstUri) return;
  let p = firstUri.trim();
  if (p.startsWith('file://')) {
    try { p = decodeURIComponent(p.slice('file://'.length)); } catch { /* leave as-is */ }
  }
  vscode.postMessage({
    type: 'insertPathInTerminal',
    path: p,
    terminalId: lastSnapshot && lastSnapshot.terminalId,
  });
});

// Signal readiness AFTER the listener is attached so the extension host
// doesn't race us with the first snapshot.
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

async function readGitInfo(cwd: string): Promise<GitInfo | undefined> {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return undefined;
    const api = (await ext.activate()).getAPI(1);
    const target = path.resolve(cwd);
    const repo = api.repositories.find((r: any) => {
      const root = String(r.rootUri?.fsPath || '');
      return root && (target === root || target.startsWith(root + path.sep));
    });
    if (!repo) return undefined;
    const branch = repo.state?.HEAD?.name as string | undefined;
    const dirtyCount =
      (repo.state?.workingTreeChanges?.length ?? 0) +
      (repo.state?.indexChanges?.length ?? 0) +
      (repo.state?.mergeChanges?.length ?? 0);
    return { branch, dirtyCount };
  } catch {
    return undefined;
  }
}

function collectRecentActivity(tailLines: string[], agentType: string, max: number): ActivityItem[] {
  const out: ActivityItem[] = [];
  // Walk backward so we end up with the most recent items first.
  const seen = new Set<string>();
  for (let i = tailLines.length - 1; i >= 0 && out.length < max; i--) {
    const activity = parseLineForActivity(tailLines[i], agentType as 'claude' | 'codex');
    if (!activity || isHarnessEnvelope(activity.summary || '')) continue;
    const formatted = formatActivity(activity);
    const dedupeKey = `${activity.type}|${activity.summary}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      kind: activity.type,
      summary: activity.summary || formatted,
      ts: activity.timestamp.getTime(),
    });
  }
  return out;
}

/**
 * Wrapper around the shared {@link extractPrUrlsHelper} kept here so existing
 * call sites in `buildSnapshot` stay readable. Tests live next to the helper.
 */
function extractPrUrls(lines: string[]): PullRequestRef[] {
  return extractPrUrlsHelper(lines);
}

/** Build presentation rows from the canonical session stream plus the workspace root. */
type UsageStatus = 'available' | 'rate_limited' | 'out_of_credits' | null;

async function getWorktreesRouted(
  workspaceRoot: string,
  activeCwd: string | undefined,
): Promise<WorktreeRef[]> {
  const byPath = new Map<string, WorktreeRef>();
  byPath.set(workspaceRoot, {
    path: workspaceRoot,
    name: path.basename(workspaceRoot),
    isActive: activeCwd ? path.resolve(activeCwd) === path.resolve(workspaceRoot) : false,
    isMain: true,
  });
  for (const value of sessionPresentationStore.sessions()) {
    const row = value as { cwd?: unknown; branch?: unknown; worktree?: { path?: unknown; branch?: unknown } };
    const worktreePath = typeof row.worktree?.path === 'string'
      ? row.worktree.path
      : typeof row.cwd === 'string' && row.cwd.includes(`${path.sep}.agents${path.sep}worktrees${path.sep}`)
        ? row.cwd
        : undefined;
    if (!worktreePath || !path.resolve(worktreePath).startsWith(`${path.resolve(workspaceRoot)}${path.sep}`)) continue;
    byPath.set(worktreePath, {
      path: worktreePath,
      name: path.basename(worktreePath),
      branch: typeof row.worktree?.branch === 'string' ? row.worktree.branch : typeof row.branch === 'string' ? row.branch : undefined,
      isActive: activeCwd ? path.resolve(activeCwd) === path.resolve(worktreePath) : false,
      isMain: false,
    });
  }
  return [...byPath.values()];
}

/** The CLI-normalized RemoteSession for a session id, from the warm
 *  `agents sessions watch --json` stream, or undefined until the stream indexes
 *  it. Reuses `presentedSessions` — the ext's mirror of the CLI shape — so the
 *  sidebar reads the SAME normalized fields (`lastResponse`, `todos`, `activity`,
 *  `prUrl`, `branch`) every other surface does, never re-deriving them from the
 *  raw row. Synchronous, in-memory: no subprocess (PHNX-3517). */
function findLiveSession(sessionId: string, host?: string): RemoteSession | undefined {
  const rows = sessionPresentationStore
    .presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL)
    .filter((s) => s.sessionId === sessionId);
  if (rows.length < 2) return rows[0];
  // A live row and its durable Previous twin can both be on the stream for one
  // session id. Prefer the row on the device the subject names, then the live
  // one — a finished twin must never shadow the session that is still running.
  const wanted = normalizeHost(host || '');
  const onDevice = wanted ? rows.filter((s) => normalizeHost(s.host) === wanted) : rows;
  const pool = onDevice.length ? onDevice : rows;
  return pool.find((s) => s.liveStatus !== 'closed') ?? pool[0];
}

/** Resolve a CLI-owned session path on the machine that produced it. */
function sessionPathUri(filePath: string, host: string | undefined): vscode.Uri {
  const remote = sessionPathUriString(filePath, host, [LOCAL_MACHINE_ID, LOCAL_LABEL]);
  return remote ? vscode.Uri.parse(remote) : vscode.Uri.file(filePath);
}


/** Read the session's CLI-provided throttle state without probing account state. */
function getUsageStatusFromCli(sessionId: string | undefined): UsageStatus {
  if (!sessionId) return null;
  const row = sessionPresentationStore.sessions().find((value) => {
    const candidate = value as { id?: unknown; sessionId?: unknown };
    return candidate.id === sessionId || candidate.sessionId === sessionId;
  }) as { rateLimited?: unknown; usageStatus?: unknown } | undefined;
  if (row?.usageStatus === 'available' || row?.usageStatus === 'rate_limited' || row?.usageStatus === 'out_of_credits') {
    return row.usageStatus;
  }
  return row?.rateLimited === true ? 'rate_limited' : null;
}

async function runInShellTerminal(command: string): Promise<void> {
  const existing = vscode.window.terminals.find((t) => t.name === 'agents: shell');
  const terminal = existing ?? vscode.window.createTerminal({
    name: 'agents: shell',
    env: buildAgentTerminalEnv(terminals.nextId('SH'), null),
  });
  terminal.show(true);
  terminal.sendText(command);
}

function randomNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// Set once by registerAgentPanel; consumed by notifyAgentPanelSessionUpdate so
// the extension.ts session-stream fact handler has a single call site instead
// of threading the provider instance through.
let activeProvider: AgentPanelProvider | undefined;
const streamRefreshCoalesce = createTrailingCoalesce();
const STREAM_REFRESH_KEY = 'agentPanel';

// Called by extension.ts whenever sessionPresentationStore.apply() reports a
// change (a fact arrived off the agents-cli daemon's session stream). This
// replaces the old 4s setInterval poll (PHNX-2833) — the panel now redraws
// only when the daemon says something actually changed, trailing-coalesced so
// a burst of facts (many tool calls in a row) collapses into one rebuild plus
// exactly one catch-up run for whatever arrived mid-flight.
/** @public loaded with require('./agentPanel.vscode') in extension.ts, which knip cannot see */
export function notifyAgentPanelSessionUpdate(): void {
  if (!activeProvider) return;
  void coalesceTrailing(streamRefreshCoalesce, STREAM_REFRESH_KEY, () => activeProvider!.refreshIfVisible());
}

export function registerAgentPanel(context: vscode.ExtensionContext): AgentPanelProvider {
  const provider = new AgentPanelProvider(context.extensionUri);
  provider.context = context;
  activeProvider = provider;
  context.subscriptions.push({ dispose: () => { if (activeProvider === provider) activeProvider = undefined; } });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AGENT_PANEL_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Re-render on terminal lifecycle events. refresh() -> buildSnapshot() spawns
  // 2-8 subprocesses (git/teams probes), so a burst of events — e.g. clicking
  // through editor tabs fires onDidChangeActiveTerminal per tab, and closing a
  // terminal fires close + active-change together — would stampede the box.
  // Trailing-edge debounce (matching the inline clearTimeout/setTimeout idiom
  // in settings.vscode.ts) coalesces a burst into one snapshot per window.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void provider.refresh();
    }, 300);
  };
  // Focusing an agent terminal makes it the subject — the other half of the
  // last-wins pair with the Fleet row click. Set BEFORE the debounce so a burst
  // of tab switches still leaves the subject on the tab the user landed on.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal(() => { setSubjectFromActiveTerminal(); debouncedRefresh(); }),
    vscode.window.onDidCloseTerminal(debouncedRefresh),
    vscode.window.onDidOpenTerminal(debouncedRefresh),
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); clearAgentPanelSubject(); } }
  );

  return provider;
}
