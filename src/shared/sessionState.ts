// One word for a session's state on every surface (Project panel, session
// sidebar), read from the CLI's own row facts. The CLI decides the
// status (agents-cli SES-18, sessions-cli inferActivity); this only names it.
//
//   status input_required / phase waiting, or an open ask  -> asks     (Asks)
//   an open stall/failure on a live agent                    -> stuck    (Stuck)
//   idle with an open review request (attention `review`)    -> review   (Ready for review)
//   idle: finished its turn, nothing asked                   -> idle     (Idle)
//   idle with background work still pending (subagents,
//     background shells, monitors; the row's `pending`)        -> waiting  (Waiting)
//   running                                                  -> working  (Running)
//   closed, or the process is gone (orphaned, crashed,
//     abandoned, failed): nothing about whether it succeeded -> ended    (Ended)
//   unknown: alive, no transcript the CLI could read          -> unknown  (Running · no transcript)

export type SessionStateKey = 'asks' | 'stuck' | 'review' | 'idle' | 'working' | 'waiting' | 'ended' | 'unknown';

export interface SessionStateFacts {
  phase?: string;
  liveStatus?: string;
  attention?: { kind?: string; state?: string } | null;
  /** An open attention item the caller only knows as present. */
  needsYou?: boolean;
  /** Background work the turn left running (CLI row `pending`); absent on an older CLI. */
  pending?: SessionPending | null;
}

/** One piece of background work still running, as the CLI names it. */
export interface PendingItem {
  id: string;
  description: string;
  startedAtMs?: number;
}

/** The CLI row's `pending`: only work running now. `subAgentCount` is cumulative
 *  and never says whether anything is still running. */
export interface SessionPending {
  subagents?: PendingItem[];
  shells?: PendingItem[];
  monitors?: PendingItem[];
}

/** The three kinds, in the order a hover lists them, with their marks. */
const PENDING_KINDS = [
  { key: 'subagents', mark: '⑂', one: 'subagent', many: 'subagents' },
  { key: 'shells', mark: '▸', one: 'shell', many: 'shells' },
  { key: 'monitors', mark: '◉', one: 'monitor', many: 'monitors' },
] as const;

/** How many of each kind are pending; all zero when the field is absent. */
export function pendingCounts(p: SessionPending | null | undefined): { subagents: number; shells: number; monitors: number; total: number } {
  const n = (xs: unknown) => (Array.isArray(xs) ? xs.length : 0);
  const subagents = n(p?.subagents);
  const shells = n(p?.shells);
  const monitors = n(p?.monitors);
  return { subagents, shells, monitors, total: subagents + shells + monitors };
}

/** "1 shell, 3 subagents": what a Waiting session waits on, in words. */
export function pendingWords(p: SessionPending | null | undefined): string {
  const c = pendingCounts(p);
  return PENDING_KINDS.filter((k) => c[k.key]).map((k) => `${c[k.key]} ${c[k.key] === 1 ? k.one : k.many}`).join(', ');
}

/** One line per pending item ("▸ Poll prod until the run closes · 6m"), for a hover. */
export function pendingLines(p: SessionPending | null | undefined, now: number): string[] {
  const lines: string[] = [];
  for (const k of PENDING_KINDS) {
    for (const it of p?.[k.key] ?? []) {
      const age = it.startedAtMs ? ` · ${agoWords(now - it.startedAtMs)}` : '';
      lines.push(`${k.mark} ${it.description || it.id}${age}`);
    }
  }
  return lines;
}

/** "45s", "6m", "2h", "3d": how long ago, in the fewest characters. */
function agoWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** "now", "6m", "2h", "3d": how long ago `atMs` was, on a card; '' when unknown. */
export function ageWords(atMs: number, now: number): string {
  if (!atMs) return '';
  return now - atMs < 60_000 ? 'now' : agoWords(now - atMs);
}

/** "just now", "12 min ago", "3 hours ago", "2 days ago"; '' when unknown. The
 *  Active Session sidebar's script carries this same function. */
export function relTime(atMs: number, now = Date.now()): string {
  if (!atMs) return '';
  const m = Math.floor((now - atMs) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  const d = Math.floor(h / 24);
  return d + ' day' + (d === 1 ? '' : 's') + ' ago';
}

/** How long a question has waited: "12s", "5m 02s", "18h 4m", "2d 3h". The Project
 *  panel's script carries this same function and ticks it each second. */
export function waitFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  const h = Math.floor(s / 3600);
  return h < 24 ? h + 'h ' + Math.floor((s % 3600) / 60) + 'm' : Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

const SPARK = '▁▂▃▄▅▆▇█';

// On screen they group by who has the ball (owner, 2026-10-13: "11 of 12 Your
// move cards were idle"; only a real ask is your move):
//   Your move — the agent does nothing until you act: a question, a permission,
//               a plan, or a stall or failure the CLI flagged
//   Review    — it finished and asked for a review
//   Idle      — it finished its turn and asked nothing
//   Running   — the agent is working (or alive with no readable transcript), or
//               its turn ended but it waits on its own background work (Waiting)
//   Ended     — the process exited
export type SessionBall = 'move' | 'review' | 'idle' | 'running' | 'ended';

export const BALL_WORD: Record<SessionBall, string> = { move: 'Your move', review: 'Ready for review', idle: 'Idle', running: 'Running', ended: 'Ended' };

export function ballOf(key: SessionStateKey): SessionBall {
  if (key === 'working' || key === 'waiting' || key === 'unknown') return 'running';
  if (key === 'asks' || key === 'stuck') return 'move';
  return key;
}

/** The words a state shows. */
export const SESSION_STATE_WORD: Record<SessionStateKey, string> = {
  asks: 'Asks',
  stuck: 'Blocked',
  review: 'Ready for review',
  idle: 'Idle',
  working: 'Running',
  waiting: 'Running',
  unknown: 'Running · no transcript',
  ended: 'Ended',
};

/** The color a state's dot takes on every surface (a card's group dots, the sidebar's
 *  state line and Related chips): your move amber, running green (waiting on its own
 *  work included: it is the agent's ball; owner video, 2026-10-22 8:50 AM), ready for
 *  review indigo; idle and ended stay quiet. */
export type StateTone = 'move' | 'running' | 'waiting' | 'review' | 'quiet';

export const STATE_TONE: Record<SessionStateKey, StateTone> = {
  asks: 'move',
  stuck: 'move',
  review: 'review',
  idle: 'quiet',
  working: 'running',
  waiting: 'running',
  unknown: 'running',
  ended: 'quiet',
};

/** How soon an ask needs you, as agents-cli computed it on the attention item
 *  (`urgency`). An item from a CLI that does not send it reads as normal. */
export type Urgency = 'urgent' | 'high' | 'normal' | 'low';

const URGENCY_RANK: Record<Urgency, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function urgencyOf(attention: { urgency?: string } | null | undefined): Urgency {
  const u = attention?.urgency;
  return u && u in URGENCY_RANK ? (u as Urgency) : 'normal';
}

export function urgencyRank(u: Urgency): number {
  return URGENCY_RANK[u];
}

const ASK_KINDS = new Set(['question', 'permission', 'plan_review', 'declared']);
const STOPPED_STATUS = new Set(['orphaned', 'crashed', 'abandoned']);

export function sessionStateOf(s: SessionStateFacts): SessionStateKey {
  const open = s.attention?.state === 'open' ? s.attention.kind ?? '' : '';
  const status = (s.liveStatus ?? '').toLowerCase();
  if (ASK_KINDS.has(open) || s.needsYou || s.phase === 'waiting' || status === 'input_required') return 'asks';
  // The process is gone: Ended, whether or not the work succeeded.
  if (STOPPED_STATUS.has(status) || s.phase === 'failed' || s.phase === 'done' || status === 'closed') return 'ended';
  // A live agent the CLI flags as stalled or failed is not progressing: your move.
  if (open === 'stall' || open === 'failure') return 'stuck';
  if (s.phase === 'running') return 'working';
  if (status === 'unknown') return 'unknown';
  // Idle, but a subagent, background shell or monitor it started still runs: the
  // agent has the ball (agents-cli feed `pending`; absent means exactly as before).
  // An absent `pending` is unknown (an older CLI on a peer) and reads as before.
  const idle = status === 'idle' || (!status && s.phase === 'idle');
  if (idle && pendingCounts(s.pending).total > 0) return 'waiting';
  return open === 'review' ? 'review' : 'idle';
}

/** Why the CLI raised an attention row, carried verbatim from the stream
 *  (`RemoteAttention.kind`). The extension classifies nothing. */
type AttentionKind = 'question' | 'permission' | 'plan_review' | 'declared' | 'failure' | 'stall' | 'review';

/** Within one urgency and wait, an interactive hand-back (question, permission,
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

/** The CLI's done-check for a session (agents-cli `doneVerdict` on the row): `done` when
 *  its checks passed, `open` with the gaps that failed, `unchecked` when nothing
 *  checkable backs it. `at` is ISO. Absent on an older CLI: nothing is drawn. */
export interface DoneVerdict {
  state: 'done' | 'open' | 'unchecked';
  gaps: string[];
  at: string;
}

/** Each gap the CLI names, in words; a gap this version does not know shows as the CLI wrote it. */
const DONE_GAP_WORDS: Record<string, string> = {
  'open-pr': 'a PR it opened is still open',
  'keep-moving': 'its checklist has open items',
  delivery: 'merge, release or install not verified',
  'live-team': 'teammates still running',
  'self-audit': 'its own audit failed',
};

function doneGapWords(gaps: readonly string[]): string[] {
  return gaps.map((g) => DONE_GAP_WORDS[g] ?? g);
}

/** What an idle card says in place of "Idle": tone (ok, bad), its word and the tooltip.
 *  Null unless the session is idle (working, waiting, an ask, review and ended keep their
 *  own word) and the CLI judged it done or not done (owner, 2026-10-18 8:59 PM: no second
 *  idle label). An `unchecked` verdict reads plain Idle (owner, 2026-10-19 2:23 AM: 8 of
 *  14 idle cards said "Unverified", which read as an alarm). */
export interface VerdictChip {
  tone: 'ok' | 'bad';
  word: string;
  why: string;
}

export function verdictChipOf(state: SessionStateKey, v: DoneVerdict | null | undefined): VerdictChip | null {
  if (!v || state !== 'idle') return null;
  if (v.state === 'done') return { tone: 'ok', word: '✓ Done', why: 'Idle · its done-check passed' };
  if (v.state === 'open') {
    const gaps = doneGapWords(v.gaps);
    return { tone: 'bad', word: 'Not done', why: gaps.length ? `Idle · not done: ${gaps.join('; ')}` : 'Idle · its done-check did not pass' };
  }
  return null;
}

/** The verdict chip on a card's title row. Self-contained, so the
 *  Active Session sidebar's script carries this same function (`${verdictChipHtml}`). */
export function verdictChipHtml(v: VerdictChip | null | undefined): string {
  if (!v) return '';
  const q = (t: string) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return '<span class="vchip v-' + v.tone + '" title="' + q(v.why) + '">' + q(v.word) + '</span>';
}
