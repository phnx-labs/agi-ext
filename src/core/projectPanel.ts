// Pure model + HTML for the Project container in the left sidebar (PHNX-4289).
// Each section is one CLI read: `agents projects status <name> --json` (Overview),
// `linear tasks --project <linear> --json` (Tickets, and Overview's state bar),
// `agents projects prs list <name> --json` (Pull requests). Sessions come from the
// session stream rows already in the presentation store, filtered on the CLI's
// `confirmedProject`. Parsers fail loud on a shape they do not know;
// the provider turns that into the section's error state, never an empty list.

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

/** The stream-row fields a session row draws; a subset of RemoteSession. */
export interface SessionLike {
  sessionId: string;
  host: string;
  title: string;
  label: string;
  topic: string;
  phase: 'running' | 'idle' | 'waiting' | 'failed' | 'done';
  liveStatus: string;
  attention?: { kind: string; state: string; question?: { text?: string } };
  lastResponse: string;
  activity: string;
  ticket: string | null;
  prStatus?: { number: number; checks?: 'passing' | 'failing' | 'pending'; isDraft: boolean; state?: string };
  artifacts: unknown[];
  files?: { total: number };
  lastActivityMs: number;
  confirmedProject: string | null;
}

/** What the row's right-hand icon says. Order is the attention order: a session
 *  that stopped making progress ranks above one that is working (AGENTS.md). */
export type SessionMark = 'asks' | 'stopped' | 'failed' | 'working' | 'idle' | 'done';
const MARK_RANK: Record<SessionMark, number> = { asks: 0, stopped: 1, failed: 2, working: 3, idle: 4, done: 5 };

export function sessionMark(s: SessionLike): SessionMark {
  const open = s.attention?.state === 'open' ? s.attention.kind : '';
  if (open === 'question' || open === 'permission' || open === 'plan_review' || open === 'declared') return 'asks';
  if (open === 'stall' || s.liveStatus === 'orphaned' || s.liveStatus === 'crashed' || s.liveStatus === 'abandoned') return 'stopped';
  if (open === 'failure' || s.phase === 'failed') return 'failed';
  if (s.phase === 'running' || s.phase === 'waiting') return 'working';
  if (s.phase === 'done') return 'done';
  return 'idle';
}

/** The project's sessions, attention first, newest first within a mark. */
export function projectSessions(rows: SessionLike[], project: string): SessionLike[] {
  const want = project.toLowerCase();
  return rows
    .filter((r) => (r.confirmedProject || '').toLowerCase() === want)
    .sort((a, b) => MARK_RANK[sessionMark(a)] - MARK_RANK[sessionMark(b)] || b.lastActivityMs - a.lastActivityMs);
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
};
function icon(name: string, title: string): string {
  return `<svg class="ic" viewBox="0 0 16 16" role="img" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title>${ICON[name]}</svg>`;
}

const MARK_TITLE: Record<SessionMark, string> = { asks: 'Asking you', stopped: 'Stopped with work left', failed: 'Failed', working: 'Working', idle: 'Idle', done: 'Done' };
const MARK_GLYPH: Record<SessionMark, string> = { asks: '?', stopped: '!', failed: '✕', working: '', idle: '', done: '✓' };

function prMini(pr: NonNullable<SessionLike['prStatus']>): string {
  const tone = pr.state === 'merged' ? 'ok' : pr.isDraft ? 'draft' : pr.checks === 'passing' ? 'ok' : pr.checks === 'failing' ? 'bad' : 'run';
  const words = pr.state === 'merged' ? 'merged' : pr.isDraft ? 'draft' : pr.checks === 'passing' ? 'ready to merge' : pr.checks === 'failing' ? 'checks failing' : 'checks running';
  return `<span class="fact pr-${tone}" title="PR #${pr.number}: ${words}">${icon('pr', `PR #${pr.number}: ${words}`)}#${pr.number}</span>`;
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

/** Three lines: what it is, what it last said or asks, the facts you act on. The
 *  state is the icon on the right, never a word in the text. */
export function renderSessionRow(s: SessionLike, now: number, selected: boolean): string {
  const mark = sessionMark(s);
  const name = s.title || s.label || s.topic || 'Untitled';
  const said = (mark === 'asks' && s.attention?.question?.text) || s.lastResponse || '';
  // The CLI's preview line is a tool call while the agent works ("Bash: cmd").
  const saidIsTool = !!said && TOOL_LINE.test(said.trim());
  const facts = [
    `<span class="fact" title="${escapeHtml(s.host)}">${icon('host', s.host)}${escapeHtml(s.host.replace(/^yosemite-/, ''))}</span>`,
    s.lastActivityMs ? `<span class="fact">${icon('clock', 'Last activity')}${relAge(s.lastActivityMs, now)}</span>` : '',
    s.ticket ? `<span class="fact">${icon('ticket', s.ticket)}${escapeHtml(s.ticket)}</span>` : '',
    s.prStatus ? prMini(s.prStatus) : '',
    s.artifacts.length ? `<span class="fact" title="${s.artifacts.length} artifacts">${icon('image', `${s.artifacts.length} artifacts`)}${s.artifacts.length}</span>` : '',
    s.files && s.files.total ? `<span class="fact" title="${s.files.total} files changed">${icon('file', `${s.files.total} files changed`)}${s.files.total}</span>` : '',
  ].filter(Boolean).join('');
  return `<button type="button" class="srow${selected ? ' sel' : ''}" data-session="${escapeHtml(s.sessionId)}" data-host="${escapeHtml(s.host)}">
    <span class="l1">${escapeHtml(name)}</span><span class="mark m-${mark}" role="img" aria-label="${MARK_TITLE[mark]}" title="${MARK_TITLE[mark]}">${MARK_GLYPH[mark]}</span>
    ${said && !saidIsTool ? `<span class="l2">${escapeHtml(said.replace(/\s+/g, ' ').trim())}</span>` : (said || s.activity) ? `<span class="l2 act">${activityLine(said || s.activity)}</span>` : ''}
    <span class="l3">${facts}</span></button>`;
}

export function renderSessions(rows: SessionLike[], now: number, selectedId: string | null): string {
  if (rows.length === 0) return '<div class="empty">No sessions on this project right now.</div>';
  const active = rows.filter((r) => { const m = sessionMark(r); return m !== 'idle' && m !== 'done'; });
  const quiet = rows.filter((r) => { const m = sessionMark(r); return m === 'idle' || m === 'done'; });
  return active.map((r) => renderSessionRow(r, now, r.sessionId === selectedId)).join('') +
    (quiet.length ? `<details class="quiet"><summary>${quiet.length} idle or done</summary>${quiet.map((r) => renderSessionRow(r, now, r.sessionId === selectedId)).join('')}</details>` : '');
}

const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

const STATE_TONE: Record<string, string> = { Doing: 'doing', 'In Progress': 'doing', 'In Review': 'review', Todo: 'todo', Backlog: 'backlog' };

/** Overview: progress, a bar of open tickets by state, and the milestone that is
 *  current, or a plain statement that there is none. */
export function renderOverview(m: OverviewModel, today: string, groups: TicketGroup[] = []): string {
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
    ${stateBar}
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
      ${r.merged.length ? `<details><summary>merged <span class="n">${r.merged.length}</span></summary><ul>${r.merged.map((p) => `<li><a class="prow" href="#" data-url="${escapeHtml(p.url)}">${ring(p.ciState, false)}<span class="tm"><span class="t">${escapeHtml(p.title)}</span><span class="sub">#${p.number} · ${age(p.date)}</span></span></a></li>`).join('')}</ul></details>` : ''}
    </section>`;
  }).join('');
}
