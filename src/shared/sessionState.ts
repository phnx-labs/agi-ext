// One word for a session's state on every surface (Project panel, session
// sidebar), read from the CLI's own row facts. The CLI decides the
// status (agents-cli SES-18, sessions-cli inferActivity); this only names it.
//
//   status input_required / phase waiting, or an open ask  -> asks     (Your move · asks)
//   idle: replied, or an open stall/failure on a live agent  -> yours    (Your move · idle)
//   running                                                  -> working  (Running)
//   closed, or the process is gone (orphaned, crashed,
//     abandoned, failed): nothing about whether it succeeded -> ended    (Ended)
//   unknown: alive, no transcript the CLI could read          -> unknown  (Running · no transcript)

export type SessionStateKey = 'asks' | 'working' | 'yours' | 'ended' | 'unknown';

export interface SessionStateFacts {
  phase?: string;
  liveStatus?: string;
  attention?: { kind?: string; state?: string } | null;
  /** An open attention item the caller only knows as present. */
  needsYou?: boolean;
}

// On screen they collapse to three, by who has the ball (owner, 2026-10-12:
// "how is Needs you different from idle, or from Your turn?"):
//   Your move — the agent does nothing until you act; a tag says why
//               (asks · idle), a question first
//   Running   — the agent is working (or alive with no readable transcript)
//   Ended     — the process exited
export type SessionBall = 'move' | 'running' | 'ended';

export const BALL_WORD: Record<SessionBall, string> = { move: 'Your move', running: 'Running', ended: 'Ended' };

export function ballOf(key: SessionStateKey): SessionBall {
  if (key === 'working' || key === 'unknown') return 'running';
  if (key === 'ended') return 'ended';
  return 'move';
}

/** Why it is your move, as the short tag a row carries; and the order those sort in. */
export const MOVE_REASON: Partial<Record<SessionStateKey, string>> = { asks: 'asks', yours: 'idle' };
const MOVE_RANK: Partial<Record<SessionStateKey, number>> = { asks: 0, yours: 1 };

export function moveRank(key: SessionStateKey): number {
  return MOVE_RANK[key] ?? Number.MAX_SAFE_INTEGER;
}

/** The words a state shows: the ball, plus the reason when it is your move. */
export const SESSION_STATE_WORD: Record<SessionStateKey, string> = {
  asks: 'Your move · asks',
  yours: 'Your move · idle',
  working: 'Running',
  unknown: 'Running · no transcript',
  ended: 'Ended',
};

const ASK_KINDS = new Set(['question', 'permission', 'plan_review', 'declared']);
const STOPPED_STATUS = new Set(['orphaned', 'crashed', 'abandoned']);

export function sessionStateOf(s: SessionStateFacts): SessionStateKey {
  const open = s.attention?.state === 'open' ? s.attention.kind ?? '' : '';
  const status = (s.liveStatus ?? '').toLowerCase();
  if (ASK_KINDS.has(open) || s.needsYou || s.phase === 'waiting' || status === 'input_required') return 'asks';
  // The process is gone: Ended, whether or not the work succeeded.
  if (STOPPED_STATUS.has(status) || s.phase === 'failed' || s.phase === 'done' || status === 'closed') return 'ended';
  // A live agent the CLI flags as stalled or failed is not progressing: your move.
  if (open === 'stall' || open === 'failure') return 'yours';
  if (s.phase === 'running') return 'working';
  if (status === 'unknown') return 'unknown';
  return 'yours';
}

/** Why the CLI raised an attention row, carried verbatim from the stream
 *  (`RemoteAttention.kind`). The extension classifies nothing. */
type AttentionKind = 'question' | 'permission' | 'plan_review' | 'declared' | 'failure' | 'stall' | 'review';

/** Needs-you order on every surface: an interactive hand-back (question, permission,
 *  plan_review, declared) leads, then a hard failure, a stall the CLI detected, and a
 *  review request. */
const ATTENTION_KIND_RANK: Record<AttentionKind, number> = {
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
