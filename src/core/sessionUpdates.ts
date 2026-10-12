// What an agent said about its own work, as the stream carries it: the
// `activity.append` events whose `event` is `status.posted` (an `agents feed post`)
// or `status.blocked` (the agent declaring it cannot go on without you). The
// extension classifies nothing: "blocked" is the agent's own word, and it stands
// until you send a message after it.

export interface SessionUpdate {
  atMs: number;
  title: string;
  detail: string;
  blocked: boolean;
  links: { name: string; href: string }[];
}

type Raw = { event?: unknown; sessionId?: unknown; ts?: unknown; title?: unknown; detail?: unknown; attachments?: unknown };

const POSTS = new Set(['status.posted', 'status.blocked']);
const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** One session's status posts, oldest first. Session ids match with or without the `session_` prefix some harnesses use. */
export function sessionUpdates(events: readonly unknown[], sessionId: string): SessionUpdate[] {
  const want = sessionId.replace(/^session_/, '');
  const out: SessionUpdate[] = [];
  for (const value of events) {
    const e = (value && typeof value === 'object' ? value : {}) as Raw;
    if (!POSTS.has(s(e.event)) || s(e.sessionId).replace(/^session_/, '') !== want) continue;
    const atMs = Date.parse(s(e.ts));
    if (!Number.isFinite(atMs)) continue;
    const links = (Array.isArray(e.attachments) ? e.attachments : [])
      .map((a) => (a && typeof a === 'object' ? a as Record<string, unknown> : {}))
      .filter((a) => s(a.href))
      .map((a) => ({ name: s(a.name) || s(a.href).split('/').pop() || s(a.href), href: s(a.href) }));
    out.push({ atMs, title: s(e.title), detail: s(e.detail), blocked: s(e.event) === 'status.blocked', links });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** The agent's latest post when it says blocked and you have not written since. */
export function blockedUpdate(updates: readonly SessionUpdate[], lastUserAtMs: number | undefined): SessionUpdate | undefined {
  const last = updates[updates.length - 1];
  if (!last || !last.blocked) return undefined;
  return lastUserAtMs && lastUserAtMs > last.atMs ? undefined : last;
}

/** Sessions whose agent says it is blocked, by session id (prefix-free), for the Project panel. */
export function blockedSessions(events: readonly unknown[], lastUserAt: (sessionId: string) => number | undefined): Map<string, SessionUpdate> {
  const ids = new Set<string>();
  for (const value of events) {
    const e = (value && typeof value === 'object' ? value : {}) as Raw;
    if (s(e.event) === 'status.blocked') ids.add(s(e.sessionId).replace(/^session_/, ''));
  }
  const out = new Map<string, SessionUpdate>();
  for (const id of ids) {
    const b = blockedUpdate(sessionUpdates(events, id), lastUserAt(id));
    if (b) out.set(id, b);
  }
  return out;
}
