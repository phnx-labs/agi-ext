// One word for a session's state on every surface (Project panel, session
// sidebar, Fleet row), read from the CLI's own row facts. The CLI decides the
// status (agents-cli SES-18, sessions-cli inferActivity); this only names it.
//
//   status input_required / phase waiting, or an open ask  -> Needs you
//   orphaned, crashed, abandoned, failed, or an open stall  -> Stopped
//   running                                                  -> Working
//   idle: replied, process waiting for your next message     -> Your turn
//   closed: the process exited, nothing about the work       -> Ended
//   unknown: alive, no transcript the CLI could read          -> Unknown

export type SessionStateKey = 'asks' | 'stopped' | 'working' | 'yours' | 'ended' | 'unknown';

export interface SessionStateFacts {
  phase?: string;
  liveStatus?: string;
  attention?: { kind?: string; state?: string } | null;
  /** An open attention item the caller only knows as a flag (Fleet's `needs`). */
  needsYou?: boolean;
}

export const SESSION_STATE_WORD: Record<SessionStateKey, string> = {
  asks: 'Needs you',
  stopped: 'Stopped',
  working: 'Working',
  yours: 'Your turn',
  ended: 'Ended',
  unknown: 'Unknown',
};

const ASK_KINDS = new Set(['question', 'permission', 'plan_review', 'declared']);
const STOPPED_STATUS = new Set(['orphaned', 'crashed', 'abandoned']);

export function sessionStateOf(s: SessionStateFacts): SessionStateKey {
  const open = s.attention?.state === 'open' ? s.attention.kind ?? '' : '';
  const status = (s.liveStatus ?? '').toLowerCase();
  if (ASK_KINDS.has(open) || s.needsYou || s.phase === 'waiting' || status === 'input_required') return 'asks';
  if (open === 'stall' || open === 'failure' || STOPPED_STATUS.has(status) || s.phase === 'failed') return 'stopped';
  if (s.phase === 'running') return 'working';
  if (s.phase === 'done' || status === 'closed') return 'ended';
  if (status === 'unknown') return 'unknown';
  return 'yours';
}

/** Why the CLI raised an attention row, carried verbatim from the stream
 *  (`RemoteAttention.kind`). The extension classifies nothing. */
export type AttentionKind = 'question' | 'permission' | 'plan_review' | 'declared' | 'failure' | 'stall' | 'review';

/** Needs-you order on every surface: an interactive hand-back (question, permission,
 *  plan_review, declared) leads, then a hard failure, a stall the CLI detected, and a
 *  review request. */
export const ATTENTION_KIND_RANK: Record<AttentionKind, number> = {
  question: 0,
  permission: 1,
  plan_review: 2,
  declared: 3,
  failure: 4,
  stall: 5,
  review: 6,
};

/** A kind's rank; a kind this version does not know, or none, sorts last. */
export function attentionRank(kind: string | undefined | null): number {
  return kind && kind in ATTENTION_KIND_RANK ? ATTENTION_KIND_RANK[kind as AttentionKind] : Number.MAX_SAFE_INTEGER;
}
