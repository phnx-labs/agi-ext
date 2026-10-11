// Pure model + HTML for the Project sidebar panel (PHNX-4289).
// Each section is one CLI read: `agents projects status <name> --json` (Overview),
// `linear tasks --project <linear> --json` (Tickets, and Overview's state bar),
// `agents projects prs list <name> --json` (Pull requests). Sessions come from the
// session stream rows already in the presentation store, filtered on the CLI's
// `confirmedProject`. Parsers fail loud on a shape they do not know;
// the provider turns that into the section's error state, never an empty list.

import { SESSION_STATE_WORD, sessionStateOf, type SessionStateKey } from '../shared/sessionState';

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
  request?: { headline?: string };
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

/** Whether a tab holds the session somewhere: the CLI names it ("Codium tab 3"),
 *  or says "detached" when only a background process is left. */
function heldInTab(s: Pick<SessionLike, 'viewingIn'>): boolean {
  return !!s.viewingIn && s.viewingIn !== 'detached';
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

const LIVE: ReadonlySet<SessionStateKey> = new Set(['working', 'yours', 'unknown']);

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

const STATE_GLYPH: Record<SessionStateKey, string> = { asks: '?', stopped: '!', working: '', yours: '', ended: '', unknown: '' };

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

/** A card says what is going on: the title and when it last moved, your last ask
 *  (with the images you pasted), where the agent is now in its own words, and the
 *  facts you act on. Its state is the icon; the device is in the tooltip. */
export function renderSessionCard(s: SessionLike, now: number, selected: boolean, thumbs: CardThumb[] = []): string {
  const state = sessionStateOf(s);
  const title = plain(s.title || s.topic || s.label || s.request?.headline || 'Untitled');
  const asked = s.request?.headline ? plain(s.request.headline) : '';
  const question = state === 'asks' ? plain(s.question?.text || s.attention?.question?.text || '') : '';
  const said = agentLine(s);
  const live = state === 'working' && s.activity && !said.startsWith(plain(s.activity).slice(0, 40)) ? s.activity : '';
  const isLive = LIVE.has(state) || state === 'asks';
  const bg = isLive ? backgroundKind(s) : null;
  const leftover = state === 'ended' && !!s.tabHere;
  const where = s.worktreeSlug || (s.branch && s.branch !== 'main' && s.branch !== 'master' ? s.branch : '');
  const chips = [
    leftover ? `<span class="chip warn" title="A tab in this window still shows this session, but its agent is not running">tab open · agent not running</span>` : '',
    bg ? `<span class="chip" title="Running in the background: no tab is attached">${escapeHtml(bg)}</span>` : '',
    s.prStatus ? prMini(s.prStatus) : '',
    s.ticket ? `<span class="chip">${icon('ticket', s.ticket)}${escapeHtml(s.ticket)}</span>` : '',
    where ? `<span class="chip" title="${escapeHtml(where)}">${icon('branch', where)}<span class="trunc">${escapeHtml(where)}</span></span>` : '',
    s.files?.total ? `<span class="chip" title="${s.files.total} files changed">${icon('file', `${s.files.total} files changed`)}${s.files.total}</span>` : '',
  ].filter(Boolean).join('');
  const shown = thumbs.slice(0, 3);
  const more = thumbs.length - shown.length;
  const go = s.resumable === false && !isLive ? '' : leftover ? 'Resume' : isLive && heldInTab(s) ? 'Focus' : 'Open';
  return `<div class="card st-${state}${selected ? ' sel' : ''}" role="button" tabindex="0" data-session="${escapeHtml(s.sessionId)}" data-host="${escapeHtml(s.host)}" title="${escapeHtml(`${SESSION_STATE_WORD[state]} · ${s.host}${heldInTab(s) ? ` · ${s.viewingIn}` : ''}`)}">
    <span class="top"><span class="mk mk-${state}" role="img" aria-label="${SESSION_STATE_WORD[state]}">${STATE_GLYPH[state]}</span><span class="ttl">${escapeHtml(title)}</span><span class="age">${relAge(s.lastActivityMs, now)}</span>${go ? `<span class="go">${go}</span>` : ''}</span>
    ${question ? `<span class="ask">${escapeHtml(question)}</span>` : ''}
    ${asked && asked !== title ? `<span class="line you">${icon('you', 'You asked')}<span>${escapeHtml(asked)}</span></span>` : ''}
    ${shown.length ? `<span class="thumbs">${shown.map((t, i) => `<a class="th" href="#" data-path="${escapeHtml(t.path)}" title="${escapeHtml(t.label)}: open the full image"><img src="${escapeHtml(t.uri)}" alt="${escapeHtml(t.label)}">${i === shown.length - 1 && more > 0 ? `<b>+${more}</b>` : ''}</a>`).join('')}</span>` : ''}
    ${said ? `<span class="line said">${icon('agent', 'The agent')}<span>${escapeHtml(said)}</span></span>` : ''}
    ${live ? `<span class="line live">${icon('run', 'Running now')}<span>${activityLine(live)}</span></span>` : ''}
    ${chips ? `<span class="chips">${chips}</span>` : ''}
  </div>`;
}

/** Every session, grouped by state in attention order. Sessions that never said
 *  anything (a reviewer that finished silently, a one-line run) fold into one line
 *  at the end so they do not bury the ones with something to read. */
export function renderSessions(rows: SessionLike[], now: number, selectedId: string | null, thumbsFor: (s: SessionLike) => CardThumb[] = () => []): string {
  if (rows.length === 0) return '<div class="empty">No sessions on this project right now.</div>';
  const hasContent = (s: SessionLike) => !!(s.request?.headline || s.timeline?.steps.length || s.lastResponse || sessionStateOf(s) === 'asks');
  const card = (s: SessionLike) => renderSessionCard(s, now, s.sessionId === selectedId, thumbsFor(s));
  const shown = rows.filter(hasContent);
  const bare = rows.filter((s) => !hasContent(s));
  const groups: [string, (s: SessionLike) => boolean][] = [
    [SESSION_STATE_WORD.asks, (s) => sessionStateOf(s) === 'asks'],
    [SESSION_STATE_WORD.stopped, (s) => sessionStateOf(s) === 'stopped'],
    ['In your tabs', (s) => LIVE.has(sessionStateOf(s)) && backgroundKind(s) === null],
    ['Background', (s) => LIVE.has(sessionStateOf(s)) && backgroundKind(s) !== null],
    [SESSION_STATE_WORD.ended, (s) => sessionStateOf(s) === 'ended'],
  ];
  return groups.map(([label, pick]) => {
    const group = shown.filter(pick);
    return group.length ? `<div class="divider">${label} <span class="n">${group.length}</span></div>${group.map(card).join('')}` : '';
  }).join('') + (bare.length ? `<details class="bare"><summary>${bare.length} more with nothing to show</summary>${bare.map(card).join('')}</details>` : '');
}

/** What the Sessions tab counts: the sessions with something to read. */
export function sessionCount(rows: SessionLike[]): { shown: number; asks: number } {
  return {
    shown: rows.filter((s) => s.request?.headline || s.timeline?.steps.length || s.lastResponse).length,
    asks: rows.filter((s) => sessionStateOf(s) === 'asks').length,
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
