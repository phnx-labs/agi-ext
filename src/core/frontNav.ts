// Agents: Next Agent That Needs You (owner video, 2026-10-19 1:32 AM). Every ordering fact
// comes from stream rows; the only thing this window remembers is which session tabs were in
// front and when (`FrontHistory`), which is UI state and is never sent anywhere. The pinned
// card has no ‹ › of its own: it follows the front tab (owner video, 2026-11-07 0:04); a
// sideways swipe over it fronts the next that needs you, or back the tab in front before.

import type { SessionLike } from './projectPanel';
import { attentionRank, ballOf, sessionStateOf, urgencyOf, urgencyRank } from '../shared/sessionState';

/** What a window remembers of its front tabs, as Next that needs you reads it. */
export interface FrontMemory {
  /** When the session was last in front; Infinity while it is. */
  seenAt(sessionId: string): number | undefined;
}

/** A tab in front for less than this was passed through (a restore, a quick switch): it is not seen. */
const DWELL_MS = 1500;
/** How many earlier front tabs a swipe back can walk through. */
const TRAIL_MAX = 30;

/** A window's own front-tab history: when each session was last in front. */
export class FrontHistory implements FrontMemory {
  private readonly seen = new Map<string, number>();
  private current: string | undefined;
  private since = 0;
  /** The sessions in front before this one, most recent last, each once. */
  private readonly trail: string[] = [];
  /** The session `back` just picked: when it comes forward, the one it leaves is not pushed,
   *  so swiping back again walks further back instead of bouncing between two. */
  private goingBack: string | undefined;

  /** The front tab changed; `id` is its session, undefined for a tab with none. */
  front(id: string | undefined, now: number): void {
    if (id === this.current) return;
    const prev = this.current;
    if (prev && now - this.since >= DWELL_MS) this.seen.set(prev, now);
    if (prev && (id === undefined || id !== this.goingBack)) {
      const at = this.trail.indexOf(prev);
      if (at >= 0) this.trail.splice(at, 1);
      this.trail.push(prev);
      if (this.trail.length > TRAIL_MAX) this.trail.shift();
    }
    this.goingBack = undefined;
    this.current = id;
    this.since = now;
  }

  /** The session tab in front before this one that `open` still has, walking back one
   *  further on each call; undefined when there is none. */
  back(open: (sessionId: string) => boolean): string | undefined {
    while (this.trail.length) {
      const id = this.trail.pop()!;
      if (id !== this.current && open(id)) { this.goingBack = id; return id; }
    }
    return undefined;
  }

  seenAt(id: string): number | undefined {
    return id === this.current ? Infinity : this.seen.get(id);
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
