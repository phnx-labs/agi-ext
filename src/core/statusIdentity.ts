// Pure logic for the agent status bar's version/account fields. Kept vscode-free
// so it is unit-tested directly (src/core convention). The VS Code layer
// (src/vscode/extension.ts) passes an EditorTerminal, which structurally provides
// these fields.

import { canonicalSessionId } from './canonicalSessionId';

/** The subset of a terminal registry entry the status bar reads for identity. */
export interface StatusIdentitySource {
  /** Session id the version/account below were APPLIED for (the display gate).
   * The version/account come from the broadcast watch row (SessionPresentationStore),
   * not a per-tab CLI fetch (RUSH-3184). A version-only harness (Grok/Cursor/Droid)
   * has this set with a null account, so its version still shows. */
  identityAppliedSessionId?: string;
  version?: string;
  statusVersion?: string;
  account?: string;
  statusAccount?: string;
}

/** The identity fields a stream row carries for a session. Both null when the
 * CLI records no identity (Kimi) or has not indexed it yet. */
export interface StreamIdentity {
  version: string | null;
  account: string | null;
}

/** What the status bar should stamp on a tab from a broadcast watch row.
 * `null` when the row is missing (session not yet indexed) — leave the tab
 * untouched, blank-until-resolved. */
export interface StreamIdentityStamp {
  version: string | null;
  account: string | null;
  identityAppliedSessionId: string;
}

/** Build the complete status-bar label from the session currently bound to a tab. */
export function formatAgentStatusBarText(
  expandedName: string,
  version: string | undefined,
  account: string | undefined,
  label: string | null,
  sessionId: string | undefined,
  showTrackingHint = false,
  host: string | null = null,
): string {
  let text = `Agents: ${expandedName}`;
  if (version) text += ` ${version}`;
  if (account) text += ` <${account}>`;
  if (host) text += ` $(vm) ${host}`;
  if (label) text += ` - ${label}`;
  const displayId = canonicalSessionId(sessionId);
  if (displayId) text += ` $(copy) ${displayId.slice(0, 8)}`;
  else if (showTrackingHint) text += ' (tracking session)';
  return text;
}

/**
 * Decide the version/account to stamp on a tab from its live stream row — the
 * single-stream projection that replaced the per-tab by-id session-detail
 * respawn over `--device <host>` (RUSH-3184). Pure so the no-spawn guarantee is
 * unit-tested directly.
 *
 * Returns null when the session is not on the stream yet (do not stamp; the next
 * stream event retries) OR when the tab has already moved on to another session.
 * Otherwise returns the row's identity AUTHORITATIVELY — a null field CLEARS a
 * value left over from a prior binding in the same terminal, never preserves it.
 */
export function resolveStreamIdentityStamp(
  live: StreamIdentity | undefined,
  liveSessionId: string,
  currentEntrySessionId: string | undefined,
): StreamIdentityStamp | null {
  if (!live) return null;
  if (currentEntrySessionId && currentEntrySessionId !== liveSessionId) return null;
  return {
    version: live.version,
    account: live.account,
    identityAppliedSessionId: liveSessionId,
  };
}

/** Strip angle brackets/whitespace from an account email; empty -> undefined. */
export function normalizeStatusEmail(email: string | null | undefined): string | undefined {
  const trimmed = email?.replace(/[<>]/g, '').trim();
  return trimmed || undefined;
}

export function formatAgentStatusBarTooltip(sessionId?: string, host?: string | null): string {
  const id = canonicalSessionId(sessionId);
  return [
    host ? `Host: ${host}` : null,
    id ? `Session: ${id}` : 'No session ID available',
    id ? 'Click to copy session ID' : null,
  ].filter(Boolean).join('\n');
}

/**
 * The version + account to DISPLAY for the session id currently shown. Only an
 * identity resolved FOR that exact session is returned; a value cached from a
 * prior binding in the same terminal (a rerun, /clear, or shell-adoption that
 * changed the session) is withheld until the current session's identity resolves.
 *
 * This is the guard against the reported bug: a Kimi tab showed a Claude `2.1.218`
 * and a stranger session id because the leftover identity of a previous binding
 * was rendered. Blank-until-resolved beats wrong.
 */
export function displayIdentity(
  entry: StatusIdentitySource | undefined,
  sessionId: string | undefined,
): { version?: string; account?: string } {
  const fresh = !!sessionId && entry?.identityAppliedSessionId === sessionId;
  if (!fresh) return {};
  return {
    version: entry?.version || entry?.statusVersion || undefined,
    account: normalizeStatusEmail(entry?.account || entry?.statusAccount),
  };
}
