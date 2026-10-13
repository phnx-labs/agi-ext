// Agent Panel: the activity-bar sidebar view that is the ONE session preview in
// the extension (PHNX-3939); everything that describes a session lives here.
//
// Subject model — two triggers, one subject, last wins:
//   an agent terminal takes focus       -> onDidChangeActiveTerminal
//   a Project panel session is clicked  -> setAgentPanelSubjectFromProject {sessionId, host}
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
//
// Detection model:
//   active terminal -> terminals.getByTerminal(t) -> EditorTerminal struct
//   cwd            -> terminal.creationOptions.cwd
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
import { BUILT_IN_AGENTS } from '../core/agents';
import { openExternalUrl } from './webviewSecurity';
import { todoProgressFromItems, type TodoProgress } from '../core/session.activity';
import {
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
import { runAgents, runCliArgs } from '../core/agentsBin';
import { canOfferMerge, prAction, prRepo, type PrAction, type RemotePrStatus } from '../core/prStatus';
import { cleanTitle } from '../core/projectPanel';
import { mergeWithMenu } from './prMerge.vscode';
import { getSettings } from './agentSettings.vscode';
import { validMergeMethod } from '../core/settings';
import { shellQuote } from '../core/shellQuote';
import { PATCH_SCRIPT, SESSION_CARDS_SCRIPT, sessionPanelCss, sessionPanelFontFaces } from '../shared/sessionCards';
import { requestImageThumbs, sessionCardFields } from '../core/sessionCardFields';
import { SESSION_STATE_WORD, sessionStateOf, type SessionStateKey } from '../shared/sessionState';
import { VERB_FILTER_ROLES, fetchTimelineFilter, openSessionArtifact } from './sessionCardActions';
import { isInside } from '../core/displayPath';
import { relatedSessions, type RelatedSession } from '../core/relatedSessions';
import { blockedUpdate, sessionUpdates, type SessionUpdate } from '../core/sessionUpdates';
import { ticketFace, type TicketFace } from '../core/ticketFaces';
import { dictation } from './dictation.vscode';

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

interface GitInfo {
  branch?: string;
  dirtyCount?: number;
}

// Re-export shared types so the rest of this file doesn't need to switch on
// `SharedFoo` everywhere. Keeps the snapshot interface readable.
type PullRequestRef = SharedPullRequestRef;
type WorktreeRef = SharedWorktreeRef;

interface PanelSnapshot {
  /** A local agent terminal backs the subject (drives terminal-only actions). */
  hasTerminal: boolean;
  /** There is a session to render at all — from a terminal OR a Project panel click. */
  hasSubject?: boolean;
  /** Where the subject came from; a Project subject shows "following the Project panel selection". */
  subjectSource?: 'terminal' | 'project';
  // Terminal facts
  terminalId?: string;       // internal id for action commands
  agentName?: string;        // "Claude"
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
  workspaceRoot?: string;
  // Git
  git?: GitInfo;
  // Conversation
  conversation?: ConversationSummary;
  // Clean 1–2 line goal (◈ GOAL), distilled by the CLI summarizer from the raw
  // request (PHNX-3939). Falls back to the conversation topic when the CLI has none.
  goal?: string;
  // Live progress checkpoints from the CLI summarizer (most-recent last).
  checkpoints?: RemoteCheckpoint[];
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
  /** The session's ticket, with its title and state when this window read them (ticketFaces). */
  ticket?: TicketFace;
  /** Where Back and Forward lead: the titles of the neighbouring subjects. */
  nav?: { back?: string; fwd?: string };
  pullRequests?: PullRequestRef[];
  /** The session's PR as the feed reports it, and the one action the card may offer. */
  prStatus?: RemotePrStatus;
  prAction?: PrAction;
  /** The Merge ▾ menu has a choice (a method, or an admin merge). */
  prCanMerge?: boolean;
  /** Sessions to handle together with this one, from the rows already in the store. */
  related?: RelatedSession[];
  /** The agent's own status posts (`agents feed post`), oldest first. */
  updates?: SessionUpdate[];
  /** Its latest post when that says blocked and you have not written since. */
  blocked?: SessionUpdate;
  prRepo?: string;
  // Account usage state — surfaces "out of credits" / "rate limited"
  usageStatus?: 'available' | 'rate_limited' | 'out_of_credits' | null;
  // Plan files
  plan?: { path: string; display: string };
}

/**
 * The sidebar's subject: the LAST of { the focused agent terminal's session, a
 * clicked Project panel session }. Presentation state only — module-local, never persisted,
 * never round-tripped through settings or workspaceState. It is stored rather
 * than recomputed so a redraw triggered by something else (a stream fact, a
 * stream row update) cannot silently snap the panel back to the active terminal
 * after the user picked a different session in the Project panel.
 */
interface PanelSubject {
  sessionId: string;
  /** Stable editor-terminal identity for a terminal-origin subject. */
  terminalId?: string;
  /** Owning device for a Project subject; '' when the row is on this machine. */
  host?: string;
  source: 'terminal' | 'project';
}

let panelSubject: PanelSubject | undefined;

/**
 * The sessions this panel showed, for its ‹ › buttons (owner video, 2026-10-12:
 * "when you click here it goes here, but there is no way to go back"). Every
 * subject change pushes the one it leaves; a new change clears Forward, as in a
 * browser. A stop keeps the title it had, so the button can name it.
 */
interface TrailStop { subject: PanelSubject; title: string }
const TRAIL_MAX = 30;
const trail: { back: TrailStop[]; fwd: TrailStop[] } = { back: [], fwd: [] };

const subjectKey = (s: PanelSubject) => s.sessionId || s.terminalId || '';

/** The subject on screen now, as a stop to come back to. */
function currentStop(): TrailStop | undefined {
  const on = resolveSubject();
  if (!on) return undefined;
  const subject: PanelSubject = {
    sessionId: on.sessionId,
    ...(on.entry ? { terminalId: on.entry.id } : {}),
    ...(on.host ? { host: on.host } : {}),
    source: on.source,
  };
  return { subject, title: activeProvider?.titleOf(on.sessionId) || 'the previous session' };
}

/** Make `next` the subject, leaving the current one on the Back trail. */
function moveSubject(next: PanelSubject): void {
  const here = currentStop();
  panelSubject = next;
  if (here && subjectKey(here.subject) === subjectKey(next)) return;
  trail.fwd = [];
  if (!here) return;
  trail.back.push(here);
  if (trail.back.length > TRAIL_MAX) trail.back.shift();
}

/** A terminal stop whose tab closed cannot be shown again; a session stop always can. */
const stopAlive = (stop: TrailStop) => stop.subject.source !== 'terminal' || !!(stop.subject.terminalId && terminals.getById(stop.subject.terminalId)?.agentConfig);

/** Step Back or Forward, past stops that can no longer be shown; false when that way is empty. */
function stepTrail(dir: 'back' | 'fwd'): boolean {
  const from = dir === 'back' ? trail.back : trail.fwd;
  const to = dir === 'back' ? trail.fwd : trail.back;
  while (from.length && !stopAlive(from[from.length - 1]!)) from.pop();
  const stop = from.pop();
  if (!stop) return false;
  const here = currentStop();
  if (here) to.push(here);
  panelSubject = stop.subject;
  return true;
}

function trailTitles(): { back?: string; fwd?: string } {
  const top = (stops: TrailStop[]) => [...stops].reverse().find(stopAlive)?.title;
  const back = top(trail.back);
  const fwd = top(trail.fwd);
  return { ...(back ? { back } : {}), ...(fwd ? { fwd } : {}) };
}

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
function resolveSubject(): { sessionId: string; entry?: terminals.EditorTerminal; host?: string; source: 'terminal' | 'project' } | undefined {
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

/** Point the sidebar at a session the user clicked in the Project panel. */
export function setAgentPanelSubjectFromProject(sessionId: string, host?: string): void {
  const id = (sessionId || '').trim();
  if (!id) return;
  moveSubject({ sessionId: id, source: 'project', ...(host ? { host } : {}) });
  // Reveal WITHOUT stealing focus, so the click keeps the user in the Project panel
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
  moveSubject({ sessionId: entry.sessionId ?? '', terminalId: entry.id, source: 'terminal' });
}

/** Forget the subject entirely (dispose, and the reset point for tests). */
export function clearAgentPanelSubject(): void {
  panelSubject = undefined;
  trail.back = [];
  trail.fwd = [];
}

/**
 * What the sidebar is currently showing, after last-wins resolution: the session,
 * the device that owns it, which trigger picked it, and whether a local terminal
 * backs it. Read-only — this is the same resolution `buildSnapshot` runs, exposed
 * so another surface (and the subject tests) can ask without rebuilding a
 * snapshot. undefined when nothing is focused and nothing was clicked.
 */
export function currentAgentPanelSubject():
  | { sessionId: string; host?: string; source: 'terminal' | 'project'; hasTerminal: boolean }
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

class AgentPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private snapshot: PanelSnapshot = { hasTerminal: false };
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
          // A remote file copies first; the tile says so until it opens or fails.
          this.view?.webview.postMessage({ type: 'artifactBusy', path: msg.path, busy: true });
          try {
            await openSessionArtifact(msg.path, this.snapshot.sessionHost, named);
          } finally {
            this.view?.webview.postMessage({ type: 'artifactBusy', path: msg.path, busy: false });
          }
        }
        return;
      case 'loadTimelineFilter':
        await this.loadTimelineFilter(msg.role, msg.sessionId);
        return;
      case 'prAction':
        await this.runPrAction(msg.action);
        return;
      case 'shareArtifact':
        if (typeof msg.path === 'string') await this.shareArtifact(msg.path);
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
      case 'nav':
        if ((msg.dir === 'back' || msg.dir === 'fwd') && stepTrail(msg.dir)) void this.refresh();
        return;
      case 'openTicket':
        // The ticket opens in the Project panel's Issues tab: one read, with comments.
        if (typeof msg.id === 'string' && msg.id) void vscode.commands.executeCommand('agents.project.openTicket', msg.id);
        return;
      case 'dictationState':
        this.view?.webview.postMessage({ type: 'dictation', state: dictation.state() });
        return;
      case 'dictate':
        if (msg.on === true) void dictation.start((update) => this.view?.webview.postMessage({ type: 'dictation', ...update }));
        else if (msg.on === false) void dictation.stop();
        return;
      case 'selectRelated':
        // A Related chip makes that session the subject, as a Project panel click does.
        if (typeof msg.sessionId === 'string') setAgentPanelSubjectFromProject(msg.sessionId, typeof msg.host === 'string' ? msg.host : undefined);
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
   * ride every stream row, so it is one `sessions <id> --include <role> --json`
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
   * 'options' opens the Merge ▾ menu (squash, rebase, merge commit, and an admin
   * merge); --admin runs only from that menu, after its own warning dialog, as
   * the CLI reserves it for a person's explicit confirm.
   */
  private async runPrAction(requested: unknown): Promise<void> {
    // One action at a time: a second click while a dialog or a merge is open is ignored.
    if (this.prActionBusy) return;
    this.prActionBusy = true;
    try {
      if (requested === 'options') await this.pickAndMerge();
      else await this.decideAndRunPrAction(requested);
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
    // The Settings method when you chose one; otherwise the CLI picks the first the repository allows.
    const method = this.context ? validMergeMethod(getSettings(this.context).mergeMethod) : undefined;
    const label = requested === 'merge' ? 'Merge' : 'Turn on auto-merge';
    const ask = requested === 'merge'
      ? `Merge ${repo}#${pr.number}${pr.title ? ` "${pr.title}"` : ''} at ${head}${method ? ` (${method === 'merge' ? 'merge commit' : method})` : ''}?`
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
      await runAgents(`projects prs ${requested} ${shellQuote(project)} --repo ${shellQuote(repo)} --number ${pr.number} --sha ${shellQuote(pr.headSha)}${requested === 'merge' && method ? ` --method ${method}` : ''}`, { timeout: 60_000 });
      void vscode.window.showInformationMessage(requested === 'merge' ? `Merged ${repo}#${pr.number}.` : `Auto-merge is on for ${repo}#${pr.number}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n').slice(0, 3).join(' ') : String(err);
      void vscode.window.showErrorMessage(`${label} failed: ${message}`);
    }
  }

  private prActionBusy = false;

  /** Merge ▾: the shared merge flow on this session's PR (one read, pick, confirm, merge). */
  private async pickAndMerge(): Promise<void> {
    const pr = this.snapshot.prStatus;
    const repo = pr ? prRepo(pr.url) : undefined;
    const project = this.snapshot.project;
    if (!pr || !repo || !project) {
      void vscode.window.showWarningMessage('This pull request cannot be merged from here' + (!project ? ': this session has no project' : '') + '.');
      return;
    }
    try {
      await mergeWithMenu(project, repo, pr.number);
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n').slice(0, 3).join(' ') : String(err);
      void vscode.window.showErrorMessage(`Merge failed: ${message}`);
    }
  }

  /**
   * Share: publish one artifact the row lists as a Rush link with
   * `artifacts share <path> --visibility <me|org|unlisted> --json`, then copy the
   * URL. Only for a file on this machine; the CLI refuses files with emails or
   * credential-shaped strings, and that refusal is shown as is.
   */
  private async shareArtifact(filePath: string): Promise<void> {
    const listed = (this.snapshot.artifacts ?? []).some((a) => a.path === filePath) || this.snapshot.plan?.path === filePath;
    if (!listed) return;
    if (!this.snapshot.sessionLocal) {
      void vscode.window.showWarningMessage('Sharing works for artifacts on this machine. Open the session on its own machine to share this one.');
      return;
    }
    const picked = await vscode.window.showQuickPick([
      { label: 'Rush org', description: 'anyone signed in to your organization', vis: 'org' },
      { label: 'Only me', description: 'owner-only, needs your Rush sign-in', vis: 'me' },
      { label: 'Anyone with the link', description: 'not listed, no sign-in needed', vis: 'unlisted' },
    ], { title: `Share ${path.basename(filePath)} as a Rush artifact`, placeHolder: 'Who can open the link (expires in 30 days)' });
    if (!picked) return;
    try {
      const { stdout } = await runCliArgs('artifacts', ['share', filePath, '--visibility', picked.vis, '--json'], { timeout: 120_000 });
      const url = (stdout.match(/https?:\/\/[^\s"']+/) || [])[0];
      if (url) {
        await vscode.env.clipboard.writeText(url);
        const open = await vscode.window.showInformationMessage(`Shared ${path.basename(filePath)} (${picked.label}). Link copied.`, 'Open');
        if (open === 'Open') openExternalUrl(url);
      } else {
        void vscode.window.showInformationMessage(`Shared ${path.basename(filePath)}.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n').slice(0, 3).join(' ') : String(err);
      void vscode.window.showErrorMessage(`Share failed: ${message}`);
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
      // Otherwise Focus and ↻ Resume are the one resume action the picker and Project panel
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
      // Fork: the panel's own tab forks in place; a session with no tab here
      // picks which session to fork, as Agents: Fork (Pick Session) does.
      case 'forkSubject':
        if (terminal && entry) { terminal.show(true); await vscode.commands.executeCommand('agents.forkCurrentSession'); }
        else await vscode.commands.executeCommand('agents.forkPickSession');
        return;
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
   * in `sessionReply.ts`. A subject with no local tab has
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
    this.snapshot.nav = trailTitles();
    this.syncPlanWatcher(this.snapshot.cwd);
    if (this.webviewReady) {
      this.view.webview.postMessage({ type: 'snapshot', data: this.snapshot });
    }
    // If not ready, snapshot stays cached; the 'ready' handler will push it.
  }

  /** The title the panel showed for a session, when it is the one on screen. */
  titleOf(sessionId: string): string | undefined {
    const s = this.snapshot;
    if (!sessionId || s.fullSessionId !== sessionId) return undefined;
    return s.sessionTitle || s.label || s.autoLabel || s.agentName;
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
    // The subject — the focused agent terminal OR the clicked Project panel session, last
    // wins. A Project subject with no local tab still renders: everything the card
    // needs is on the stream row.
    const subject = resolveSubject();
    if (!subject) {
      return { hasTerminal: false, hasSubject: false };
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


    const sessionId = subject.sessionId || entry?.sessionId;
    const sessionChunk = sessionId ? sessionId.slice(0, 8) : undefined;

    const snapshot: PanelSnapshot = {
      hasTerminal: !!entry,
      hasSubject: true,
      subjectSource: subject.source,
      terminalId: entry?.id,
      agentName: entry?.agentConfig?.title,
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
      workspaceRoot,
    };

    // ── Fill from the CLI-normalized session stream (PHNX-3517) ─────────────
    // Everything a tab-switch needs to paint — what the agent is doing now, its
    // todo checklist, topic, last message, PR, branch — is already in memory,
    // NORMALIZED by the CLI-mirror (`presentedSessions` → RemoteSession), off the
    // `agents feed watch --json` stream the Project panel already consumes. Read it
    // SYNCHRONOUSLY (no subprocess) and reuse the SAME normalized fields every
    // other surface reads — the ext never re-derives them from the raw row. The
    // old path spawned a `--include tools` transcript read + `agents teams
    // status` per team on EVERY switch (2-8 subprocesses), which behind the
    // all-or-nothing snapshot wedged the panel on "Loading…" for seconds.
    if (sessionId) {
      const live = findLiveSession(sessionId, subject.host);
      if (live) {
        // The card fields the Project panel shares (src/core/sessionCardFields.ts).
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
        if (card.linearIssue) snapshot.ticket = ticketFace(card.linearIssue);

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

        // Checklist — already the CLI-normalized RemoteTodoItem[]; just tally it.
        const todos = todoProgressFromItems(summaryChecklist);
        if (todos) snapshot.todoProgress = todos;

        // PR: the CLI already extracted the url — structure it, don't re-scan.
        if (card.pullRequests) snapshot.pullRequests = card.pullRequests;
        if (live.prStatus) {
          snapshot.prStatus = live.prStatus;
          snapshot.prAction = prAction(live.prStatus);
          snapshot.prCanMerge = canOfferMerge(live.prStatus);
          snapshot.prRepo = prRepo(live.prStatus.url);
        }

        // A Project subject has no local tab, so the agent identity, cwd and host
        // come off the same row instead of the terminal's creation options.
        if (!entry) {
          snapshot.agentType = snapshot.agentType || live.agentType;
          const def = BUILT_IN_AGENTS.find((a) => a.key === live.agentType);
          if (def) {
            snapshot.agentName = snapshot.agentName || def.title;
            snapshot.agentIconUri = snapshot.agentIconUri || this.iconUriFor(def.prefix);
          }
          snapshot.label = snapshot.label || live.label || undefined;
          if (!snapshot.cwd && live.cwd) {
            cwd = live.cwd;
            snapshot.cwd = live.cwd;
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
        // The same title as the Project panel's card: an inserted note or a bare command is skipped.
        snapshot.sessionTitle = cleanTitle(live.title || '') || cleanTitle(live.label || '') || undefined;
        snapshot.related = relatedSessions(live, sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL), Date.now());
        snapshot.model = live.model;
        snapshot.project = live.project || undefined;
        snapshot.hostLabel = remoteDevice || os.hostname().split('.')[0];
        snapshot.sessionLocal = card.sessionLocal;
        snapshot.inWorktree = !!live.worktreeSlug;
        snapshot.startedAtMs = live.startedAtMs || undefined;
        snapshot.lastActivityMs = live.lastActivityMs || undefined;
        const stateKey = sessionStateOf(live);
        snapshot.state = { key: stateKey, word: SESSION_STATE_WORD[stateKey] };
        if (card.needsYou) snapshot.needsYou = card.needsYou as PanelSnapshot['needsYou'];
        snapshot.failures = live.failures;
        snapshot.failedCount = live.failures ? live.failures.filter((f) => !f.blocked).length : live.timeline?.failed;
        snapshot.blockedCount = live.failures ? live.failures.filter((f) => f.blocked).length : undefined;
        snapshot.activityHistogram = live.activityHistogram;
        snapshot.userTurns = live.userTurns;
        snapshot.updates = sessionUpdates(sessionPresentationStore.activityEvents(), live.sessionId);
        snapshot.blocked = blockedUpdate(snapshot.updates, live.userTurns?.length ? live.userTurns[live.userTurns.length - 1]!.atMs : undefined);
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

${PATCH_SCRIPT}
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

const HEAD_ICON = {
  open: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/></svg>',
  resume: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5l7 4.5-7 4.5z"/></svg>',
  fork: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4 5v1.5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V5M8 8.5V11"/></svg>',
};

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
  // The face is the title and three quick icons; who runs it (model, account,
  // host) lives in the ⋯ menu so the session's content starts higher up.
  const usageRow = usageBadge ? '<div class="account-row">' + usageBadge + '</div>' : '';
  const following = s.subjectSource === 'project' && !s.hasTerminal
    ? '<div class="account-row">following the Project panel selection</div>'
    : '';

  // ⋯ menu: the session id (copy, and the pencil that rebinds a tab, offered even
  // before the harness reports an id), project, branch, worktree, start time,
  // tokens, and the raw identity lines. Its open state is remembered.
  const menu = [];
  if (s.model) menu.push(['Model', '<b class="model-name" title="' + esc(s.model) + '">' + esc(prettyModel(s.model)) + '</b>']);
  if (s.accountLabel || s.account) menu.push(['Account', '<span title="' + esc(s.account || '') + '">' + esc(s.accountLabel ?? s.account) + '</span>']);
  if (s.hostLabel) menu.push(['Host', '<span class="where-chip mono">' + esc(s.hostLabel) + '</span>']);
  const pencil = s.hasTerminal && s.terminalId
    ? '<button type="button" class="head-btn small" data-action="setSessionId" title="Set session ID for terminal" aria-label="Set session ID for terminal">✎</button>'
    : '';
  if (s.sessionChunk || pencil) {
    menu.push(['Session', (s.sessionChunk ? '<button type="button" class="session-chunk" id="copy-session" title="Copy full session ID" aria-label="Copy full session ID">' + esc(s.sessionChunk) + '</button>' : '<span class="menu-v">not reported yet</span>') + pencil]);
  }
  // The PR's merge actions live here; the Made tile opens the PR on GitHub.
  const pr = s.prStatus;
  if (pr) {
    const act = s.prAction || { kind: 'none', reason: '' };
    const merge = (act.kind === 'merge'
      ? '<button type="button" class="action-btn primary" data-pr-action="merge">Merge</button>'
      : act.kind === 'automerge'
        ? '<button type="button" class="action-btn" data-pr-action="automerge" title="Turn on GitHub auto-merge">Merge when green</button>'
        : '') +
      // Merge ▾: squash, rebase, merge commit, or an admin merge (its own warning dialog).
      (s.prCanMerge ? '<button type="button" class="action-btn" data-pr-action="options" title="Squash, rebase, merge commit, or admin merge" aria-label="Merge options">' + (act.kind === 'none' ? 'Merge ▾' : '▾') + '</button>' : '');
    const note = act.kind === 'none' && act.reason && pr.state === 'open' ? '<span class="menu-note">' + esc(act.reason) + '</span>' : '';
    menu.push(['PR', '<span class="menu-pr"><span class="mono">#' + esc(pr.number) + '</span>' + prReviewGlyph(pr) + prMergeGlyph(pr) + merge + '</span>' + note]);
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
  // Quick icons, each with its words in the tooltip: open the tab (or resume a
  // session with no tab here) and fork. Both need the session id.
  const icon = (action, label, svg) =>
    '<button type="button" class="head-btn" data-action="' + action + '" aria-label="' + label + '" title="' + label + '">' + svg + '</button>';
  const actions =
    '<div class="head-actions">' +
      (s.fullSessionId
        ? (s.hasTerminal
            ? icon('focusSubject', 'Open its tab', HEAD_ICON.open)
            : icon('resumeSubject', 'Resume session', HEAD_ICON.resume)) +
          icon('forkSubject', 'Fork session', HEAD_ICON.fork)
        : '') +
    '</div>';
  return (
    '<div class="head-row">' +
      '<div class="agent-head">' +
        '<div class="agent-head-text">' +
          '<div class="title-line">' + logo + '<div class="title-row session-title" title="' + esc(title) + '">' + esc(title) + '</div></div>' +
          usageRow +
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
// sidebar and the Project panel say the same thing for the same row.
function sessionState(s) {
  const st = s.state || { key: 'unknown', word: 'Unknown' };
  // Your move reads amber (a question or an idle turn), Running green, Ended quiet.
  const cls = st.key === 'asks' || st.key === 'yours' ? 'waiting' : st.key === 'working' || st.key === 'unknown' ? 'running' : 'idle';
  return { cls, word: st.word };
}

function renderSessionStats(s) {
  const span = s.durationMs > 0 ? s.durationMs : (s.startedAtMs ? Date.now() - s.startedAtMs : 0);
  const age = compactDuration(span);
  if (!age && !s.lastActivityMs) return '';
  const st = s.blocked ? { cls: 'failed', word: 'Your move · blocked' } : sessionState(s);
  const ran = age ? (st.cls === 'running' ? ' <b>' + esc(age) + '</b>' : ' · ran <b>' + esc(age) + '</b>') : '';
  // A dot that pulses says "active just now" (owner video, 2026-10-12 8:15 PM); the exact
  // time is its tooltip. The account lives in the ⋯ menu.
  const live = st.cls === 'running' && s.lastActivityMs && Date.now() - s.lastActivityMs < 90000;
  const when = s.lastActivityMs ? 'Active ' + relTime(s.lastActivityMs) : '';
  return '<div class="session-stats state-' + st.cls + (live ? ' live' : '') + '" title="' + esc(when) + '"><span class="state-dot"></span><span class="stats-text">' + esc(st.word) + ran + '</span></div>' +
    renderIdleWarning(s);
}

// A session you are flipping past should catch your eye once it has sat still for
// IDLE_WARN_MS. The sidebar has no timers (it repaints only on stream facts), so
// the warning is rendered up front and revealed by a CSS animation delay: it
// appears on its own at the right moment even if no new row arrives. It names a
// clock time, so its words stay true however long it stays up.
const IDLE_WARN_MS = 5 * 60_000;

function renderIdleWarning(s) {
  // Your move is already amber on the state line; this catches a Running session gone quiet.
  if (!s.lastActivityMs || !s.state || s.state.key !== 'working') return '';
  const delay = Math.max(0, IDLE_WARN_MS - (Date.now() - s.lastActivityMs));
  const since = new Date(s.lastActivityMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const words = 'Running, but quiet since ' + since;
  return '<div class="idle-warn" role="status" style="--idle-delay:' + delay + 'ms" title="No output for more than 5 minutes: it may be on a long command">' +
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>' + esc(words) +
    (s.hasTerminal ? '<button type="button" class="idle-open" data-action="focusSubject">Open</button>' : '') + '</div>';
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
    '<div class="request-block">' +
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
const PR_SEGMENT_ORDER = { passed: 0, running: 1, failed: 2, skipped: 3 };

// One word for where the PR stands, and its tone.
function prVerdict(pr) {
  if (pr.state === 'merged') return { word: 'Merged', tone: 'ok' };
  if (pr.state === 'closed') return { word: 'Closed', tone: 'idle' };
  if (pr.checks === 'failing') return { word: 'Failing', tone: 'bad' };
  if (pr.isDraft) return { word: 'Draft', tone: 'idle' };
  if (pr.mergeable === 'conflicting') return { word: 'Conflicts', tone: 'bad' };
  if (pr.review === 'changes_requested') return { word: 'Changes requested', tone: 'bad' };
  if (pr.checks === 'pending') return { word: 'Checks running', tone: 'warn' };
  if (pr.checks === 'passing') {
    // Green checks alone are not "Ready": a required review or an unknown merge
    // state still stands between the PR and a merge.
    if (pr.review === 'review_required') return { word: 'Needs review', tone: 'warn' };
    if (pr.mergeable !== 'mergeable') return { word: 'Checks passed', tone: 'ok' };
    return { word: 'Ready', tone: 'ok' };
  }
  return { word: 'Open', tone: 'idle' };
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

// ── Made ────────────────────────────────────────────────────────────────────
// What the session made, as one row of previews you scroll sideways (owner,
// 2026-10-12: "artifacts are important; a PR is an artifact, and so is the
// ticket"). The PR tile carries its checks as a bar and a count, and opens the PR
// on GitHub; merging lives in the ⋯ menu (owner video, 2026-10-12: "show how many
// pass here; clicking it takes us to the link"). The ticket is a tile that opens
// the ticket to read. Then every artifact file, newest first; an image previews,
// a page or doc shows its type, and a click opens it in the editor. A chosen
// timeline range dims files changed outside it, without moving anything. Pages,
// docs and images on this machine carry Share.
const SHARE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10V2.5M5 5.5l3-3 3 3M3.5 8.5v4.5h9V8.5"/></svg>';
const MIC_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg>';
const SHAREABLE = /^(html?|md|markdown|pdf|png|jpe?g|gif|webp|svg)$/;
const busyArtifacts = new Set();

function prChecksBar(pr) {
  const bar = prCheckSegments(pr);
  const words = bar.counted
    ? bar.passed + ' of ' + bar.counted + ' checks passed' + (bar.running ? ', ' + bar.running + ' running' : '') + (bar.failed ? ', ' + bar.failed + ' failed' : '')
    : pr.checks ? (pr.checks === 'passing' ? 'Checks passed' : pr.checks === 'failing' ? 'A check failed' : 'Checks running') : 'No checks reported';
  const segs = bar.segments.map((c) => '<i class="seg ' + esc(c.state) + '"></i>').join('');
  return '<span class="mk-checks" role="img" title="' + esc(words) + '" aria-label="' + esc(words) + '">' +
    '<span class="pr-bar">' + (segs || '<i class="seg none"></i>') + '</span>' +
    (bar.counted ? '<span class="pr-frac pr-tone-' + (bar.failed ? 'bad' : bar.passed === bar.counted ? 'ok' : 'warn') + '">' + bar.passed + '/' + bar.counted + '</span>' : '') +
  '</span>';
}

function renderMadeShelf(s) {
  const pr = s.prStatus;
  const others = (s.pullRequests || []).filter((p) => !pr || p.url !== pr.url);
  const files = [];
  for (const it of artifactItems(s)) if (it.files) for (const f of it.files) files.push(f);
  files.sort((a, b) => (b.editedAtMs || 0) - (a.editedAtMs || 0));
  const tk = s.ticket;
  if (!pr && !others.length && !tk && !files.length) return '';
  const range = currentRange(s);
  const tiles = [];
  if (pr) {
    const v = prVerdict(pr);
    tiles.push('<button type="button" class="mk mk-pr" data-url="' + esc(pr.url) + '" title="' + esc('Open #' + pr.number + (pr.title ? ' ' + pr.title : '') + ' on GitHub') + '">' +
      '<span class="mk-h">' + APP_ICON.github + '<b>#' + esc(pr.number) + '</b><span class="mk-st pr-tone-' + v.tone + '">' + esc(v.word) + '</span></span>' +
      '<span class="mk-t">' + esc(pr.title || s.prRepo || '') + '</span>' +
      '<span class="mk-f">' + prChecksBar(pr) + '<span class="mk-go" aria-hidden="true">↗</span></span></button>');
  }
  for (const p of others) {
    tiles.push('<button type="button" class="mk mk-pr" data-url="' + esc(p.url) + '" title="' + esc('Open ' + p.url) + '">' +
      '<span class="mk-h">' + APP_ICON.github + '<b>#' + esc(p.number) + '</b></span><span class="mk-t">' + esc(p.ownerRepo) + '</span>' +
      '<span class="mk-f"><span class="mk-go" aria-hidden="true">↗</span></span></button>');
  }
  if (tk) {
    tiles.push('<button type="button" class="mk mk-pr mk-tk" data-ticket="' + esc(tk.id) + '" title="' + esc('Read ' + tk.id + (tk.title ? ' ' + tk.title : '')) + '">' +
      '<span class="mk-h">' + APP_ICON.linear + '<b>' + esc(tk.id) + '</b>' + (tk.state ? '<span class="mk-st tk-st">' + esc(tk.state) + '</span>' : '') + '</span>' +
      '<span class="mk-t">' + esc(tk.title || 'Linear ticket') + '</span>' +
      '<span class="mk-f"><span class="mk-read">Read ›</span></span></button>');
  }
  for (const f of files) {
    const kind = artifactKind(f);
    const out = range && f.editedAtMs && !inRange(range, f.editedAtMs) ? ' out' : '';
    const busy = busyArtifacts.has(f.path) ? ' busy' : '';
    const face = f.uri ? '<span class="mk-img">' + thumbImg(f) + '</span>' : '<span class="mk-doc" aria-hidden="true">' + esc(FILE_GLYPH[kind] || kind.slice(0, 4).toUpperCase()) + '</span>';
    const share = s.sessionLocal && SHAREABLE.test(kind)
      ? '<button type="button" class="mk-share" data-share="' + esc(f.path) + '" title="Share as a Rush artifact" aria-label="' + esc('Share ' + f.name) + '">' + SHARE_ICON + '</button>'
      : '';
    tiles.push('<div class="mk mk-file' + out + busy + '"><button type="button" class="mk-open artifact-open" data-artifact="' + esc(f.path) + '" title="' + esc('Open ' + f.path) + '">' + face +
      '<span class="mk-n">' + esc(f.name) + '</span><span class="mk-m">' + esc(busy ? 'opening…' : kind + (f.editedAtMs ? ' · ' + relTime(f.editedAtMs) : '')) + '</span></button>' + share + '</div>');
  }
  return '<div class="made"><div class="made-l">Made <span>' + tiles.length + '</span></div>' +
    '<div class="made-strip" data-strip="made">' + tiles.join('') + '</div></div>';
}

// ── Blocked ─────────────────────────────────────────────────────────────────
// The agent said it cannot go on without you (agents feed post, status.blocked):
// its own words, in red, until you write after it.
function renderBlocked(s) {
  const b = s.blocked;
  if (!b) return '';
  return '<div class="blocked-strip" role="status"><div class="blocked-k">BLOCKED · ' + esc(relTime(b.atMs).toUpperCase()) + '</div>' +
    '<div class="blocked-t">' + esc(b.title) + '</div>' + (b.detail ? '<div class="blocked-d">' + esc(truncate(b.detail, 280)) + '</div>' : '') +
    '<div class="needs-you-btns"><button type="button" class="ny-btn primary" id="blocked-reply">Reply…</button>' +
    (s.hasTerminal ? '<button type="button" class="ny-btn" data-action="focusSubject">Open tab</button>' : '') + '</div></div>';
}

// ── Related ─────────────────────────────────────────────────────────────────
// One line of chips under Made: other sessions on the same ticket, PR or branch,
// or with a similar request (relatedSessions, from the rows already in memory).
// Each chip carries its state dot and, in its tooltip, why it is related; a click
// makes it the subject.
const RELATED_DOT = { asks: 'waiting', yours: 'waiting', working: 'running', unknown: 'running', ended: 'idle' };

function renderRelated(s) {
  const rel = s.related || [];
  if (!rel.length) return '';
  return '<div class="rel"><span class="rel-l">Related</span><div class="rel-s" data-strip="related">' + rel.map((r) =>
    '<button type="button" class="rel-c state-' + (RELATED_DOT[r.state] || 'idle') + '" data-related="' + esc(r.sessionId) + '" data-related-host="' + esc(r.host || '') + '" title="' + esc(r.title + ' · ' + r.why) + '">' +
      '<span class="state-dot"></span>' + esc(truncate(r.title, 48)) + '</button>').join('') + '</div></div>';
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

function renderGoalCard(s) {
  const goal = (s.goal || '').trim();
  if (!goal) return '';
  // One line inside the session card; the whole goal is in the tooltip.
  return (
    '<div class="goal-line" title="' + esc('Goal: ' + goal) + '">' +
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

let lastSnapshot = null;

// The reply box is built once and lives outside the patched card, so a stream
// update never takes away the caret or what you are typing (owner video,
// 2026-10-12). A draft belongs to its session: switching subjects puts it away
// and brings back that session's own draft.
const replyDrafts = {};
let replySession = '';

function render(snap) {
  lastSnapshot = snap;
  // The empty state is about having NO SUBJECT — not about having no terminal.
  // A session picked in the Project panel renders here with no local tab at all.
  if (!snap || !snap.hasSubject) {
    // Put the draft away: the reply box is rebuilt when a session comes back.
    const input = root.querySelector('#reply-input');
    if (input) replyDrafts[replySession] = input.value;
    replySession = '';
    root.innerHTML = (
      '<div class="empty">No session selected.<br><br>' +
      'Click an agent tab in the editor, open one with <b>Cmd+Shift+A</b>, ' +
      'or click a session in the Project panel.</div>'
    );
    return;
  }
  let body = root.querySelector('#panel-body');
  if (!body) {
    root.innerHTML = '<div id="panel-body"></div>' + renderReplyBox() +
      '<div class="footer"><button id="refresh-btn">Refresh</button></div>';
    body = root.querySelector('#panel-body');
    bindReplyBox();
    // A rebuilt box asks whether a recording is still running.
    vscode.postMessage({ type: 'dictationState' });
  }
  syncReplyBox(snap);
  // One card, top to bottom (owner, 2026-10-12): the title with quick icons, the
  // state, the goal, an open ask, what you asked, what it made, then the activity
  // strip whose range filters the feed under it. The reply floats at the bottom.
  patchChildren(body,
    renderNav(snap) +
    '<div class="card session-card">' +
      renderTerminalCard(snap) +
      renderSessionStats(snap) +
      renderFailures(snap) +
      renderGoalCard(snap) +
      renderBlocked(snap) +
      renderNeedsYou(snap) +
      renderRequestCard(snap) +
      renderMadeShelf(snap) +
      renderRelated(snap) +
      renderTimelineCard(snap) +
    '</div>'
  );
  bindPanel();
}

// Back and forward through the sessions this panel showed. The host keeps the
// trail; the card only names where Back leads.
function renderNav(s) {
  const n = s.nav;
  if (!n || (!n.back && !n.fwd)) return '';
  const btn = (dir, label, to) =>
    '<button type="button" class="nav-btn" data-nav="' + dir + '"' + (to ? ' title="' + esc(label + ' to ' + to) + '"' : ' disabled') + ' aria-label="' + label + '">' + (dir === 'back' ? '‹' : '›') + '</button>';
  return '<div class="nav-row">' + btn('back', 'Back', n.back) + btn('fwd', 'Forward', n.fwd) +
    (n.back ? '<button type="button" class="nav-crumb" data-nav="back" title="' + esc('Back to ' + n.back) + '">' + esc(n.back) + '</button>' : '') +
  '</div>';
}

function focusReply() {
  const r = root.querySelector('#reply-input');
  if (r) { r.scrollIntoView({ block: 'center' }); r.focus(); }
}

function bindPanel() {
  const details = root.querySelector('#session-details');
  if (details && bindOnce(details, 'toggle')) details.addEventListener('toggle', () => { viewState.detailsOpen = details.open; vscode.setState(viewState); });
  const failures = root.querySelector('#failures');
  if (failures && bindOnce(failures, 'toggle')) failures.addEventListener('toggle', () => { viewState.failuresOpen = failures.open; vscode.setState(viewState); });
  for (const el of root.querySelectorAll('#blocked-reply, #needs-you-reply')) if (bindOnce(el, 'reply')) el.addEventListener('click', focusReply);
  for (const img of root.querySelectorAll('img[data-avatar]')) if (bindOnce(img, 'error')) img.addEventListener('error', () => img.remove());
  bindSessionCards();
  for (const el of root.querySelectorAll('[data-files-view]')) {
    if (bindOnce(el, 'files')) el.addEventListener('click', () => {
      viewState.filesView = el.getAttribute('data-files-view');
      vscode.setState(viewState);
      render(lastSnapshot);
    });
  }
  const copy = root.querySelector('#copy-session');
  if (copy && bindOnce(copy, 'copy')) copy.addEventListener('click', () => vscode.postMessage({ type: 'copySessionId' }));
  for (const el of root.querySelectorAll('.path-link')) {
    if (bindOnce(el, 'path')) el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openPath', path: el.getAttribute('data-path') });
    });
  }
  // Worktree paths are DIRECTORIES — they need vscode.openFolder, not the
  // file-only vscode.open that openPath uses. Distinct selector + message
  // type so the extension can branch on intent without sniffing the path.
  for (const el of root.querySelectorAll('.wt-link')) {
    if (bindOnce(el, 'wt')) el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openWorktree', path: el.getAttribute('data-worktree-path') });
    });
  }
  for (const el of root.querySelectorAll('[data-related]')) {
    if (bindOnce(el, 'related')) el.addEventListener('click', () => vscode.postMessage({ type: 'selectRelated', sessionId: el.getAttribute('data-related'), host: el.getAttribute('data-related-host') || undefined }));
  }
  for (const el of root.querySelectorAll('[data-share]')) {
    if (bindOnce(el, 'share')) el.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'shareArtifact', path: el.getAttribute('data-share') }); });
  }
  for (const el of root.querySelectorAll('[data-ticket]')) {
    if (bindOnce(el, 'ticket')) el.addEventListener('click', () => vscode.postMessage({ type: 'openTicket', id: el.getAttribute('data-ticket') }));
  }
  for (const el of root.querySelectorAll('[data-nav]')) {
    if (bindOnce(el, 'nav')) el.addEventListener('click', () => vscode.postMessage({ type: 'nav', dir: el.getAttribute('data-nav') }));
  }
  for (const el of root.querySelectorAll('[data-pr-action]')) {
    if (bindOnce(el, 'pr')) el.addEventListener('click', () => vscode.postMessage({ type: 'prAction', action: el.getAttribute('data-pr-action') }));
  }
  for (const el of root.querySelectorAll('[data-scm]')) {
    if (bindOnce(el, 'scm')) el.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openSourceControl' });
    });
  }
  for (const el of root.querySelectorAll('[data-action]')) {
    if (bindOnce(el, 'action')) el.addEventListener('click', () => {
      vscode.postMessage({
        type: 'runQuickAction',
        action: el.getAttribute('data-action'),
        terminalId: lastSnapshot && lastSnapshot.terminalId,
        workspaceRoot: lastSnapshot && lastSnapshot.workspaceRoot,
        url: el.getAttribute('data-url') || undefined,
      });
    });
  }
}

// The reply rail: type, press Enter, and the host injects it into the session.
// The mic dictates into the box: click to talk, click again to stop; the words
// land in the box to edit before Enter sends them.
function renderReplyBox() {
  return (
    '<div class="reply-box" hidden>' +
      '<textarea id="reply-input" rows="1" placeholder="Reply to this session… (Enter to send)"></textarea>' +
      '<div class="dictation" hidden><span class="dict-dot"></span><span class="dict-wave">' +
        '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="dict-t"></span></div>' +
      '<button type="button" class="reply-mic" id="reply-mic" title="Dictate: click to talk, click again to stop" aria-label="Dictate" aria-pressed="false">' + MIC_ICON + '</button>' +
      '<div class="reply-err" id="reply-err" hidden></div>' +
    '</div>'
  );
}

function syncReplyBox(s) {
  const box = root.querySelector('.reply-box');
  const input = root.querySelector('#reply-input');
  if (!box || !input) return;
  const id = s.fullSessionId || '';
  if (id !== replySession) {
    replyDrafts[replySession] = input.value;
    input.value = replyDrafts[id] || '';
    replySession = id;
    showReplyError('');
  }
  box.hidden = !id;
}

// The mic's state, as the host reports it. Listening shows a moving wave (CSS, no
// timer: the sidebar keeps none); the words land in the box when transcribed.
// The session the words were spoken for: they land in its draft even if the
// subject changed while transcribing.
let dictationSession = '';

function setDictation(state, text) {
  const box = root.querySelector('.reply-box');
  if (!box) return;
  if (state === 'listening' && !box.classList.contains('listening')) dictationSession = replySession;
  const mic = box.querySelector('#reply-mic');
  box.classList.toggle('listening', state === 'listening');
  box.classList.toggle('transcribing', state === 'transcribing');
  mic.setAttribute('aria-pressed', String(state === 'listening'));
  mic.disabled = state === 'transcribing';
  box.querySelector('.dictation').hidden = state === 'idle';
  box.querySelector('.dict-t').textContent = state === 'transcribing' ? 'Transcribing…' : 'Listening · click the mic to stop';
  if (text) {
    const join = (draft) => draft ? draft.replace(/\\s+$/, '') + ' ' + text : text;
    const input = box.querySelector('#reply-input');
    if (dictationSession && dictationSession !== replySession) {
      replyDrafts[dictationSession] = join(replyDrafts[dictationSession] || '');
    } else {
      input.value = join(input.value);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function bindReplyBox() {
  const reply = root.querySelector('#reply-input');
  reply.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter is a newline.
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
    replyDrafts[replySession] = '';
  });
  const mic = root.querySelector('#reply-mic');
  mic.addEventListener('click', () => {
    showReplyError('');
    vscode.postMessage({ type: 'dictate', on: mic.getAttribute('aria-pressed') !== 'true' });
  });
  const btn = root.querySelector('#refresh-btn');
  btn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
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
  else if (msg && msg.type === 'dictation') {
    setDictation(msg.state, msg.text);
    if (msg.error) showReplyError(msg.error);
  }
  else if (msg && msg.type === 'artifactBusy') {
    if (msg.busy) busyArtifacts.add(msg.path); else busyArtifacts.delete(msg.path);
    if (lastSnapshot) render(lastSnapshot);
  }
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

/** Build presentation rows from the canonical session stream plus the workspace root. */
type UsageStatus = 'available' | 'rate_limited' | 'out_of_credits' | null;

/** The CLI-normalized RemoteSession for a session id, from the warm
 *  `agents feed watch --json` stream, or undefined until the stream indexes
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
  context.subscriptions.push({ dispose: () => dictation.cancel() });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AGENT_PANEL_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Re-render on terminal lifecycle events. refresh() -> buildSnapshot() spawns
  // git probes, so a burst of events — e.g. clicking
  // through editor tabs fires onDidChangeActiveTerminal per tab, and closing a
  // terminal fires close + active-change together — would stampede the box.
  // A trailing-edge debounce coalesces a burst into one snapshot per window.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void provider.refresh();
    }, 300);
  };
  // Focusing an agent terminal makes it the subject — the other half of the
  // last-wins pair with the Project panel click. Set BEFORE the debounce so a burst
  // of tab switches still leaves the subject on the tab the user landed on.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal(() => { setSubjectFromActiveTerminal(); debouncedRefresh(); }),
    vscode.window.onDidCloseTerminal(debouncedRefresh),
    vscode.window.onDidOpenTerminal(debouncedRefresh),
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); clearAgentPanelSubject(); } }
  );

  return provider;
}
