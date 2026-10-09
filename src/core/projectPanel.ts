// Pure model + HTML for the secondary-sidebar Project container (PHNX-4289).
// Each section is one CLI read: `agents projects status <name> --json` (Overview),
// `linear tasks --project <linear> --json` (Tickets), `agents projects prs list
// <name> --json` (Pull requests). Parsers fail loud on a shape they do not know;
// the provider turns that into the section's error state, never an empty list.

export interface ProjectRef {
  name: string;
  linearName: string | null;
}

export interface Milestone {
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

export interface Ticket {
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

export interface PrRow {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  ciState: string | null;
  author: string;
  date: string;
}

export interface RepoPrs {
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

// ── HTML ──────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

function bar(done: number, total: number): string {
  return `<div class="bar"><span style="width:${pct(done, total)}%"></span></div>`;
}

function link(url: string, inner: string, cls = ''): string {
  return `<a class="${cls}" href="#" data-url="${escapeHtml(url)}" title="${escapeHtml(url)}">${inner}</a>`;
}

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

export function renderOverview(m: OverviewModel, today: string): string {
  const open = m.milestones.filter((x) => x.total === 0 || x.done < x.total);
  const closed = m.milestones.filter((x) => x.total > 0 && x.done >= x.total);
  const byDate = (a: Milestone, b: Milestone) => (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999');
  const msRow = (x: Milestone) => {
    const late = x.targetDate !== null && x.targetDate < today && x.done < x.total;
    const next = x.name === m.nextMilestone ? '<span class="tag">next</span>' : '';
    return `<li class="ms${late ? ' late' : ''}">
      <div class="row"><span class="t">${escapeHtml(x.name)}</span>${next}<span class="n">${x.done}/${x.total}</span></div>
      ${bar(x.done, x.total)}
      ${x.targetDate ? `<div class="sub">${late ? 'overdue · ' : ''}due ${escapeHtml(x.targetDate)}</div>` : ''}
    </li>`;
  };
  const schedule = m.schedule && m.schedule.kind === 'overdue' && m.schedule.milestone
    ? `<div class="warn">${escapeHtml(m.schedule.milestone)} is ${m.schedule.days ?? '?'}d overdue</div>`
    : '';
  return `<section>
    <div class="head"><span class="title">${escapeHtml(m.name)}</span><span class="n">${pct(m.done, m.total)}%</span></div>
    ${m.description ? `<div class="sub">${escapeHtml(m.description)}</div>` : ''}
    ${bar(m.done, m.total)}
    <div class="stats">
      <span><b>${m.inProgress}</b> in progress</span>
      <span><b>${m.total - m.done}</b> open</span>
      <span><b>${m.running}</b> running · ${m.idle} idle</span>
      <span><b>${m.openPrs}</b> open PRs</span>
    </div>
    ${schedule}
    ${m.latestRelease ? `<div class="sub">latest release ${escapeHtml(m.latestRelease.tag)} · ${escapeHtml(shortDate(m.latestRelease.publishedAt))}</div>` : ''}
  </section>
  <section>
    <div class="label">Milestones</div>
    ${m.milestones.length === 0 ? '<div class="empty">No milestones on this project.</div>' : ''}
    <ul>${open.sort(byDate).map(msRow).join('')}</ul>
    ${closed.length > 0 ? `<details><summary>${closed.length} complete</summary><ul>${closed.sort(byDate).map(msRow).join('')}</ul></details>` : ''}
  </section>`;
}

const PRIORITY_LABEL: Record<number, string> = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };

export function renderTickets(groups: TicketGroup[]): string {
  if (groups.length === 0) return '<div class="empty">No open tickets in this project.</div>';
  return groups.map((g) => `<details open>
    <summary>${escapeHtml(g.state)} <span class="n">${g.tickets.length}</span></summary>
    <ul>${g.tickets.map((t) => `<li class="item">
      <div class="row">${link(t.url, escapeHtml(t.identifier), 'id')}<span class="t">${escapeHtml(t.title)}</span></div>
      <div class="sub">${[
        PRIORITY_LABEL[t.priority] ? `<span class="p p${t.priority}">${PRIORITY_LABEL[t.priority]}</span>` : '',
        t.owner ? `@${escapeHtml(t.owner)}` : '',
        t.milestone ? escapeHtml(t.milestone) : '',
      ].filter(Boolean).join(' · ')}</div>
    </li>`).join('')}</ul>
  </details>`).join('');
}

function ciDot(state: string | null): string {
  const cls = state === 'SUCCESS' ? 'ok' : state === 'FAILURE' || state === 'ERROR' ? 'bad' : state ? 'warn' : 'none';
  return `<span class="dot ${cls}" title="${escapeHtml(state ?? 'no CI')}"></span>`;
}

export function renderPrs(m: PrsModel): string {
  const repoHtml = (r: RepoPrs) => {
    if (r.error) return `<section><div class="label">${escapeHtml(r.slug)}</div><div class="err">Fetch failed: ${escapeHtml(r.error)}</div></section>`;
    const prLi = (p: PrRow, merged: boolean) => `<li class="item">
      <div class="row">${ciDot(p.ciState)}${link(p.url, `#${p.number}`, 'id')}<span class="t">${escapeHtml(p.title)}</span>${p.isDraft ? '<span class="tag">draft</span>' : ''}</div>
      <div class="sub">@${escapeHtml(p.author)} · ${merged ? 'merged ' : ''}${escapeHtml(shortDate(p.date))}</div>
    </li>`;
    const meta = [
      r.branch ? `${ciDot(r.branch.ciState)}${escapeHtml(r.branch.name)}` : '',
      r.release ? `${escapeHtml(r.release.tag)}${r.release.npm ? ` · npm ${escapeHtml(r.release.npm)}` : ''} · ${r.release.mergesSince} since` : '',
    ].filter(Boolean).join(' · ');
    return `<section>
      <div class="head"><span class="label">${escapeHtml(r.slug)}</span><span class="n">${r.open.length} open</span></div>
      ${meta ? `<div class="sub">${meta}</div>` : ''}
      <ul>${r.open.map((p) => prLi(p, false)).join('')}</ul>
      ${r.merged.length > 0 ? `<details><summary>recently merged <span class="n">${r.merged.length}</span></summary><ul>${r.merged.map((p) => prLi(p, true)).join('')}</ul></details>` : ''}
    </section>`;
  };
  const partial = m.partial ? '<div class="warn">Some repositories could not be fetched; this list is incomplete.</div>' : '';
  if (m.repos.length === 0) return '<div class="empty">This project has no attached repositories.</div>';
  return partial + m.repos.map(repoHtml).join('');
}
