import { shellQuote } from './shellQuote';

/** The one-shot fork verb: `agents fork <id> [--device <host>]`. agents-cli
 *  resolves the source cross-fleet and launches a recap-seeded same-harness sibling,
 *  so the extension only presents the command and tracks its terminal. */
export function forkCommand(sessionId: string, host: string | undefined): string {
  const parts = ['agents', 'fork', shellQuote(sessionId)];
  if (host) parts.push('--device', shellQuote(host));
  return parts.join(' ');
}

/** The fork tab's name before the fork has one of its own, and after it failed. */
export function forkTabLabel(sourceTitle: string, failed = false): string {
  return failed ? `fork failed: ${sourceTitle}` : `fork of ${sourceTitle}`;
}

/** Whether a finished shell command in a fork tab is the fork verb failing: its
 *  status is known and nonzero (`wrapNativeAgentCommand` keeps it). */
export function forkFailed(commandLine: string, exitCode: number | undefined): boolean {
  return /(^|\s)agents fork\s/.test(commandLine) && exitCode !== undefined && exitCode !== 0;
}

export interface ForkSessionSource {
  sessionId?: string;
  agentKey?: string;
  /** Device the source session LIVES on; undefined means this machine. */
  host?: string;
}

/**
 * Where the user asked the fork to RUN, when they picked a device explicitly
 * (`Agents: Fork (Pick Host)`). `host: undefined` is a deliberate "run here";
 * passing no target at all leaves the fork on the source session's machine.
 */
export interface ForkSessionTarget {
  host?: string;
}

export type ForkSessionRequest =
  | {
      ok: true;
      sessionId: string;
      agentKey: string;
      /** Device the fork runs on; undefined = this machine. */
      host?: string;
    }
  | { ok: false; reason: 'no_session' | 'no_agent' };

/**
 * The fork's source and placement, without touching the source terminal.
 *
 * With no `target` the fork runs where the session lives (the `Agents: Fork`
 * behavior). With a `target` the user has chosen the device, so that wins; the
 * CLI resolves the source across the fleet either way.
 */
export function buildForkSessionRequest(
  source: ForkSessionSource,
  target?: ForkSessionTarget,
): ForkSessionRequest {
  const sessionId = source.sessionId?.trim();
  if (!sessionId) return { ok: false, reason: 'no_session' };

  const agentKey = source.agentKey?.trim().toLowerCase();
  if (!agentKey) return { ok: false, reason: 'no_agent' };

  const sourceHost = source.host?.trim() || undefined;
  const host = target ? target.host?.trim() || undefined : sourceHost;
  return { ok: true, sessionId, agentKey, host };
}
