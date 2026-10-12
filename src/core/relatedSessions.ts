import { extractLinearTicketId } from './utils';
import { sessionStateOf, type SessionStateKey } from '../shared/sessionState';
import type { RemoteSession } from './remoteSessions';

// Sessions to handle together with the one in the sidebar (owner, 2026-10-12:
// "similar tickets or similar sessions, quickly, so I know to take care of them
// together"). A selector over the rows already in the presentation store: no
// process, no fetch, no transcript read. A shared ticket or PR is the strongest
// tie, then the same branch in the same folder, then a similar title or request.

export interface RelatedSession {
  sessionId: string;
  host: string;
  title: string;
  state: SessionStateKey;
  why: string;
}

type Row = Pick<RemoteSession, 'sessionId' | 'host' | 'title' | 'label' | 'topic' | 'cwd' | 'branch' | 'prUrl' | 'lastResponse' | 'lastActivityMs' | 'phase' | 'liveStatus' | 'attention'> & { request?: { headline?: string; kind?: string } | null };

const STOP = new Set(['claude', 'codex', 'agent', 'agents', 'message', 'another', 'prior', 'branch', 'cleanshot', 'check', 'wait', 'tool', 'tools', 'this', 'that', 'with', 'from', 'into', 'have', 'what', 'when', 'your', 'about', 'there', 'their', 'would', 'could', 'should', 'just', 'like', 'make', 'need', 'some', 'them', 'then', 'they', 'will', 'also', 'more', 'only', 'other', 'than', 'were', 'been', 'does', 'session', 'continue']);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SCORE = 1.5;
/** A word in more than this share of the sessions says nothing about any one of them. */
const COMMON_SHARE = 0.12;

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}

function ticketOf(r: Row): string | null {
  return extractLinearTicketId(r.title) || extractLinearTicketId(r.topic) || extractLinearTicketId(r.lastResponse);
}

// What identifies the work: its title and your own request. Not the topic, which
// can be a skill's expanded text (every /continue session would look alike), and
// not a slash command.
const textOf = (r: Row) => [r.title || r.label, r.request && r.request.kind !== 'skill' && r.request.kind !== 'command' ? r.request.headline : ''].filter(Boolean).join(' ');

/** Up to `max` sessions related to `subject`, strongest tie first, each with why. */
export function relatedSessions(subject: Row, rows: readonly Row[], now: number, max = 3): RelatedSession[] {
  const ticket = ticketOf(subject);
  // Words most sessions share (the harness's own boilerplate, the project's name)
  // are noise; similarity counts only the words that set a session apart.
  const docs = rows.map((r) => words(textOf(r)));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) ?? 0) + 1);
  const limit = Math.max(2, rows.length * COMMON_SHARE);
  const telling = (set: Set<string>) => new Set([...set].filter((w) => (df.get(w) ?? 0) <= limit));
  const mine = telling(words(textOf(subject)));
  const scored: { r: Row; score: number; why: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.sessionId === subject.sessionId || seen.has(r.sessionId)) continue;
    if (r.lastActivityMs && now - r.lastActivityMs > WEEK_MS) continue;
    let score = 0;
    let why = '';
    const t = ticketOf(r);
    if (ticket && t === ticket) { score += 5; why = `same ticket ${ticket}`; }
    if (subject.prUrl && r.prUrl === subject.prUrl) { score += 5; why ||= 'same pull request'; }
    if (subject.branch && r.branch === subject.branch && subject.cwd && r.cwd === subject.cwd && !/^(main|master)$/.test(subject.branch)) { score += 3; why ||= `same branch ${subject.branch}`; }
    const theirs = telling(words(textOf(r)));
    if (mine.size && theirs.size) {
      let shared = 0;
      for (const w of mine) if (theirs.has(w)) shared++;
      const jaccard = shared / (mine.size + theirs.size - shared);
      if (shared >= 2 && jaccard >= 0.25) { score += jaccard * 5; why ||= 'similar request'; }
    }
    if (score < MIN_SCORE) continue;
    seen.add(r.sessionId);
    scored.push({ r, score, why });
  }
  scored.sort((a, b) => b.score - a.score || (b.r.lastActivityMs ?? 0) - (a.r.lastActivityMs ?? 0));
  return scored.slice(0, max).map(({ r, why }) => ({
    sessionId: r.sessionId,
    host: r.host,
    title: r.title || r.label || r.topic || r.sessionId.slice(0, 8),
    state: sessionStateOf(r),
    why,
  }));
}
