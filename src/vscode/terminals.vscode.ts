// VS Code-dependent terminal state management
// Implements API.md 2-map architecture

import * as vscode from 'vscode';
import * as path from 'path';
import { probeChildPids } from '../monitor/probes';
import { AgentConfig } from './agents.vscode';

import { generateTerminalId, resolveRestoredVersion } from '../core/terminals';
import * as sessionsPersist from '../core/sessions.persist';
import { canonicalSessionId } from '../core/canonicalSessionId';
import type { ManualSessionOverride } from '../core/remoteAutoLabel';
import { needsSessionIdHydrate } from '../core/sessionIdHydrate';
import { restoredSessionTabLabels } from '../core/sessionTabLabelSync';
import {
  getTerminalDisplayInfo,
  TerminalIdentificationOptions,
  prefixToAgentType,
  SessionAgentType,
  type TabStage,
} from '../core/utils';

// Per-terminal debug lines, gated behind an env flag so steady state stays quiet (#96).
const TERMINAL_DEBUG = process.env.SWARMIFY_DEBUG_TERMINALS === '1';
function debugLog(...args: unknown[]): void {
  if (TERMINAL_DEBUG) console.log(...args);
}

/**
 * Extract identification options from a VS Code terminal.
 * Used to gather all inputs for getTerminalDisplayInfo.
 */
export function extractTerminalIdentificationOptions(terminal: vscode.Terminal): TerminalIdentificationOptions {
  const opts = terminal.creationOptions as vscode.TerminalOptions;
  const env = opts?.env;
  const terminalId = env ? env['AGENT_TERMINAL_ID'] : undefined;
  const sessionId = env ? env['AGENT_SESSION_ID'] : undefined;
  const version = env ? env['AGENT_VERSION'] : undefined;

  // Extract icon filename from iconPath
  let iconFilename: string | null = null;
  if (opts?.iconPath) {
    const icon: any = opts.iconPath;
    if (icon instanceof vscode.Uri) {
      iconFilename = path.basename(icon.fsPath);
    } else if (icon && typeof icon === 'object') {
      // Support { light: Uri; dark: Uri } or direct object with fsPath
      const candidate = icon.light ?? icon.dark ?? icon;
      if (candidate instanceof vscode.Uri || (candidate && typeof candidate.fsPath === 'string')) {
        iconFilename = path.basename(candidate.fsPath);
      }
    }
  }

  return {
    name: terminal.name,
    terminalId: terminalId as string | undefined,
    sessionId: sessionId as string | undefined,
    version: (version as string | undefined) || undefined,
    iconFilename
  };
}

// Terminal entry following API.md
export interface EditorTerminal {
  id: string;
  terminal: vscode.Terminal;
  agentConfig: Omit<AgentConfig, 'count'> | null;
  label?: string;           // User-set status bar label (manual via Cmd+L)
  autoLabel?: string;       // Auto-generated label (populated by LLM)
  createdAt: number;
  pid?: number;             // Shell process ID
  manualSessionOverride?: ManualSessionOverride;
  sessionId?: string;       // CLI session ID (for resume, history reading)
  host?: string;            // Device the agent runs on when offloaded via `agents run --device`;
                            // undefined for a local tab. The session's transcript lives on THAT
                            // machine, so every by-session lookup (label, preview, resume) has to
                            // route through `--device <name>` instead of the local filesystem.
  agentType?: SessionAgentType; // Agent type for session operations
  recoveryAgent?: string;   // Opaque CLI harness resumed through the canonical recovery verb.
  version?: string;         // Pinned agent version ("2.1.113"); undefined when unknown
  account?: string;         // Resolved account email for this terminal when known
  statusVersion?: string;   // Display-only version from agents-cli metadata
  statusAccount?: string;   // Display-only account from agents-cli metadata
  identityAppliedSessionId?: string; // Session id the version/account (from the broadcast watch row) were applied for (even if a field is null); display gate — the status bar shows them only for THIS session, never a prior binding's leftover
  approvalStatus?: 'pending' | 'approved' | 'running' | 'complete'; // Swarm approval status
  autoLabelPollerId?: NodeJS.Timeout; // Poller for auto-label fetch (cleared once label is set)
  appliedTitle?: string;    // Tab title showing now (creation name or last rename) — dedupe guard so an unchanged title is never re-applied (and never disturbs focus)
  pendingTitle?: string;    // Desired title for a tab that is NOT currently focused; applied on next focus. Renaming a background tab would steal focus, which we never do.
  stage?: TabStage;         // Launch stage the tab shows until the session is named (`formatTerminalTitle`)
}

const STATUS_BAR_LABELS_KEY = 'agentStatusBarLabels';

type StatusBarLabelsStorage = { [pid: number]: string };


function loadStatusBarLabels(context: vscode.ExtensionContext): StatusBarLabelsStorage {
  const stored = context.globalState.get<StatusBarLabelsStorage>(STATUS_BAR_LABELS_KEY);
  return stored || {};
}

async function saveStatusBarLabel(
  context: vscode.ExtensionContext,
  pid: number,
  label: string | undefined
): Promise<void> {
  const stored = loadStatusBarLabels(context);
  if (label) {
    stored[pid] = label;
  } else {
    delete stored[pid];
  }
  await context.globalState.update(STATUS_BAR_LABELS_KEY, stored);
}

// Recently closed session info for "reopen last session"
export interface ClosedSession {
  sessionId: string;
  /** Device the closed session ran on, so reopening resumes it there. */
  host?: string;
  label?: string;
  agentType?: SessionAgentType;
  version?: string;
  account?: string;
}

const MAX_CLOSED_SESSIONS = 10;
const recentlyClosedSessions: ClosedSession[] = [];

export function pushClosedSession(session: ClosedSession): void {
  recentlyClosedSessions.unshift(session);
  if (recentlyClosedSessions.length > MAX_CLOSED_SESSIONS) {
    recentlyClosedSessions.length = MAX_CLOSED_SESSIONS;
  }
}

export function popClosedSession(): ClosedSession | undefined {
  return recentlyClosedSessions.shift();
}

// Two-map architecture (API.md)
const editorTerminals = new Map<string, EditorTerminal>();
const terminalToId = new WeakMap<vscode.Terminal, string>();
// Tabs a restore has not reopened yet. They stay in the store until they are
// live, so a crash or reload in the middle of a staggered restore loses none.
const restoring = new Map<string, sessionsPersist.PersistedSession>();
let terminalIdCounter = 0;

// Debounced disk persistence
let persistTimeout: NodeJS.Timeout | null = null;

/**
 * The restore store key for this window: its workspace file when it has one (a
 * multi-root workspace, saved or untitled), else its folder. `legacyKey` is the
 * first-folder key the pre-upgrade shared store used. Limits: saving an untitled
 * workspace gives it a new key, so its tabs are not restored once; two windows
 * on the same folder or workspace (which the editor normally prevents) share a file.
 */
function restoreStoreKeys(): { key: string; legacyKey: string } | undefined {
  const folder = vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return undefined;
  return { key: vscode.workspace.workspaceFile?.toString() ?? folder, legacyKey: folder };
}

/**
 * Schedule disk persistence (debounced to batch rapid changes).
 * Call this after any terminal state change.
 */
function schedulePersist(): void {
  if (!restoreStoreKeys()) return;
  if (persistTimeout) clearTimeout(persistTimeout);
  persistTimeout = setTimeout(() => {
    persistTimeout = null;
    persistNow();
  }, 500); // 500ms debounce
}

/** Persist immediately: on deactivate, after a restore, and when a tab closes. */
export function persistNow(): void {
  const keys = restoreStoreKeys();
  if (!keys) return;
  if (persistTimeout) {
    clearTimeout(persistTimeout);
    persistTimeout = null;
  }
  sessionsPersist.saveWorkspaceSessions(keys.key, buildPersistedSessions(), {
    folders: windowFolders(),
    pid: process.pid,
  });
}

export function windowFolders(): string[] {
  return (vscode.workspace?.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

const STALE_TERMINAL_MS = 10_000;

/**
 * A terminal's shell pid within 10s. `timedOut` tells a terminal still starting
 * (processId never settled in time) from one with no pty at all (processId
 * settled to undefined, as for a terminal tab the editor revived after a crash).
 */
export async function processIdWithin(terminal: vscode.Terminal): Promise<{ pid: number | undefined; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = Symbol('timeout');
  try {
    const result = await Promise.race([
      terminal.processId,
      new Promise<typeof timeout>((resolve) => { timer = setTimeout(() => resolve(timeout), STALE_TERMINAL_MS); }),
    ]);
    return result === timeout ? { pid: undefined, timedOut: true } : { pid: result, timedOut: false };
  } catch {
    return { pid: undefined, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Accessors

export function getByTerminal(t: vscode.Terminal): EditorTerminal | undefined {
  const id = terminalToId.get(t);
  const entry = id ? editorTerminals.get(id) : undefined;
  debugLog(`[DEBUG getByTerminal] terminal="${t.name}" -> id=${id}, entry.label="${entry?.label}"`);
  return entry;
}

export function getById(id: string): EditorTerminal | undefined {
  return editorTerminals.get(id);
}

/**
 * The live editor-terminal entry for a CLI session id, if one is tracked in
 * this window. Used to reveal the terminal from an approval-waiting
 * notification (RUSH-2039). Skips entries whose process has exited.
 */
export function getBySessionId(sessionId: string): EditorTerminal | undefined {
  if (!sessionId) return undefined;
  for (const entry of editorTerminals.values()) {
    if (entry.sessionId === sessionId && entry.terminal.exitStatus === undefined) {
      return entry;
    }
  }
  return undefined;
}

const STARTING_MS = 15_000;

/**
 * This window's tabs for a session, split into the one showing it (`live`) and
 * tabs that no longer run its agent (`dead`). Pure: nothing is closed here; a
 * caller about to open the session closes `dead` with closeTabs. A tab counts as
 * live while its process runs and either is the agent (a tab opened with
 * agentTabShell), has a child process (the agent started from the shell), or was
 * created in the last 15s (its agent may still be starting).
 */
export async function sessionTabs(sessionId: string): Promise<{ live: EditorTerminal | undefined; dead: EditorTerminal[] }> {
  let live: EditorTerminal | undefined;
  const dead: EditorTerminal[] = [];
  if (!sessionId) return { live, dead };
  for (const entry of editorTerminals.values()) {
    if (entry.sessionId !== sessionId) continue;
    if (await runsAgent(entry)) live ??= entry;
    else dead.push(entry);
  }
  return { live, dead };
}

export function closeTabs(entries: readonly EditorTerminal[]): void {
  for (const entry of entries) {
    unregister(entry.terminal);
    entry.terminal.dispose();
  }
}

async function runsAgent(entry: EditorTerminal): Promise<boolean> {
  if (entry.terminal.exitStatus !== undefined) return false;
  const starting = Date.now() - entry.createdAt < STARTING_MS;
  if (starting && (entry.pid === undefined || pidAlive(entry.pid))) return true;
  return agentRunning(entry);
}

async function agentRunning(entry: EditorTerminal): Promise<boolean> {
  if (entry.terminal.exitStatus !== undefined || entry.pid === undefined || !pidAlive(entry.pid)) return false;
  const args = (entry.terminal.creationOptions as vscode.TerminalOptions | undefined)?.shellArgs;
  if (Array.isArray(args) && args.includes('-c')) return true;
  return (await probeChildPids(entry.pid)).length > 0;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait up to `timeoutMs` for the tab's agent to exit; false if it is still running. */
export async function waitForAgentExit(entry: EditorTerminal, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await agentRunning(entry))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function getAllTerminals(): EditorTerminal[] {
  return Array.from(editorTerminals.values());
}

export function isAgentTerminal(t: vscode.Terminal): boolean {
  const entry = getByTerminal(t);
  return entry?.agentConfig !== null && entry?.agentConfig !== undefined;
}

// Mutations

// Generate a unique terminal ID (call before creating terminal for env var)
export function nextId(prefix: string): string {
  return generateTerminalId(prefix, ++terminalIdCounter);
}

// Register a terminal with a pre-generated ID
// IMPORTANT: This function is idempotent - if the terminal is already registered,
// it will skip registration to prevent race conditions from overwriting sessionId
export function register(
  terminal: vscode.Terminal,
  id: string,
  agentConfig: Omit<AgentConfig, 'count'> | null,
  pid?: number,
  context?: vscode.ExtensionContext,
  initialLabel?: string,
  // The tab's ORIGINAL creation time, when one is being restored. A reload or a
  // tmux reattach builds a new vscode.Terminal widget for an agent that has been
  // running for hours, and `createdAt` is what dates that agent's own session
  // records (liveSessionIdForShell) — stamping it "now" would make the still-live
  // agent's SessionStart record look like it predates its own tab and get
  // discarded. Omitted for a genuinely new tab, which is created now by definition.
  createdAt?: number,
): void {
  // Check if terminal is already registered (prevents race condition with onDidOpenTerminal)
  const existingId = terminalToId.get(terminal);
  if (existingId) {
    console.log(`[TERMINALS] Terminal "${terminal.name}" already registered with id=${existingId}, skipping duplicate registration`);
    return;
  }

  console.log(`[DEBUG register] Registering terminal: name="${terminal.name}", id=${id}, pid=${pid}, initialLabel=${initialLabel}`);

  const entry: EditorTerminal = {
    id,
    terminal,
    agentConfig,
    createdAt: createdAt ?? Date.now(),
    pid,
    // The name a tab was created with is its title already; a rename to the same
    // title is never issued.
    appliedTitle: terminal.name || undefined,
  };

  if (pid !== undefined && context) {
    const persistedLabels = loadStatusBarLabels(context);
    console.log(`[DEBUG register] All persisted labels in globalState:`, JSON.stringify(persistedLabels));
    const persistedLabel = persistedLabels[pid];
    console.log(`[DEBUG register] Persisted label for PID ${pid}: "${persistedLabel}"`);
    if (persistedLabel) {
      entry.label = persistedLabel;
    } else if (initialLabel) {
      entry.label = initialLabel;
      // Also persist this label since we found it on a restored terminal
      saveStatusBarLabel(context, pid, initialLabel);
    }
  } else if (initialLabel) {
    entry.label = initialLabel;
  }

  console.log(`[DEBUG register] Final entry.label: "${entry.label}"`);
  editorTerminals.set(id, entry);
  terminalToId.set(terminal, id);
  restoring.delete(id);
  console.log(`[DEBUG register] editorTerminals now has ${editorTerminals.size} entries`);

  // Persist to disk
  schedulePersist();
}

export function unregister(terminal: vscode.Terminal): void {
  const id = terminalToId.get(terminal);
  if (id) {
    const entry = editorTerminals.get(id);
    if (entry?.autoLabelPollerId) {
      clearInterval(entry.autoLabelPollerId);
    }
    editorTerminals.delete(id);
    terminalToId.delete(terminal);

    // Immediately: a closed tab must be off disk before anything else can crash.
    persistNow();
  }
}

export async function setLabel(
  terminal: vscode.Terminal,
  label: string | undefined,
  context?: vscode.ExtensionContext
): Promise<void> {
  console.log(`[DEBUG setLabel] Setting label for terminal "${terminal.name}" to "${label}"`);
  const entry = getByTerminal(terminal);
  console.log(`[DEBUG setLabel] Found entry: id=${entry?.id}, pid=${entry?.pid}, currentLabel="${entry?.label}"`);
  if (entry) {
    entry.label = label;
    if (entry.pid !== undefined && context) {
      console.log(`[DEBUG setLabel] Persisting label "${label}" for PID ${entry.pid}`);
      await saveStatusBarLabel(context, entry.pid, label);
    }

    // Persist to disk
    schedulePersist();

    stopAutoLabelPoller(terminal);
  } else {
    console.log(`[DEBUG setLabel] No entry found for terminal - label NOT saved!`);
  }
}

export function setAutoLabel(terminal: vscode.Terminal, autoLabel: string | undefined): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.autoLabel = autoLabel;
    if (autoLabel && entry.autoLabelPollerId) {
      clearInterval(entry.autoLabelPollerId);
      entry.autoLabelPollerId = undefined;
      console.log(`[TERMINALS] Cleared auto-label poller for terminal "${terminal.name}" - label set: "${autoLabel}"`);
    }
    schedulePersist();
  }
}

// Cap the auto-label poll interval. Once a stable label exists the poller
// stops entirely; until then the interval doubles after each failed poll so a
// terminal whose label never resolves doesn't re-spawn a model subprocess
// every 5 minutes forever.
const AUTO_LABEL_MAX_INTERVAL_MS = 60 * 60 * 1000;

export function startAutoLabelPoller(
  terminal: vscode.Terminal,
  pollFn: () => Promise<void>,
  intervalMs: number = 5 * 60 * 1000
): void {
  const entry = getByTerminal(terminal);
  if (!entry) return;
  if (entry.autoLabelPollerId) return;
  if (entry.autoLabel || entry.label) return;

  // Run immediately on start, then back off for subsequent polls.
  pollFn().catch(() => {});

  let delay = intervalMs;
  const schedule = (): void => {
    entry.autoLabelPollerId = setTimeout(async () => {
      // Stable label exists -> stop the drip entirely.
      if (entry.autoLabel || entry.label) {
        entry.autoLabelPollerId = undefined;
        return;
      }
      await pollFn().catch(() => {});
      if (entry.autoLabel || entry.label) {
        entry.autoLabelPollerId = undefined;
        return;
      }
      // Still unlabeled: back off before trying again.
      delay = Math.min(delay * 2, AUTO_LABEL_MAX_INTERVAL_MS);
      schedule();
    }, delay);
  };
  schedule();
  console.log(`[TERMINALS] Started auto-label poller for terminal "${terminal.name}" (interval: ${intervalMs}ms, backoff cap: ${AUTO_LABEL_MAX_INTERVAL_MS}ms)`);
}

export function stopAutoLabelPoller(terminal: vscode.Terminal): void {
  const entry = getByTerminal(terminal);
  if (entry?.autoLabelPollerId) {
    clearInterval(entry.autoLabelPollerId);
    entry.autoLabelPollerId = undefined;
    console.log(`[TERMINALS] Stopped auto-label poller for terminal "${terminal.name}"`);
  }
}

function restoredSessionId(envId: string | null | undefined, persisted?: sessionsPersist.PersistedSession): string | undefined {
  // The env is frozen at shell creation; persisted stream rebindings are newer.
  return persisted ? persisted.sessionId : envId || undefined;
}

export async function promptSessionId(args: { terminalId?: string } = {}): Promise<EditorTerminal | undefined> {
  const entry = args.terminalId ? getById(args.terminalId)
    : vscode.window.activeTerminal ? getByTerminal(vscode.window.activeTerminal) : undefined;
  if (!entry?.agentConfig) return undefined;
  const raw = await vscode.window.showInputBox({
    title: 'Set Session ID for Terminal',
    value: entry.sessionId ?? '',
    validateInput: (value) => canonicalSessionId(value) && !needsSessionIdHydrate(canonicalSessionId(value))
      ? undefined : 'Enter a session ID.',
  });
  if (raw === undefined) return undefined;
  const sessionId = canonicalSessionId(raw);
  if (!sessionId || needsSessionIdHydrate(sessionId) || getById(entry.id) !== entry) return undefined;
  setSessionId(entry.terminal, sessionId, true);
  return entry;
}

const sessionBindingListeners = new Set<() => void>();

export function onSessionBindingChanged(listener: () => void): { dispose(): void } {
  sessionBindingListeners.add(listener);
  return { dispose: () => { sessionBindingListeners.delete(listener); } };
}

export function setSessionId(terminal: vscode.Terminal, sessionId: string, manual = false): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    const prevSessionId = entry.sessionId;
    const replaced = [...(entry.manualSessionOverride?.replaced ?? []), ...(prevSessionId ? [canonicalSessionId(prevSessionId) ?? prevSessionId] : [])];
    entry.sessionId = sessionId;
    entry.manualSessionOverride = manual ? { sessionId, replaced: [...new Set(replaced)].filter(id => id !== sessionId) } : undefined;
    if (prevSessionId !== sessionId) {
      // Drop a stale auto-label only when a PRIOR real session owned it (a
      // rerun / /clear rebinds the tab to a new id whose label differs).
      if (prevSessionId) entry.autoLabel = undefined;
      // Clear the fast id-resolve poller on ANY id change — crucially including
      // the no-id -> UUID transition (RUSH-3184). That poller was spun up to
      // resolve the id; once the id lands it has done its job. The old guard
      // (`prevSessionId && …`) skipped this case, so the poller kept firing
      // every few seconds for the life of the tab even after the id was known,
      // and applyHydratedSessionId's re-arm stacked a second poller on top.
      if (entry.autoLabelPollerId) {
        clearInterval(entry.autoLabelPollerId);
        entry.autoLabelPollerId = undefined;
      }
    }
    console.log(`[TERMINALS] Set sessionId for terminal "${terminal.name}": ${sessionId}`);
    if (prevSessionId !== sessionId) for (const listener of sessionBindingListeners) listener();

    // Persist to disk
    if (manual) persistNow();
    else schedulePersist();

  } else {
    console.error(`[TERMINALS] FAILED to set sessionId - terminal "${terminal.name}" not found in registry. This may indicate a race condition.`);
  }
}

export function setAgentType(
  terminal: vscode.Terminal,
  agentType: SessionAgentType,
): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.agentType = agentType;

    // Persist to disk
    schedulePersist();

  } else {
    console.error(`[TERMINALS] FAILED to set agentType - terminal "${terminal.name}" not found in registry.`);
  }
}

export function setRecoveryAgent(terminal: vscode.Terminal, recoveryAgent: string): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.recoveryAgent = recoveryAgent;
    schedulePersist();
  } else {
    console.error(`[TERMINALS] FAILED to set recoveryAgent - terminal "${terminal.name}" not found in registry.`);
  }
}

// Convert an SH-registered terminal into an agent terminal once the user has
// launched an agent CLI inside it. Mutates the existing entry in place so
// every consumer (dashboard, status bar, session tracker, label generation,
// autogit, swarm) starts treating the tab as the detected agent.
//
// The VS Code tab icon and `creationOptions` are immutable, so the visible
// tab keeps its SH chip — only the internal registry and downstream display
// names update.
//
// Idempotent: a non-SH entry is returned unchanged.
export function adoptShellAsAgent(
  terminal: vscode.Terminal,
  newAgentConfig: Omit<AgentConfig, 'count'>,
  agentType: SessionAgentType,
  sessionId: string | undefined
): boolean {
  const entry = getByTerminal(terminal);
  if (!entry) {
    console.error(`[TERMINALS] adoptShellAsAgent: terminal "${terminal.name}" not in registry`);
    return false;
  }
  if (entry.agentConfig?.prefix !== 'sh') {
    console.log(`[TERMINALS] adoptShellAsAgent: terminal "${terminal.name}" already adopted (prefix=${entry.agentConfig?.prefix}), skipping`);
    return false;
  }

  console.log(`[TERMINALS] Adopting SH terminal "${terminal.name}" (id=${entry.id}) as ${newAgentConfig.title}, sessionId=${sessionId}`);
  entry.agentConfig = newAgentConfig;
  entry.agentType = agentType;
  if (sessionId) {
    entry.sessionId = sessionId;
  }

  schedulePersist();
  return true;
}

/** Record the device an offloaded terminal runs on (see EditorTerminal.host). */
export function setHost(terminal: vscode.Terminal, host: string): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    entry.host = host;
    schedulePersist();
  } else {
    console.error(`[TERMINALS] FAILED to set host - terminal "${terminal.name}" not found in registry.`);
  }
}

export function setVersion(terminal: vscode.Terminal, version: string | null | undefined): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    // A null/empty version CLEARS the cached value rather than being ignored: a
    // harness the CLI records no version for (Kimi, Grok, …) must not keep a
    // version left over from a prior binding in the same terminal.
    const normalized = version?.trim() || undefined;
    entry.version = normalized;
    entry.statusVersion = normalized;
    schedulePersist();
  } else {
    console.error(`[TERMINALS] FAILED to set version - terminal "${terminal.name}" not found in registry.`);
  }
}

export function setAccount(
  terminal: vscode.Terminal,
  account: string | null | undefined
): void {
  const entry = getByTerminal(terminal);
  if (entry) {
    const normalized = account?.trim();
    entry.account = normalized || undefined;
    entry.statusAccount = normalized || undefined;
  } else {
    console.error(`[TERMINALS] FAILED to set account - terminal "${terminal.name}" not found in registry.`);
  }
}

export function getSessionId(terminal: vscode.Terminal): string | undefined {
  const entry = getByTerminal(terminal);
  return entry?.sessionId;
}

export function getAgentType(terminal: vscode.Terminal): SessionAgentType | undefined {
  const entry = getByTerminal(terminal);
  return entry?.agentType;
}

// Rename a terminal tab title — WITHOUT ever stealing focus.
//
// `workbench.action.terminal.renameWithArg` only operates on the active
// terminal, and VS Code exposes no API to rename a terminal tab without
// focusing it (microsoft/vscode #171175). The old code worked around that by
// `terminal.show()`ing the target and then showing the previous one back — but
// every programmatic `.show()` is indistinguishable from a user focus change,
// so with the focus handlers renaming tabs on every focus event it produced a
// self-sustaining hop that cycled the active tab with no user input (#3019).
//
// The rule now: a tab is renamed only while it is ALREADY the active terminal.
// A background tab stores its desired title in `pendingTitle` and picks it up
// the next time the user focuses it (see applyPendingTitle) — the extension
// never switches the visible tab to rename it.
export async function renameTerminal(terminal: vscode.Terminal, newName: string): Promise<void> {
  const entry = getByTerminal(terminal);
  // Already showing this exact title → nothing to do (and never re-issue a
  // command that could disturb focus).
  if (entry?.appliedTitle === newName) return;
  // `renameWithArg` renames whichever terminal is active when the workbench runs
  // it, so the target must be active right before the command, and a rename that
  // landed on another tab is undone.
  if (vscode.window.activeTerminal !== terminal) {
    if (entry) entry.pendingTitle = newName;
    return;
  }
  const live = vscode.window.terminals ?? [];
  const namesBefore = new Map(live.map((t) => [t, t.name]));
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: newName });
  } catch (err) {
    console.error('[TERMINALS] Failed to rename terminal', err);
    return;
  }
  const hit = (vscode.window.terminals ?? []).find((t) => t !== terminal && t.name === newName && namesBefore.get(t) !== newName);
  if (hit) {
    const previous = namesBefore.get(hit);
    console.warn(`[TERMINALS] Rename to "${newName}" landed on "${previous}"; restoring it`);
    if (previous && vscode.window.activeTerminal === hit) {
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: previous }).then(undefined, () => {});
    }
    if (entry) entry.pendingTitle = newName;
    return;
  }
  if (entry) {
    entry.appliedTitle = newName;
    entry.pendingTitle = undefined;
  }
}

// Apply a title deferred while the tab was in the background. Called when a tab
// gains focus: it is now the active terminal, so renameTerminal can write the
// stored title without stealing focus from anyone.
export async function applyPendingTitle(terminal: vscode.Terminal): Promise<void> {
  const entry = getByTerminal(terminal);
  const pending = entry?.pendingTitle;
  if (!pending) return;
  await renameTerminal(terminal, pending);
}

// Lifecycle

type InferAgentConfig = (name: string, knownPrefix?: string | null) => Omit<AgentConfig, 'count'> | null;

/**
 * Register an agent tab this window did not open itself: one found on activation
 * or one the editor opened later. Its identity comes from the env it was created
 * with, and the persisted entry with its terminal id (newer than that env) restores
 * labels, host, version and session. False when it is not an agent tab, or when
 * `requireProcess` and it has no shell.
 */
export async function adopt(
  terminal: vscode.Terminal,
  inferAgentConfig: InferAgentConfig,
  opts: {
    context?: vscode.ExtensionContext;
    persistedSessions: readonly sessionsPersist.PersistedSession[];
    requireProcess?: boolean;
    onSessionRestored?: (terminal: vscode.Terminal) => void;
  },
): Promise<boolean> {
  const identOpts = extractTerminalIdentificationOptions(terminal);
  // A window reload revives a tab with only its name and its process: env and
  // icon come back empty, and the name carries no harness. The shell pid is the
  // same process the persisted entry recorded, so it finds that entry.
  const pidWait = identOpts.terminalId ? undefined : await processIdWithin(terminal);
  const byPid = pidWait?.pid !== undefined
    ? opts.persistedSessions.find(p => p.agentPid === pidWait.pid)
    : undefined;
  const info = getTerminalDisplayInfo(byPid ? { ...identOpts, terminalId: byPid.terminalId } : identOpts);
  if (!info.isAgent || !info.prefix) return false;

  const agentConfig = inferAgentConfig(terminal.name, info.prefix);
  if (!agentConfig) return false;

  const id = identOpts.terminalId || byPid?.terminalId || nextId(info.prefix);
  const { pid, timedOut } = pidWait ?? await processIdWithin(terminal);

  // A terminal-editor input can survive a window reload after its backing
  // pseudo-terminal has gone away. VS Code still exposes that stale input in
  // window.terminals, but processId resolves undefined (and the renderer logs
  // "Unable to resolve resource vscode-terminal:..."). Registering it makes
  // restoreAgentTerminals believe the persisted session already has a live
  // tab, so it skips the real recreation and the user gets no terminal at all.
  // Only a terminal with a backing process is an existing terminal. A revived
  // agent tab with no pty is closed, so the persisted-session path reopens that
  // session as the one live tab in its place. One still starting (timed out)
  // may yet come up, so it is left alone.
  if (pid === undefined && opts.requireProcess) {
    if (!timedOut) terminal.dispose();
    console.log(`[TERMINALS] No backing process for "${terminal.name}" (${timedOut ? 'still starting, left open' : 'no pty, closed'})`);
    return false;
  }

  const persisted = identOpts.terminalId
    ? opts.persistedSessions.find(p => p.terminalId === identOpts.terminalId)
    : byPid;
  const restoredLabels = restoredSessionTabLabels(info.label || undefined, persisted);
  register(terminal, id, agentConfig, pid, opts.context, restoredLabels.manualLabel);
  if (restoredLabels.autoLabel) setAutoLabel(terminal, restoredLabels.autoLabel);
  console.log(`[TERMINALS] Registered: id=${id}, prefix=${info.prefix}, pid=${pid}, label=${info.label}`);

  // VS Code can drop `creationOptions.env` across a reload, so the persisted
  // entry is the other source for the device and the pinned version. The host
  // goes on BEFORE any host-dependent lookup: without it a remote session's
  // resume degrades to a local binary and the label poller reads the wrong
  // filesystem (RUSH-2047).
  if (persisted?.host) setHost(terminal, persisted.host);
  const pinnedVersion = resolveRestoredVersion(identOpts.version, persisted?.version);
  if (pinnedVersion) setVersion(terminal, pinnedVersion);

  // The agent type goes on even without a session id, so a fresh session file
  // can be adopted later.
  const agentType = prefixToAgentType(info.prefix);
  if (agentType) setAgentType(terminal, agentType);
  const sessionId = restoredSessionId(identOpts.sessionId, persisted);
  if (sessionId !== undefined) {
    setSessionId(terminal, sessionId);
    console.log(`[TERMINALS] Restored session: sessionId=${sessionId}, agentType=${agentType}`);
  }
  const restoredEntry = getByTerminal(terminal);
  if (restoredEntry) restoredEntry.manualSessionOverride = persisted?.manualSessionOverride;
  if (sessionId && opts.onSessionRestored) opts.onSessionRestored(terminal);
  return true;
}

export async function scanExisting(
  inferAgentConfig: InferAgentConfig,
  context?: vscode.ExtensionContext,
  onSessionRestored?: (terminal: vscode.Terminal) => void
): Promise<number> {
  console.log('[TERMINALS] Scanning all terminals...');
  let registeredCount = 0;

  // Snapshot this window's store before registering anything. Every register or
  // close persists, and a persist writes the live tabs plus `restoring`; without
  // the snapshot, the first write during a slow scan would erase the crashed tabs
  // restore exists to reopen, and consume the one-time upgrade read.
  const persistedSessions = loadPersistedSessions();
  setRestoring(persistedSessions);
  console.log(`[TERMINALS] Loaded ${persistedSessions.length} persisted sessions`);

  for (const terminal of vscode.window.terminals) {
    // Skip terminals whose process has exited (tab may still be open), and ones
    // already registered.
    if (terminal.exitStatus !== undefined || terminalToId.has(terminal)) continue;
    if (await adopt(terminal, inferAgentConfig, { context, persistedSessions, requireProcess: true, onSessionRestored })) {
      registeredCount++;
    }
  }

  console.log(`[TERMINALS] Scan complete. Registered ${registeredCount} agent terminals.`);
  return registeredCount;
}

// Clear state (for testing/deactivation)
export function clear(): void {
  // Dispose any auto-label pollers still running so deactivate doesn't leak
  // intervals for terminals whose label never resolved.
  for (const entry of editorTerminals.values()) {
    if (entry.autoLabelPollerId) {
      clearInterval(entry.autoLabelPollerId);
      entry.autoLabelPollerId = undefined;
    }
  }
  editorTerminals.clear();
  restoring.clear();
  terminalIdCounter = 0;
}

// Session persistence for restore across VS Code restarts

// Build persisted session data from current terminals
export function buildPersistedSessions(): sessionsPersist.PersistedSession[] {
  const sessions: sessionsPersist.PersistedSession[] = [];

  for (const entry of editorTerminals.values()) {
    // Only persist agent terminals (not regular terminals)
    if (!entry.agentConfig) continue;

    sessions.push({
      terminalId: entry.id,
      prefix: entry.agentConfig.prefix,
      sessionId: entry.sessionId,
      manualSessionOverride: entry.manualSessionOverride,
      host: entry.host,
      label: entry.label,
      autoLabel: entry.autoLabel,
      agentType: entry.agentType,
      recoveryAgent: entry.recoveryAgent,
      version: entry.version,
      createdAt: entry.createdAt,
      agentPid: entry.pid,
    });
  }
  for (const pending of restoring.values()) {
    if (!editorTerminals.has(pending.terminalId)) sessions.push(pending);
  }

  return sessions;
}

export function setRestoring(sessions: readonly sessionsPersist.PersistedSession[]): void {
  restoring.clear();
  for (const session of sessions) restoring.set(session.terminalId, session);
}

/** Persisted tabs not reopened yet: the scan's snapshot until restore narrows it. */
export function pendingRestore(): sessionsPersist.PersistedSession[] {
  return [...restoring.values()];
}

// This window's persisted tabs.
export function loadPersistedSessions(): sessionsPersist.PersistedSession[] {
  const keys = restoreStoreKeys();
  return keys ? sessionsPersist.getWorkspaceSessions(keys.key, keys.legacyKey) : [];
}

