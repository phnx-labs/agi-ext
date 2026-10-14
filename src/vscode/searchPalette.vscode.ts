// ⌘K (`agents.searchSessions`): VS Code's own QuickPick over one in-memory index
// (src/core/searchIndex.ts). Sections, in order: Artifacts, Sessions, Tickets,
// Pull requests, then a row that hands the words to the Lead. Enter goes to the
// session (an artifact's maker included); an artifact's button opens the page.
//
// The artifact index is cached for the window's life and refreshed in the
// background when the picker opens (at most once a minute): one
// `artifacts list --json`, the first 512 KB of the rendered HTML beside each
// source (read again only when its mtime changes), and `sessions artifacts <id> --json` for this
// machine's sessions whose activity moved. The picker never waits on it: it
// draws what the cache holds and redraws when the refresh lands.
//
// While the query is empty the sections show as headings in `searchAll`'s order.
// Once the user types, VS Code sorts the rows by its own label match and drops
// separators (`sortByLabel` is proposed API, not in 1.85), so the tiered order
// holds only for the empty query, and every row also names its kind.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { runCliArgs } from '../core/agentsBin';
import {
  htmlTitle,
  indexArtifacts,
  leadQuery,
  parseArtifactList,
  provenanceSessionId,
  renderedHtmlCandidates,
  searchAll,
  type ArtifactListEntry,
  type IndexedArtifact,
  type IndexedSession,
  type RenderedFacts,
  type SearchPr,
  type SearchTicket,
} from '../core/searchIndex';
import { agoWords, pendingWords, SESSION_STATE_WORD, sessionStateOf, type SessionStateKey } from '../shared/sessionState';

const FRESH_MS = 60_000;
/** Bytes of a rendered page read for its title and provenance link; both sit near
 *  the top (the link was at most 214 KB in across 744 pages), and pages run to 7 MB. */
export const PAGE_PREFIX_BYTES = 512 * 1024;
/** `sessions artifacts` runs for at most this many of this machine's newest sessions per refresh. */
const SESSION_FILES_MAX = 120;
const CONCURRENCY = 4;
/** The command the Lead client registers; the row shows only when it exists. */
const LEAD_ASK = 'agents.lead.ask';

/** A session row as the palette needs it, with its state for the dot. */
export interface PaletteSession extends IndexedSession {
  state: SessionStateKey;
  /** "Waiting · 1 shell" or "Your move · asks", as on the card. */
  stateWords: string;
  /** Whether `sessions artifacts` can read it: it lives on this machine. */
  local: boolean;
}

export interface PaletteSources {
  sessions: PaletteSession[];
  tickets: SearchTicket[];
  prs: SearchPr[];
  goToSession: (sessionId: string, host: string) => void;
  openTicket: (id: string) => void;
}

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!).catch(() => undefined);
  }));
}

type RunCli = (tool: 'artifacts' | 'sessions', args: string[], opts: { timeout: number; maxBuffer?: number }) => Promise<{ stdout: string }>;

/** The first `bytes` of a file, through a handle: a page is never read whole. */
async function readPrefix(file: string, bytes: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export class ArtifactIndex {
  constructor(private readonly run: RunCli = (tool, args, opts) => runCliArgs(tool, args, opts)) {}
  private list: ArtifactListEntry[] = [];
  private readonly pages = new Map<string, RenderedFacts & { mtimeMs: number }>();
  private readonly files = new Map<string, { at: number; files: string[] }>();
  private refreshedAt = 0;
  private running: Promise<void> | undefined;
  error: string | undefined;
  /** Pages read so far (each a prefix); a test counts them to prove the mtime cache. */
  reads = 0;

  artifacts(sessions: readonly IndexedSession[]): IndexedArtifact[] {
    const fileMap = new Map([...this.files].map(([id, v]) => [id, v.files] as const));
    return indexArtifacts(this.list, this.pages, fileMap, sessions);
  }

  /** Refresh unless fresh; resolves when done. Never throws: a failure is kept in `error`. */
  refresh(sessions: readonly PaletteSession[], force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && Date.now() - this.refreshedAt < FRESH_MS) return Promise.resolve();
    this.running = this.load(sessions)
      .then(() => { this.error = undefined; this.refreshedAt = Date.now(); })
      .catch((e) => { this.error = e instanceof Error ? e.message : String(e); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async load(sessions: readonly PaletteSession[]): Promise<void> {
    const { stdout } = await this.run('artifacts', ['list', '--json'], { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
    this.list = parseArtifactList(stdout);
    await inBatches(this.list, (a) => this.readPage(a.sourcePath));
    const local = sessions.filter((s) => s.local).sort((a, b) => b.lastActivityMs - a.lastActivityMs).slice(0, SESSION_FILES_MAX);
    await inBatches(local.filter((s) => this.files.get(s.sessionId)?.at !== s.lastActivityMs), async (s) => {
      const { stdout: out } = await this.run('sessions', ['artifacts', s.sessionId, '--json'], { timeout: 20_000 });
      const rows = JSON.parse(out) as unknown;
      const paths = Array.isArray(rows) ? rows.flatMap((r) => (r && typeof r === 'object' && typeof (r as { path?: unknown }).path === 'string' ? [(r as { path: string }).path] : [])) : [];
      this.files.set(s.sessionId, { at: s.lastActivityMs, files: paths });
    });
  }

  /** The page rendered for one source: its title and provenance, read again only when it changed. */
  private async readPage(sourcePath: string): Promise<void> {
    for (const htmlPath of renderedHtmlCandidates(sourcePath)) {
      let st: fs.Stats;
      try { st = await fs.promises.stat(htmlPath); } catch { continue; }
      if (!st.isFile()) continue;
      const held = this.pages.get(sourcePath);
      if (held && held.htmlPath === htmlPath && held.mtimeMs === st.mtimeMs) return;
      this.reads++;
      const html = await readPrefix(htmlPath, PAGE_PREFIX_BYTES);
      this.pages.set(sourcePath, { htmlPath, title: htmlTitle(html), sessionId: provenanceSessionId(html), mtimeMs: st.mtimeMs });
      return;
    }
    this.pages.delete(sourcePath);
  }
}

const index = new ArtifactIndex();

export type Item = vscode.QuickPickItem & { go?: () => void; open?: () => void };

const STATE_COLOR: Record<SessionStateKey, string | undefined> = {
  asks: 'charts.yellow', yours: 'charts.orange', working: 'charts.green', waiting: 'charts.blue', unknown: 'charts.green', ended: undefined,
};

function artifactKind(p: string): string {
  if (/\/\.agents\/plans\/|\/plans?\//i.test(p) || /plan/i.test(p.split('/').pop() ?? '')) return 'Plan';
  if (/\/reports?\//i.test(p)) return 'Report';
  return /\.html?$/i.test(p) ? 'Page' : 'Doc';
}

function stateIcon(state: SessionStateKey): vscode.ThemeIcon {
  const color = STATE_COLOR[state];
  return new vscode.ThemeIcon(state === 'ended' ? 'circle-outline' : 'circle-filled', color ? new vscode.ThemeColor(color) : undefined);
}

const OPEN_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open the artifact' };

/** The rows for one query, sectioned: Artifacts, Sessions, Tickets, Pull requests, Lead. */
export function buildItems(query: string, src: PaletteSources, leadReady: boolean, artifacts: readonly IndexedArtifact[], indexError?: string): Item[] {
  const now = Date.now();
  const found = searchAll(query, { artifacts, sessions: src.sessions, tickets: src.tickets, prs: src.prs });
  const items: Item[] = [];
  const section = (label: string, rows: Item[]) => { if (rows.length) items.push({ label, kind: vscode.QuickPickItemKind.Separator }, ...rows); };
  const openFile = (p: string) => () => { void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p)); };
  section('Artifacts', found.artifacts.map(({ artifact: a, session }) => {
    const by = session as PaletteSession | undefined;
    return {
      label: a.title,
      iconPath: new vscode.ThemeIcon('file-text'),
      description: `Artifact · ${artifactKind(a.sourcePath)}${a.updatedAtMs ? ` · ${agoWords(now - a.updatedAtMs)} ago` : ''}`,
      detail: by ? `made by ${by.title} on ${by.host}` : a.sessionId ? `made by session ${a.sessionId.slice(0, 8)}, not in the stream` : a.sourcePath,
      buttons: [OPEN_BUTTON],
      alwaysShow: true,
      go: by ? () => src.goToSession(by.sessionId, by.host) : openFile(a.openPath),
      open: openFile(a.openPath),
    };
  }));
  section('Sessions', found.sessions.map((s) => {
    const p = s as PaletteSession;
    return {
      label: p.title,
      iconPath: stateIcon(p.state),
      description: `Session · ${p.stateWords} · ${p.host}`,
      detail: p.text.split('\n')[0] || undefined,
      alwaysShow: true,
      go: () => src.goToSession(p.sessionId, p.host),
    };
  }));
  section('Tickets', found.tickets.map((t) => ({
    label: t.title,
    iconPath: new vscode.ThemeIcon('issues'),
    description: `Ticket · ${t.identifier} · ${t.state}${t.delegate ? ` · delegated to ${t.delegate}` : ''}`,
    alwaysShow: true,
    go: () => src.openTicket(t.identifier),
  })));
  section('Pull requests', found.prs.map((p) => ({
    label: p.title,
    iconPath: new vscode.ThemeIcon(p.isDraft ? 'git-pull-request-draft' : 'git-pull-request'),
    description: `PR · #${p.number} · ${p.repo.split('/').pop()}${p.ciState === 'SUCCESS' ? ' · checks passed' : p.ciState === 'FAILURE' || p.ciState === 'ERROR' ? ' · checks failing' : ''}`,
    alwaysShow: true,
    go: () => { void vscode.env.openExternal(vscode.Uri.parse(p.url)); },
  })));
  const q = query.trim();
  const ask = leadQuery(query);
  if (ask && leadReady) {
    section('Lead', [{
      label: `Ask the Lead: “${ask}”`,
      iconPath: new vscode.ThemeIcon('comment-discussion'),
      description: 'Lead · sends what you typed; it answers in its overlay',
      alwaysShow: true,
      go: () => { void vscode.commands.executeCommand(LEAD_ASK, ask); },
    }]);
  }
  if (!items.length) items.push({ label: q ? `Nothing matches “${q}”` : 'Nothing to search yet', description: indexError ? `artifacts: ${indexError}` : undefined, alwaysShow: true });
  return items;
}

/** Open the palette. Returns at once; the picker lives until it is accepted or hidden. */
export function openSearchPalette(src: PaletteSources): void {
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = 'Search artifacts, sessions, tickets and pull requests';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  let leadReady = false;
  let open = true;
  const draw = () => { if (open) qp.items = buildItems(qp.value, src, leadReady, index.artifacts(src.sessions), index.error); };
  draw();
  qp.onDidChangeValue(draw);
  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    if (!pick?.go) return;
    qp.hide();
    pick.go();
  });
  qp.onDidTriggerItemButton((e) => { e.item.open?.(); qp.hide(); });
  qp.onDidHide(() => { open = false; qp.dispose(); });
  qp.show();
  void vscode.commands.getCommands(true).then((all) => { leadReady = all.includes(LEAD_ASK); draw(); });
  qp.busy = true;
  void index.refresh(src.sessions).then(() => { if (!open) return; qp.busy = false; draw(); });
}

/** The words a session's state shows in the palette. */
export function paletteStateWords(row: Parameters<typeof sessionStateOf>[0]): string {
  const st = sessionStateOf(row);
  return st === 'waiting' ? `Waiting on ${pendingWords(row.pending)}` : SESSION_STATE_WORD[st];
}
