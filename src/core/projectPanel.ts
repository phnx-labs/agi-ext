// Pure model + HTML for the Project sidebar panel (PHNX-4289).
// Each section is one CLI read: `agents projects status <name> --json` (Overview),
// `linear tasks --project <linear> --json` (Tickets, and Overview's state bar),
// `agents projects prs list <name> --json` (Pull requests). Sessions come from the
// session stream rows already in the presentation store, filtered on the CLI's
// `confirmedProject`. Parsers fail loud on a shape they do not know;
// the provider turns that into the section's error state, never an empty list.

import { SESSION_STATE_WORD, sessionStateOf, type SessionStateKey } from '../shared/sessionState';
import type { SessionCardFields } from './sessionCardFields';

export interface ProjectRef {
  name: string;
  linearName: string | null;
}

interface Milestone {
  name: string;
  done: number;
  total: number;
  targetDate: string | null;
}

export interface OverviewModel {
  name: string;
  description: string | null;
  done: number;
  total: number;
  inProgress: number;
  milestones: Milestone[];
  nextMilestone: string | null;
  schedule: { kind: string; milestone: string | null; days: number | null } | null;
  running: number;
  idle: number;
  openPrs: number;
  latestRelease: { tag: string; publishedAt: string } | null;
}

interface Ticket {
  identifier: string;
  title: string;
  url: string;
  priority: number;
  milestone: string | null;
  owner: string | null;
}

export interface TicketGroup {
  state: string;
  tickets: Ticket[];
}

interface PrRow {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  ciState: string | null;
  author: string;
  date: string;
}

interface RepoPrs {
  slug: string;
  error: string | null;
  branch: { name: string; ciState: string | null } | null;
  release: { tag: string; npm: string | null; mergesSince: number } | null;
  open: PrRow[];
  merged: PrRow[];
}

export interface PrsModel {
  repos: RepoPrs[];
  partial: boolean;
}

type Json = Record<string, unknown>;

function obj(v: unknown, what: string): Json {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Unexpected ${what} shape from the CLI`);
  return v as Json;
}
function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`Unexpected ${what} shape from the CLI`);
  return v;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** `agents projects status --path <dir> --json`: all-null when no project contains dir. */
export function parseProjectDetection(raw: string): ProjectRef | null {
  const d = obj(JSON.parse(raw), 'project detection');
  const name = str(d.name);
  if (!name) return null;
  const linear = d.linear && typeof d.linear === 'object' ? (d.linear as Json) : null;
  return { name, linearName: str(linear?.name) };
}

/** `agents projects list --json`. */
export function parseProjectList(raw: string): ProjectRef[] {
  return arr(JSON.parse(raw), 'project list').map((p) => {
    const d = obj(p, 'project');
    const name = str(d.name);
    if (!name) throw new Error('Unexpected project shape from the CLI');
    const linear = d.linear && typeof d.linear === 'object' ? (d.linear as Json) : null;
    return { name, linearName: str(linear?.name) };
  });
}

/** `agents projects status <name> --json` prints a one-element card array. */
export function parseOverview(raw: string): OverviewModel {
  const cards = arr(JSON.parse(raw), 'project status');
  if (cards.length !== 1) throw new Error(`Expected one project card, got ${cards.length}`);
  const c = obj(cards[0], 'project card');
  const linear = c.linear && typeof c.linear === 'object' ? (c.linear as Json) : null;
  const milestones: Milestone[] = linear
    ? arr(linear.milestones ?? [], 'milestones').map((m) => {
        const d = obj(m, 'milestone');
        return { name: str(d.name) ?? '(unnamed)', done: num(d.done), total: num(d.total), targetDate: str(d.targetDate) };
      })
    : [];
  const next = linear?.nextMilestone && typeof linear.nextMilestone === 'object' ? (linear.nextMilestone as Json) : null;
  const sched = c.schedule && typeof c.schedule === 'object' ? (c.schedule as Json) : null;
  const status = c.byStatus && typeof c.byStatus === 'object' ? (c.byStatus as Json) : {};
  const rel = c.latestRelease && typeof c.latestRelease === 'object' ? (c.latestRelease as Json) : null;
  return {
    name: str(c.name) ?? '(unnamed)',
    description: str(c.description),
    done: num(linear?.done),
    total: num(linear?.total),
    inProgress: num(linear?.inProgress),
    milestones,
    nextMilestone: str(next?.name),
    schedule: sched && str(sched.kind)
      ? { kind: str(sched.kind)!, milestone: str(sched.milestone), days: typeof sched.days === 'number' ? sched.days : null }
      : null,
    running: num(status.running),
    idle: num(status.idle),
    openPrs: Array.isArray(c.openPrs) ? c.openPrs.length : 0,
    latestRelease: rel && str(rel.tag) ? { tag: str(rel.tag)!, publishedAt: str(rel.publishedAt) ?? '' } : null,
  };
}

const STATE_ORDER: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, triage: 3 };

/** `linear tasks --project <name> --json`: open issues, grouped Doing → Todo → Backlog. */
export function parseTickets(raw: string): TicketGroup[] {
  const issues = arr(obj(JSON.parse(raw), 'linear tasks').issues, 'linear issues');
  const groups = new Map<string, { order: number; tickets: Ticket[] }>();
  for (const i of issues) {
    const d = obj(i, 'linear issue');
    const state = obj(d.state, 'issue state');
    const stateName = str(state.name) ?? '(no state)';
    const order = STATE_ORDER[str(state.type) ?? ''] ?? 9;
    const ms = d.projectMilestone && typeof d.projectMilestone === 'object' ? (d.projectMilestone as Json) : null;
    const delegate = d.delegate && typeof d.delegate === 'object' ? (d.delegate as Json) : null;
    const assignee = d.assignee && typeof d.assignee === 'object' ? (d.assignee as Json) : null;
    const ticket: Ticket = {
      identifier: str(d.identifier) ?? '?',
      title: str(d.title) ?? '',
      url: str(d.url) ?? '',
      priority: num(d.priority),
      milestone: str(ms?.name),
      owner: str(delegate?.name) ?? str(assignee?.name),
    };
    const g = groups.get(stateName) ?? { order, tickets: [] };
    g.tickets.push(ticket);
    groups.set(stateName, g);
  }
  // Linear priority: 1 urgent … 4 low, 0 none (sorts last).
  const rank = (p: number) => (p === 0 ? 5 : p);
  return [...groups.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([state, g]) => ({ state, tickets: g.tickets.sort((x, y) => rank(x.priority) - rank(y.priority)) }));
}

const MERGED_SHOWN = 5;

function prRow(p: unknown, dateKey: 'createdAt' | 'mergedAt'): PrRow {
  const d = obj(p, 'pull request');
  const author = d.author && typeof d.author === 'object' ? (d.author as Json) : {};
  return {
    number: num(d.number),
    title: str(d.title) ?? '',
    url: str(d.url) ?? '',
    isDraft: d.isDraft === true,
    ciState: str(d.ciState),
    author: str(author.login) ?? '?',
    date: str(d[dateKey]) ?? '',
  };
}

/** `agents projects prs list <name> --json` (the AGI Menu contract shape). */
export function parsePrs(raw: string): PrsModel {
  const env = obj(JSON.parse(raw), 'project prs');
  const repos = arr(env.repositories, 'repositories').map((r): RepoPrs => {
    const d = obj(r, 'repository');
    const branch = d.defaultBranch && typeof d.defaultBranch === 'object' ? (d.defaultBranch as Json) : null;
    const rel = d.release && typeof d.release === 'object' ? (d.release as Json) : null;
    const npm = rel?.npm && typeof rel.npm === 'object' ? (rel.npm as Json) : null;
    return {
      slug: str(d.slug) ?? '?',
      error: str(d.error),
      branch: branch && str(branch.name) ? { name: str(branch.name)!, ciState: str(branch.ciState) } : null,
      release: rel && str(rel.latestTag) ? { tag: str(rel.latestTag)!, npm: str(npm?.version), mergesSince: num(rel.mergesSince) } : null,
      open: arr(d.pullRequests ?? [], 'pullRequests').map((p) => prRow(p, 'createdAt')),
      merged: arr(d.recentlyMerged ?? [], 'recentlyMerged').slice(0, MERGED_SHOWN).map((p) => prRow(p, 'mergedAt')),
    };
  });
  // Repos with open work first; quiet repos keep the CLI's order after them.
  repos.sort((a, b) => Number(b.open.length > 0) - Number(a.open.length > 0));
  return { repos, partial: env.partial === true };
}

// ── Sessions (from stream rows) ───────────────────────────────────────────

/** The stream-row fields a session card draws; a subset of RemoteSession. */
export interface SessionLike {
  sessionId: string;
  host: string;
  title: string;
  label: string;
  topic: string;
  phase: 'running' | 'idle' | 'waiting' | 'failed' | 'done';
  liveStatus: string;
  attention?: { kind: string; state: string; question?: { text?: string } };
  question?: { text?: string } | null;
  request?: { headline?: string; attachments?: { kind: string; name: string }[] };
  timeline?: { steps: { text: string }[] };
  lastResponse: string;
  activity: string;
  ticket: string | null;
  prStatus?: { number: number; checks?: 'passing' | 'failing' | 'pending'; isDraft: boolean; state?: string };
  branch?: string;
  worktreeSlug?: string;
  files?: { total: number };
  viewingIn?: string;
  /** The CLI's context for the session: terminal, headless, teams, cloud, recent. */
  context?: string;
  /** attached | background | parked, from the CLI; absent off that axis. */
  presence?: string;
  /** 'inactive' for an ended session the CLI listed as previous. */
  state?: string;
  /** A tab in this window is bound to the session (it may be a shell the agent left). */
  tabHere?: boolean;
  /** That tab's 1-based position in its editor group, when this window holds one. */
  tabIndex?: number;
  /** The terminal app the process runs under ("ghostty"); never the machine. */
  terminalApp?: string;
  /** Tabs on any machine showing the session, with the workspace their window has open. */
  observers?: { device: string; viewingIn: string; workspaceDir: string }[];
  startedAtMs?: number;
  resumable?: boolean;
  lastActivityMs: number;
  confirmedProject: string | null;
}

/** An image the user pasted into the session's request, resolved on this machine. */
export interface CardThumb {
  uri: string;
  path: string;
  label: string;
}

/** Where a live session runs: in an editor tab you attached to, or in the background
 *  (a headless run, a team member, a cloud task, or a session you sent to the background). */
export function backgroundKind(s: Pick<SessionLike, 'context' | 'presence'>): string | null {
  if (s.presence === 'background' || s.presence === 'parked') return 'background';
  if (s.context === 'teams') return 'team';
  if (s.context === 'cloud') return 'cloud';
  if (s.context === 'headless' || (!s.context && !s.presence)) return 'headless';
  return null;
}

/** One row per session id: a live row wins over its ended or previous twin. */
export function preferLive<T extends { sessionId: string; phase?: string; liveStatus?: string; state?: string }>(rows: T[]): T[] {
  const ended = (r: T) => r.state === 'inactive' || r.phase === 'done' || r.liveStatus === 'closed';
  const best = new Map<string, T>();
  for (const r of rows) {
    const held = best.get(r.sessionId);
    if (!held || (ended(held) && !ended(r))) best.set(r.sessionId, r);
  }
  return rows.filter((r) => best.get(r.sessionId) === r);
}

/** The project's sessions, newest first. */
export function projectSessions<T extends Pick<SessionLike, 'confirmedProject' | 'lastActivityMs'>>(rows: T[], project: string): T[] {
  const want = project.toLowerCase();
  return rows
    .filter((r) => (r.confirmedProject || '').toLowerCase() === want)
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

function relAge(ms: number, now: number): string {
  if (!ms) return '';
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

// ── HTML ──────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** Small line icons (16px box, currentColor). Each use carries a title with the words. */
const ICON: Record<string, string> = {
  pr: '<path d="M5 3.5v9M11 12.5V7a2 2 0 0 0-2-2H7" /><circle cx="5" cy="3" r="1.3"/><circle cx="5" cy="13" r="1.3"/><circle cx="11" cy="13" r="1.3"/><path d="M8.5 3.5 7 5l1.5 1.5"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.1"/><path d="m3 12 3.5-3.5 2.5 2.5 2-2 2.5 2.5"/>',
  file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
  host: '<rect x="2.5" y="3" width="11" height="7.5" rx="1"/><path d="M6 13.5h4M8 10.5v3"/>',
  ticket: '<path d="M2.5 5.5V4h11v1.5a1.5 1.5 0 0 0 0 3V10h-11V8.5a1.5 1.5 0 0 0 0-3Z"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  you: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.8-2.4 2.7-3.5 5-3.5s4.2 1.1 5 3.5"/>',
  agent: '<rect x="3" y="4" width="10" height="8" rx="2"/><path d="M6 8h.01M10 8h.01M8 2v2"/>',
  run: '<path d="M4 6l2.5 2L4 10M8 10.5h4"/>',
  branch: '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5v6M11 7.5c0 2-2 2.5-6 3.5"/>',
};
function icon(name: string, title: string): string {
  return `<svg class="ic" viewBox="0 0 16 16" role="img" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title>${ICON[name]}</svg>`;
}

function prMini(pr: NonNullable<SessionLike['prStatus']>): string {
  const tone = pr.state === 'merged' ? 'ok' : pr.isDraft ? 'draft' : pr.checks === 'passing' ? 'ok' : pr.checks === 'failing' ? 'bad' : 'run';
  const words = pr.state === 'merged' ? 'merged' : pr.isDraft ? 'draft' : pr.checks === 'passing' ? 'ready to merge' : pr.checks === 'failing' ? 'checks failing' : 'checks running';
  return `<span class="chip pr-${tone}" title="PR #${pr.number}: ${words}">${icon('pr', `PR #${pr.number}: ${words}`)}#${pr.number}</span>`;
}

/** A live tool call reads as what it runs, not as a "Tool: args" label: a shell
 *  command as `$ cmd`, any other tool as its name with its argument dimmed. */
const TOOL_LINE = /^([A-Z][\w.-]{0,30}|exec_command|run_terminal_cmd):\s*(.*)$/;

export function activityLine(activity: string): string {
  const flat = activity.replace(/\s+/g, ' ').trim();
  const m = flat.match(TOOL_LINE);
  if (!m) return escapeHtml(flat);
  const [, tool, arg] = m;
  return /^(bash|shell|exec|exec_command|run_terminal_cmd)$/i.test(tool)
    ? `<span class="cmd">$ ${escapeHtml(arg)}</span>`
    : `<span class="tool">${escapeHtml(tool)}</span> <span class="cmd">${escapeHtml(arg)}</span>`;
}

/** Markdown links read as their words; the rest is flattened to one line. */
function plain(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]*(?:\)|$)/g, '$1').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
}

/** What the agent last said in its own words: the newest timeline step, else its reply. */
function agentLine(s: SessionLike): string {
  const steps = s.timeline?.steps ?? [];
  return plain(steps.length ? steps[steps.length - 1].text : s.lastResponse || '');
}

// ── Session list: place, outputs, grouping ────────────────────────────────

type SessionGroupBy = 'app' | 'machine' | 'state' | 'none';
type SessionSort = 'last' | 'newest' | 'name';

/** What the viewer chose in the ⇅ menu, plus folded groups and sessions they hid
 *  (each hidden until it moves past the activity it had when hidden). */
export interface SessionListPrefs {
  group: SessionGroupBy;
  sort: SessionSort;
  showLeftover: boolean;
  showEnded: boolean;
  folded: string[];
  hidden: Record<string, number>;
}

export const DEFAULT_SESSION_PREFS: SessionListPrefs = { group: 'app', sort: 'last', showLeftover: true, showEnded: false, folded: [], hidden: {} };

const GROUPS: readonly SessionGroupBy[] = ['app', 'machine', 'state', 'none'];
const SORTS: readonly SessionSort[] = ['last', 'newest', 'name'];

/** A stored preference object, keeping only values this version knows. */
export function readSessionPrefs(v: unknown): SessionListPrefs {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const hidden: Record<string, number> = {};
  if (o.hidden && typeof o.hidden === 'object') {
    for (const [id, ms] of Object.entries(o.hidden as Record<string, unknown>)) if (typeof ms === 'number') hidden[id] = ms;
  }
  return {
    group: GROUPS.includes(o.group as SessionGroupBy) ? (o.group as SessionGroupBy) : DEFAULT_SESSION_PREFS.group,
    sort: SORTS.includes(o.sort as SessionSort) ? (o.sort as SessionSort) : DEFAULT_SESSION_PREFS.sort,
    showLeftover: typeof o.showLeftover === 'boolean' ? o.showLeftover : DEFAULT_SESSION_PREFS.showLeftover,
    showEnded: typeof o.showEnded === 'boolean' ? o.showEnded : DEFAULT_SESSION_PREFS.showEnded,
    folded: Array.isArray(o.folded) ? o.folded.filter((k): k is string => typeof k === 'string') : [],
    hidden,
  };
}

/** This window, as the list needs it: the machine it runs on, the workspace it has
 *  open, which editor it is, and the app icons it can draw. */
export interface SessionHere {
  device: string;
  /** The `host` the presentation store gives sessions on this machine. */
  localHost: string;
  workspace: string;
  /** The folder names this window has open; a tab in one of them is this window. */
  folders?: string[];
  editor: 'vscodium' | 'vscode' | 'cursor';
  editorName: string;
  icons: Partial<Record<'vscodium' | 'vscode' | 'cursor' | 'ghostty', string>>;
}

type PlaceKind = 'here' | 'window' | 'ghostty' | 'terminal' | 'background' | 'leftover' | 'ended';

/** Where a session lives, said the way the list groups it. */
export interface SessionPlace {
  kind: PlaceKind;
  /** Group key under Group by App ("here", "window:agents-cli", "ghostty", …). */
  key: string;
  /** Group heading: a workspace or app name. */
  name: string;
  /** Second word on the heading ("VSCodium", "zion"). */
  sub: string;
  /** "m5 · tab 32" on the card. */
  where: string;
  device: string;
}

const shortDevice = (d: string) => d.replace(/^yosemite-/, '');
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export function sessionPlace(s: SessionLike, here: SessionHere): SessionPlace {
  const state = sessionStateOf(s);
  const device = s.host === here.localHost ? here.device : s.host;
  const mine = (o: { device: string }) => o.device.toLowerCase() === here.device.toLowerCase();
  const observerHere = (s.observers ?? []).filter(mine);
  const ours = new Set([here.workspace, ...(here.folders ?? [])]);
  const editorTab = observerHere.find((o) => o.workspaceDir && !/ghostty/i.test(o.viewingIn) && !ours.has(baseName(o.workspaceDir)));
  const ghosttyTab = observerHere.find((o) => /ghostty/i.test(o.viewingIn));
  const tabOf = (words: string) => Number(words.match(/tab (\d+)/i)?.[1]) || null;
  const tab = s.tabIndex ?? (editorTab ? tabOf(editorTab.viewingIn) : null);
  const where = [shortDevice(device), tab ? `tab ${tab}` : ''].filter(Boolean).join(' · ');
  const place = (kind: PlaceKind, key: string, name: string, sub: string, w = where): SessionPlace => ({ kind, key, name, sub, where: w, device });
  if (state === 'ended') return s.tabHere ? place('leftover', 'leftover', 'Tabs with no agent', here.workspace) : place('ended', 'ended', 'Ended', '');
  if (s.tabHere) return place('here', 'here', here.workspace, `${here.editorName} · this window`);
  if (editorTab) { const ws = baseName(editorTab.workspaceDir); return place('window', `window:${ws}`, ws, here.editorName); }
  if (ghosttyTab || /ghostty/i.test(s.terminalApp ?? '')) return place('ghostty', 'ghostty', 'Ghostty', shortDevice(device));
  const bg = backgroundKind(s);
  if (bg) return place('background', 'background', 'Background', '', [shortDevice(device), bg].join(' · '));
  return place('terminal', 'terminal', 'Other terminals', '');
}

/** What the agent made, grouped the way a person looks for it: PRs, the ticket,
 *  then one entry per folder of artifacts with its images. Built from the same
 *  fields the session sidebar draws (`sessionCardFields`). */
export interface SessionMade {
  prs: { label: string; url: string }[];
  ticket: string | null;
  folders: { name: string; display: string; files: { name: string; path: string }[]; images: { name: string; path: string; uri: string }[] }[];
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;

export function sessionMade(card: Pick<SessionCardFields, 'artifacts' | 'plan' | 'pullRequests' | 'linearIssue'>): SessionMade {
  const byDir = new Map<string, SessionMade['folders'][number]>();
  const files = [...card.artifacts.map((a) => ({ path: a.path, name: a.basename, display: a.display, uri: a.uri })),
    ...(card.plan && !card.artifacts.some((a) => a.path === card.plan!.path) ? [{ path: card.plan.path, name: baseName(card.plan.path), display: card.plan.display, uri: undefined }] : [])];
  for (const f of files) {
    const dir = f.path.replace(/[\\/][^\\/]*$/, '');
    const folder = byDir.get(dir) ?? { name: baseName(dir), display: f.display.replace(/[\\/][^\\/]*$/, ''), files: [], images: [] };
    if (IMAGE_FILE.test(f.name) && f.uri) folder.images.push({ name: f.name, path: f.path, uri: f.uri });
    else folder.files.push({ name: f.name, path: f.path });
    byDir.set(dir, folder);
  }
  return {
    prs: (card.pullRequests ?? []).map((p) => ({ label: `${p.ownerRepo.split('/').pop()} #${p.number}`, url: p.url })),
    ticket: card.linearIssue ?? null,
    folders: [...byDir.values()],
  };
}

export interface SessionListOptions {
  selectedId: string | null;
  here: SessionHere;
  prefs: SessionListPrefs;
  thumbsFor?: (s: SessionLike) => CardThumb[];
  madeFor?: (s: SessionLike) => SessionMade | null;
}

const ACT_ICON = {
  focus: '<path d="M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5 7.5 8.5"/>',
  resume: '<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  hide: '<path d="M2.5 8S4.5 4.5 8 4.5 13.5 8 13.5 8 11.5 11.5 8 11.5 2.5 8 2.5 8z"/><path d="M3.5 12.5l9-9"/>',
  sort: '<path d="M5 3v10M3 11l2 2 2-2M11 13V3M9 5l2-2 2 2"/>',
  folder: '<path d="M2 4.5h4l1.2 1.3H14v6.7H2z"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/>',
  cloud: '<path d="M4.5 12h7a2.5 2.5 0 0 0 .3-5A3.5 3.5 0 0 0 5 6.5 2.75 2.75 0 0 0 4.5 12z"/>',
  machine: '<rect x="2.5" y="3" width="11" height="7.5" rx="1"/><path d="M6 13.5h4M8 10.5v3"/>',
  state: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/>',
};
function glyph(name: keyof typeof ACT_ICON, cls = 'ic'): string {
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${ACT_ICON[name]}</svg>`;
}

function placeIcon(p: SessionPlace, here: SessionHere): string {
  const img = (key: keyof SessionHere['icons'], alt: string) => here.icons[key] ? `<img class="appic" src="${escapeHtml(here.icons[key]!)}" alt="${escapeHtml(alt)}">` : '';
  if (p.kind === 'here' || p.kind === 'window') return img(here.editor, here.editorName) || glyph('terminal', 'gi');
  if (p.kind === 'ghostty') return img('ghostty', 'Ghostty') || glyph('terminal', 'gi');
  if (p.kind === 'background') return glyph('cloud', 'gi');
  return glyph('terminal', 'gi');
}

/** The one line a compact card shows: what it asks you, else the agent's latest words. */
function cardLine(s: SessionLike, state: SessionStateKey): string {
  if (state === 'asks') return plain(s.question?.text || s.attention?.question?.text || '') || agentLine(s);
  return agentLine(s) || (s.request?.headline ? plain(s.request.headline) : '');
}

export function renderSessionCard(s: SessionLike, place: SessionPlace, now: number, opts: { selected: boolean; pinned: boolean; thumbs: CardThumb[]; made: SessionMade | null; here: SessionHere }): string {
  const state = sessionStateOf(s);
  const title = plain(s.title || s.topic || s.label || s.request?.headline || 'Untitled');
  const asked = s.request?.headline ? plain(s.request.headline) : '';
  const question = state === 'asks' ? plain(s.question?.text || s.attention?.question?.text || '') : '';
  const said = agentLine(s);
  const live = state === 'working' && s.activity && !said.startsWith(plain(s.activity).slice(0, 40)) ? s.activity : '';
  const line = cardLine(s, state);
  const made = opts.made;
  const where = opts.pinned && (place.kind === 'here' || place.kind === 'window') ? `${place.name} · ${place.where}` : opts.pinned && place.kind === 'ghostty' ? 'Ghostty' : place.where;
  const busy = state === 'working' || state === 'asks';
  const hasTab = place.kind === 'here' || place.kind === 'leftover';
  const go = state === 'ended'
    ? (s.resumable === false ? '' : `<button class="act" data-act="resume" title="Resume the agent${hasTab ? ' in its tab' : ''}">${glyph('resume')}</button>`)
    : `<button class="act" data-act="focus" title="Focus ${escapeHtml(place.kind === 'here' ? (s.tabIndex ? `tab ${s.tabIndex} in this window` : 'its tab in this window') : place.kind === 'window' ? `its tab in ${place.name}` : place.kind === 'ghostty' ? 'its Ghostty window' : 'it')}">${glyph('focus')}</button>`;
  const x = hasTab
    ? `<button class="act x" data-act="close" title="Close the tab">${glyph('close')}</button>`
    : `<button class="act x" data-act="hide" title="Hide until it does something new">${glyph('hide')}</button>`;
  const prChip = s.prStatus ? prMini(s.prStatus) : '';
  const ticketChip = (made?.ticket ?? s.ticket) ? `<span class="chip">${icon('ticket', made?.ticket ?? s.ticket ?? '')}${escapeHtml(made?.ticket ?? s.ticket ?? '')}</span>` : '';
  const folders = made?.folders ?? [];
  const outImages = folders.flatMap((f) => f.images);
  const tiny = [
    ...opts.thumbs.slice(0, 1).map((t) => `<img class="tiny in" src="${escapeHtml(t.uri)}" alt="${escapeHtml(t.label)}" title="Attached by you">`),
    ...outImages.slice(0, 2).map((i) => `<img class="tiny" src="${escapeHtml(i.uri)}" alt="${escapeHtml(i.name)}" title="Made by the agent: ${escapeHtml(i.name)}">`),
  ].join('');
  const strip = [prChip, ticketChip, folders.length ? `<span class="chip" title="${folders.length} artifact folder${folders.length > 1 ? 's' : ''}">${glyph('folder')}${folders.length}</span>` : '', tiny].join('');
  const shown = opts.thumbs.slice(0, 3);
  const more = opts.thumbs.length - shown.length;
  const prs = made?.prs.length ? made.prs.map((p) => `<a class="chip" href="#" data-url="${escapeHtml(p.url)}">${icon('pr', p.label)}${escapeHtml(p.label)}</a>`).join('') : prChip;
  const madeBlock = (prs || ticketChip || folders.length) ? `<div class="lab">Made</div><div class="made">${prs || ticketChip ? `<div class="chips">${prs}${ticketChip}</div>` : ''}${folders.slice(0, 4).map((f) => `
      <a class="folder" href="#" data-artifact="${escapeHtml((f.files[0] ?? f.images[0]).path)}" title="${escapeHtml(f.display)}">${glyph('folder')}<span class="fx"><span><b>${escapeHtml(f.name)}/</b> · ${escapeHtml([...f.files, ...f.images].slice(0, 3).map((x) => x.name).join(', '))}${f.files.length + f.images.length > 3 ? ' …' : ''}</span><span class="fp">${escapeHtml(f.display)}</span></span></a>${f.images.length ? `<span class="thumbs">${f.images.slice(0, 3).map((i) => `<a class="th" href="#" data-artifact="${escapeHtml(i.path)}" title="${escapeHtml(i.name)}"><img src="${escapeHtml(i.uri)}" alt="${escapeHtml(i.name)}"></a>`).join('')}${f.images.length > 3 ? `<span class="more">+${f.images.length - 3}</span>` : ''}</span>` : ''}`).join('')}</div>` : '';
  return `<div class="card st-${state}${opts.selected ? ' sel' : ''}" tabindex="0" data-session="${escapeHtml(s.sessionId)}" data-host="${escapeHtml(s.host)}" data-busy="${busy ? 1 : 0}" data-tab="${hasTab ? 1 : 0}" data-title="${escapeHtml(title)}">
    <div class="top"><span class="ttl">${escapeHtml(title)}</span><span class="age">${relAge(s.lastActivityMs, now)}</span><span class="acts">${go}${x}</span></div>
    <div class="meta"><span class="pill st-${state}"><i></i>${SESSION_STATE_WORD[state]}</span><span class="where">${escapeHtml(where)}</span></div>
    <div class="compact">${line ? `<div class="cline">${escapeHtml(line)}</div>` : ''}${strip ? `<div class="cstrip">${strip}</div>` : ''}</div>
    <div class="full">
      ${asked && asked !== title ? `<div class="lab">You</div><div class="line">${escapeHtml(asked)}</div>` : ''}
      ${shown.length ? `${asked && asked !== title ? '' : '<div class="lab">You</div>'}<span class="thumbs">${shown.map((t, i) => `<a class="th in" href="#" data-path="${escapeHtml(t.path)}" title="Attached by you: ${escapeHtml(t.label)}"><img src="${escapeHtml(t.uri)}" alt="${escapeHtml(t.label)}"><i>attached</i>${i === shown.length - 1 && more > 0 ? `<b>+${more}</b>` : ''}</a>`).join('')}</span>` : ''}
      ${question ? `<div class="lab">Agent · waiting on you</div><div class="ask">${escapeHtml(question)}</div>` : said ? `<div class="lab">Agent</div><div class="line said">${escapeHtml(said)}</div>` : ''}
      ${live ? `<div class="line live">${activityLine(live)}</div>` : ''}
      ${madeBlock}
    </div>
  </div>`;
}

const STATE_ORDER_KEYS: SessionStateKey[] = ['working', 'yours', 'stopped', 'unknown', 'ended'];
const PLACE_ORDER: Record<PlaceKind, number> = { here: 0, window: 1, ghostty: 2, terminal: 3, background: 4, leftover: 5, ended: 6 };
const DOT_TONE: Record<SessionStateKey, string> = { asks: 'asks', working: 'working', yours: 'yours', stopped: 'stopped', unknown: 'unknown', ended: 'ended' };

/** What the list keeps after the viewer's Show choices and hidden sessions. */
function visibleSessions(rows: SessionLike[], here: SessionHere, prefs: SessionListPrefs): { row: SessionLike; place: SessionPlace }[] {
  return rows
    .filter((s) => !(s.sessionId in prefs.hidden) || s.lastActivityMs > prefs.hidden[s.sessionId])
    .map((row) => ({ row, place: sessionPlace(row, here) }))
    .filter(({ place }) => (place.kind !== 'leftover' || prefs.showLeftover) && (place.kind !== 'ended' || prefs.showEnded));
}

function sortRows(items: { row: SessionLike; place: SessionPlace }[], sort: SessionSort): { row: SessionLike; place: SessionPlace }[] {
  const by = sort === 'name'
    ? (a: SessionLike, b: SessionLike) => plain(a.title || a.label || a.topic).localeCompare(plain(b.title || b.label || b.topic))
    : sort === 'newest' ? (a: SessionLike, b: SessionLike) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0)
      : (a: SessionLike, b: SessionLike) => b.lastActivityMs - a.lastActivityMs;
  return [...items].sort((a, b) => (sort === 'name' ? 0 : Number(sessionStateOf(b.row) === 'working') - Number(sessionStateOf(a.row) === 'working')) || by(a.row, b.row));
}

function menuHtml(p: SessionListPrefs): string {
  const item = (on: boolean, label: string, key: string, value: string, ic = '') => `<button role="menuitemcheckbox" aria-checked="${on}" data-pref="${key}" data-value="${value}"><span class="ck">${on ? '✓' : ''}</span>${ic}${label}</button>`;
  return `<div class="menu" role="menu" hidden>
    <div class="sec">Sort</div>${item(p.sort === 'last', 'Last active', 'sort', 'last')}${item(p.sort === 'newest', 'Newest', 'sort', 'newest')}${item(p.sort === 'name', 'Name', 'sort', 'name')}<hr>
    <div class="sec">Show</div>${item(p.showLeftover, 'Tabs with no agent', 'showLeftover', String(!p.showLeftover))}${item(p.showEnded, 'Ended', 'showEnded', String(!p.showEnded))}<hr>
    <div class="sec">Group</div>${item(p.group === 'app', 'App', 'group', 'app', glyph('terminal', 'mi'))}${item(p.group === 'machine', 'Machine', 'group', 'machine', glyph('machine', 'mi'))}${item(p.group === 'state', 'State', 'group', 'state', glyph('state', 'mi'))}${item(p.group === 'none', 'None', 'group', 'none')}
  </div>`;
}

/** The Sessions tab: a header with counts and the ⇅ menu, Needs you pinned, then
 *  the viewer's grouping. Each card is compact until hovered or selected. */
export function renderSessions(rows: SessionLike[], now: number, opts: SessionListOptions): string {
  const { here, prefs } = opts;
  const all = visibleSessions(rows, here, prefs);
  const asks = sortRows(all.filter(({ row }) => sessionStateOf(row) === 'asks'), prefs.sort);
  const rest = all.filter(({ row }) => sessionStateOf(row) !== 'asks');
  const card = ({ row, place }: { row: SessionLike; place: SessionPlace }, pinned = false) => renderSessionCard(row, place, now, {
    selected: row.sessionId === opts.selectedId, pinned, here, thumbs: opts.thumbsFor?.(row) ?? [], made: opts.madeFor?.(row) ?? null,
  });
  const c = sessionCount(rows, here, prefs);
  const head = `<div class="shead"><span class="label">Sessions</span><span class="sum">${c.tabs} tab${c.tabs === 1 ? '' : 's'} · ${c.shown} live · ${c.asks} need${c.asks === 1 ? 's' : ''} you</span><button class="icon" data-menu aria-haspopup="menu" aria-expanded="false" title="Sort, show and group" aria-label="Sort, show and group">${glyph('sort')}</button>${menuHtml(prefs)}</div>`;
  const tail = '<div class="bulk" hidden></div><div class="toast" hidden></div>';
  if (all.length === 0) return `${head}<div class="empty">No sessions on this project right now.</div>${tail}`;
  const pinned = asks.length ? `<div class="pinned"><div class="ph">${SESSION_STATE_WORD.asks} <span class="n">${asks.length}</span></div>${asks.map((x) => card(x, true)).join('')}</div>` : '';
  type Group = { key: string; name: string; sub: string; icon: string; items: typeof rest; action?: string };
  let groups: Group[];
  if (prefs.group === 'app') {
    const byKey = new Map<string, Group>();
    for (const x of [...rest].sort((a, b) => PLACE_ORDER[a.place.kind] - PLACE_ORDER[b.place.kind])) {
      const g = byKey.get(x.place.key) ?? { key: x.place.key, name: x.place.name, sub: x.place.sub, icon: placeIcon(x.place, here), items: [], action: x.place.kind === 'leftover' ? 'close-all' : undefined };
      g.items.push(x); byKey.set(x.place.key, g);
    }
    groups = [...byKey.values()];
  } else if (prefs.group === 'machine') {
    const devices = [...new Set(rest.map((x) => x.place.device))].sort((a, b) => Number(b === here.device) - Number(a === here.device) || a.localeCompare(b));
    groups = devices.map((d) => ({ key: `machine:${d}`, name: d, sub: d === here.device ? 'this machine' : '', icon: glyph('machine', 'gi'), items: rest.filter((x) => x.place.device === d) }));
  } else if (prefs.group === 'state') {
    groups = STATE_ORDER_KEYS.map((k) => ({ key: `state:${k}`, name: SESSION_STATE_WORD[k], sub: '', icon: `<span class="pill st-${k} solo"><i></i></span>`, items: rest.filter((x) => sessionStateOf(x.row) === k) }));
  } else {
    return head + pinned + `<div class="flat">${sortRows(rest, prefs.sort).map((x) => card(x)).join('')}</div>` + tail;
  }
  const folded = new Set(prefs.folded);
  return head + pinned + groups.filter((g) => g.items.length).map((g) => {
    const counts = new Map<SessionStateKey, number>();
    for (const { row } of g.items) { const k = sessionStateOf(row); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const dots = [...counts].map(([k, n]) => `<i class="d-${DOT_TONE[k]}" title="${n} ${SESSION_STATE_WORD[k]}"></i>`).join('');
    const closed = folded.has(g.key);
    return `<section class="grp${closed ? ' closed' : ''}" data-group="${escapeHtml(g.key)}">
      <div class="gh" role="button" tabindex="0" aria-expanded="${!closed}"><span class="car">▾</span><span class="gi-box">${g.icon}</span><span class="gname"><b>${escapeHtml(g.name)}</b> <span class="n">${g.items.length}</span>${g.sub ? ` <span class="gs">· ${escapeHtml(g.sub)}</span>` : ''}</span>${g.action ? `<button class="gact" data-act="close-all" title="Close every tab here whose agent is not running">Close all</button>` : ''}<span class="dots">${dots}</span></div>
      <div class="items">${closed ? '' : sortRows(g.items, prefs.sort).map((x) => card(x)).join('')}</div>
    </section>`;
  }).join('') + tail;
}

/** The tab's numbers: live sessions, the ones that need you, tabs held here. */
export function sessionCount(rows: SessionLike[], here?: SessionHere, prefs: SessionListPrefs = DEFAULT_SESSION_PREFS): { shown: number; asks: number; tabs: number } {
  const items = here ? visibleSessions(rows, here, prefs) : rows.map((row) => ({ row, place: null as SessionPlace | null }));
  return {
    shown: items.filter(({ row }) => sessionStateOf(row) !== 'ended').length,
    asks: items.filter(({ row }) => sessionStateOf(row) === 'asks').length,
    tabs: rows.filter((s) => s.tabHere).length,
  };
}

const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

const STATE_TONE: Record<string, string> = { Doing: 'doing', 'In Progress': 'doing', 'In Review': 'review', Todo: 'todo', Backlog: 'backlog' };

/** Overview: progress, a bar of open tickets by state, and the milestone that is
 *  current, or a plain statement that there is none. */
export function renderOverview(m: OverviewModel, today: string, groups: TicketGroup[] = [], ticketsError: string | null = null): string {
  const open = m.milestones.filter((x) => x.total === 0 || x.done < x.total)
    .sort((a, b) => (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999'));
  const current = open.find((x) => x.targetDate === null || x.targetDate >= today) ?? null;
  const late = open.filter((x) => x.targetDate !== null && x.targetDate < today);
  const counted = groups.filter((g) => STATE_TONE[g.state]);
  const total = counted.reduce((n, g) => n + g.tickets.length, 0);
  const unplanned = groups.reduce((n, g) => n + g.tickets.filter((t) => !t.milestone).length, 0);
  const stateBar = total
    ? `<div class="sbar" role="img" aria-label="${counted.map((g) => `${g.tickets.length} ${g.state}`).join(', ')}">${counted.map((g) => `<span class="st-${STATE_TONE[g.state]}" style="flex:${g.tickets.length}" title="${g.tickets.length} ${escapeHtml(g.state)}"></span>`).join('')}</div>
      <div class="legend">${counted.map((g) => `<span><i class="st-${STATE_TONE[g.state]}"></i>${g.tickets.length} ${escapeHtml(g.state)}</span>`).join('')}</div>`
    : '';
  const milestone = current
    ? `<div class="ms"><div class="row"><span class="t">${escapeHtml(current.name)}</span><span class="n">${current.done}/${current.total}</span></div><div class="mbar"><span style="width:${pct(current.done, current.total)}%"></span></div>${current.targetDate ? `<div class="sub">due ${escapeHtml(current.targetDate)}</div>` : ''}</div>`
    : `<div class="note"><b>No current milestone.</b>${late.length ? ` ${late.length} past due.` : ''}${unplanned ? ` ${unplanned} open tickets unplanned.` : ''}</div>`;
  return `<section>
    <div class="head"><span class="title">${escapeHtml(m.name)}</span><span class="n">${pct(m.done, m.total)}%</span></div>
    ${m.description ? `<div class="sub">${escapeHtml(m.description)}</div>` : ''}
    ${ticketsError ? `<div class="err">Tickets could not be read: ${escapeHtml(ticketsError)}</div>` : stateBar}
    ${milestone}
    ${m.latestRelease ? `<div class="sub">${escapeHtml(m.latestRelease.tag)} · ${escapeHtml(shortDate(m.latestRelease.publishedAt))}</div>` : ''}
  </section>`;
}

const PRIORITY_TITLE: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

/** Signal bars: urgent and high are three bars, medium two, low one. */
function priorityBars(p: number): string {
  const lit = p === 1 || p === 2 ? 3 : p === 3 ? 2 : p === 4 ? 1 : 0;
  return `<span class="pri p${p}" role="img" aria-label="${PRIORITY_TITLE[p] ?? 'No priority'}" title="${PRIORITY_TITLE[p] ?? 'No priority'}">${[1, 2, 3].map((i) => `<i class="${i <= lit ? 'on' : ''}" style="height:${2 + i * 3}px"></i>`).join('')}</span>`;
}

export function renderTickets(groups: TicketGroup[]): string {
  if (groups.length === 0) return '<div class="empty">No open tickets in this project.</div>';
  return groups.map((g, gi) => `<details ${gi < 2 ? 'open' : ''}>
    <summary>${escapeHtml(g.state)} <span class="n">${g.tickets.length}</span></summary>
    <ul>${g.tickets.map((t) => `<li><a class="trow" href="#" data-url="${escapeHtml(t.url)}">${priorityBars(t.priority)}<span class="tm"><span class="t">${escapeHtml(t.title)}</span><span class="sub">${escapeHtml(t.identifier)}${t.owner ? ` · ${escapeHtml(t.owner)}` : ''}${t.milestone ? ` · ${escapeHtml(t.milestone)}` : ''}</span></span></a></li>`).join('')}</ul>
  </details>`).join('');
}

function ring(state: string | null, draft: boolean): string {
  const tone = draft ? 'draft' : state === 'SUCCESS' ? 'ok' : state === 'FAILURE' || state === 'ERROR' ? 'bad' : state ? 'run' : 'none';
  const words = draft ? 'Draft' : tone === 'ok' ? 'Checks passed' : tone === 'bad' ? 'Checks failing' : tone === 'run' ? 'Checks running' : 'No checks';
  return `<span class="ring r-${tone}" role="img" aria-label="${words}" title="${words}"><svg viewBox="0 0 18 18"><circle class="trk" cx="9" cy="9" r="7"/><circle class="arc" cx="9" cy="9" r="7"/>${tone === 'ok' ? '<path class="chk" d="M5.8 9.2l2.2 2.2 4.2-4.6"/>' : ''}</svg></span>`;
}

export function renderPrs(m: PrsModel, now: number): string {
  if (m.repos.length === 0) return '<div class="empty">This project has no attached repositories.</div>';
  const age = (iso: string) => relAge(Date.parse(iso), now);
  const partial = m.partial ? '<div class="warn">Some repositories could not be read; this list is incomplete.</div>' : '';
  return partial + m.repos.map((r) => {
    if (r.error) return `<section><div class="label">${escapeHtml(r.slug)}</div><div class="err">Could not read: ${escapeHtml(r.error)}</div></section>`;
    if (r.open.length === 0 && r.merged.length === 0) return '';
    const branch = r.branch ? `<span class="rmeta" title="${escapeHtml(r.branch.name)}: ${escapeHtml(r.branch.ciState ?? 'no CI')}">${ring(r.branch.ciState, false)}${escapeHtml(r.branch.name)}</span>` : '';
    return `<section>
      <div class="head"><span class="label">${escapeHtml(r.slug.split('/')[1] ?? r.slug)}</span>${branch}<span class="n">${r.open.length}</span></div>
      <ul>${r.open.map((p) => `<li><a class="prow" href="#" data-url="${escapeHtml(p.url)}">${ring(p.ciState, p.isDraft)}<span class="tm"><span class="t">${escapeHtml(p.title)}</span><span class="sub">#${p.number} · ${age(p.date)} · ${escapeHtml(p.author)}</span></span></a></li>`).join('')}</ul>
      ${r.merged.length ? `<details open><summary>merged <span class="n">${r.merged.length}</span></summary><ul>${r.merged.map((p) => `<li><a class="prow" href="#" data-url="${escapeHtml(p.url)}">${ring(p.ciState, false)}<span class="tm"><span class="t">${escapeHtml(p.title)}</span><span class="sub">#${p.number} · ${age(p.date)}</span></span></a></li>`).join('')}</ul></details>` : ''}
    </section>`;
  }).join('');
}
