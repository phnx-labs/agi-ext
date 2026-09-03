// Terminal-to-session crash recovery - VS Code integration
// Records which terminal is running which agent session so that, after a
// non-clean shutdown (crash), the extension can reopen and resume them.
//
// PHNX-3768: this state lives in `context.workspaceState`, NOT `globalState`.
// workspaceState is per-workspace and shared by nothing across windows, so a
// window activating for project A can only ever restore/clear project A's own
// mappings. With machine-global `globalState` (the prior bug) every window's
// activation iterated the whole machine's mappings, reopened/resumed each into
// whatever window just opened, AND wiped every other window's recovery state in
// the same pass — an N-window resume-storm that pinned CPU and crashed the host.
// This mirrors `restoreAgentTerminals` (the disk-persist sibling), which is
// already keyed per workspace, and `agentlinks.vscode.ts`, which likewise uses
// workspaceState for per-workspace one-shot flags.

import * as vscode from 'vscode';
import {
  PrewarmAgentType,
  TerminalSessionMapping,
} from '../core/prewarm';

// WorkspaceState keys (per-workspace; see the PHNX-3768 note above).
const MAPPINGS_KEY = 'prewarm.mappings';
const CLEAN_SHUTDOWN_KEY = 'prewarm.cleanShutdown';
// One-time marker so the pre-upgrade globalState migration runs at most once per
// workspace (see migrateFromGlobalStateOnce).
const MIGRATED_KEY = 'prewarm.migratedFromGlobal';

// === Terminal-to-Session Mapping for Crash Recovery ===

/**
 * Get all terminal-session mappings
 */
function getMappings(context: vscode.ExtensionContext): TerminalSessionMapping[] {
  return context.workspaceState.get<TerminalSessionMapping[]>(MAPPINGS_KEY, []);
}

/**
 * Save terminal-session mapping
 */
export async function recordTerminalSession(
  context: vscode.ExtensionContext,
  terminalId: string,
  sessionId: string,
  agentType: PrewarmAgentType,
  cwd: string
): Promise<void> {
  const mappings = getMappings(context);

  // Remove existing mapping for this terminal if any
  const existing = mappings.findIndex(m => m.terminalId === terminalId);
  if (existing !== -1) {
    mappings.splice(existing, 1);
  }

  mappings.push({
    terminalId,
    sessionId,
    agentType,
    createdAt: Date.now(),
    workingDirectory: cwd
  });

  await context.workspaceState.update(MAPPINGS_KEY, mappings);
  console.log(`[PREWARM] Recorded mapping: ${terminalId} -> ${sessionId}`);
}

/**
 * Remove terminal-session mapping
 */
export async function removeTerminalSession(
  context: vscode.ExtensionContext,
  terminalId: string
): Promise<void> {
  const mappings = getMappings(context);
  const idx = mappings.findIndex(m => m.terminalId === terminalId);

  if (idx !== -1) {
    const removed = mappings.splice(idx, 1)[0];
    await context.workspaceState.update(MAPPINGS_KEY, mappings);
    console.log(`[PREWARM] Removed mapping: ${terminalId} -> ${removed.sessionId}`);
  }
}

/**
 * Mark clean shutdown (called in deactivate)
 */
export async function markCleanShutdown(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(CLEAN_SHUTDOWN_KEY, true);
  console.log('[PREWARM] Marked clean shutdown');
}

/**
 * Check if last shutdown was clean
 */
function wasCleanShutdown(context: vscode.ExtensionContext): boolean {
  return context.workspaceState.get<boolean>(CLEAN_SHUTDOWN_KEY, true);
}

/**
 * Restore terminals from previous crash
 * Returns number of terminals restored
 */
export interface TerminalRestoreActions {
  listRestorableSessionIds(): Promise<Set<string>>;
  /**
   * The terminal ids and session ids that already have a live/tracked tab —
   * i.e. everything `restoreAgentTerminals` (the debounced persisted-terminals
   * path) already reopened on this same crash. Prewarm mappings are written
   * eagerly per `registerAgentTerminal`, while that store is a 500ms debounce
   * (`schedulePersist`), so the two overlap: without this guard both paths
   * reopen and re-resume the same session, racing two `agents sessions resume`
   * processes onto one transcript (the RUSH-2477 thundering-herd class).
   */
  trackedKeys(): { terminalIds: Set<string>; sessionIds: Set<string> };
  openAgentSessionTerminal(
    context: vscode.ExtensionContext,
    session: { id: string; shortId: string; agent: string; cwd?: string; terminalId?: string },
  ): Promise<boolean>;
}

/**
 * One-time upgrade migration (PHNX-3768).
 *
 * Pre-fix versions stored crash-recovery state in machine-global `globalState`.
 * A user who was mid-crash when the extension auto-updated has legitimate pending
 * mappings sitting in the OLD global keys; without this, `workspaceState` reads
 * its `true` default, the reactivation is misread as a clean shutdown, and that
 * one pending restore is silently dropped. On the first activation after upgrade,
 * fold THIS workspace's slice of the old global mappings into `workspaceState` and
 * adopt the old machine-wide clean-shutdown flag, then never read `globalState`
 * again.
 *
 * We only READ `globalState` and only WRITE this window's own `workspaceState`
 * — we never clear the global keys (they become harmless orphaned bytes). That
 * avoids the every-window-mutates-shared-state race this whole fix exists to kill.
 * Slice by exact `workingDirectory === workspacePath` match, never a prefix, so a
 * sibling workspace can never pull in another's sessions.
 */
async function migrateFromGlobalStateOnce(
  context: vscode.ExtensionContext,
  workspacePath: string,
): Promise<void> {
  if (context.workspaceState.get<boolean>(MIGRATED_KEY, false)) return;

  const globalMappings = context.globalState.get<TerminalSessionMapping[]>(MAPPINGS_KEY, []);
  const mine = globalMappings.filter(m => m.workingDirectory === workspacePath);
  if (mine.length > 0) {
    const existing = getMappings(context);
    const seen = new Set(existing.map(m => m.terminalId));
    const merged = existing.concat(mine.filter(m => !seen.has(m.terminalId)));
    await context.workspaceState.update(MAPPINGS_KEY, merged);
    // Only seed the crash flag if this workspace has never recorded one, so a
    // real pre-upgrade crash (global flag === false) still triggers a restore.
    if (context.workspaceState.get<boolean>(CLEAN_SHUTDOWN_KEY, undefined as any) === undefined) {
      const globalClean = context.globalState.get<boolean>(CLEAN_SHUTDOWN_KEY, true);
      await context.workspaceState.update(CLEAN_SHUTDOWN_KEY, globalClean);
    }
  }

  await context.workspaceState.update(MIGRATED_KEY, true);
}

export async function restoreTerminals(
  context: vscode.ExtensionContext,
  actions: TerminalRestoreActions,
  // The activating window's workspace-folder path (the caller resolves it from
  // `vscode.workspace.workspaceFolders`). Injected rather than read here so this
  // function stays a pure unit of the injected context — no module-global vscode
  // state whose mock another test file could win.
  workspacePath: string | undefined,
): Promise<number> {
  // Mirror `restoreAgentTerminals` (the disk-persist sibling): a folder-less
  // ("empty") window has no stable per-window workspaceState identity across a
  // cold crash+relaunch, and that path bails here too — so prewarm crash-recovery
  // is a deliberate no-op with no workspace folder rather than a best-effort guess.
  if (!workspacePath) return 0;

  await migrateFromGlobalStateOnce(context, workspacePath);

  const cleanShutdown = wasCleanShutdown(context);
  await context.workspaceState.update(CLEAN_SHUTDOWN_KEY, false);
  if (cleanShutdown) {
    // Clean shutdown - clear mappings, don't restore
    await context.workspaceState.update(MAPPINGS_KEY, []);
    return 0;
  }

  const mappings = getMappings(context);
  if (mappings.length === 0) return 0;

  console.log(`[PREWARM] Detected crash - ${mappings.length} terminals to restore`);
  const restorableIds = await actions.listRestorableSessionIds();
  // Only reopen mappings `restoreAgentTerminals` did NOT already restore on this
  // crash. Its debounced store lags the eager prewarm mappings by up to 500ms, so
  // this path exists to catch that residual window — not to double every tab.
  const tracked = actions.trackedKeys();
  let restored = 0;
  for (const mapping of mappings) {
    if (!restorableIds.has(mapping.sessionId)) continue;
    if (tracked.terminalIds.has(mapping.terminalId) || tracked.sessionIds.has(mapping.sessionId)) continue;
    const opened = await actions.openAgentSessionTerminal(context, {
      id: mapping.sessionId,
      shortId: mapping.sessionId.slice(0, 8),
      agent: mapping.agentType,
      cwd: mapping.workingDirectory,
      terminalId: mapping.terminalId,
    });
    if (opened) restored++;
  }
  await context.workspaceState.update(MAPPINGS_KEY, []);
  return restored;
}
