import type { RemoteSession } from './remoteSessions';
import { formatRelativeTime, truncateText } from './utils';

export interface TerminalPickFace {
  description: string;
  detail: string;
  lastActivityMs?: number;
}

/** Go to Terminal's description (last activity) and detail (first ask) for one
 *  tab, from its session's stream row; a tab the stream has not named yet shows
 *  neither. The message count it once showed is not on the row (docs/ARCH.md). */
export function terminalPickFace(
  row: Pick<RemoteSession, 'firstUserMessage' | 'lastActivityMs'> | undefined,
  now: number = Date.now(),
): TerminalPickFace {
  if (!row) return { description: '', detail: '' };
  const detail = row.firstUserMessage ? truncateText(row.firstUserMessage, 80) : '';
  if (row.lastActivityMs <= 0) return { description: '', detail };
  const description = now - row.lastActivityMs < 60_000 ? 'Just now' : formatRelativeTime(row.lastActivityMs);
  return { description, detail, lastActivityMs: row.lastActivityMs };
}
