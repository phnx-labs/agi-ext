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
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import * as os from 'os';
import { displayPath } from '../core/displayPath';
import * as terminals from './terminals.vscode';
import { buildAgentTerminalEnv } from '../core/terminals';
import { TeamWithMates } from './foreman.sources';
import { extractLinearTicketId } from '../core/utils';
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
import { shellQuote } from '../core/deviceDispatchShell';

/** Where the CLI materializes pasted images; the only image root the webview may read. */
const ATTACHMENT_CACHE_DIR = path.join(os.homedir(), '.agents', '.cache', 'attachments');
// Where the CLI saves images pasted on this machine; a request names them by file name.
const PASTED_ATTACHMENT_DIR = path.join(os.homedir(), '.agents', '.history', 'attachments');
// Local copies of a remote session's artifacts, fetched on an explicit click.
const REMOTE_ARTIFACT_CACHE_DIR = path.join(os.homedir(), '.agents', '.cache', 'remote-artifacts');
const THUMB_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

function isInside(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, path.resolve(filePath));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Timeline filters that need the full transcript stream, one `agents sessions` call per click. */
const VERB_FILTER_ROLES = new Set(['assistant', 'thinking', 'tools']);

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

  /**
   * A local artifact opens in place. A remote session's artifact is copied once
   * into the local cache with one `agents ssh` call on this click, so it opens
   * in the Reader without a Remote-SSH connection.
   */
  private async localArtifactUri(filePath: string): Promise<vscode.Uri | undefined> {
    const device = remoteDeviceArg(this.snapshot.sessionHost);
    if (!device) return vscode.Uri.file(filePath);
    // Copy only an artifact the row names, by its absolute path, into this
    // device's cache folder: a stream value must never choose where we write.
    const named = (this.snapshot.artifacts ?? []).some((a) => a.path === filePath) || this.snapshot.plan?.path === filePath;
    const local = path.join(REMOTE_ARTIFACT_CACHE_DIR, device, filePath);
    if (!named || !path.posix.isAbsolute(filePath) || !/^[\w.-]+$/.test(device) || !isInside(local, path.join(REMOTE_ARTIFACT_CACHE_DIR, device))) {
      void vscode.window.showErrorMessage(`Not opening ${filePath}: it is not an artifact of this session.`);
      return undefined;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Fetching ${path.basename(filePath)} from ${device}` },
        async () => {
          const argv = shellQuote(JSON.stringify(['base64', filePath]));
          const { stdout } = await runAgents(`ssh ${shellQuote(device)} --argv ${argv}`, { timeout: 60_000, maxBuffer: 128 * 1024 * 1024 });
          await fs.promises.mkdir(path.dirname(local), { recursive: true });
          await fs.promises.writeFile(local, Buffer.from(stdout, 'base64'));
        },
      );
      return vscode.Uri.file(local);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not fetch ${filePath} from ${device}: ${(err as Error).message.split('\n')[0]}`);
      return undefined;
    }
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
        // A plan or report opens as an editor tab in the Agents Reader, beside the
        // agent that wrote it; anything else opens normally.
        if (typeof msg.path === 'string') {
          const uri = await this.localArtifactUri(msg.path);
          if (!uri) return;
          const viewType = /\.html?$/i.test(msg.path) ? 'agents.htmlReader' : /\.md$/i.test(msg.path) ? 'agents.markdownEditor' : undefined;
          if (viewType) await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
          else await vscode.commands.executeCommand('vscode.open', uri);
        }
        return;
      case 'loadTimelineFilter':
        await this.loadTimelineFilter(msg.role, msg.sessionId);
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
    try {
      const { stdout } = await runAgents(`sessions ${shellQuote(sessionId)} --include ${role} --json`, { timeout: 20_000 });
      const parsed = JSON.parse(stdout);
      const items = role === 'tools'
        ? ((parsed.sessions || []).find((x: { id?: string }) => x.id === sessionId)?.calls || []).map((c: { timestamp?: string; tool?: string; input?: string; outcome?: string }) => ({
            at: c.timestamp, text: (c.tool || 'tool') + ': ' + String(c.input || '').slice(0, 300), bad: c.outcome && c.outcome !== 'ok',
          }))
        : (parsed.events || []).map((e: { timestamp?: string; content?: string }) => ({ at: e.timestamp, text: String(e.content || '').slice(0, 600) }));
      reply({ items });
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      reply({ error: message });
    }
  }

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
      // Focus and Resume — the two verbs the removed Fleet detail rail owned,
      // reusing the SAME host entry points it called. Focus prefers the live tab;
      // with no local tab it attaches a fresh terminal to the session on its
      // owning device. Resume runs the CLI's own recovery command for the row.
      case 'setSessionId':
        if (this.snapshot.hasTerminal && terminalId) {
          try {
            await vscode.commands.executeCommand('agents.setSessionId', { terminalId });
          } catch {
            void vscode.window.showWarningMessage('Set Session ID failed. Check that the extension build includes this command.');
          }
        }
        return;
      case 'focusSubject': {
        if (terminal) { terminal.show(true); return; }
        const sessionId = this.snapshot.fullSessionId;
        if (!sessionId || !this.context) return;
        const { openAgentSessionById } = require('./extension') as typeof import('./extension');
        // `sessionHost` is the PROJECTED host, so a local session carries the
        // 'this-mac' sentinel (resolveSessionHost folds LOCAL_MACHINE_ID to it).
        // Handing that through as a device pins the fresh tab to a device that
        // does not exist: the auto-label poller then takes its offloaded branch
        // and runs `agents sessions <id> --json --device this-mac` on a timer,
        // failing into its silent catch every tick. remoteDeviceArg folds every
        // local identity to undefined so the local case stays local.
        await openAgentSessionById(this.context, sessionId, remoteDeviceArg(this.snapshot.sessionHost));
        return;
      }
      case 'resumeSubject': {
        const sessionId = this.snapshot.fullSessionId;
        if (!sessionId || !this.context) return;
        const { openAgentSessionByRecovery } = require('./extension') as typeof import('./extension');
        const device = remoteDeviceArg(this.snapshot.sessionHost);
        await openAgentSessionByRecovery(this.context, {
          sessionId,
          agentType: this.snapshot.agentType ?? '',
          ...(device ? { device } : {}),
        });
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
        snapshot.sessionHost = live.host;
        snapshot.conversation = {
          topic: live.topic || undefined,
          lastMessage: live.lastResponse || undefined,
          messageCount: 0,
          lastActivityMs: live.lastActivityMs || undefined,
        };
        const linear = extractLinearTicketId(live.topic) || extractLinearTicketId(live.lastResponse);
        if (linear) snapshot.linearIssue = linear;

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
        const pathOptions = { cwd: live.cwd || cwd, home: os.homedir(), isRemote: !!remoteDeviceArg(live.host), sessionId };
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
        if (live.prUrl) snapshot.pullRequests = extractPrUrls([live.prUrl]);

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
        snapshot.artifacts = live.artifacts.map((artifact) => ({ ...artifact, display: displayPath(artifact.path, pathOptions) }));
        if (live.planFile) snapshot.plan = { path: live.planFile, display: displayPath(live.planFile, pathOptions) };
        snapshot.attachments = live.attachments;
        const remoteDevice = remoteDeviceArg(live.host);
        snapshot.sessionTitle = live.title || live.label || undefined;
        snapshot.model = live.model;
        snapshot.project = live.project || undefined;
        snapshot.hostLabel = remoteDevice || os.hostname().split('.')[0];
        snapshot.sessionLocal = !remoteDevice;
        snapshot.inWorktree = !!live.worktreeSlug;
        snapshot.startedAtMs = live.startedAtMs || undefined;
        snapshot.lastActivityMs = live.lastActivityMs || undefined;
        if (live.attention && live.attention.state === 'open') {
          const openedAtMs = Date.parse(live.attention.openedAt);
          snapshot.needsYou = {
            kind: live.attention.kind,
            text: live.attention.question?.text || live.awaitingReason || '',
            openedAtMs: Number.isFinite(openedAtMs) ? openedAtMs : undefined,
          };
        }
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
          // An image the user pasted on this machine is in its attachment store
          // under the name the request carries, wherever the agent runs.
          const pasted = (live.request?.attachments ?? [])
            .filter((a) => a.kind === 'image' && a.name && path.basename(a.name) === a.name)
            .map((a) => path.join(PASTED_ATTACHMENT_DIR, a.name))
            .filter((p) => fs.existsSync(p))
            .map((p) => ({ path: p, label: path.basename(p), uri: webview.asWebviewUri(vscode.Uri.file(p)).toString() }));
          snapshot.imageThumbs = pasted;
        }
        // The CLI's cached copies (hash-named) are the same pastes; use them only
        // when the request named none this machine has.
        if (webview && !remoteDevice && !snapshot.imageThumbs?.length) {
          snapshot.imageThumbs = live.attachments
            .filter((a) => a.mediaType.startsWith('image/') && isInside(a.path, ATTACHMENT_CACHE_DIR))
            .map((a) => ({ path: a.path, label: a.label, uri: webview.asWebviewUri(vscode.Uri.file(a.path)).toString() }));
        }
        if (webview && !remoteDevice) {
          for (const artifact of snapshot.artifacts) {
            if (THUMB_EXT.test(artifact.path) && isInside(artifact.path, os.homedir())) artifact.uri = webview.asWebviewUri(vscode.Uri.file(artifact.path)).toString();
          }
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
    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${cspSource} https: data:; connect-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root {
    color-scheme: light dark;
  }
  /* Pin the whole webview canvas to the sidebar background so short content
     never leaves a mismatched void under light/custom themes (PHNX-3809). The
     root element's background paints the entire viewport canvas; body repeats
     it and stretches to full height so the padded area is themed too. */
  html {
    background: var(--vscode-sideBar-background);
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 0 12px 16px;
    margin: 0;
    min-height: 100vh;
    box-sizing: border-box;
  }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
    margin: 14px 0 6px;
  }
  .empty {
    color: var(--vscode-descriptionForeground);
    padding: 24px 4px;
    font-style: italic;
  }
  .card {
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 8px 10px;
    background: var(--vscode-sideBar-background);
    margin-top: 4px;
  }
  .agent-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .agent-logo {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    flex-shrink: 0;
    object-fit: contain;
    background: var(--vscode-input-background, transparent);
  }
  .agent-head-text { flex: 1; min-width: 0; }
  .title-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-weight: 600;
  }
  .agent-name { color: var(--vscode-foreground); }
  .session-chunk {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-weight: 400;
  }
  .account-row {
    margin-top: 3px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .branch-row {
    margin-top: 3px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .branch-name {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-foreground);
    background: transparent;
    border: none;
    padding: 0;
    font-size: inherit;
    cursor: pointer;
  }
  .branch-name:hover { text-decoration: underline; }
  .dirty-pill {
    background: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-badge-background));
    color: var(--vscode-badge-foreground);
    padding: 0 5px;
    border-radius: 8px;
    font-size: 10px;
    border: none;
    cursor: pointer;
    font: inherit;
    font-size: 10px;
  }
  .dirty-pill:hover { filter: brightness(1.15); }
  .working-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 11.5px;
    padding: 4px 2px;
  }
  .pulse-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vscode-charts-green);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
  .row-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    margin-top: 4px;
  }
  .row-grid dt {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .row-grid dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }
  .path-link:hover { text-decoration: underline; }
  .plan-meta {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .conv-topic {
    color: var(--vscode-foreground);
    line-height: 1.4;
    word-break: break-word;
  }
  .conv-topic p { margin: 0 0 6px; }
  .conv-topic p:last-child { margin-bottom: 0; }
  .conv-topic .md-heading {
    font-weight: 600;
    margin: 0 0 5px;
  }
  .conv-topic code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.94em;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px;
    padding: 0 3px;
  }
  .conv-topic .md-bullet {
    padding-left: 10px;
    text-indent: -8px;
  }
  .conv-meta {
    margin-top: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .request-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 7px;
  }
  .attachment-link {
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 2px 5px;
  }
  .art-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .art-bar select {
    margin-left: 4px; font: inherit; border-radius: 3px; padding: 1px 2px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
  }
  button.art-group {
    font: inherit; font-size: 11px; cursor: pointer; border-radius: 10px; padding: 1px 8px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    background: transparent; color: var(--vscode-descriptionForeground);
  }
  button.art-group[aria-pressed="true"] { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-color: transparent; }
  .art-icon { width: 14px; height: 14px; flex: none; }
  .requester { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .avatar {
    position: relative; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none;
    border-radius: 50%; overflow: hidden; font-size: 10px; font-weight: 600;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .art-app { display: flex; align-items: center; gap: 6px; margin: 10px 0 2px; font-size: 11.5px; font-weight: 600; }
  .art-count { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .art-folder { padding: 5px 0 6px; }
  .art-folder-head { display: flex; align-items: center; gap: 4px; }
  button.art-folder-toggle { display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0; }
  .art-folder-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .caret { width: 10px; flex: none; color: var(--vscode-descriptionForeground); font-size: 9px; }
  .art-folder-head button.art-reveal { color: var(--vscode-descriptionForeground); padding: 0 4px; }
  .art-time { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
  .art-meta { margin: 1px 0 5px 15px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow-wrap: anywhere; }
  .art-files { display: flex; gap: 6px; margin-left: 15px; padding-bottom: 4px; overflow-x: auto; }
  .art-folder.open .art-files { flex-wrap: wrap; overflow-x: hidden; overflow-y: auto; max-height: 260px; }
  button.art-tile { flex: none; width: 88px; }
  .art-folder.open button.art-tile { width: calc(50% - 3px); }
  .art-thumb {
    display: flex; align-items: center; justify-content: center; aspect-ratio: 3 / 2; overflow: hidden; border-radius: 3px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); background: var(--vscode-editor-background);
  }
  .art-thumb img { width: 100%; height: 100%; object-fit: cover; }
  button.art-tile:hover .art-thumb { border-color: var(--vscode-focusBorder); }
  .art-ext { color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; letter-spacing: 0.05em; }
  .art-label {
    display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px;
  }
  .art-card button.art-link {
    display: flex; align-items: center; gap: 6px; width: 100%; margin: 3px 0; padding: 6px 8px; border-radius: 4px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); color: var(--vscode-textLink-foreground); box-sizing: border-box;
  }
  .art-link-kind { color: var(--vscode-descriptionForeground); font-size: 9px; letter-spacing: 0.05em; text-transform: uppercase; }
  button.art-summary { display: flex; align-items: center; gap: 6px; width: 100%; }
  .art-summary img { width: 32px; height: 21px; object-fit: cover; border-radius: 2px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
  .art-apps { display: flex; gap: 3px; }
  button.art-toggle { display: inline-flex; align-items: center; gap: 4px; text-transform: inherit; letter-spacing: inherit; color: inherit; font-weight: inherit; }
  .team-summary { display: flex; align-items: center; gap: 8px; }
  .team-summary-name { color: var(--vscode-foreground); font-weight: 600; }
  .team-summary-count { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .activity {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
  .activity-kind {
    width: 56px;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
    text-transform: lowercase;
    font-size: 10.5px;
  }
  .activity-summary {
    color: var(--vscode-foreground);
    word-break: break-word;
  }
  /* ◈ Goal (PHNX-3939) — teal accent label, the clean one-line read. */
  .goal-card {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .goal-mk {
    flex-shrink: 0;
    color: var(--vscode-terminal-ansiCyan);
    font-size: 12px;
  }
  .goal-txt {
    color: var(--vscode-foreground);
    font-weight: 600;
    line-height: 1.45;
    word-break: break-word;
  }
  /* Progress checkpoints — amber marker for the live now-line, newest on top. */
  .checkpoint {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
  .checkpoint-mk {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
    background: var(--vscode-charts-yellow);
  }
  .checkpoint-txt { color: var(--vscode-foreground); word-break: break-word; }
  .checkpoint-at {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
  }
  /* Always-on checklist empty/summarizing state. */
  .todo-empty {
    color: var(--vscode-descriptionForeground);
    font-size: 11.5px;
    font-style: italic;
  }
  /* ── Request card (PHNX-3939 follow-up) ────────────────────────────────
     The user's own sentence leads, bold; attachments and pasted terminal become
     chips; the full turn folds away. Nothing here is a rewrite. */
  .request-headline {
    color: var(--vscode-foreground);
    font-weight: 600;
    line-height: 1.45;
    word-break: break-word;
  }
  .request-command {
    font-family: var(--vscode-editor-font-family, monospace);
    font-weight: 600;
  }
  .request-continues {
    color: var(--vscode-descriptionForeground);
    font-weight: 400;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 7px;
  }
  .chip {
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 9px;
    padding: 1px 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
  }
  .chip.mono { font-family: var(--vscode-editor-font-family, monospace); }
  .request-first {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--vscode-widget-border, transparent);
  }
  .request-first-label {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }
  /* ── Timeline card ─────────────────────────────────────────────────────
     One row per folded step, newest first. The live step gets the amber
     now-line; a 'user' step is a hollow dot with quoted text; a 'derived' step
     (a harness that wrote no narration) renders muted so it never reads as
     something the agent said. */
  .step {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    gap: 2px 8px;
    padding: 3px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
  .step-mk {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-top: 4px;
    background: var(--vscode-descriptionForeground);
  }
  .step.live .step-mk { background: var(--vscode-charts-yellow); }
  .step.src-user .step-mk {
    background: transparent;
    border: 1px solid var(--vscode-descriptionForeground);
  }
  .step-txt { color: var(--vscode-foreground); word-break: break-word; }
  .step.src-user .step-txt { color: var(--vscode-descriptionForeground); font-style: italic; }
  .step.src-derived .step-txt { color: var(--vscode-descriptionForeground); }
  .step-at {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    white-space: nowrap;
  }
  .step.live .step-at { color: var(--vscode-charts-yellow); font-weight: 600; }
  .step-now {
    grid-column: 2 / span 2;
    color: var(--vscode-charts-yellow);
    font-size: 10.5px;
    word-break: break-word;
  }
  .step-chips {
    grid-column: 2 / span 2;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
  }
  .step-chips .bad { color: var(--vscode-errorForeground); }
  .step-chips .mark { color: var(--vscode-charts-green); }
  .timeline-more, .timeline-earlier {
    color: var(--vscode-textLink-foreground);
    font-size: 10.5px;
    cursor: pointer;
    list-style: none;
    padding-top: 4px;
  }
  .timeline-more::-webkit-details-marker, .timeline-earlier::-webkit-details-marker { display: none; }
  .timeline-earlier { cursor: default; color: var(--vscode-descriptionForeground); }
  h2 .head-meta {
    float: right;
    color: var(--vscode-descriptionForeground);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    font-size: 10.5px;
  }
  .card-note {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    line-height: 1.45;
  }
  .card-note strong { color: var(--vscode-foreground); }
  .card-note code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px;
    padding: 0 3px;
  }
  /* ── Files card ────────────────────────────────────────────────────────── */
  .file-row {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 2px 0;
    font-size: 11.5px;
  }
  .file-op {
    font-family: var(--vscode-editor-font-family, monospace);
    flex-shrink: 0;
    width: 8px;
  }
  .file-op.created { color: var(--vscode-charts-green); }
  .file-op.modified { color: var(--vscode-textLink-foreground); }
  .file-op.deleted { color: var(--vscode-errorForeground); }
  .file-row .path-link {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    white-space: normal;
  }
  /* ── Reply field ───────────────────────────────────────────────────────── */
  .reply-box { margin-top: 14px; }
  .reply-box textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 30px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    font-size: 11.5px;
  }
  .reply-box textarea:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .reply-err {
    color: var(--vscode-errorForeground);
    font-size: 10.5px;
    margin-top: 4px;
  }
  /* Header actions — Focus / Resume, the two verbs the removed Fleet rail owned. */
  .head-actions {
    display: flex;
    gap: 5px;
    margin-left: auto;
    align-self: flex-start;
  }
  .head-btn {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 9px;
    width: 18px;
    height: 18px;
    padding: 0;
    line-height: 18px;
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }
  .head-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
  }
  /* Demoted, collapsible Request. */
  .request-details > summary {
    list-style: none;
    cursor: pointer;
  }
  .request-details > summary::-webkit-details-marker { display: none; }
  .request-details > summary h2 { display: inline; }
  .request-details > summary::before {
    content: '▸';
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    margin-right: 4px;
  }
  .request-details[open] > summary::before { content: '▾'; }
  h2 .todo-frac {
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
    font-size: 11px;
  }
  .todo-track {
    height: 3px;
    border-radius: 2px;
    background: var(--vscode-editorWidget-border);
    overflow: hidden;
    margin-bottom: 6px;
  }
  .todo-track > i {
    display: block;
    height: 100%;
    background: var(--vscode-progressBar-background, var(--vscode-textLink-foreground));
  }
  .todo {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 1px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
  .todo-mk {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
    background: var(--vscode-descriptionForeground);
  }
  .todo.status-in_progress .todo-mk { background: var(--vscode-charts-yellow); }
  .todo.status-completed .todo-mk { background: var(--vscode-charts-green); }
  .todo.status-completed .todo-txt { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
  .todo-txt { color: var(--vscode-foreground); word-break: break-word; }
  .actions-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .action-btn {
    flex: 1 1 auto;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    text-align: center;
  }
  .action-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
  }
  .action-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .action-btn.primary:hover {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
  }
  .slash-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 5px;
  }
  .action-btn.slash {
    flex: none;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px;
    padding: 5px 8px;
    text-align: left;
  }
  .actions-pr {
    margin-bottom: 8px;
  }
  .actions-hint {
    margin-top: 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
  }
  .prompt-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .prompt-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }
  .prompt-btn:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .prompt-title {
    font-weight: 500;
    flex: 0 0 auto;
  }
  .prompt-preview {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .prompt-star {
    color: var(--vscode-charts-yellow);
    font-size: 10px;
    margin-right: 2px;
  }
  .links-list { display: flex; flex-direction: column; gap: 4px; }
  .link-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
  }
  .link-row a {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .link-row a:hover { text-decoration: underline; }
  .link-tag {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .usage-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .usage-badge.usage-out {
    background: var(--vscode-inputValidation-errorBackground);
    color: var(--vscode-inputValidation-errorForeground);
    border: 1px solid var(--vscode-inputValidation-errorBorder, transparent);
  }
  .usage-badge.usage-rate {
    background: var(--vscode-inputValidation-warningBackground);
    color: var(--vscode-inputValidation-warningForeground);
    border: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
  }

  .worktree {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 11.5px;
  }
  .wt-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground);
    opacity: 0.5;
    flex-shrink: 0;
  }
  .wt-dot.active {
    background: var(--vscode-charts-green);
    opacity: 1;
  }
  .wt-name {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .wt-name:hover { text-decoration: underline; }
  .wt-name.active { font-weight: 600; }
  .wt-tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background, transparent);
    padding: 0 5px;
    border-radius: 6px;
  }
  .wt-branch {
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .team {
    margin-top: 6px;
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 6px 8px;
    background: var(--vscode-sideBar-background);
  }
  .team-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .team-name { font-weight: 600; }
  .team-counts {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground);
  }
  .mate {
    display: grid;
    grid-template-columns: 14px 1fr auto auto;
    align-items: center;
    gap: 6px;
    padding: 2px 0 2px 4px;
    font-size: 11.5px;
  }
  .mate-dot {
    width: 6px; height: 6px; border-radius: 50%;
    justify-self: center;
  }
  .mate-dot.running   { background: var(--vscode-charts-green); }
  .mate-dot.completed { background: var(--vscode-descriptionForeground); }
  .mate-dot.pending   { background: var(--vscode-charts-yellow); }
  .mate-dot.failed    { background: var(--vscode-errorForeground); }
  .mate-dot.stopped   { background: var(--vscode-descriptionForeground); opacity: 0.5; }
  .mate-name { font-family: var(--vscode-editor-font-family, monospace); }
  .mate-agent {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
  }
  .mate-status {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
  }
  .err {
    color: var(--vscode-errorForeground);
    font-size: 11px;
    margin-top: 4px;
  }
  .footer {
    margin-top: 16px;
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    text-align: right;
  }
  .footer button {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font: inherit;
    padding: 0;
  }
  .footer button:hover { text-decoration: underline; }
  button.path-link, button.step, button.session-chunk, button.art-toggle, button.art-folder-toggle,
  button.art-reveal, button.art-tile, button.art-link, button.art-summary {
    background: transparent; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  button.path-link { color: var(--vscode-textLink-foreground); padding: 0; }
  button.step { width: 100%; }
  #session-details { margin-top: 8px; color: var(--vscode-descriptionForeground); }
  #session-details summary { cursor: pointer; }
  .session-details { font-size: 11px; overflow-wrap: anywhere; margin-top: 6px; }
  button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  /* Glance header (v3): title, model, id, where it runs. */
  .session-title { font-weight: 600; font-size: 13px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .model-name { font-weight: 600; color: var(--vscode-foreground); }
  .id-row { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
  .id-row .session-chunk { font-size: 10.5px; opacity: .8; }
  .head-btn.small { width: 16px; height: 16px; font-size: 10px; }
  .where-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .where-chip { font-size: 10.5px; padding: 0 7px; border-radius: 9px; line-height: 17px; border: 0; color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); white-space: nowrap; }
  .where-chip.proj { font-weight: 600; background: color-mix(in srgb, var(--vscode-charts-green) 22%, transparent); }
  .where-chip.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; cursor: pointer; }
  .where-chip.wt { background: color-mix(in srgb, var(--vscode-charts-purple) 24%, transparent); }
  .needs-you { margin: 8px 0 2px; border-radius: 6px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--vscode-charts-yellow) 60%, transparent); background: color-mix(in srgb, var(--vscode-charts-yellow) 14%, transparent); }
  .needs-you-k { font-size: 10px; font-weight: 700; letter-spacing: .05em; color: var(--vscode-charts-yellow); }
  .needs-you-t { font-size: 12.5px; margin-top: 3px; line-height: 1.4; }
  .needs-you-btns { display: flex; gap: 6px; margin-top: 7px; }
  .ny-btn { font-size: 11px; padding: 2px 9px; border-radius: 4px; cursor: pointer; border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent)); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .ny-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .session-stats { display: block; margin: 7px 0 0; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
  .failures { margin-top: 4px; font-size: 11.5px; }
  .failures > summary { cursor: pointer; list-style: none; color: var(--vscode-charts-orange, var(--vscode-errorForeground)); }
  .failures > summary::-webkit-details-marker { display: none; }
  .failures-show { color: var(--vscode-textLink-foreground); margin-left: 4px; }
  .failures[open] .failures-show { display: none; }
  .fail-list { margin-top: 6px; border-radius: 6px; padding: 4px 8px; border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 35%, transparent); background: color-mix(in srgb, var(--vscode-errorForeground) 7%, transparent); }
  .fail-row { display: grid; grid-template-columns: auto 1fr; gap: 8px; padding: 4px 0; border-top: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 18%, transparent); }
  .fail-row:first-child { border-top: 0; }
  .fail-at { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; padding-top: 1px; }
  .fail-cmd { font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fail-err { font-size: 10.5px; color: var(--vscode-errorForeground); }
  .fail-blocked > summary { cursor: pointer; font-size: 10.5px; color: var(--vscode-descriptionForeground); padding: 4px 0; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
  .thumb { position: relative; padding: 0; border: 1px solid var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 30%, transparent)); border-radius: 4px; overflow: hidden; width: 96px; height: 54px; background: var(--vscode-editor-background); cursor: pointer; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; object-position: left top; display: block; }
  .thumb-n { position: absolute; right: 2px; bottom: 2px; font-size: 9px; padding: 0 3px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .seek { margin: 2px 0 8px; }
  .seek-bars { display: flex; align-items: flex-end; gap: 2px; height: 34px; border-bottom: 1px solid var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 30%, transparent)); }
  .seek-bar { height: 100%; padding: 0; border: 0; background: transparent; cursor: pointer; display: flex; align-items: flex-end; min-width: 3px; }
  .seek-bar i { display: block; width: 100%; background: color-mix(in srgb, var(--vscode-charts-blue) 55%, transparent); border-radius: 1px 1px 0 0; }
  .seek-bar.bad i { box-shadow: inset 0 -3px 0 var(--vscode-charts-red); }
  .seek-bar:hover i { background: var(--vscode-charts-blue); }
  .seek-gap { align-self: stretch; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 8.5px; line-height: 1.1; color: var(--vscode-descriptionForeground); border-left: 1px dashed var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 30%, transparent)); border-right: 1px dashed var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 30%, transparent)); }
  .seek-marks { position: relative; height: 27px; }
  .seek-mk.low { top: 15px; }
  .seek-mk { position: absolute; top: 2px; transform: translateX(-50%); width: 11px; height: 11px; border-radius: 50%; font-size: 7.5px; font-weight: 700; line-height: 11px; text-align: center; color: var(--vscode-editor-background); }
  .seek-mk.you { background: var(--vscode-charts-blue); }
  .seek-mk.sub { background: var(--vscode-charts-purple); border-radius: 2px; }
  .seek-mk.ask { background: var(--vscode-charts-yellow); }
  .seek-axis { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--vscode-descriptionForeground); }
  .tl-filters { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 8px; }
  .tl-filter { font-size: 10.5px; padding: 0 8px; line-height: 18px; border-radius: 9px; cursor: pointer; border: 1px solid var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 30%, transparent)); background: transparent; color: var(--vscode-foreground); }
  .tl-filter.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .tl-filter em { font-style: normal; opacity: .7; margin-left: 4px; }
  .tl-refresh { background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: inherit; }
  .tl-item { padding: 5px 7px; margin-bottom: 4px; border-radius: 5px; background: color-mix(in srgb, var(--vscode-charts-blue) 9%, transparent); }
  .tl-item.bad { background: color-mix(in srgb, var(--vscode-errorForeground) 9%, transparent); }
  .tl-item-at { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .tl-item-text { font-size: 12px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .step.flash { outline: 2px solid var(--vscode-focusBorder); border-radius: 4px; }
  .subagent { border-radius: 5px; padding: 5px 8px; margin-bottom: 5px; background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
  .subagent > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .subagent > summary::-webkit-details-marker { display: none; }
  .sub-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--vscode-charts-green); }
  .subagent.status-running .sub-dot { background: var(--vscode-charts-blue); }
  .subagent.status-failed .sub-dot { background: var(--vscode-charts-red); }
  .sub-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub-status { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .sub-meta { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--vscode-descriptionForeground); margin: 3px 0 0 13px; }
  .sub-result { font-size: 11.5px; margin: 4px 0 0 13px; padding-left: 7px; border-left: 2px solid var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 30%, transparent)); }
  .sub-open { font-size: 11px; margin: 4px 0 0 13px; background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; }
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

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function relTime(ms) {
  if (!ms) return '';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  const d = Math.floor(h / 24);
  return d + ' day' + (d === 1 ? '' : 's') + ' ago';
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function compactTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1) + 'm tok';
  if (value >= 1000) return Math.round(value / 1000) + 'k tok';
  return Math.round(value) + ' tok';
}

function compactDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalMinutes = Math.max(1, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? hours + 'h ' + minutes + 'm' : minutes + 'm';
}

function prettyModel(id) {
  if (!id) return '';
  const m = id.match(/^claude-(opus|sonnet|haiku|fable)-(\\d+)-(\\d+)/);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2] + '.' + m[3];
  return id;
}

// "today 3:54 PM", "yesterday 10:13 PM", or "Oct 1, 10:13 PM": a person reads a
// clock time, not a bare 24-hour stamp.
function clockTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'today ' + time;
  if (diff === 1) return 'yesterday ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
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
  const whoRow = who.length || usageBadge ? '<div class="account-row">' + who.join(' · ') + usageBadge + '</div>' : '';
  const idRow = s.sessionChunk
    ? '<div class="id-row">' +
        '<button type="button" class="session-chunk" id="copy-session" title="Copy full session ID" aria-label="Copy full session ID">' + esc(s.sessionChunk) + '</button>' +
        (s.hasTerminal && s.terminalId ? '<button type="button" class="head-btn small" data-action="setSessionId" title="Set session ID for terminal" aria-label="Set session ID for terminal">✎</button>' : '') +
      '</div>'
    : '';
  // Where it runs: project, branch, a worktree badge only for a linked worktree
  // (never the worktree's folder name), and the host.
  const branch = s.git && s.git.branch;
  const chips = [];
  if (s.project) chips.push('<span class="where-chip proj">' + esc(s.project) + '</span>');
  if (branch) chips.push('<button type="button" class="where-chip mono" data-scm title="Open Source Control">⎇ ' + esc(branch) + '</button>');
  if (s.inWorktree) chips.push('<span class="where-chip wt" title="' + esc(s.cwd || '') + '">worktree</span>');
  if (s.hostLabel) chips.push('<span class="where-chip">' + esc(s.hostLabel) + '</span>');
  const where = chips.length ? '<div class="where-row">' + chips.join('') + '</div>' : '';
  const actions = s.fullSessionId
    ? '<div class="head-actions">' +
        '<button type="button" class="head-btn" data-action="focusSubject" aria-label="Focus session" title="Focus session">◎</button>' +
        '<button type="button" class="head-btn" data-action="resumeSubject" aria-label="Resume session" title="Resume session">↻</button>' +
      '</div>'
    : '';
  const following = s.subjectSource === 'fleet' && !s.hasTerminal
    ? '<div class="account-row">following the Fleet selection</div>'
    : '';
  return (
    '<div class="card">' +
      '<div class="agent-head">' +
        logo +
        '<div class="agent-head-text">' +
          '<div class="title-row session-title" title="' + esc(title) + '">' + esc(title) + '</div>' +
          whoRow +
          idRow +
          where +
          following +
        '</div>' +
        actions +
      '</div>' +
      '<details id="session-details"' + (viewState.detailsOpen ? ' open' : '') + '><summary>Details</summary><div class="session-details">' +
        [((s.agentType || s.agentName || '') + ' ' + (s.version || '')).trim(), s.model, s.fullSessionId, s.cwd, s.sessionHost].filter(Boolean).map((value) => '<div>' + esc(value) + '</div>').join('') +
        (s.git && s.git.dirtyCount > 0 ? '<div class="branch-row"><button type="button" class="dirty-pill" data-scm>' + s.git.dirtyCount + ' changed</button></div>' : '') +
      '</div></details>' +
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
function renderSessionStats(s) {
  const stats = [];
  if (s.startedAtMs) stats.push('Started ' + clockTime(s.startedAtMs));
  const duration = compactDuration(s.durationMs);
  const tokens = compactTokens(s.tokenCount);
  if (duration) stats.push(duration);
  if (tokens) stats.push(tokens);
  if (s.tokPerSec > 0) stats.push(Math.round(s.tokPerSec) + ' tok/s');
  if (!stats.length) return '';
  return '<div class="session-stats">' + esc(stats.join(' · ')) + '</div>';
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

// ── Timeline ────────────────────────────────────────────────────────────────
// The CLI's narration-anchored fold: last 5 steps newest-first, 3 more behind
// "more", everything older collapsed into one counter. On an older CLI the
// summarizer's 'checkpoints' are projected into the same step shape so the card
// degrades instead of disappearing.
function timelineFromCheckpoints(s) {
  const checkpoints = s.checkpoints || [];
  if (!checkpoints.length) return null;
  return {
    steps: checkpoints.map((c) => ({
      text: c.text, at: c.at, source: 'narration', tools: 0, failed: 0, blocked: 0,
    })),
    earlier: { steps: 0, tools: 0, failed: 0 },
    tools: 0, failed: 0, spanMs: 0, state: 'ready',
  };
}

function stepChips(step) {
  const bits = [];
  const mix = step.mix || {};
  // Top 3 verb classes by count — the shape of the work, not a full histogram.
  const top = Object.keys(mix)
    .map((k) => ({ k: k, n: mix[k] }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);
  for (const entry of top) bits.push(esc(entry.n + ' ' + entry.k));
  if (step.failed > 0) bits.push('<span class="bad">' + step.failed + ' failed</span>');
  if (step.blocked > 0) bits.push('<span class="bad">' + step.blocked + ' blocked</span>');
  for (const mark of (step.marks || [])) bits.push('<span class="mark">' + esc(mark) + '</span>');
  return bits.length ? '<span class="step-chips">' + bits.join(' · ') + '</span>' : '';
}

function renderStep(step) {
  const at = Date.parse(step.at);
  const when = Number.isFinite(at) ? relTime(at) : '';
  const cls = 'step src-' + esc(step.source || 'narration') + (step.live ? ' live' : '');
  // A user turn is the user's own words, so it renders quoted and muted — it is
  // not something the agent did.
  const text = step.source === 'user' ? '“' + truncate(step.text, 120) + '”' : truncate(step.text, 160);
  const key = JSON.stringify([lastSnapshot && lastSnapshot.fullSessionId, step.at, step.source]);
  const expanded = !!(viewState.expandedSteps && viewState.expandedSteps[key]);
  return (
    '<button type="button" data-at="' + (Number.isFinite(at) ? at : '') + '" data-step-key="' + esc(key) + '" class="' + cls + '" data-expand="' + esc(step.source === 'user' ? '“' + step.text + '”' : step.text) + '" data-short="' + esc(text) + '" aria-expanded="' + expanded + '">' +
      '<span class="step-mk"></span>' +
      '<span class="step-txt">' + esc(expanded ? (step.source === 'user' ? '“' + step.text + '”' : step.text) : text) + '</span>' +
      '<span class="step-at" title="' + esc(step.at || '') + '">' + esc(step.live ? 'now' : when) + '</span>' +
      (step.live && step.now ? '<span class="step-now">▶ ' + esc(truncate(step.now, 120)) + '</span>' : '') +
      stepChips(step) +
    '</button>'
  );
}

const TIMELINE_SHOWN = 3;

// One strip of tool activity across the whole session. A run of 3+ empty buckets
// collapses into a labeled gap so a 17-hour session with 10 idle hours still
// shows its bursts. Markers: your messages (numbered), subagent starts, and the
// open ask at the end. Clicking a bar jumps the step list to that moment.
function renderSeekBar(s) {
  const h = s.activityHistogram;
  if (!h || !h.buckets || !h.buckets.length || !(h.endMs > h.startMs)) return '';
  const n = h.buckets.length;
  const bucketMs = (h.endMs - h.startMs) / n;
  const max = Math.max(1, ...h.buckets.map((b) => b.tools));
  const empty = (b) => b.tools === 0 && b.failed === 0 && b.blocked === 0;
  const segs = [];
  for (let i = 0; i < n;) {
    if (empty(h.buckets[i])) {
      let j = i;
      while (j < n && empty(h.buckets[j])) j++;
      if (j - i >= 3) { segs.push({ gap: true, from: i, to: j }); i = j; continue; }
    }
    segs.push({ gap: false, i: i });
    i++;
  }
  const units = segs.reduce((acc, seg) => acc + (seg.gap ? 3 : 1), 0);
  const leftOf = {};
  let u = 0;
  for (const seg of segs) {
    if (seg.gap) { for (let k = seg.from; k < seg.to; k++) leftOf[k] = (u + 1.5) / units * 100; u += 3; }
    else { leftOf[seg.i] = (u + 0.5) / units * 100; u += 1; }
  }
  const bucketOf = (ms) => Math.max(0, Math.min(n - 1, Math.floor((ms - h.startMs) / bucketMs)));
  const bars = segs.map((seg) => {
    if (seg.gap) {
      return '<div class="seek-gap" style="flex:3" role="img" aria-label="' + esc(compactDuration((seg.to - seg.from) * bucketMs) + ' idle') + '">' + esc(compactDuration((seg.to - seg.from) * bucketMs)) + '<br>idle</div>';
    }
    const b = h.buckets[seg.i];
    const height = b.tools ? Math.max(8, Math.round(b.tools / max * 100)) : 4;
    const at = Math.round(h.startMs + (seg.i + 0.5) * bucketMs);
    const bad = b.failed + b.blocked;
    const tip = clockTime(at) + ' · ' + b.tools + ' tools' + (b.failed ? ' · ' + b.failed + ' failed' : '') + (b.blocked ? ' · ' + b.blocked + ' blocked' : '');
    return '<button type="button" class="seek-bar' + (bad ? ' bad' : '') + '" style="flex:1" data-seek="' + at + '" title="' + esc(tip) + '" aria-label="' + esc('Jump to ' + tip) + '"><i style="height:' + height + '%"></i></button>';
  }).join('');
  const marks = [];
  // Messages that land in one bucket share one marker (its tooltip lists them all);
  // subagents and the open ask sit on a second row so they never cover a message.
  const youByBucket = {};
  (h.userAtMs || []).forEach((t, k) => { (youByBucket[bucketOf(t)] = youByBucket[bucketOf(t)] || []).push(k + 1); });
  for (const key of Object.keys(youByBucket)) {
    const nums = youByBucket[key];
    const label = nums.length === 1 ? String(nums[0]) : nums[0] + '+';
    marks.push('<span class="seek-mk you" role="img" aria-label="' + esc('Your message' + (nums.length > 1 ? 's ' : ' ') + nums.join(', ')) + '" style="left:' + leftOf[key].toFixed(2) + '%" title="Your message' + (nums.length > 1 ? 's ' : ' ') + esc(nums.join(', ')) + '">' + esc(label) + '</span>');
  }
  const lower = {};
  for (const x of (s.subagents || [])) {
    if (!x.startedAtMs) continue;
    const b = bucketOf(x.startedAtMs);
    (lower[b] = lower[b] || []).push(x.description);
  }
  for (const key of Object.keys(lower)) {
    marks.push('<span class="seek-mk sub low" role="img" aria-label="' + esc('Subagent: ' + lower[key].join('; ')) + '" style="left:' + leftOf[key].toFixed(2) + '%" title="Subagent: ' + esc(lower[key].join('; ')) + '">' + (lower[key].length > 1 ? lower[key].length : 'S') + '</span>');
  }
  if (s.needsYou) marks.push('<span class="seek-mk ask low" role="img" aria-label="Needs you" style="left:' + leftOf[n - 1].toFixed(2) + '%" title="Needs you">!</span>');
  return (
    '<div class="seek" role="group" aria-label="Session activity">' +
      '<div class="seek-bars">' + bars + '</div>' +
      '<div class="seek-marks">' + marks.join('') + '</div>' +
      '<div class="seek-axis"><span>' + esc(clockTime(h.startMs)) + '</span><span>' + esc(clockTime(h.endMs)) + '</span></div>' +
    '</div>'
  );
}

// Filters swap the default summary for one stream. You and Failed ride the row;
// Agent, Tools and Reasoning are one agents-sessions call per click (cached).
const TIMELINE_FILTERS = [{ id: 'summary', label: 'Summary' }, { id: 'user', label: 'You' }, { id: 'failed', label: 'Failed' }, { id: 'assistant', label: 'Agent' }, { id: 'tools', label: 'Tools' }, { id: 'thinking', label: 'Reasoning' }];
const filterCache = {};
const pendingFilters = {};
const VERB_FILTERS = ['assistant', 'tools', 'thinking'];

// One loaded list per session and filter. A live session keeps writing, so the list
// remembers the activity stamp it was loaded at and offers a refresh; it never refetches
// on its own. The id can outlive the page (webview state); the payload cannot, so a
// restored heavy filter with no request in this page falls back to Summary.
function filterKey(s, role) {
  return ((s && s.fullSessionId) || '') + ':' + role;
}

function requestTimelineFilter(sessionId, role) {
  const key = (sessionId || '') + ':' + role;
  delete filterCache[key];
  pendingFilters[key] = true;
}

function applyTimelineFilter(msg, snapshot) {
  const key = (msg.sessionId || '') + ':' + msg.role;
  delete pendingFilters[key];
  const current = snapshot && snapshot.fullSessionId === msg.sessionId;
  filterCache[key] = msg.error ? { error: msg.error } : { items: msg.items || [], atStamp: current ? (snapshot.lastActivityMs || 0) : 0 };
  return !!current;
}

function currentFilter(s) {
  const id = (s && s.fullSessionId) || '';
  const f = (viewState.timelineFilter || {})[id];
  if (VERB_FILTERS.indexOf(f) >= 0 && !(s && s.sessionLocal)) return 'summary';
  if (VERB_FILTERS.indexOf(f) >= 0 && !filterCache[id + ':' + f] && !pendingFilters[id + ':' + f]) return 'summary';
  return TIMELINE_FILTERS.some((x) => x.id === f) ? f : 'summary';
}

function renderFilterChips(s, active) {
  if (!s.fullSessionId) return '';
  const counts = { user: (s.userTurns || []).length, failed: (s.failures || []).length };
  return '<div class="tl-filters">' + TIMELINE_FILTERS.map((f) => {
    if (f.id === 'user' && !s.userTurns) return '';
    if (f.id === 'failed' && !(s.failures && s.failures.length)) return '';
    if (VERB_FILTERS.indexOf(f.id) >= 0 && !s.sessionLocal) return '';
    const count = counts[f.id] ? '<em>' + counts[f.id] + '</em>' : '';
    return '<button type="button" class="tl-filter' + (f.id === active ? ' on' : '') + '" data-filter="' + f.id + '" aria-pressed="' + (f.id === active) + '">' + esc(f.label) + count + '</button>';
  }).join('') + '</div>';
}

function filteredRows(items) {
  if (!items.length) return '<div class="card-note">Nothing here.</div>';
  return items.map((it) => (
    '<div class="tl-item' + (it.bad ? ' bad' : '') + '">' +
      '<div class="tl-item-at">' + esc((it.label ? it.label + ' · ' : '') + (it.atMs ? clockTime(it.atMs) : '')) + '</div>' +
      '<div class="tl-item-text">' + esc(it.text) + '</div>' +
    '</div>'
  )).join('');
}

function renderFilteredBody(s, active) {
  if (active === 'user') {
    return filteredRows((s.userTurns || []).map((t, i) => ({
      atMs: t.atMs,
      label: 'turn ' + (i + 1) + (t.images ? ' · ' + t.images + ' image' + (t.images === 1 ? '' : 's') : ''),
      text: t.text,
    })));
  }
  if (active === 'failed') {
    return filteredRows((s.failures || []).slice().reverse().map((f) => ({
      atMs: f.atMs, label: f.blocked ? 'blocked' : 'failed', text: f.tool + ': ' + f.summary + ' → ' + f.error, bad: true,
    })));
  }
  const cached = filterCache[filterKey(s, active)];
  if (!cached) return '<div class="card-note">Loading…</div>';
  if (cached.error) return '<div class="card-note">Could not load: ' + esc(cached.error) + ' <button type="button" class="tl-refresh" data-refresh-filter="' + active + '">Retry</button></div>';
  const stale = (s.lastActivityMs || 0) > (cached.atStamp || 0)
    ? '<div class="card-note">Newer activity since this loaded. <button type="button" class="tl-refresh" data-refresh-filter="' + active + '">Refresh</button></div>'
    : '';
  return stale + filteredRows(cached.items.map((it) => ({ atMs: Date.parse(it.at) || 0, text: it.text, bad: it.bad })).reverse());
}

function renderTimelineCard(s) {
  // The stream has not established for this session's scope: say so instead of
  // rendering an empty card that reads as "the agent has done nothing".
  if (s.streamDegraded) {
    return (
      '<h2>Timeline</h2>' +
      '<div class="card"><div class="card-note">' +
        '<strong>Waiting for the session stream…</strong><br>' +
        'No row has arrived for ' + esc(s.streamScope || 'this machine') + ' yet. The elected ' +
        'window runs <code>agents feed watch --json</code> while a session view is open, and ' +
        'this panel renders whatever that stream carries. Nothing here is fetched per click.' +
      '</div></div>'
    );
  }
  const t = s.timeline || timelineFromCheckpoints(s);
  if (!t) return '';
  if (t.state === 'unavailable') {
    return (
      '<h2>Timeline</h2>' +
      '<div class="card"><div class="card-note">' +
        '<strong>Timeline unavailable for this harness</strong>' +
        (t.reason ? '<br>' + esc(t.reason) : '') +
      '</div></div>'
    );
  }
  const steps = (t.steps || []).slice().reverse();   // newest first
  if (!steps.length && !t.earlier.steps) return '';
  const head = [];
  if (s.lastActivityMs) head.push('last active ' + relTime(s.lastActivityMs));
  if (t.tools > 0) head.push(t.tools + ' tools');
  const meta = head.length ? '<span class="head-meta">' + esc(head.join(' · ')) + '</span>' : '';
  const active = currentFilter(s);
  const seekAndFilters = renderSeekBar(s) + renderFilterChips(s, active);
  if (active !== 'summary') {
    return '<h2>Timeline' + meta + '</h2><div class="card">' + seekAndFilters + '<div class="tl-filtered">' + renderFilteredBody(s, active) + '</div></div>';
  }

  const shown = steps.slice(0, TIMELINE_SHOWN).map(renderStep).join('');
  const rest = steps.slice(TIMELINE_SHOWN);
  const more = rest.length
    ? '<details><summary class="timeline-more">' + rest.length + ' more</summary>' +
      rest.map(renderStep).join('') + '</details>'
    : '';
  const earlierBits = [];
  if (t.earlier.steps > 0) {
    earlierBits.push(t.earlier.steps + ' earlier step' + (t.earlier.steps === 1 ? '' : 's'));
    if (t.earlier.tools > 0) earlierBits.push(t.earlier.tools + ' tools');
    if (t.earlier.failed > 0) earlierBits.push(t.earlier.failed + ' failed');
  }
  const earlier = earlierBits.length
    ? '<div class="timeline-earlier">▸ ' + esc(earlierBits.join(' · ')) + '</div>'
    : '';
  const partial = t.state === 'partial'
    ? '<div class="card-note" style="margin-top:6px">Partial: the transcript was capped this tick.</div>'
    : '';
  return (
    '<h2>Timeline' + meta + '</h2>' +
    '<div class="card">' + seekAndFilters + shown + more + earlier + partial + '</div>'
  );
}

// ── Files ───────────────────────────────────────────────────────────────────
// The paths the HARNESS recorded as created / modified / deleted. Nothing is
// inferred from the filesystem: no 'files' on the row means no card.
const FILE_OP_SYMBOL = { created: '+', modified: '~', deleted: '−' };

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
  const rows = files.changes.map((change) => {
    return (
      '<div class="file-row">' +
        '<span class="file-op ' + esc(change.op) + '">' + esc(FILE_OP_SYMBOL[change.op] || '~') + '</span>' +
        '<button type="button" class="path-link" data-path="' + esc(change.path) + '" title="' + esc(change.path) + '">' + esc(change.display) + '</button>' +
      '</div>'
    );
  }).join('');
  return (
    '<h2>Files' + (head.length ? '<span class="head-meta">' + esc(head.join(' · ')) + '</span>' : '') + '</h2>' +
    '<div class="card">' + rows + '</div>'
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

// ── Artifacts ───────────────────────────────────────────────────────────────
// Everything the session produced for a person: the CLI's artifacts grouped into
// their folders, the PR and the ticket. Sort, grouping and the folded state are
// the viewer's choice and persist; the data is only what the row carries.
const APP_LABEL = { github: 'GitHub', finder: 'Finder', linear: 'Linear' };
const APP_ICON = {
  github: '<svg class="art-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  finder: '<svg class="art-icon" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="3.5" fill="#1E6FF0"/><path d="M8.6 0H12.5A3.5 3.5 0 0116 3.5v9A3.5 3.5 0 0112.5 16H7.4C7.9 12 8.9 9.5 7.2 9.2 6.4 9 7.6 3 8.6 0z" fill="#9DD0FF"/><path d="M4.7 5v1.6M11.3 5v1.6M3.8 11c2.6 1.8 5.8 1.8 8.4 0" stroke="#0B2A5C" stroke-width="1.1" fill="none" stroke-linecap="round"/></svg>',
  linear: '<svg class="art-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#5E6AD2"/><path d="M2.2 9.6l4.2 4.2M2.9 6.8l6.3 6.3M4.4 4.4l7.2 7.2M6.8 2.9l6.3 6.3" stroke="#fff" stroke-width="1.1"/></svg>',
};
const ARTIFACT_SORTS = {
  latest: (a, b) => (b.editedAtMs || 0) - (a.editedAtMs || 0),
  oldest: (a, b) => (a.editedAtMs || 0) - (b.editedAtMs || 0),
  name: (a, b) => a.name.localeCompare(b.name),
};

function artifactItems(s) {
  const files = (s.artifacts || []).slice();
  if (s.plan && !files.some((a) => a.path === s.plan.path)) {
    files.push({ path: s.plan.path, display: s.plan.display, basename: s.plan.display.split('/').pop(), bucket: 'plans' });
  }
  const folders = new Map();
  for (const f of files) {
    const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
    let folder = folders.get(dir);
    if (!folder) {
      const cut = f.display.lastIndexOf('/');
      const shown = cut < 0 ? '' : f.display.slice(0, cut);
      folder = { app: 'finder', key: dir, name: dir.split('/').pop() || dir, display: shown, files: [], editedAtMs: 0 };
      folders.set(dir, folder);
    }
    folder.files.push(Object.assign({ name: f.title || f.basename }, f));
    folder.editedAtMs = Math.max(folder.editedAtMs, f.editedAtMs || 0);
  }
  const items = Array.from(folders.values());
  for (const pr of (s.pullRequests || [])) items.push({ app: 'github', key: pr.url, name: pr.ownerRepo + ' #' + pr.number, pr });
  if (s.linearIssue) items.push({ app: 'linear', key: s.linearIssue, name: s.linearIssue, ticket: s.linearIssue });
  return items;
}

function renderArtifactsCard(s) {
  const items = artifactItems(s);
  if (!items.length) return '';
  const sortKey = ARTIFACT_SORTS[viewState.artifactSort] ? viewState.artifactSort : 'latest';
  const grouped = viewState.artifactGroup !== false;
  const collapsed = !!viewState.artifactsCollapsed;
  items.sort(ARTIFACT_SORTS[sortKey]);
  const fileCount = items.reduce((n, it) => n + (it.files ? it.files.length : 0), 0);
  const meta = items.length + (items.length === 1 ? ' item' : ' items') + (fileCount ? ' · ' + fileCount + (fileCount === 1 ? ' file' : ' files') : '');
  const head =
    '<h2><button type="button" class="art-toggle" data-art-toggle aria-expanded="' + !collapsed + '">' +
      '<span class="caret">' + (collapsed ? '▸' : '▾') + '</span>Artifacts</button>' +
      '<span class="head-meta">' + esc(meta) + '</span></h2>';
  if (collapsed) return head + renderArtifactsSummary(items);
  const options = [['latest', 'Latest edited'], ['oldest', 'Oldest first'], ['name', 'Name']]
    .map((o) => '<option value="' + o[0] + '"' + (o[0] === sortKey ? ' selected' : '') + '>' + o[1] + '</option>').join('');
  const bar =
    '<div class="art-bar"><label>Sort <select data-art-sort>' + options + '</select></label>' +
    '<button type="button" class="art-group" data-art-group aria-pressed="' + grouped + '">Group by app</button></div>';
  let body = '';
  if (grouped) {
    const apps = [];
    for (const it of items) {
      let group = apps.find((g) => g.app === it.app);
      if (!group) apps.push(group = { app: it.app, items: [] });
      group.items.push(it);
    }
    body = apps.map((g) =>
      '<div class="art-app">' + APP_ICON[g.app] + esc(APP_LABEL[g.app]) + '<span class="art-count">' + g.items.length + '</span></div>' +
      g.items.map((it) => renderArtifactItem(it, s, sortKey, false)).join('')
    ).join('');
  } else {
    body = items.map((it) => renderArtifactItem(it, s, sortKey, true)).join('');
  }
  return head + '<div class="card art-card">' + bar + body + '</div>';
}

function renderArtifactItem(it, s, sortKey, showApp) {
  const icon = showApp ? APP_ICON[it.app] : '';
  if (it.pr) {
    return '<button type="button" class="art-link" data-url="' + esc(it.pr.url) + '" title="' + esc(it.pr.url) + '">' +
      icon + '<span class="art-link-kind">PR</span>' + esc(it.pr.ownerRepo) + ' #' + it.pr.number + '</button>';
  }
  if (it.ticket) {
    const url = 'https://linear.app/issue/' + encodeURIComponent(it.ticket);
    return '<button type="button" class="art-link" data-url="' + esc(url) + '" title="' + esc(url) + '">' +
      icon + '<span class="art-link-kind">Ticket</span>' + esc(it.ticket) + '</button>';
  }
  const open = !!(viewState.openFolders || {})[it.key];
  const files = it.files.slice().sort(ARTIFACT_SORTS[sortKey]);
  const count = it.files.length + (it.files.length === 1 ? ' file' : ' files');
  return (
    '<div class="art-folder' + (open ? ' open' : '') + '">' +
      '<div class="art-folder-head">' +
        '<button type="button" class="art-folder-toggle" data-folder="' + esc(it.key) + '" aria-expanded="' + open + '" title="' + esc(it.key) + '">' +
          '<span class="caret">' + (open ? '▾' : '▸') + '</span>' + icon + '<span class="art-folder-name">' + esc(it.name) + '</span></button>' +
        (s.sessionLocal ? '<button type="button" class="art-reveal" data-reveal="' + esc(it.key) + '" title="Reveal in Finder">↗</button>' : '') +
        (it.editedAtMs ? '<span class="art-time">' + esc(relTime(it.editedAtMs)) + '</span>' : '') +
      '</div>' +
      '<div class="art-meta">' + esc([it.display, count].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="art-files" data-strip="' + esc(it.key) + '">' + files.map(renderArtifactTile).join('') + '</div>' +
    '</div>'
  );
}

// An agent's renders are often 4000+ px; an <img> keeps the full decode (60+ MB)
// alive for a 90 px tile. Each image is instead fetched once when it scrolls
// near view, downscaled to a small WebP, and cached for the webview's life.
// Decodes run one at a time so a folder of renders never spikes the machine.
const THUMB_WIDTH = 176;
const THUMB_RETRY_MS = 30000;
const thumbCache = new Map();
const thumbFailedAt = new Map();
let thumbQueue = Promise.resolve();
const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbObserver.unobserve(entry.target);
    queueThumb(entry.target.getAttribute('data-thumb'));
  }
}, { rootMargin: '200px' });

function thumbImg(f) {
  if (f.path.toLowerCase().endsWith('.svg')) return '<img src="' + esc(f.uri) + '" alt="">';
  // No src until the small copy exists: src="" would draw a broken-image icon.
  const ready = thumbCache.get(f.uri);
  return '<img data-thumb="' + esc(f.uri) + '"' + (ready ? ' src="' + esc(ready) + '"' : '') + ' alt="">';
}

function queueThumb(uri) {
  thumbQueue = thumbQueue.then(async () => {
    // A render still being written fails to decode; try again later, not every render.
    if (Date.now() - (thumbFailedAt.get(uri) || 0) < THUMB_RETRY_MS) return;
    if (!thumbCache.has(uri)) {
      try {
        const bitmap = await createImageBitmap(await (await fetch(uri)).blob(), { resizeWidth: THUMB_WIDTH, resizeQuality: 'medium' });
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        // WebP keeps transparency; JPEG would turn a cutout or logo black.
        thumbCache.set(uri, canvas.toDataURL('image/webp', 0.8));
      } catch {
        thumbFailedAt.set(uri, Date.now());
        return;
      }
    }
    const url = thumbCache.get(uri);
    for (const img of root.querySelectorAll('img[data-thumb]')) if (img.getAttribute('data-thumb') === uri) img.src = url;
  });
}

function renderArtifactTile(f) {
  const face = f.uri
    ? thumbImg(f)
    : '<span class="art-ext">' + esc((f.path.split('.').pop() || '').toUpperCase()) + '</span>';
  return '<button type="button" class="art-tile artifact-open" data-artifact="' + esc(f.path) + '" title="' + esc(f.path) + '">' +
    '<span class="art-thumb">' + face + '</span><span class="art-label">' + esc(f.name) + '</span></button>';
}

// The folded section still says what is there: the first thumbnails, which
// apps hold artifacts, and when the newest one changed.
function renderArtifactsSummary(items) {
  const thumbs = [];
  for (const it of items) for (const f of (it.files || [])) if (f.uri && thumbs.length < 3) thumbs.push(thumbImg(f));
  const apps = items.map((it) => it.app).filter((app, i, all) => all.indexOf(app) === i).map((app) => APP_ICON[app]).join('');
  const newest = Math.max(0, ...items.map((it) => it.editedAtMs || 0));
  return '<button type="button" class="art-summary" data-art-toggle>' + thumbs.join('') + '<span class="art-apps">' + apps + '</span>' +
    (newest ? '<span class="art-time">newest ' + esc(relTime(newest)) + '</span>' : '') + '</button>';
}

function renderSpawnedTeamCard(s) {
  const subs = s.subagents || [];
  if (subs.length) {
    const running = subs.filter((x) => x.status === 'running').length;
    const rows = subs.map((x) => {
      const dur = typeof x.startedAtMs === 'number' && typeof x.endedAtMs === 'number' ? compactDuration(x.endedAtMs - x.startedAtMs) : '';
      const meta = [x.agentType, dur, x.toolCount ? x.toolCount + ' tools' : ''].filter(Boolean).join(' · ');
      return (
        '<details class="subagent status-' + esc(x.status) + '">' +
          '<summary><span class="sub-dot"></span><span class="sub-name">' + esc(x.description || x.id) + '</span>' +
          '<span class="sub-status">' + esc(x.status) + '</span></summary>' +
          '<div class="sub-meta">' + esc(meta) + '</div>' +
          (x.resultExcerpt ? '<div class="sub-result">' + esc(x.resultExcerpt) + '</div>' : '') +
          (x.transcriptPath ? '<button type="button" class="sub-open path-link" data-path="' + esc(x.transcriptPath) + '">Open transcript ▸</button>' : '') +
        '</details>'
      );
    }).join('');
    const head = subs.length + (running ? ' · ' + running + ' running' : ' · all finished');
    return '<h2>Subagents<span class="head-meta">' + esc(head) + '</span></h2><div class="card subagents">' + rows + '</div>';
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
  // Stream updates re-render the panel; a strip the viewer scrolled stays put.
  const stripScroll = {};
  for (const el of root.querySelectorAll('[data-strip]')) stripScroll[el.getAttribute('data-strip')] = [el.scrollLeft, el.scrollTop];
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
  // What was asked, what the agent has actually done, the checklist, what it
  // produced, and the files it touched — then a reply field (PHNX-3939).
  root.innerHTML = (
    renderTerminalCard(snap) +
    renderNeedsYou(snap) +
    renderSessionStats(snap) +
    renderFailures(snap) +
    renderGoalCard(snap) +
    renderRequestCard(snap) +
    renderTimelineCard(snap) +
    renderArtifactsCard(snap) +
    renderChecklistCard(snap) +
    renderSpawnedTeamCard(snap) +
    renderActivityCard(snap) +
    renderFilesCard(snap) +
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
  for (const el of root.querySelectorAll('[data-strip]')) {
    const at = stripScroll[el.getAttribute('data-strip')];
    if (at) { el.scrollLeft = at[0]; el.scrollTop = at[1]; }
  }
  for (const img of root.querySelectorAll('img[data-avatar]')) img.addEventListener('error', () => img.remove());
  thumbObserver.disconnect();
  for (const img of root.querySelectorAll('img[data-thumb]')) if (!img.hasAttribute('src')) thumbObserver.observe(img);
  for (const el of root.querySelectorAll('[data-art-toggle]')) {
    el.addEventListener('click', () => { viewState.artifactsCollapsed = !viewState.artifactsCollapsed; vscode.setState(viewState); render(lastSnapshot); });
  }
  const artSort = root.querySelector('[data-art-sort]');
  if (artSort) artSort.addEventListener('change', () => { viewState.artifactSort = artSort.value; vscode.setState(viewState); render(lastSnapshot); });
  const artGroup = root.querySelector('[data-art-group]');
  if (artGroup) artGroup.addEventListener('click', () => { viewState.artifactGroup = viewState.artifactGroup === false; vscode.setState(viewState); render(lastSnapshot); });
  for (const el of root.querySelectorAll('[data-folder]')) {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-folder');
      const open = Object.assign({}, viewState.openFolders);
      if (open[key]) delete open[key]; else open[key] = true;
      viewState.openFolders = open;
      vscode.setState(viewState);
      render(lastSnapshot);
    });
  }
  for (const el of root.querySelectorAll('[data-reveal]')) {
    el.addEventListener('click', () => vscode.postMessage({ type: 'revealCwd', path: el.getAttribute('data-reveal') }));
  }
  for (const el of root.querySelectorAll('.artifact-open')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openArtifact', path: el.getAttribute('data-artifact') });
    });
  }
  for (const el of root.querySelectorAll('[data-filter]')) {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-filter');
      const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
      const next = Object.assign({}, viewState.timelineFilter);
      next[key] = id;
      viewState.timelineFilter = next;
      vscode.setState(viewState);
      const cached = filterCache[filterKey(lastSnapshot, id)];
      if (VERB_FILTERS.indexOf(id) >= 0 && (!cached || cached.error)) {
        requestTimelineFilter(key, id);
        vscode.postMessage({ type: 'loadTimelineFilter', role: id, sessionId: key });
      }
      render(lastSnapshot);
    });
  }
  for (const el of root.querySelectorAll('[data-refresh-filter]')) {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-refresh-filter');
      const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
      requestTimelineFilter(key, id);
      vscode.postMessage({ type: 'loadTimelineFilter', role: id, sessionId: key });
      render(lastSnapshot);
    });
  }
  for (const el of root.querySelectorAll('[data-seek]')) {
    el.addEventListener('click', () => {
      const at = Number(el.getAttribute('data-seek'));
      const key = (lastSnapshot && lastSnapshot.fullSessionId) || '';
      if (currentFilter(lastSnapshot) !== 'summary') {
        const next = Object.assign({}, viewState.timelineFilter);
        next[key] = 'summary';
        viewState.timelineFilter = next;
        vscode.setState(viewState);
        render(lastSnapshot);
      }
      let best = null;
      for (const step of root.querySelectorAll('.step[data-at]')) {
        const t = Number(step.getAttribute('data-at'));
        if (!Number.isFinite(t) || !t) continue;
        if (!best || Math.abs(t - at) < Math.abs(Number(best.getAttribute('data-at')) - at)) best = step;
      }
      if (!best) return;
      const fold = best.closest('details');
      if (fold) fold.open = true;
      best.scrollIntoView({ block: 'center' });
      best.classList.add('flash');
      setTimeout(() => best.classList.remove('flash'), 1200);
    });
  }
  const copy = root.querySelector('#copy-session');
  if (copy) copy.addEventListener('click', () => vscode.postMessage({ type: 'copySessionId' }));
  for (const el of root.querySelectorAll('[data-expand]')) {
    el.addEventListener('click', () => {
      const expanded = el.getAttribute('aria-expanded') === 'true';
      viewState.expandedSteps = viewState.expandedSteps || {};
      const key = el.getAttribute('data-step-key');
      if (expanded) delete viewState.expandedSteps[key];
      else viewState.expandedSteps[key] = true;
      vscode.setState(viewState);
      el.setAttribute('aria-expanded', String(!expanded));
      el.querySelector('.step-txt').textContent = expanded ? el.getAttribute('data-short') : el.getAttribute('data-expand');
    });
  }
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
  for (const el of root.querySelectorAll('[data-url]:not([data-action])')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openUrl', url: el.getAttribute('data-url') });
    });
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
    if (!activity) continue;
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
