// Terminal-to-session crash recovery - VS Code integration
// Records which terminal is running which agent session so that, after a
// non-clean shutdown (crash), the extension can reopen and resume them.

import * as vscode from 'vscode';
import {
  PrewarmAgentType,
  TerminalSessionMapping,
} from '../core/prewarm';

// GlobalState keys
const MAPPINGS_KEY = 'prewarm.mappings';
const CLEAN_SHUTDOWN_KEY = 'prewarm.cleanShutdown';

// === Terminal-to-Session Mapping for Crash Recovery ===

/**
 * Get all terminal-session mappings
 */
export function getMappings(context: vscode.ExtensionContext): TerminalSessionMapping[] {
  return context.globalState.get<TerminalSessionMapping[]>(MAPPINGS_KEY, []);
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

  await context.globalState.update(MAPPINGS_KEY, mappings);
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
    await context.globalState.update(MAPPINGS_KEY, mappings);
    console.log(`[PREWARM] Removed mapping: ${terminalId} -> ${removed.sessionId}`);
  }
}

/**
 * Mark clean shutdown (called in deactivate)
 */
export async function markCleanShutdown(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(CLEAN_SHUTDOWN_KEY, true);
  console.log('[PREWARM] Marked clean shutdown');
}

/**
 * Check if last shutdown was clean
 */
function wasCleanShutdown(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(CLEAN_SHUTDOWN_KEY, true);
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

export async function restoreTerminals(
  context: vscode.ExtensionContext,
  actions: TerminalRestoreActions,
): Promise<number> {
  const cleanShutdown = wasCleanShutdown(context);
  await context.globalState.update(CLEAN_SHUTDOWN_KEY, false);
  if (cleanShutdown) {
    // Clean shutdown - clear mappings, don't restore
    await context.globalState.update(MAPPINGS_KEY, []);
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
  await context.globalState.update(MAPPINGS_KEY, []);
  return restored;
}
