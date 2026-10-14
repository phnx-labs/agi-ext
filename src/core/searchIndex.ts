// The one in-memory index ⌘K (`agents.searchSessions`) searches: artifacts,
// sessions, tickets and pull requests, plus a row that hands the words to the
// Lead. Pure: the VS Code side reads `artifacts list --json`, the rendered HTML
// beside each source and `sessions artifacts <id> --json`, and passes the
// results in; nothing here touches the disk or a process.
//
// An artifact names the session that made it, tried in this order:
//   1. link      the `agents://session/<id>` the renderer stamps in the HTML;
//   2. files     the session's own list of files it wrote (`sessions artifacts`);
//   3. worktree  the source sits in `.agents/worktrees/<name>/`, a session's cwd.
//
// Ranking, in every section: an exact id, then a title that starts with the
// query, then a title holding every word, then any other text holding every
// word; recency breaks ties.

export interface ArtifactListEntry {
  id: string;
  sourcePath: string;
  title: string;
  updatedAtMs: number;
}

/** `artifacts list --json`: `{ count, artifacts: [{ id, sourcePath, title, createdAt, updatedAt }] }`. */
export function parseArtifactList(raw: string): ArtifactListEntry[] {
  const env = JSON.parse(raw) as { artifacts?: unknown };
  if (!env || typeof env !== 'object' || !Array.isArray(env.artifacts)) throw new Error('Unexpected artifacts list shape from the CLI');
  return env.artifacts.flatMap((a) => {
    if (!a || typeof a !== 'object') return [];
    const o = a as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const sourcePath = typeof o.sourcePath === 'string' ? o.sourcePath : '';
    if (!id || !sourcePath) return [];
    const at = Date.parse(typeof o.updatedAt === 'string' ? o.updatedAt : typeof o.createdAt === 'string' ? o.createdAt : '');
    return [{ id, sourcePath, title: typeof o.title === 'string' ? o.title.trim() : '', updatedAtMs: Number.isFinite(at) ? at : 0 }];
  });
}

/** Where `artifacts render` writes the page for a source: beside it, or in its `.artifacts/` folder. */
export function renderedHtmlCandidates(sourcePath: string): string[] {
  if (/\.html?$/i.test(sourcePath)) return [sourcePath];
  const dir = sourcePath.replace(/[\\/][^\\/]*$/, '');
  const stem = sourcePath.slice(dir.length + 1).replace(/\.[^.]*$/, '');
  return [`${dir}/${stem}.html`, `${dir}/.artifacts/${stem}.html`];
}

/** A rendered page's `<title>`, without the brand the renderer puts in front ("AGI | …"). */
export function htmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  const t = m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return t.replace(/^[^|]{1,24}\s\|\s+/, '');
}

/** The session id the renderer stamped as the page's provenance, or null. */
export function provenanceSessionId(html: string): string | null {
  return html.match(/agents:\/\/session\/([0-9a-f]{8}(?:-[0-9a-f-]{4,})?)/i)?.[1]?.toLowerCase() ?? null;
}

/** What the extension learned from one rendered page. */
export interface RenderedFacts {
  htmlPath: string;
  title: string;
  sessionId: string | null;
}

type ArtifactLink = 'link' | 'files' | 'worktree';

export interface IndexedArtifact {
  id: string;
  title: string;
  sourcePath: string;
  /** The page to open, when one was rendered; else the source. */
  openPath: string;
  updatedAtMs: number;
  /** The session that made it, and how that was known; absent when nothing says. */
  sessionId?: string;
  link?: ArtifactLink;
}

/** The session fields the index needs. */
export interface IndexedSession {
  sessionId: string;
  host: string;
  title: string;
  /** Other words a match may land on: ticket, PR, branch, model, host, first request. */
  text: string;
  cwd?: string;
  worktreePath?: string;
  lastActivityMs: number;
}

const home = (p: string) => p.replace(/\/+$/, '').replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|~)(?=\/|$)/, '~');

/** The worktree folder a path sits in (`…/.agents/worktrees/<name>`), or ''. */
function worktreeOf(p: string): string {
  return home(p).match(/^(.*\/\.(?:agents|claude)\/worktrees\/[^/]+)/)?.[1] ?? '';
}

/** Join the list, the rendered pages and each session's written files into one artifact index. */
export function indexArtifacts(
  list: ArtifactListEntry[],
  rendered: ReadonlyMap<string, RenderedFacts>,
  sessionFiles: ReadonlyMap<string, readonly string[]>,
  sessions: readonly IndexedSession[],
): IndexedArtifact[] {
  const writer = new Map<string, string>();
  for (const [sid, files] of sessionFiles) for (const f of files) if (!writer.has(home(f))) writer.set(home(f), sid);
  const byWorktree = new Map<string, string>();
  for (const s of [...sessions].sort((a, b) => b.lastActivityMs - a.lastActivityMs)) {
    for (const p of [s.worktreePath, s.cwd]) { const w = p ? worktreeOf(p) : ''; if (w && !byWorktree.has(w)) byWorktree.set(w, s.sessionId); }
  }
  return list.map((a) => {
    const page = rendered.get(a.sourcePath);
    const title = a.title || page?.title || a.sourcePath.split('/').pop() || a.id;
    const base: IndexedArtifact = { id: a.id, title, sourcePath: a.sourcePath, openPath: page?.htmlPath ?? a.sourcePath, updatedAtMs: a.updatedAtMs };
    if (page?.sessionId) return { ...base, sessionId: page.sessionId, link: 'link' };
    const wrote = writer.get(home(a.sourcePath)) ?? (page ? writer.get(home(page.htmlPath)) : undefined);
    if (wrote) return { ...base, sessionId: wrote, link: 'files' };
    const wt = worktreeOf(a.sourcePath);
    const inWt = wt ? byWorktree.get(wt) : undefined;
    if (inWt) return { ...base, sessionId: inWt, link: 'worktree' };
    return base;
  });
}

/** A session id as the index stores it: no `session_` prefix, lowercase. */
const bareId = (id: string) => id.replace(/^session_/, '').toLowerCase();

/** The session an id names: exact, or one whose id and the given id share an
 *  8+ character prefix (a page stamps the short id or the full one). */
export function findSession<T extends { sessionId: string }>(sessions: readonly T[], id: string): T | undefined {
  const want = bareId(id);
  const exact = sessions.find((s) => bareId(s.sessionId) === want);
  if (exact || want.length < 8) return exact;
  return sessions.find((s) => { const have = bareId(s.sessionId); return have.length >= 8 && (have.startsWith(want) || want.startsWith(have)); });
}

/** One searchable row, any kind. */
export interface SearchDoc {
  ids: string[];
  title: string;
  text: string;
  atMs: number;
}

/** Lower is better; null when the row does not match. Empty query: every row, tier 3. */
export function matchTier(doc: SearchDoc, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 3;
  if (doc.ids.some((id) => { const i = id.toLowerCase(); return i === q || (q.length >= 6 && /^[0-9a-f-]+$/.test(q) && i.startsWith(q)); })) return 0;
  const title = doc.title.toLowerCase();
  if (title.startsWith(q)) return 1;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.every((w) => title.includes(w))) return 2;
  const hay = `${title} ${doc.text.toLowerCase()} ${doc.ids.join(' ').toLowerCase()}`;
  if (words.every((w) => hay.includes(w))) return 3;
  return null;
}

/** The rows that match, best first: tier, then newest. */
function rank<T>(rows: readonly T[], doc: (row: T) => SearchDoc, query: string): T[] {
  return rows
    .map((row) => { const d = doc(row); return { row, tier: matchTier(d, query), at: d.atMs }; })
    .filter((x): x is { row: T; tier: number; at: number } => x.tier !== null)
    .sort((a, b) => a.tier - b.tier || b.at - a.at)
    .map((x) => x.row);
}

export interface SearchTicket { identifier: string; title: string; state: string; delegate: string | null; assignee: string | null }
export interface SearchPr { repo: string; number: number; title: string; url: string; author: string; date: string; ciState: string | null; isDraft: boolean }

export interface SearchSections {
  artifacts: { artifact: IndexedArtifact; session: IndexedSession | undefined }[];
  sessions: IndexedSession[];
  tickets: SearchTicket[];
  prs: SearchPr[];
}

/** Every section ranked for a query, each cut to `limit` rows. */
export function searchAll(
  query: string,
  src: { artifacts: readonly IndexedArtifact[]; sessions: readonly IndexedSession[]; tickets: readonly SearchTicket[]; prs: readonly SearchPr[] },
  limit = 8,
): SearchSections {
  const madeBy = (a: IndexedArtifact) => (a.sessionId ? findSession(src.sessions, a.sessionId) : undefined);
  const artifacts = rank(src.artifacts, (a) => {
    const s = madeBy(a);
    return { ids: [a.id, ...(a.sessionId ? [a.sessionId, a.sessionId.slice(0, 8)] : [])], title: a.title, text: `${a.sourcePath} ${s?.title ?? ''}`, atMs: a.updatedAtMs };
  }, query).slice(0, limit).map((artifact) => ({ artifact, session: madeBy(artifact) }));
  const sessions = rank(src.sessions, (s) => ({ ids: [bareId(s.sessionId), bareId(s.sessionId).slice(0, 8)], title: s.title, text: s.text, atMs: s.lastActivityMs }), query).slice(0, limit);
  const tickets = rank(src.tickets, (t) => ({ ids: [t.identifier], title: t.title, text: `${t.state} ${t.delegate ?? ''} ${t.assignee ?? ''}`, atMs: 0 }), query).slice(0, limit);
  const prs = rank(src.prs, (p) => ({ ids: [`#${p.number}`, String(p.number)], title: p.title, text: `${p.repo} ${p.author}`, atMs: Date.parse(p.date) || 0 }), query).slice(0, limit);
  return { artifacts, sessions, tickets, prs };
}

/** The words the "Ask the Lead" row hands over: the query once it has two or more
 *  words (one word is a search, not a sentence); null otherwise. */
export function leadQuery(query: string): string | null {
  const q = query.trim().replace(/\s+/g, ' ');
  return q.split(' ').filter(Boolean).length >= 2 ? q : null;
}
