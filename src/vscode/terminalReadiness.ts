// VS Code glue for the terminalReadiness state machine.
//
// One global registry keyed by vscode.Terminal instance; its entry is torn down
// when the terminal closes. Probing is ReadinessDetector's: the monitor's, or
// this window's own (`local`) while the monitor is down.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// VS Code's console.log lands in no persisted file, so shell adoption mirrors
// its steps to ~/.cache/swarmify/shell-adoption.log for post-hoc debugging.
const ADOPTION_LOG_PATH = path.join(os.homedir(), '.cache', 'swarmify', 'shell-adoption.log');
let adoptionLogReady = false;
export function adoptionLog(msg: string): void {
  try {
    if (!adoptionLogReady) {
      fs.mkdirSync(path.dirname(ADOPTION_LOG_PATH), { recursive: true });
      adoptionLogReady = true;
    }
    fs.appendFileSync(ADOPTION_LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}
import {
  ReadinessEntry,
  ReadinessEvent,
  createEntry,
  markEvent,
  resetFrom,
  waitFor as coreWaitFor,
  dispose as coreDispose,
  hasFired,
  AgentLauncherKey,
  detectAgentKeyFromArgs,
  extractSessionIdFromArgs,
} from '../core/terminalReadiness';
import { PROMPT_READY_TIMEOUT_MS, AGENT_READY_TIMEOUT_MS } from '../monitor/probes';
import { ReadinessDetector } from '../monitor/readinessDetector';

interface Registered {
  entry: ReadinessEntry;
  terminal: vscode.Terminal;
  pid: number | null;
  agentArmed: boolean;
}

const registry = new Map<vscode.Terminal, Registered>();

const local = new ReadinessDetector({
  emit: ({ pid, event }) => ingestReadinessFact(pid, event),
  emitAdoption: ({ pid, agentKey, sessionId, childPid }) =>
    ingestShellAdoptionFact(pid, { agentKey: agentKey as AgentLauncherKey, sessionId, childPid }),
  fired: (pid, event) => [...registry.values()].some((r) => r.pid === pid && hasFired(r.entry, event)),
});

// --- Monitor follower routing (#68) ---------------------------------------
//
// When this window is connected to the centralized monitor, the leader runs the
// ps/pgrep probes once per pid and broadcasts readiness facts; this window then
// resolves each fact to its own terminal and feeds the SAME state machine via
// markEvent. Local probing is therefore SUPPRESSED while connected, and the arm
// intents are forwarded to the monitor. When disconnected (election race, leader
// loss) this window's own detector probes instead, emitting into the same ingest.

export interface MonitorArmSink {
  armAgent(pid: number): void;
  armShellAdoption(pid: number): void;
}

let monitorConnected: () => boolean = () => false;
let monitorArmSink: MonitorArmSink | undefined;

/** Wire the predicate the gating consults to decide local-vs-broadcast. */
export function setMonitorConnectivity(fn: () => boolean): void {
  monitorConnected = fn;
}

/** Wire the sink that forwards arm intents to the monitor. */
export function setMonitorArmSink(sink: MonitorArmSink | undefined): void {
  monitorArmSink = sink;
}

function useMonitor(pid: number | null): pid is number {
  return pid !== null && monitorConnected() && monitorArmSink !== undefined;
}

/** Apply a broadcast readiness fact to every local terminal on that pid. */
export function ingestReadinessFact(pid: number, event: ReadinessEvent): void {
  for (const r of registry.values()) {
    if (r.pid === pid) markEvent(r.entry, event);
  }
}

/** Apply a broadcast shell-adoption fact: fire the armed callback for that pid. */
export function ingestShellAdoptionFact(pid: number, info: ShellAdoptionInfo): void {
  for (const [terminal, r] of registry.entries()) {
    if (r.pid !== pid) continue;
    const state = shellAdoptions.get(terminal);
    if (!state || !state.armed) continue;
    state.armed = false;
    shellAdoptions.delete(terminal);
    adoptionLog(`"${terminal.name}" (shellPid=${pid}): adopted agentKey=${info.agentKey} childPid=${info.childPid} sessionId=${info.sessionId}`);
    try {
      state.onAdopted(info);
    } catch (err) {
      adoptionLog(`"${terminal.name}": onAdopted callback threw: ${err}`);
      console.error('[READINESS] shell adoption callback threw', err);
    }
  }
}

// On leadership loss / disconnect, probe locally whatever each terminal still
// awaits; the detector skips every milestone the terminal already reached.
export function onMonitorDisconnected(): void {
  for (const [terminal, r] of registry.entries()) {
    if (r.pid === null) continue;
    local.addPid(r.pid);
    if (r.agentArmed) local.armAgent(r.pid);
    if (shellAdoptions.get(terminal)?.armed) local.armShellAdoption(r.pid);
  }
}

let shellIntegrationDisposable: vscode.Disposable | null = null;
let closeDisposable: vscode.Disposable | null = null;

// Call once during extension activation.
export function initReadiness(context: vscode.ExtensionContext): void {
  if (shellIntegrationDisposable) return;

  shellIntegrationDisposable = vscode.window.onDidChangeTerminalShellIntegration(
    ({ terminal }) => {
      const r = registry.get(terminal);
      if (!r) return;
      markEvent(r.entry, 'promptReady');
    }
  );

  closeDisposable = vscode.window.onDidCloseTerminal((terminal) => {
    disposeTerminal(terminal);
  });

  context.subscriptions.push(shellIntegrationDisposable);
  context.subscriptions.push(closeDisposable);
}

export interface RegisterOptions {
  // When true, the terminal was restored after an IDE reload and its agent is
  // already running. Mark all events as fired immediately; do not probe.
  restored?: boolean;
}

// Register a terminal at creation time. Kicks off tabReady + shellReady probes.
// Idempotent: calling twice on the same terminal is a no-op.
export function registerTerminal(
  terminal: vscode.Terminal,
  opts: RegisterOptions = {}
): void {
  if (registry.has(terminal)) return;

  const r: Registered = {
    entry: createEntry(),
    terminal,
    pid: null,
    agentArmed: opts.restored === true,
  };
  registry.set(terminal, r);

  if (opts.restored) {
    // Resolve pid for completeness but skip all probes — the agent is up.
    Promise.resolve(terminal.processId).then((pid) => {
      if (!pid || registry.get(terminal) !== r) return;
      r.pid = pid;
      armPendingAdoption(terminal, pid);
    }, () => { /* ignore */ });
    markEvent(r.entry, 'agentReady');
    return;
  }

  // tabReady: resolves as soon as the pty is allocated.
  Promise.resolve(terminal.processId).then((pid) => {
    if (!pid || registry.get(terminal) !== r) return;
    r.pid = pid;
    markEvent(r.entry, 'tabReady');
    // When connected to the monitor, the leader probes this pid once and
    // broadcasts shellReady/promptReady (resolved via ingestReadinessFact);
    // skip the local ps/pgrep probes. The follower already reports this pid.
    if (!useMonitor(pid)) local.addPid(pid);
    armPendingAdoption(terminal, pid);
  }, () => {
    // Terminal was disposed before pid resolved.
  });
}

// Called by Resume/Reload flows after ^C^C: we want to re-await promptReady
// fresh because the agent CLI needs to release the pty and the shell prompt
// needs to reappear. Probed here even while the monitor is connected: the
// leader already reported promptReady for this pid and will not report it again.
export function resetAfterAgentExit(terminal: vscode.Terminal): void {
  const r = registry.get(terminal);
  if (!r) return;
  r.agentArmed = false;
  resetFrom(r.entry, 'promptReady');
  if (r.pid !== null) local.reset(r.pid);
}

export { detectAgentKeyFromArgs, extractSessionIdFromArgs };

// Arm agentReady detection. Call this right after sending the agent launch
// command. Detection is the process-state probe (stable 'S' plus minimum
// child runtime).
export function armAgentReady(terminal: vscode.Terminal): void {
  const r = registry.get(terminal);
  if (!r) return;
  if (r.agentArmed) return;
  if (hasFired(r.entry, 'agentReady')) return;
  r.agentArmed = true;
  if (r.pid === null) return;

  if (useMonitor(r.pid)) {
    monitorArmSink!.armAgent(r.pid);
    return;
  }
  local.addPid(r.pid);
  local.armAgent(r.pid);
}

// Public wait. If timeoutMs is undefined, sensible defaults are picked per event.
export function waitFor(
  terminal: vscode.Terminal,
  event: ReadinessEvent,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const r = registry.get(terminal);
  if (!r) {
    return Promise.reject(new Error(`terminal not registered for readiness: ${terminal.name}`));
  }

  const timeoutMs = opts.timeoutMs ?? defaultTimeoutFor(event);
  return coreWaitFor(r.entry, event, { timeoutMs });
}

function defaultTimeoutFor(event: ReadinessEvent): number | undefined {
  switch (event) {
    case 'tabReady': return 10_000;
    case 'shellReady': return 10_000;
    case 'promptReady': return PROMPT_READY_TIMEOUT_MS;
    case 'agentReady': return AGENT_READY_TIMEOUT_MS;
  }
}

function disposeTerminal(terminal: vscode.Terminal): void {
  const r = registry.get(terminal);
  if (!r) return;
  registry.delete(terminal);
  shellAdoptions.delete(terminal);
  if (r.pid !== null) local.removePid(r.pid);
  coreDispose(r.entry, 'terminal closed');
}

// --- Graceful agent teardown on a genuine tab close (#5b) -----------------
//
// `onDidCloseTerminal` fires for BOTH a real user close (Cmd+W / close tab) and
// a window RELOAD — and the underlying agent (in a detached tmux/mux session)
// survives both, so a naive "kill on close" would break crash-restore, which
// re-registers the very session it just saw close. The one signal that cleanly
// separates the two is `terminal.exitStatus.reason` (VS Code's
// `TerminalExitReason`, stable since API 1.77):
//
//   User (3)      — the user closed the tab            → TEAR DOWN
//   Shutdown (1)  — the window/app is reloading/quitting → keep (restore reattaches)
//   Process (2)   — the agent exited on its own          → keep (already gone; #5a reaped the mux)
//   Extension (4) — an extension closed it programmatically → keep
//   Unknown (0)   — ambiguous                              → keep (fail safe)
//
// Only `User` tears down. Every other reason — including the ambiguous
// `Unknown` — is left alone, so a reload/restore never kills a live agent.

/**
 * Whether a terminal close should tear down the underlying agent + its mux.
 * TRUE only for a genuine USER close; every other (or absent) exit reason is
 * left running so a window reload / programmatic close / natural exit can't kill
 * a session crash-restore is about to reattach.
 */
export function shouldTearDownAgentOnClose(
  reason: vscode.TerminalExitReason | undefined,
): boolean {
  return reason === vscode.TerminalExitReason.User;
}

export interface AgentCloseTeardown {
  /** `terminal.exitStatus?.reason` at close time. */
  reason: vscode.TerminalExitReason | undefined;
  /** The closed tab's live CLI session id, when it tracked one. */
  sessionId: string | undefined;
  /** The device the agent runs on, when offloaded (`--device`); undefined for a local tab. */
  host: string | undefined;
  /**
   * Runs `agents ps stop <id>` — injected so the teardown decision is
   * testable without spawning the CLI. Called ONLY for a genuine user close of
   * a tab that tracks a live session id.
   */
  stop: (sessionId: string, opts: { local: boolean }) => Promise<void>;
}

/**
 * On a genuine user close of an agent tab, stop the underlying agent and tear
 * down its tmux/mux session so it doesn't linger orphaned-idle (#5b). A no-op
 * for a reload/programmatic/natural close, and for a tab that never bound a
 * session id (a plain shell, or an agent that hadn't reported one yet — nothing
 * to stop). `--local` is passed for a local tab so the CLI skips the fleet
 * sweep; an offloaded tab (`host` set) lets the CLI resolve + hop to that box.
 */
export async function maybeTearDownAgentOnClose(t: AgentCloseTeardown): Promise<void> {
  if (!shouldTearDownAgentOnClose(t.reason)) return;
  if (!t.sessionId) return;
  await t.stop(t.sessionId, { local: !t.host });
}

// --- Shell adoption ------------------------------------------------------
//
// Watches the descendant process tree of an SH terminal for a known agent CLI
// (ReadinessDetector's adoption loop) and fires `onAdopted` once with the
// agent and its session id, when resolvable.

export interface ShellAdoptionInfo {
  agentKey: AgentLauncherKey;
  sessionId: string | undefined;
  childPid: number;
}

export type ShellAdoptionCallback = (info: ShellAdoptionInfo) => void;

interface ShellAdoptionState {
  armed: boolean;
  onAdopted: ShellAdoptionCallback;
}

const shellAdoptions = new WeakMap<vscode.Terminal, ShellAdoptionState>();

export function armShellAdoption(
  terminal: vscode.Terminal,
  onAdopted: ShellAdoptionCallback
): void {
  const r = registry.get(terminal);
  if (!r) {
    adoptionLog(`armShellAdoption: terminal "${terminal.name}" not in readiness registry — bailing`);
    return;
  }
  if (shellAdoptions.has(terminal)) {
    adoptionLog(`armShellAdoption: terminal "${terminal.name}" already armed — skipping`);
    return;
  }
  shellAdoptions.set(terminal, { armed: true, onAdopted });
  adoptionLog(`armShellAdoption: armed for terminal "${terminal.name}" (pid=${r.pid})`);
  if (r.pid !== null) armPendingAdoption(terminal, r.pid);
}

// Arms happen before the pid resolves too; registerTerminal calls this again
// once it has.
function armPendingAdoption(terminal: vscode.Terminal, pid: number): void {
  if (!shellAdoptions.get(terminal)?.armed) return;
  // Connected: the monitor walks this pid's tree once and broadcasts the
  // ShellAdoptionInfo (resolved via ingestShellAdoptionFact). Forward the arm.
  if (useMonitor(pid)) {
    adoptionLog(`armShellAdoption: forwarding to monitor for "${terminal.name}" (pid=${pid})`);
    monitorArmSink!.armShellAdoption(pid);
    return;
  }
  local.addPid(pid);
  local.armShellAdoption(pid);
}

export function __clearRegistryForTests(): void {
  for (const [terminal, r] of registry.entries()) {
    shellAdoptions.delete(terminal);
    if (r.pid !== null) local.removePid(r.pid);
  }
  registry.clear();
}
