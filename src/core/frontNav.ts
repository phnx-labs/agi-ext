// The pinned card's ‹ › and Agents: Next Agent That Needs You (owner video, 2026-10-19
// 1:32 AM). Every ordering fact comes from stream rows; the only thing this window
// remembers is which session tabs were in front and when (`FrontHistory`), which is
// UI state and is never sent anywhere.

import type { SessionLike } from './projectPanel';
import type { ArrowMode } from './settings';
import { attentionRank, ballOf, sessionStateOf, urgencyOf, urgencyRank } from '../shared/sessionState';

/** One arrow: the session it fronts and its tooltip, or only a tooltip when there is nowhere to go. */
export interface FrontStep { sessionId?: string; host?: string; tip: string }

/** What the pinned card's arrows do; `off` draws none. */
export interface FrontNav { mode: ArrowMode; prev?: FrontStep; next?: FrontStep }

/** What a window remembers of its front tabs, as the arrows read it. */
export interface FrontMemory {
  /** When the session was last in front; Infinity while it is. */
  seenAt(sessionId: string): number | undefined;
  /** The sessions ‹ returns to, newest first. */
  backTrail(): readonly string[];
}

const TRAIL_MAX = 50;
/** A tab in front for less than this was passed through (a restore, a quick switch): it is
 *  neither seen nor a step Back returns to. */
const DWELL_MS = 1500;

/** A window's own front-tab history: when each session was last in front, and the
 *  trail ‹ walks back, like Back in a browser. */
export class FrontHistory implements FrontMemory {
  private readonly seen = new Map<string, number>();
  private readonly trail: string[] = [];
  private current: string | undefined;
  private since = 0;
  private returning: string | undefined;

  /** The front tab changed; `id` is its session, undefined for a tab with none. */
  front(id: string | undefined, now: number): void {
    if (id === this.current) return;
    const prev = this.current;
    if (prev && now - this.since >= DWELL_MS) {
      this.seen.set(prev, now);
      // ‹ itself is not a step forward, so going back never grows the trail.
      if (!(id && this.returning === id) && this.trail[this.trail.length - 1] !== prev) {
        this.trail.push(prev);
        if (this.trail.length > TRAIL_MAX) this.trail.shift();
      }
    }
    this.returning = undefined;
    this.current = id;
    this.since = now;
  }

  /** ‹ was pressed for `id`: it and every newer step leave the trail. */
  goBack(id: string): void {
    const i = this.trail.lastIndexOf(id);
    if (i >= 0) this.trail.length = i;
    this.returning = id;
  }

  seenAt(id: string): number | undefined {
    return id === this.current ? Infinity : this.seen.get(id);
  }

  backTrail(): readonly string[] {
    return [...this.trail].reverse();
  }
}

function askedAt(r: SessionLike): number {
  const t = r.attention?.state === 'open' && r.attention.openedAt ? Date.parse(r.attention.openedAt) : NaN;
  return Number.isFinite(t) ? t : r.lastActivityMs;
}

/** The next session tab that needs you, after the one in front: an open ask you have
 *  not had in front since it asked (the CLI's urgency, then the longest wait), then a
 *  turn that finished after you last had it in front (newest first), then the rest of
 *  the asking and idle tabs, the one you saw longest ago first. Never one that works
 *  or waits on its own work. */
export function nextNeedsYou(tabs: SessionLike[], frontId: string | null | undefined, memory: FrontMemory, blocked: (r: SessionLike) => boolean = () => false): { row: SessionLike; why: string } | undefined {
  const ball = (r: SessionLike) => (blocked(r) ? 'move' : ballOf(sessionStateOf(r)));
  const others = tabs.filter((r) => r.sessionId !== frontId);
  const asks = others.filter((r) => ball(r) === 'move');
  const calm = others.filter((r) => ball(r) === 'review' || ball(r) === 'idle');
  const seen = (r: SessionLike) => memory.seenAt(r.sessionId) ?? -Infinity;
  const unseenAsks = asks.filter((r) => seen(r) < askedAt(r)).sort((a, b) =>
    urgencyRank(urgencyOf(a.attention)) - urgencyRank(urgencyOf(b.attention)) || askedAt(a) - askedAt(b)
    || attentionRank(a.attention?.kind) - attentionRank(b.attention?.kind));
  if (unseenAsks[0]) return { row: unseenAsks[0], why: 'asks you' };
  const fresh = calm.filter((r) => seen(r) < r.lastActivityMs).sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  if (fresh[0]) return { row: fresh[0], why: 'finished since you looked' };
  const again = [...asks, ...calm].sort((a, b) => seen(a) - seen(b) || (a.tabIndex ?? Infinity) - (b.tabIndex ?? Infinity));
  return again[0] ? { row: again[0], why: 'next in turn' } : undefined;
}

/** The pinned card's arrows. Tab order: the session tabs before and after the front
 *  one, wrapping around. Next that needs you: › is `nextNeedsYou`, ‹ the last session
 *  in front that still has its tab here. `tabs` are this window's session tabs in tab order. */
export function frontNav(mode: ArrowMode, tabs: SessionLike[], front: SessionLike, memory: FrontMemory | undefined, label: (r: SessionLike) => string, blocked?: (r: SessionLike) => boolean): FrontNav {
  if (mode === 'off') return { mode };
  const step = (r: SessionLike | undefined, words: string, none: string): FrontStep => r && r.sessionId !== front.sessionId
    ? { sessionId: r.sessionId, host: r.host, tip: `${words}: tab ${r.tabIndex} · ${label(r)}` }
    : { tip: none };
  if (mode === 'tabs') {
    const at = tabs.findIndex((r) => r.sessionId === front.sessionId);
    if (at < 0) return { mode, prev: { tip: 'No previous tab' }, next: { tip: 'No next tab' } };
    return {
      mode,
      prev: step(tabs[(at - 1 + tabs.length) % tabs.length], 'Previous tab', 'No previous tab'),
      next: step(tabs[(at + 1) % tabs.length], 'Next tab', 'No next tab'),
    };
  }
  const mem = memory ?? new FrontHistory();
  const back = mem.backTrail().map((id) => tabs.find((r) => r.sessionId === id)).find((r) => r && r.sessionId !== front.sessionId);
  const next = nextNeedsYou(tabs, front.sessionId, mem, blocked);
  return {
    mode,
    prev: step(back, 'Back', 'Nothing to go back to'),
    next: step(next?.row, 'Next that needs you', 'Nothing needs you: every other agent is working'),
  };
}
