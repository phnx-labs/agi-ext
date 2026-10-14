// Pure model + HTML for the Project sidebar panel (PHNX-4289).
// Each section is one CLI read: `linear tasks --project <linear> --json` (Issues),
// `agents projects prs list <name> --json` (Review). Sessions come from the
// session stream rows already in the presentation store, filtered on the CLI's
// `confirmedProject`. Parsers fail loud on a shape they do not know;
// the provider turns that into the section's error state, never an empty list.

import * as os from 'os';
import * as path from 'path';
import { extractLinearTicketId, isHostFallbackLabel } from './utils';
import { isDerivedSessionName } from './remoteSessions';
import { ticketFace } from './ticketFaces';
import { BALL_WORD, PENDING_KINDS, SESSION_STATE_WORD, attentionRank, ballOf, pendingCounts, pendingLines, pendingWords, sessionStateOf, urgencyOf, urgencyRank, type SessionPending, type SessionStateKey } from '../shared/sessionState';
import { DEFAULT_CARD_SETTINGS, type CardSettings } from './settings';
import { resolveProject } from '../shared/project';
import { BUILT_IN_AGENTS } from './agents';
import { CLI_AGENT_META, type CliAgentId } from './agents.cli';
import type { SessionCardFields } from './sessionCardFields';

export interface ProjectRef {
  name: string;
  linearName: string | null;
  /** Its repositories and where each is checked out; only `agents projects list` carries them. */
  repos?: { slug: string; path: string }[];
  /** The checkout the window's folder resolved to (`agents projects status --path`'s `root`). */
  root?: string;
}

interface Ticket {
  identifier: string;
  title: string;
  priority: number;
  milestone: string | null;
  /** The person it is assigned to, and the agent it is delegated to, as Linear names them. */
  assignee: string | null;
  delegate: string | null;
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
  /** The author's GitHub avatar, when the CLI carries it. */
  avatar: string | null;
  date: string;
  /** How many required checks fail (the CLI's failingChecks). */
  failing: number;
  /** The head commit the list read, so Merge lands only what you saw. */
  headSha: string | null;
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
  const root = str(d.root);
  return { name, linearName: str(linear?.name), ...(root ? { root } : {}) };
}

/** `agents projects list --json`. */
export function parseProjectList(raw: string): ProjectRef[] {
  return arr(JSON.parse(raw), 'project list').map((p) => {
    const d = obj(p, 'project');
    const name = str(d.name);
    if (!name) throw new Error('Unexpected project shape from the CLI');
    const linear = d.linear && typeof d.linear === 'object' ? (d.linear as Json) : null;
    const repos = Array.isArray(d.repos)
      ? d.repos.flatMap((r) => {
        const o = r && typeof r === 'object' ? (r as Json) : {};
        const slug = str(o.slug);
        return slug ? [{ slug, path: str(o.path) ?? '' }] : [];
      })
      : [];
    return { name, linearName: str(linear?.name), repos };
  });
}

/** `~/…` for a path under home, as the CLI prints it. */
export function displayHome(p: string, home: string = os.homedir()): string {
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** Projects with a repository checked out inside `folder`: a window opened on a
 *  parent folder holds several, and the panel's project menu offers those first. */
export function projectsInFolder(all: ProjectRef[], folder: string, home: string): { projects: { name: string; repos: string[] }[] } {
  const abs = (p: string) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  const inside = (p: string) => !!folder && (abs(p) === folder || abs(p).startsWith(folder.replace(/\/+$/, '') + '/'));
  return {
    projects: all
      .filter((p) => (p.repos ?? []).some((r) => r.path && inside(r.path)))
      .map((p) => ({ name: p.name, repos: (p.repos ?? []).map((r) => r.slug.split('/').pop() ?? r.slug) })),
  };
}

/** `agents projects status <name> --json` prints a one-element card array. */
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
      priority: num(d.priority),
      milestone: str(ms?.name),
      assignee: str(assignee?.name),
      delegate: str(delegate?.name),
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
    avatar: /^https:\/\/avatars\.githubusercontent\.com\//.test(str(author.avatarUrl) ?? '') ? str(author.avatarUrl) : null,
    date: str(d[dateKey]) ?? '',
    failing: Array.isArray(d.failingChecks) ? d.failingChecks.length : 0,
    headSha: /^[0-9a-f]{7,40}$/i.test(str(d.headSha) ?? '') ? str(d.headSha) : null,
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
  /** The CLI's resolved name for the session; every surface shows it (`streamTitle`). */
  title: string;
  label: string;
  topic: string;
  /** What the session was started with, when it differs from its title (agents-cli). */
  startedAs?: string;
  /** The harness the CLI reported (`claude`, `codex`, …). */
  agentType?: string;
  /** Model id of the latest assistant reply; absent when the CLI does not know it. */
  model?: string;
  phase: 'running' | 'idle' | 'waiting' | 'failed' | 'done';
  liveStatus: string;
  /** The CLI's open attention item: its key answers it (`agents feed answer`); urgency
   *  and its reason come from agents-cli (absent on an older CLI: normal). */
  attention?: {
    key?: string; kind: string; state: string; openedAt?: string; urgency?: string; urgencyReason?: string;
    question?: AskQuestion; choices?: { id: string; label: string; description?: string }[];
  };
  question?: AskQuestion | null;
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
  /** Where the agent runs; the card names its repository only when it is not this window's. */
  cwd?: string;
  /** Background work still running (CLI `pending`); idle plus pending is Waiting. */
  pending?: SessionPending;
  effort?: string;
  fast?: boolean;
  /** The account it runs on, when the stream names one. */
  account?: string;
}

/** A question as the CLI carries it (agents-cli `BlockQuestion`). */
interface AskQuestion {
  text?: string;
  header?: string;
  options?: { label?: string; description?: string; id?: string }[];
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

/** A path with the home folder written as `~`, so a session on another machine
 *  (`/Users/x/src/a`) compares with this one (`/home/x/src/a`). */
function homeless(p: string): string {
  return p.replace(/\/+$/, '').replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|~)(?=\/|$)/, '~');
}

/** The checkout a cwd belongs to: a worktree folds to the repository holding it. */
function checkoutOf(cwd: string): string {
  return homeless(cwd).replace(/\/\.(?:agents|claude)\/worktrees\/.*$/, '');
}

/** The repository paths a project is checked out at, as `~/…` paths. */
export function projectRepoPaths(p: Pick<ProjectRef, 'root' | 'repos'>): string[] {
  return [...new Set([p.root ?? '', ...(p.repos ?? []).map((r) => r.path)].filter(Boolean).map(homeless))];
}

/** What the repository-path stopgap needs: the project's checkouts, and every
 *  registered project name (null until `agents projects list` answered). */
export interface ProjectFallback {
  repoPaths: string[];
  registered: ReadonlySet<string> | null;
}

/** The fallback for one project from the registry (`agents projects list`) and,
 *  when the folder was detected, its `root`. */
export function projectFallback(p: Pick<ProjectRef, 'name' | 'root' | 'repos'>, registry: readonly ProjectRef[] | null): ProjectFallback {
  const listed = registry?.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
  return {
    repoPaths: projectRepoPaths({ root: p.root, repos: [...(p.repos ?? []), ...(listed?.repos ?? [])] }),
    registered: registry ? new Set(registry.map((x) => x.name.toLowerCase())) : null,
  };
}

/** The project's sessions, newest first: the CLI's own `confirmedProject`, and
 *  until agents-cli resolves a project's old names, a session whose checkout is
 *  one of the project's repositories while the CLI filed it under no project or
 *  under a name no registered project has (a renamed project's old name). A
 *  session another live project claims stays there, even in a shared repository. */
export function projectSessions<T extends Pick<SessionLike, 'confirmedProject' | 'lastActivityMs'> & { cwd?: string }>(rows: T[], project: string, fallback?: ProjectFallback): T[] {
  const want = project.toLowerCase();
  const repos = new Set((fallback?.repoPaths ?? []).map(homeless));
  const orphan = (r: T) => { const c = (r.confirmedProject || '').toLowerCase(); return !c || (!!fallback?.registered && !fallback.registered.has(c)); };
  const inRepo = (r: T) => repos.size > 0 && !!r.cwd && orphan(r) && repos.has(checkoutOf(r.cwd));
  return rows
    .filter((r) => (r.confirmedProject || '').toLowerCase() === want || inRepo(r))
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

/** A string's FNV-1a hash in base 36: a card carries it so an unchanged card is not re-patched. */
function fieldsHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
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

/** Where a chip points, as that service's own mark: GitHub for pull requests, Linear for
 *  tickets (the tracker the Issues tab reads). */
const GITHUB_MARK = '<svg class="ic mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const LINEAR_MARK = '<svg class="ic mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="#5E6AD2" stroke="none"/><path d="M2.2 9.6l4.2 4.2M1.6 7l7.4 7.4M2.6 4.6l8.8 8.8M4.4 2.8l8.8 8.8" stroke="#fff" stroke-width="1.05"/></svg>';

function prMini(pr: NonNullable<SessionLike['prStatus']>): string {
  const tone = pr.state === 'merged' ? 'ok' : pr.isDraft ? 'draft' : pr.checks === 'passing' ? 'ok' : pr.checks === 'failing' ? 'bad' : 'run';
  const words = pr.state === 'merged' ? 'merged' : pr.isDraft ? 'draft' : pr.checks === 'passing' ? 'ready to merge' : pr.checks === 'failing' ? 'checks failing' : 'checks running';
  return `<span class="chip pr-${tone}" title="PR #${pr.number}: ${words}">${GITHUB_MARK}#${pr.number}</span>`;
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
  /** Show only the sessions on today's goal (its ticket id in the title, topic or reply). */
  todayOnly: boolean;
  /** 2 once Ended defaults to shown and folded; 3 once Idle defaults to folded. */
  v: 3;
}

/** The Ended group's key under App and under State; Machine and None have no Ended group. */
const ENDED_GROUPS = ['ended', 'state:ended'];
/** The Idle group's key: finished turns that asked nothing, folded by default. */
const IDLE_GROUP = 'idle';

export const DEFAULT_SESSION_PREFS: SessionListPrefs = { group: 'app', sort: 'last', showLeftover: true, showEnded: true, folded: [...ENDED_GROUPS, IDLE_GROUP], hidden: {}, todayOnly: false, v: 3 };

const GROUPS: readonly SessionGroupBy[] = ['app', 'machine', 'state', 'none'];
const SORTS: readonly SessionSort[] = ['last', 'newest', 'name'];

/** A stored preference object, keeping only values this version knows. Prefs stored
 *  before v2 saved Ended off as the old default, not as a choice, so they get the
 *  new default: Ended shown and folded. Turning it on was a choice and is kept, and
 *  a Machine or None grouping, which has no Ended group to fold, keeps Ended off.
 *  Prefs from before v3 get the Idle group folded. */
export function readSessionPrefs(v: unknown): SessionListPrefs {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const hidden: Record<string, number> = {};
  if (o.hidden && typeof o.hidden === 'object') {
    for (const [id, ms] of Object.entries(o.hidden as Record<string, unknown>)) if (typeof ms === 'number') hidden[id] = ms;
  }
  const folded = Array.isArray(o.folded) ? o.folded.filter((k): k is string => typeof k === 'string') : [];
  const group = GROUPS.includes(o.group as SessionGroupBy) ? (o.group as SessionGroupBy) : DEFAULT_SESSION_PREFS.group;
  const before = o.v !== 2 && o.v !== 3 && o.showEnded !== true;
  const kept = before ? [...folded, ...ENDED_GROUPS] : folded;
  const foldable = group === 'app' || group === 'state';
  return {
    group,
    sort: SORTS.includes(o.sort as SessionSort) ? (o.sort as SessionSort) : DEFAULT_SESSION_PREFS.sort,
    showLeftover: typeof o.showLeftover === 'boolean' ? o.showLeftover : DEFAULT_SESSION_PREFS.showLeftover,
    showEnded: before ? foldable : typeof o.showEnded === 'boolean' ? o.showEnded : DEFAULT_SESSION_PREFS.showEnded,
    folded: o.v === 3 ? folded : [...new Set([...kept, IDLE_GROUP])],
    hidden,
    todayOnly: o.todayOnly === true,
    v: 3,
  };
}

/** Whether a session works on a ticket: its id in the title, topic, label or latest reply. */
export function onTicket(s: Pick<SessionLike, 'title' | 'topic' | 'label'> & { lastResponse?: string }, id: string | undefined): boolean {
  if (!id) return false;
  return [s.title, s.topic, s.label, s.lastResponse].some((t) => extractLinearTicketId(t || '') === id || (t || '').includes(id));
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
  if (s.tabHere) return place('here', 'here', 'Open tabs', here.workspace);
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
  /** The session in this window's front tab; its card says "This tab". */
  frontId?: string | null;
  /** What precedes a tab number on a card: "⌘" on macOS, "Alt+" elsewhere. */
  tabKey?: string;
  here: SessionHere;
  prefs: SessionListPrefs;
  thumbsFor?: (s: SessionLike) => CardThumb[];
  madeFor?: (s: SessionLike) => SessionMade | null;
  /** Today's goal ticket (`linear goals`), so its sessions carry ☀ and can be filtered. */
  todayId?: string;
  /** Sessions whose agent posted that it is blocked and you have not written since
   *  (status.blocked on the stream, `blockedSessions`); ids without a `session_` prefix. */
  blockedIds?: ReadonlySet<string>;
  /** The shortcut the search icon names ("⌘K", "Ctrl+K"). */
  searchKey?: string;
  /** The project shown, so a card filed under another name says so in its ⋯ menu. */
  project?: string;
  /** How a card shows an open ask (Settings, Session cards). */
  cards?: CardSettings;
}

const ACT_ICON = {
  focus: '<path d="M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5 7.5 8.5"/>',
  resume: '<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  hide: '<path d="M2.5 8S4.5 4.5 8 4.5 13.5 8 13.5 8 11.5 11.5 8 11.5 2.5 8 2.5 8z"/><path d="M3.5 12.5l9-9"/>',
  sort: '<path d="M5 3v10M3 11l2 2 2-2M11 13V3M9 5l2-2 2 2"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  folder: '<path d="M2 4.5h4l1.2 1.3H14v6.7H2z"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/>',
  cloud: '<path d="M4.5 12h7a2.5 2.5 0 0 0 .3-5A3.5 3.5 0 0 0 5 6.5 2.75 2.75 0 0 0 4.5 12z"/>',
  machine: '<rect x="2.5" y="3" width="11" height="7.5" rx="1"/><path d="M6 13.5h4M8 10.5v3"/>',
  state: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/>',
  merge: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5v6M4.5 5c0 3 3 3 5.5 3"/>',
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

const HARNESS_LOGOS = new Set(BUILT_IN_AGENTS.filter((a) => a.key !== 'shell').map((a) => a.key));

/** The harness's logo, drawn by its `hx-<key>` class; nothing for a harness without one. */
function harnessLogo(agentType: string | undefined): string {
  const key = (agentType ?? '').toLowerCase();
  if (!HARNESS_LOGOS.has(key)) return '';
  const name = CLI_AGENT_META[key as CliAgentId]?.name ?? key;
  return `<i class="hx hx-${key}" role="img" aria-label="${escapeHtml(name)}" title="${escapeHtml(name)}"></i>`;
}

/** How long a session ran: "47m", "13h 8m", "2d 3h". */
export function ranFor(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** When it ran, by day: "yesterday 6:50 PM → today 7:56 AM", "Oct 11 · 4:20 AM → 12:32 PM". */
export function ranSpan(start: number, end: number, now: number): string {
  const day = (t: number) => new Date(t).toDateString();
  const dayWord = (t: number) => {
    if (day(t) === day(now)) return 'today';
    if (day(t) === day(now - 86_400_000)) return 'yesterday';
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return day(start) === day(end)
    ? `${dayWord(start)} · ${clock(start)} → ${clock(end)}`
    : `${dayWord(start)} ${clock(start)} → ${dayWord(end)} ${clock(end)}`;
}

/** Claude Code puts a note in as the first user turn when another session writes in
 *  ("Another Claude session sent a message: <agent-message …>"); a bare slash command
 *  or a sub-agent's hand-back says nothing about the work either. */
const INJECTED_NOTE = /^another \w+ session sent a message:?\s*/i;

/** A title candidate as words, or '' when it is an inserted note or a bare command. */
export function cleanTitle(raw: string): string {
  if (/^\s*<(task-notification|system-reminder)/i.test(raw)) return '';
  const t = plain(raw.replace(/<\/?agent-message[^>]*>/gi, ' ').replace(INJECTED_NOTE, '')).replace(/^[…. ]+$/, '');
  if (/^\[subagent hand-back\]/i.test(t) || /^\/[\w:-]+(\s|$)/.test(t)) return '';
  return t;
}

/** The session's one name, on its tab, its card and the status bar alike: the
 *  CLI's resolved title, else its label (a real /rename, not Claude's
 *  `<folder>-<n>` placeholder or the `[host/…]` fallback), else the topic or the
 *  request; each skipped while it is only an inserted note or a slash command
 *  (owner video, 2026-10-12 8:15 PM). '' while the CLI knows none. */
export function streamTitle(s: Pick<SessionLike, 'title' | 'topic' | 'label' | 'request' | 'cwd'>): string {
  const label = s.label && !isHostFallbackLabel(s.label) && !isDerivedSessionName(s.label, s.cwd ?? '') ? s.label : '';
  for (const c of [s.title, label, s.topic, s.request?.headline]) {
    const t = cleanTitle(c ?? '');
    if (t) return t;
  }
  return '';
}

/** The card title: `streamTitle`, or Untitled. */
export function sessionTitle(s: Pick<SessionLike, 'title' | 'topic' | 'label' | 'request' | 'cwd'>): string {
  return streamTitle(s) || 'Untitled';
}

/** How long a question has waited: "12s", "5m 02s", "18h 4m", "2d 3h". The list's
 *  script ticks the same words each second. */
export function waitFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(s / 3600);
  return h < 24 ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** When the open question was asked, from the CLI's attention item; NaN when none. */
function askedAt(s: SessionLike): number {
  return s.attention?.state === 'open' && s.attention.openedAt ? Date.parse(s.attention.openedAt) : NaN;
}

/** A question shows its attention glow for this long after it arrives. */
const FRESH_MS = 20_000;

/** The words "Try another way" sends: the agent goes on without you, or parks the task. */
export const TRY_ANOTHER_WAY = "I can't answer this right now. Try a different approach that doesn't need me; if there is none, park this and move to the next task.";

/** One `agents feed answer` for an ask: a choice by its id, or typed words. `--json`
 *  makes a delivery the CLI could not make an error the card can show. */
export function answerArgv(key: string, answer: { choice: string } | { text: string }): string[] {
  return ['feed', 'answer', key, ...('choice' in answer ? ['--choice', answer.choice] : ['--text', answer.text]), '--json'];
}

/** What `agents feed answer --json` said, as the card shows it: null when it was delivered. */
export function answerFailure(stdout: string): string | null {
  let r: { status?: string; reason?: string };
  try { r = JSON.parse(stdout.trim().split('\n').pop() ?? ''); } catch { return stdout.trim() || 'The CLI gave no answer.'; }
  if (r.status === 'failed') return `Not delivered: ${r.reason ?? 'no reason given'}`;
  if (r.status === 'unknown') return `Delivery unconfirmed: ${r.reason ?? 'no receipt yet'}`;
  return null;
}

/** An ask's answers: the attention item's own choices, else its question's options. */
function askChoices(s: SessionLike): { id?: string; label: string; description?: string }[] {
  const a = s.attention;
  if (a?.choices?.length) return a.choices.filter((c) => c.label);
  const q = a?.question ?? s.question;
  return (q?.options ?? []).flatMap((o) => (o.label ? [{ id: o.id, label: o.label, description: o.description }] : []));
}

/** The ask on a card: its header and question, and, with answers on, one compact
 *  button per choice (keys 1–9), Other… and Try another way. Every button carries
 *  what it sends; the page holds it 5 s with Undo before one `feed answer`. */
function askBlock(s: SessionLike, cards: CardSettings): string {
  const a = s.attention?.state === 'open' ? s.attention : undefined;
  const q = a?.question ?? s.question ?? undefined;
  const text = plain(q?.text || '');
  if (!text) return '';
  const permission = a?.kind === 'permission';
  const full = cards.question === 'full';
  const head = `<div class="ah">Asks${q?.header ? ` · ${escapeHtml(plain(q.header))}` : ''}</div>`;
  const question = `<div class="q${permission ? ' cmdq' : ''}${full ? ' full' : ''}" title="${escapeHtml(text)}"${full ? '' : ' data-expand'}>${escapeHtml(text)}</div>`;
  const key = a?.key;
  if (cards.asks !== 'answers' || !key) return `<div class="ask">${head}${question}</div>`;
  const opt = (c: { id?: string; label: string; description?: string }, i: number) => {
    const sends = c.id ? `data-choice="${escapeHtml(c.id)}"` : `data-ask-text="${escapeHtml(c.label)}"`;
    const detail = cards.options === 'details' && c.description ? `<small>${escapeHtml(c.description)}</small>` : '';
    return `<button class="opt" ${sends} data-label="${escapeHtml(c.label)}"${c.description ? ` title="${escapeHtml(c.description)}"` : ''}>${i < 9 ? `<span class="k">${i + 1}</span>` : ''}<span class="ol">${escapeHtml(c.label)}</span>${detail}</button>`;
  };
  const opts = askChoices(s).map(opt).join('');
  return `<div class="ask" data-ask="${escapeHtml(key)}">${head}${question}${opts ? `<div class="opts">${opts}</div>` : ''}<div class="alt"><button class="lnk" data-ask-other>Other…</button><button class="lnk" data-ask-text="${escapeHtml(TRY_ANOTHER_WAY)}" data-label="Try another way" title="${escapeHtml(TRY_ANOTHER_WAY)}">Try another way</button></div><div class="aother" hidden><input data-ask-input aria-label="Your reply" placeholder="Type a reply · Enter sends"></div><div class="asend" hidden></div></div>`;
}

/** A thumbnail's markup: no `src` until the webview's cache holds a 480 px copy
 *  (`THUMB_SCRIPT`, `src/shared/sessionCards.ts`), so a redraw never decodes the
 *  full render again. An SVG is drawn directly. */
function thumbImg(uri: string, path: string, alt: string): string {
  const size = 'width="54" height="34"';
  return /\.svg$/i.test(path)
    ? `<img src="${escapeHtml(uri)}" ${size} alt="${escapeHtml(alt)}">`
    : `<img data-thumb="${escapeHtml(uri)}" ${size} alt="${escapeHtml(alt)}">`;
}

/** The card's ⋯ menu: what used to crowd its meta row (tab, model, folder, session
 *  id, account), each on its own line. */
function cardMenu(s: SessionLike, place: SessionPlace, opts: { project?: string; here: SessionHere }): string {
  const tab = place.where.match(/tab \d+/)?.[0];
  const rows: [string, string][] = [
    ['Tab', s.tabHere ? (tab ? `${tab} in this window` : 'in this window') : tab ? `${tab} in ${place.name}` : 'none'],
    ['Model', [s.model, s.effort ? `${s.effort} effort` : '', s.fast ? 'fast' : ''].filter(Boolean).join(' · ') || 'not reported'],
    ['Machine', place.device === opts.here.device ? `${place.device} (this one)` : place.device],
    ...(s.cwd ? [['Folder', displayHome(s.cwd)] as [string, string]] : []),
    ['Session', s.sessionId],
    ...(s.account ? [['Account', s.account] as [string, string]] : []),
    ...(opts.project && s.confirmedProject && s.confirmedProject.toLowerCase() !== opts.project.toLowerCase()
      ? [['Project', `${opts.project} (the CLI said ${s.confirmedProject})`] as [string, string]] : []),
  ];
  return `<details class="cmore"><summary class="act" title="Details" aria-label="Details">⋯</summary><div class="cmenu"><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl><button data-copy="${escapeHtml(s.sessionId)}">Copy session ID</button></div></details>`;
}

export function renderSessionCard(s: SessionLike, place: SessionPlace, now: number, opts: { selected: boolean; front?: boolean; tabKey?: string; pinned: boolean; thumbs: CardThumb[]; made: SessionMade | null; here: SessionHere; today?: boolean; blocked?: boolean; project?: string; cards?: CardSettings }): string {
  const state = sessionStateOf(s);
  const title = sessionTitle(s);
  const cards = opts.cards ?? DEFAULT_CARD_SETTINGS;
  const ask = state === 'asks' && cards.asks !== 'off' ? askBlock(s, cards) : '';
  const said = agentLine(s);
  const live = state === 'working' && s.activity && !said.startsWith(plain(s.activity).slice(0, 40)) ? s.activity : '';
  const made = opts.made;
  const busy = state === 'working' || state === 'waiting' || state === 'asks';
  const hasTab = place.kind === 'here' || place.kind === 'leftover';
  const go = state === 'ended'
    ? (s.resumable === false ? '' : `<button class="act" data-act="resume" title="Resume the agent${hasTab ? ' in its tab' : ''}">${glyph('resume')}</button>`)
    : `<button class="act" data-act="focus" title="Focus ${escapeHtml(place.kind === 'here' ? (s.tabIndex ? `tab ${s.tabIndex} in this window` : 'its tab in this window') : place.kind === 'window' ? `its tab in ${place.name}` : place.kind === 'ghostty' ? 'its Ghostty window' : 'it')}">${glyph('focus')}</button>`;
  const x = hasTab
    ? `<button class="act x" data-act="close" title="Close the tab">${glyph('close')}</button>`
    : `<button class="act x" data-act="hide" title="Hide until it does something new">${glyph('hide')}</button>`;
  const ticketId = made?.ticket ?? s.ticket ?? '';
  const ticket = ticketId ? ticketFace(ticketId) : null;
  const ticketChip = ticketId ? `<a class="chip" href="#" data-open-ticket="${escapeHtml(ticketId)}" title="${escapeHtml(ticket?.title ? `${ticketId}: ${ticket.title}` : `Read ${ticketId}`)}">${LINEAR_MARK}${escapeHtml(ticketId)}</a>` : '';
  const prs = made?.prs.length ? made.prs.map((p) => `<a class="chip" href="#" data-url="${escapeHtml(p.url)}" title="Open ${escapeHtml(p.label)} on GitHub">${GITHUB_MARK}${escapeHtml(p.label)}</a>`).join('') : s.prStatus ? prMini(s.prStatus) : '';
  const ran = state === 'ended' && s.startedAtMs && s.lastActivityMs > s.startedAtMs ? s.lastActivityMs - s.startedAtMs : 0;
  const folders = made?.folders ?? [];
  // Previews always show: what you attached, then images the agent made, three at most.
  // Each goes through the webview's 480 px cache, in a fixed box, so a redraw never flickers.
  const attached = opts.thumbs.slice(0, 3).map((t) => `<a class="th in" href="#" data-path="${escapeHtml(t.path)}" title="Attached by you: ${escapeHtml(t.label)}">${thumbImg(t.uri, t.path, t.label)}</a>`);
  const madeImages = folders.flatMap((f) => f.images).slice(0, 3 - attached.length).map((i) => `<a class="th" href="#" data-artifact="${escapeHtml(i.path)}" title="Made by the agent: ${escapeHtml(i.name)}">${thumbImg(i.uri, i.path, i.name)}</a>`);
  const thumbs = [...attached, ...madeImages];
  const folderChip = folders.length ? `<a class="chip" href="#" data-artifact="${escapeHtml((folders[0].files[0] ?? folders[0].images[0]).path)}" title="${escapeHtml(folders.map((f) => f.display).join('\n'))}">${glyph('folder')}${folders.length}</a>` : '';
  const chips = [prs, ticketChip, folderChip].join('');
  const asked = askedAt(s);
  const waited = (state === 'asks' || state === 'stuck') && Number.isFinite(asked) ? Math.max(0, now - asked) : -1;
  // Waiting names its work on hover; its chips count each kind (⑂ subagents, ▸ shells, ◉ monitors).
  const pendHover = pendingLines(s.pending, now).join('\n');
  const counts = pendingCounts(s.pending);
  const pendChips = state !== 'ended' && counts.total
    ? PENDING_KINDS.filter((k) => counts[k.key]).map((k) => `<span class="pc" title="${escapeHtml(pendHover)}">${k.mark} ${counts[k.key]}</span>`).join('')
    : '';
  const word = opts.blocked ? 'Blocked' : `${SESSION_STATE_WORD[state]}${ran ? ` · ran ${ranFor(ran)}` : ''}`;
  const pillTitle = state === 'waiting' ? ` title="${escapeHtml(`Waiting on its own work: ${pendingWords(s.pending)}\n${pendHover}`)}"` : '';
  const pill = `<span class="pill st-${opts.blocked ? 'blocked' : state}"${pillTitle}><i></i>${escapeHtml(word)}${waited >= 0 ? ` · <span class="wait" data-since="${asked}">${waitFor(waited)}</span>` : ''}</span>`;
  // The repository only when it is not the one this window has open.
  const repo = s.cwd ? resolveProject(s.cwd) : '';
  const ours = new Set([opts.here.workspace, ...(opts.here.folders ?? [])].map((f) => f.toLowerCase()));
  const repoTag = repo && !ours.has(repo.toLowerCase()) ? `<span class="repo" title="${escapeHtml(displayHome(s.cwd!))}">${escapeHtml(repo)}</span>` : '';
  const fx = `${s.fast ? '<span class="fast" title="Fast mode">⚡</span>' : ''}${s.effort === 'high' || s.effort === 'xhigh' || s.effort === 'max' ? `<span class="hi" title="${escapeHtml(s.effort)} reasoning effort">◆</span>` : ''}`;
  // Why it is urgent, in agents-cli's words, with how long it has waited.
  const reason = s.attention?.state === 'open' && s.attention.urgencyReason
    ? `<div class="why u-${urgencyOf(s.attention)}">${escapeHtml(s.attention.urgencyReason)}${waited >= 0 ? ` · waiting <span data-since="${asked}">${waitFor(waited)}</span>` : ''}</div>` : '';
  const preview = ask
    || (said ? `<div class="line said">${escapeHtml(said)}</div>`
      : s.request?.headline ? `<div class="line said">${escapeHtml(plain(s.request.headline))}</div>` : '');
  // An open tab carries its number, as the tab key reaches it; the front tab says so.
  const tabNo = place.kind === 'here' && s.tabIndex ? `<span class="tabn" title="Tab ${s.tabIndex} in this window">${escapeHtml(opts.tabKey ?? '⌘')}${s.tabIndex}</span>` : '';
  const started = s.startedAs && cleanTitle(s.startedAs) !== title ? `<div class="started" title="${escapeHtml(s.startedAs)}">started: ${escapeHtml(plain(s.startedAs))}</div>` : '';
  const body = `
    ${opts.front ? '<div class="thistab">This tab</div>' : ''}<div class="top">${tabNo}${harnessLogo(s.agentType)}<span class="ttl" title="${escapeHtml(title)}">${escapeHtml(title)}</span>${fx ? `<span class="fx">${fx}</span>` : ''}${opts.today ? '<span class="tday" title="On today\'s goal">☀</span>' : ''}<span class="age">${relAge(s.lastActivityMs, now)}</span><span class="acts">${cardMenu(s, place, opts)}${go}${x}</span></div>
    ${started}${reason}<div class="meta">${pill}${pendChips}${repoTag}</div>
    ${preview}${live ? `<div class="line live">${activityLine(live)}</div>` : ''}${ran ? `<div class="span">${escapeHtml(ranSpan(s.startedAtMs!, s.lastActivityMs, now))}</div>` : ''}
    ${thumbs.length ? `<div class="thumbs">${thumbs.join('')}</div>` : ''}<div class="cbot">${chips ? `<div class="cstrip">${chips}</div>` : ''}<span class="hst" title="Machine">${escapeHtml(shortDevice(place.device))}</span></div>
  `;
  const cls = `card st-${state}${opts.selected ? ' sel' : ''}${opts.front ? ' front' : ''}${waited >= 0 && waited < FRESH_MS ? ' fresh' : ''}`;
  const attrs = `tabindex="0" data-session="${escapeHtml(s.sessionId)}" data-host="${escapeHtml(s.host)}" data-busy="${busy ? 1 : 0}" data-tab="${hasTab ? 1 : 0}" data-here="${place.kind === 'here' && state !== 'ended' ? 1 : 0}" data-title="${escapeHtml(title)}"`;
  // data-key pairs the card with its node across a redraw; data-h skips one whose markup is unchanged.
  return `<div class="${cls}" ${attrs} data-key="${escapeHtml(`${s.sessionId}@${s.host}`)}" data-h="${fieldsHash(cls + attrs + body)}">${body}</div>`;
}

const PLACE_ORDER: Record<PlaceKind, number> = { here: 0, window: 1, ghostty: 2, terminal: 3, background: 4, leftover: 5, ended: 6 };
const DOT_TONE: Record<SessionStateKey, string> = { asks: 'asks', stuck: 'asks', review: 'review', idle: 'idle', working: 'working', waiting: 'waiting', unknown: 'unknown', ended: 'ended' };

/** What the list keeps after the viewer's Show choices and hidden sessions. */
function visibleSessions(rows: SessionLike[], here: SessionHere, prefs: SessionListPrefs): { row: SessionLike; place: SessionPlace }[] {
  return rows
    .filter((s) => !(s.sessionId in prefs.hidden) || s.lastActivityMs > prefs.hidden[s.sessionId])
    .map((row) => ({ row, place: sessionPlace(row, here) }))
    .filter(({ place }) => (place.kind !== 'leftover' || prefs.showLeftover) && (place.kind !== 'ended' || prefs.showEnded));
}

function sortRows(items: { row: SessionLike; place: SessionPlace }[], sort: SessionSort): { row: SessionLike; place: SessionPlace }[] {
  // Open tabs keep the tab order, whatever the sort; a panel terminal (no tab number) follows.
  if (items.length && items.every(({ place }) => place.kind === 'here')) {
    return [...items].sort((a, b) => (a.row.tabIndex ?? Infinity) - (b.row.tabIndex ?? Infinity) || b.row.lastActivityMs - a.row.lastActivityMs);
  }
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

/** The Sessions tab: a header with its controls, then what needs you, pinned above
 *  every grouping: Needs you now (urgent and high asks), Asks (normal and low), each
 *  by urgency, then longest wait. Then Ready for review, Idle (finished turns that
 *  asked nothing, folded by default), and the viewer's grouping of the rest.
 *  A session with a tab in this window stays in Open tabs, in tab order, working or
 *  finished; only an ask leaves it, for the pinned group where it is answered
 *  (PHNX-4369), so its card and its answer buttons exist once (PHNX-4387). */
export function renderSessions(rows: SessionLike[], now: number, opts: SessionListOptions): string {
  const { here, prefs } = opts;
  const visible = visibleSessions(rows, here, prefs);
  const today = (r: SessionLike) => onTicket(r, opts.todayId);
  const onToday = visible.filter(({ row }) => today(row)).length;
  const all = prefs.todayOnly && opts.todayId ? visible.filter(({ row }) => today(row)) : visible;
  const openKind = (r: SessionLike) => (r.attention?.state === 'open' ? r.attention.kind : undefined);
  const blocked = (r: SessionLike) => !!opts.blockedIds?.has(r.sessionId.replace(/^session_/, ''));
  const ball = (r: SessionLike) => (blocked(r) ? 'move' : ballOf(sessionStateOf(r)));
  const urgency = (r: SessionLike) => urgencyOf(r.attention?.state === 'open' ? r.attention : null);
  const waitedSince = (r: SessionLike) => { const t = askedAt(r); return Number.isFinite(t) ? t : Infinity; };
  // Urgency first; within it a blocked agent (it said it cannot go on), then the longest wait.
  const mine = sortRows(all.filter(({ row }) => ball(row) === 'move'), prefs.sort)
    .sort((a, b) => urgencyRank(urgency(a.row)) - urgencyRank(urgency(b.row)) || Number(blocked(b.row)) - Number(blocked(a.row))
      || waitedSince(a.row) - waitedSince(b.row) || attentionRank(openKind(a.row)) - attentionRank(openKind(b.row)));
  const pressing = mine.filter(({ row }) => urgencyRank(urgency(row)) <= urgencyRank('high'));
  const asks = mine.filter(({ row }) => urgencyRank(urgency(row)) > urgencyRank('high'));
  const tabHere = (x: { place: SessionPlace }) => x.place.kind === 'here';
  const rest = all.filter((x) => ball(x.row) === 'running' || ball(x.row) === 'ended' || (tabHere(x) && ball(x.row) !== 'move'));
  const card = ({ row, place }: { row: SessionLike; place: SessionPlace }, pinned = false) => renderSessionCard(row, place, now, {
    selected: row.sessionId === opts.selectedId, front: !!opts.frontId && row.sessionId === opts.frontId && place.kind === 'here', tabKey: opts.tabKey, pinned, here, thumbs: opts.thumbsFor?.(row) ?? [], made: opts.madeFor?.(row) ?? null, today: today(row), blocked: blocked(row), project: opts.project, cards: opts.cards,
  });
  // The tab already shows the count and the asks badge, so the header carries only its controls.
  const head = `<div class="shead"><span class="label">Sessions</span>${opts.todayId && (onToday || prefs.todayOnly) ? `<button class="today${prefs.todayOnly ? ' on' : ''}" data-pref="todayOnly" data-value="${!prefs.todayOnly}" aria-pressed="${prefs.todayOnly}" title="${prefs.todayOnly ? 'Show every session' : `Show only the sessions on today's goal (${escapeHtml(opts.todayId)})`}">☀ ${onToday} on today</button>` : ''}<button class="icon" data-search title="Search sessions (${escapeHtml(opts.searchKey ?? '⌘K')})" aria-label="Search sessions">${glyph('search')}</button><button class="icon" data-menu aria-haspopup="menu" aria-expanded="false" title="Sort, show and group" aria-label="Sort, show and group">${glyph('sort')}</button>${menuHtml(prefs)}</div>`;
  const tail = '<div class="bulk" hidden></div><div class="toast" hidden></div>';
  if (all.length === 0) return `${head}<div class="empty">No sessions on this project right now.</div>${tail}`;
  const pin = (cls: string, name: string, items: typeof mine) => items.length ? `<div class="pinned${cls}"><div class="ph">${name} <span class="n">${items.length}</span></div>${items.map((x) => card(x, true)).join('')}</div>` : '';
  type Group = { key: string; name: string; sub: string; icon: string; items: typeof rest; action?: string };
  const folded = new Set(prefs.folded);
  const section = (g: Group) => {
    const counts = new Map<SessionStateKey, number>();
    for (const { row } of g.items) { const k = sessionStateOf(row); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const dots = [...counts].map(([k, n]) => `<i class="d-${DOT_TONE[k]}" title="${n} ${SESSION_STATE_WORD[k]}"></i>`).join('');
    // A folded group opens while it holds the selected session (the front tab included).
    const closed = folded.has(g.key) && !g.items.some(({ row }) => row.sessionId === opts.selectedId);
    return `<section class="grp${closed ? ' closed' : ''}" data-group="${escapeHtml(g.key)}">
      <div class="gh" role="button" tabindex="0" aria-expanded="${!closed}"><span class="car">▾</span><span class="gi-box">${g.icon}</span><span class="gname"><b>${escapeHtml(g.name)}</b> <span class="n">${g.items.length}</span>${g.sub ? ` <span class="gs">· ${escapeHtml(g.sub)}</span>` : ''}</span>${g.action ? `<button class="gact" data-act="close-all" title="Close every tab here whose agent is not running">Close all</button>` : ''}<span class="dots">${dots}</span></div>
      <div class="items">${closed ? '' : sortRows(g.items, prefs.sort).map((x) => card(x)).join('')}</div>
    </section>`;
  };
  const byBall = (b: 'review' | 'idle') => all.filter((x) => ball(x.row) === b && !tabHere(x));
  const ballIcon = (b: 'review' | 'idle') => `<span class="pill st-${b} solo"><i></i></span>`;
  const pinned = pin(' now', 'Needs you now', pressing) + pin('', 'Asks', asks)
    + [{ key: 'review', name: BALL_WORD.review, sub: '', icon: ballIcon('review'), items: byBall('review') },
      { key: IDLE_GROUP, name: BALL_WORD.idle, sub: 'finished, no tab here', icon: ballIcon('idle'), items: byBall('idle') }]
      .filter((g) => g.items.length).map(section).join('');
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
    groups = (['running', 'ended'] as const).map((b) => ({ key: `state:${b}`, name: BALL_WORD[b], sub: '', icon: `<span class="pill st-${b === 'running' ? 'working' : 'ended'} solo"><i></i></span>`, items: rest.filter((x) => ballOf(sessionStateOf(x.row)) === b) }));
    // A finished turn whose tab is open here is neither running nor ended.
    const finished = rest.filter((x) => tabHere(x) && ball(x.row) !== 'running' && ball(x.row) !== 'ended');
    groups.splice(1, 0, { key: 'state:here', name: 'Open tabs', sub: 'finished', icon: finished.length ? placeIcon(finished[0].place, here) : '', items: finished });
  } else {
    return head + pinned + `<div class="flat">${sortRows(rest, prefs.sort).map((x) => card(x)).join('')}</div>` + tail;
  }
  return head + pinned + groups.filter((g) => g.items.length).map(section).join('') + tail;
}

/** The tab's numbers: live sessions, the asks (never an idle turn), tabs held here. */
export function sessionCount(rows: SessionLike[], here?: SessionHere, prefs: SessionListPrefs = DEFAULT_SESSION_PREFS): { shown: number; asks: number; tabs: number } {
  const items = here ? visibleSessions(rows, here, prefs) : rows.map((row) => ({ row, place: null as SessionPlace | null }));
  return {
    shown: items.filter(({ row }) => sessionStateOf(row) !== 'ended').length,
    asks: items.filter(({ row }) => ballOf(sessionStateOf(row)) === 'move').length,
    tabs: rows.filter((s) => s.tabHere).length,
  };
}

const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

const PRIORITY_TITLE: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

/** Signal bars: urgent and high are three bars, medium two, low one. */
function priorityBars(p: number): string {
  const lit = p === 1 || p === 2 ? 3 : p === 3 ? 2 : p === 4 ? 1 : 0;
  return `<span class="pri p${p}" role="img" aria-label="${PRIORITY_TITLE[p] ?? 'No priority'}" title="${PRIORITY_TITLE[p] ?? 'No priority'}">${[1, 2, 3].map((i) => `<i class="${i <= lit ? 'on' : ''}" style="height:${2 + i * 3}px"></i>`).join('')}</span>`;
}

/** A person as a colored initial (the hue fixed by their name); an agent member
 *  Linear delegates to (claude, codex1, grok…) as its harness logo. */
function personAvatar(name: string | null): string {
  if (!name) return '';
  const key = name.toLowerCase().replace(/\[bot\]$/, '').replace(/^app\//, '').replace(/\d+$/, '');
  const logo = harnessLogo(key);
  if (logo) return `<span class="iav agent" title="Delegated to ${escapeHtml(name)}">${logo}</span>`;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
  return `<span class="iav av${h % 6}" title="${escapeHtml(name)}">${escapeHtml(initials)}</span>`;
}

export function renderTickets(groups: TicketGroup[]): string {
  if (groups.length === 0) return '<div class="empty">No open tickets in this project.</div>';
  return groups.map((g, gi) => `<details ${gi < 2 ? 'open' : ''}>
    <summary>${escapeHtml(g.state)} <span class="n">${g.tickets.length}</span></summary>
    <ul>${g.tickets.map((t) => `<li><a class="trow" href="#" data-ticket="${escapeHtml(t.identifier)}">${priorityBars(t.priority)}<span class="tm"><span class="t">${escapeHtml(t.title)}</span><span class="sub">${escapeHtml(t.identifier)}${t.milestone ? ` · ${escapeHtml(t.milestone)}` : ''}</span></span><span class="who">${personAvatar(t.delegate)}${personAvatar(t.assignee)}</span></a></li>`).join('')}</ul>
  </details>`).join('');
}

function ring(state: string | null, draft: boolean): string {
  const tone = draft ? 'draft' : state === 'SUCCESS' ? 'ok' : state === 'FAILURE' || state === 'ERROR' ? 'bad' : state ? 'run' : 'none';
  const words = draft ? 'Draft' : tone === 'ok' ? 'Checks passed' : tone === 'bad' ? 'Checks failing' : tone === 'run' ? 'Checks running' : 'No checks';
  return `<span class="ring r-${tone}" role="img" aria-label="${words}" title="${words}"><svg viewBox="0 0 18 18"><circle class="trk" cx="9" cy="9" r="7"/><circle class="arc" cx="9" cy="9" r="7"/>${tone === 'ok' ? '<path class="chk" d="M5.8 9.2l2.2 2.2 4.2-4.6"/>' : ''}</svg></span>`;
}

type ReviewGroup = 'status' | 'repo' | 'author' | 'none';

/** The Review tab's ⇅ choices: grouping, and whether drafts and recent merges show. */
export interface ReviewPrefs { group: ReviewGroup; showDrafts: boolean; showMerged: boolean }

export const DEFAULT_REVIEW_PREFS: ReviewPrefs = { group: 'status', showDrafts: false, showMerged: false };

export function readReviewPrefs(v: unknown): ReviewPrefs {
  const o = v && typeof v === 'object' ? (v as Partial<ReviewPrefs>) : {};
  return {
    group: o.group === 'status' || o.group === 'repo' || o.group === 'author' || o.group === 'none' ? o.group : DEFAULT_REVIEW_PREFS.group,
    showDrafts: typeof o.showDrafts === 'boolean' ? o.showDrafts : DEFAULT_REVIEW_PREFS.showDrafts,
    showMerged: typeof o.showMerged === 'boolean' ? o.showMerged : DEFAULT_REVIEW_PREFS.showMerged,
  };
}

/** One ⇅ change applied; null for a key or value it does not know. */
export function applyReviewPref(p: ReviewPrefs, key: string, value: string): ReviewPrefs | null {
  if (key === 'group' && (value === 'status' || value === 'repo' || value === 'author' || value === 'none')) return { ...p, group: value };
  if ((key === 'showDrafts' || key === 'showMerged') && (value === 'true' || value === 'false')) return { ...p, [key]: value === 'true' };
  return null;
}

interface ReviewOptions { prefs: ReviewPrefs; mergeWith: string }

const METHOD_WORD: Record<string, string> = { squash: 'squash', rebase: 'rebase', merge: 'a merge commit' };

type PrState = 'ready' | 'running' | 'failing' | 'draft';
function prState(p: PrRow): PrState {
  if (p.isDraft) return 'draft';
  if (p.ciState === 'FAILURE' || p.ciState === 'ERROR') return 'failing';
  if (p.ciState && p.ciState !== 'SUCCESS') return 'running';
  return 'ready';
}

/** The PR's state as its rightmost control: Merge (one click, then Undo) when checks
 *  pass, else the checks in a word or two (owner, 2026-10-12 9:00 PM). */
function prStatusCell(p: PrRow, slug: string, mergeWith: string): string {
  const st = prState(p);
  if (st === 'ready') return `<button class="rs merge" data-merge-repo="${escapeHtml(slug)}" data-merge-number="${p.number}"${p.headSha ? ` data-merge-sha="${escapeHtml(p.headSha)}"` : ''} title="Merge #${p.number} with ${METHOD_WORD[mergeWith] ?? mergeWith} (change in Settings)">Merge</button>`;
  if (st === 'failing') return `<span class="rs fail" title="${p.failing ? `${p.failing} check${p.failing === 1 ? '' : 's'} failing` : 'Checks failing'}">✕${p.failing ? ` ${p.failing}` : ''}</span>`;
  if (st === 'running') return `<span class="rs run" title="Checks running">${ring(p.ciState, false)}</span>`;
  return '<span class="rs draft">Draft</span>';
}

function prFace(p: PrRow): string {
  return p.avatar ? `<img class="pav" src="${escapeHtml(p.avatar)}" alt="${escapeHtml(p.author)}" title="${escapeHtml(p.author)}">` : personAvatar(p.author) || '<span class="iav av0">?</span>';
}

function prLine(p: PrRow, slug: string, now: number, mergeWith: string, showRepo: boolean): string {
  const age = relAge(Date.parse(p.date), now);
  return `<li class="prli">${prFace(p)}<a class="prow" href="#" data-url="${escapeHtml(p.url)}"><span class="tm"><span class="t">${escapeHtml(p.title)}</span><span class="sub">#${p.number}${showRepo ? ` · ${escapeHtml(slug.split('/')[1] ?? slug)}` : ''} · ${age}</span></span></a>${prStatusCell(p, slug, mergeWith)}</li>`;
}

function reviewMenu(p: ReviewPrefs): string {
  const item = (on: boolean, label: string, key: string, value: string) => `<button role="menuitemcheckbox" aria-checked="${on}" data-rpref="${key}" data-value="${value}"><span class="ck">${on ? '✓' : ''}</span>${label}</button>`;
  return `<div class="menu" role="menu" hidden>
    <div class="sec">Group</div>${item(p.group === 'status', 'Status, ready first', 'group', 'status')}${item(p.group === 'repo', 'Repository', 'group', 'repo')}${item(p.group === 'author', 'Author', 'group', 'author')}${item(p.group === 'none', 'None', 'group', 'none')}<hr>
    <div class="sec">Show</div>${item(p.showDrafts, 'Drafts', 'showDrafts', String(!p.showDrafts))}${item(p.showMerged, 'Recently merged', 'showMerged', String(!p.showMerged))}
  </div>`;
}

/** Review while repositories answer one by one: each finished one draws its PRs, the rest say they are being read. */
export function renderPrsProgress(slugs: string[], done: Map<string, PrsModel['repos'][number]>, now: number, opts: ReviewOptions): string {
  const ready = slugs.flatMap((s) => { const r = done.get(s); return r ? [r] : []; });
  const waiting = slugs.filter((s) => !done.has(s));
  const body = renderPrs({ repos: ready, partial: false }, now, opts, waiting);
  return body;
}

export function renderPrs(m: PrsModel, now: number, opts: ReviewOptions, reading: string[] = []): string {
  const { prefs, mergeWith } = opts;
  const all = m.repos.flatMap((r) => r.open.map((p) => ({ p, slug: r.slug })));
  const shown = all.filter(({ p }) => prefs.showDrafts || !p.isDraft);
  const hidden = all.length - shown.length;
  const head = `<div class="shead"><span class="label">Review</span><span class="sum">${shown.length} open${hidden ? ` · ${hidden} draft${hidden === 1 ? '' : 's'} hidden` : ''}</span><button class="icon" data-menu aria-haspopup="menu" aria-expanded="false" title="Group and show" aria-label="Group and show">${glyph('sort')}</button>${reviewMenu(prefs)}</div>`;
  const partial = m.partial ? '<div class="warn">Some repositories could not be read; this list is incomplete.</div>' : '';
  const readingLine = reading.length ? `<div class="reading">Reading ${reading.map((w) => escapeHtml(w.split('/').pop() ?? w)).join(', ')}…</div>` : '';
  const errors = m.repos.filter((r) => r.error).map((r) => `<div class="err">${escapeHtml(r.slug)}: could not read: ${escapeHtml(r.error!)}</div>`).join('');
  if (!m.repos.length && !reading.length) return head + '<div class="empty">This project has no attached repositories.</div>';
  const many = m.repos.length > 1;
  const section = (name: string, items: { p: PrRow; slug: string }[], cls = '', extra = '', showRepo = many) =>
    items.length ? `<section class="rgrp ${cls}"><div class="head"><span class="label">${escapeHtml(name)}</span>${extra}<span class="n">${items.length}</span></div><ul>${items.map(({ p, slug }) => prLine(p, slug, now, mergeWith, showRepo)).join('')}</ul></section>` : '';
  let body = '';
  if (prefs.group === 'status') {
    const by = (st: PrState) => shown.filter(({ p }) => prState(p) === st);
    body = section('Ready to merge', by('ready'), 'g-ready') + section('Checks running', by('running')) + section('Failing', by('failing'), 'g-fail') + section('Drafts', by('draft'));
  } else if (prefs.group === 'repo') {
    body = m.repos.filter((r) => !r.error).map((r) => {
      const branch = r.branch ? `<span class="rmeta" title="${escapeHtml(r.branch.name)}: ${escapeHtml(r.branch.ciState ?? 'no CI')}">${ring(r.branch.ciState, false)}${escapeHtml(r.branch.name)}</span>` : '';
      return section(r.slug.split('/')[1] ?? r.slug, shown.filter((x) => x.slug === r.slug), '', branch, false);
    }).join('');
  } else if (prefs.group === 'author') {
    body = [...new Set(shown.map(({ p }) => p.author))].map((a) => section(a, shown.filter(({ p }) => p.author === a))).join('');
  } else {
    body = section('Open', shown);
  }
  const merged = prefs.showMerged ? m.repos.flatMap((r) => r.merged.map((p) => ({ p, slug: r.slug }))).sort((a, b) => Date.parse(b.p.date) - Date.parse(a.p.date)) : [];
  const mergedHtml = merged.length ? `<section class="rgrp"><div class="head"><span class="label">Recently merged</span><span class="n">${merged.length}</span></div><ul>${merged.map(({ p, slug }) => `<li class="prli">${prFace(p)}<a class="prow" href="#" data-url="${escapeHtml(p.url)}"><span class="tm"><span class="t">${escapeHtml(p.title)}</span><span class="sub">#${p.number}${many ? ` · ${escapeHtml(slug.split('/')[1] ?? slug)}` : ''} · merged ${relAge(Date.parse(p.date), now)}</span></span></a><span class="rs done">Merged</span></li>`).join('')}</ul></section>` : '';
  const none = !body && !readingLine ? `<div class="quiet">No open pull requests${hidden ? ' except drafts' : ''}.</div>` : '';
  return head + partial + readingLine + errors + body + none + mergedHtml + '<div class="toast" hidden></div>';
}
