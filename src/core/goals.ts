import { escapeHtml } from '../shared/sessionCards';

// The goals the Project panel shows above its tabs (owner, 2026-10-12: "show the
// company goal, then my goal: what I'm focusing on today; succinct, not a block").
// Read from one `linear goals --json`: the company initiative, this week's cycle
// goal, and my day goal (an issue). One quiet line; the week and the day ride the tooltip.

interface Milestone { name: string; project: string; target?: string; progress?: number }

export interface Goals {
  company?: { name: string; target?: string; url?: string };
  /** The company's project milestones; the panel shows the shown project's next one. */
  milestones?: Milestone[];
  week?: string;
  today?: { id: string; title: string; url?: string; due?: string };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function parseGoals(stdout: string): Goals {
  const raw = JSON.parse(stdout) as Record<string, any>;
  const init = raw?.company?.initiative;
  const day = raw?.me?.dayGoal;
  const goals: Goals = {};
  const name = str(init?.name);
  if (name) goals.company = { name, target: str(init?.targetDate), url: str(init?.url) };
  const milestones = (Array.isArray(raw?.company?.milestones) ? raw.company.milestones : [])
    .map((m: Record<string, unknown>) => ({ name: str(m?.name), project: str(m?.project), target: str(m?.targetDate), progress: typeof m?.progress === 'number' ? m.progress : undefined }))
    .filter((m: Partial<Milestone>): m is Milestone => !!m.name && !!m.project);
  if (milestones.length) goals.milestones = milestones;
  const week = str(raw?.week?.goal) ?? str(raw?.week?.cycle?.name);
  if (week) goals.week = week;
  const id = str(day?.identifier);
  const title = str(day?.title);
  if (id && title) goals.today = { id, title, url: str(day?.url), due: str(day?.dueDate) };
  return goals;
}

function shortDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The project's next milestone: the earliest unfinished one by target date. */
export function nextMilestone(goals: Goals, linearName: string | null | undefined): Milestone | undefined {
  if (!linearName) return undefined;
  const mine = (goals.milestones ?? []).filter((m) => m.project.toLowerCase() === linearName.toLowerCase() && (m.progress ?? 0) < 100);
  return mine.sort((a, b) => (a.target ?? '9999').localeCompare(b.target ?? '9999'))[0];
}

/** One quiet line on the panel's header row (owner video, 2026-10-18 8:59 PM: one row, not
 *  two): the project's next milestone with its date and progress (owner video, 2026-10-22
 *  6:42 AM), else ◎ the company goal with its date; the rest in its tooltip; with neither,
 *  ☀ Today. The ☀ filter on Sessions still finds today's sessions. */
export function renderGoals(goals: Goals, linearName?: string | null): string {
  const today = goals.today ? `Today · ${goals.today.id}: ${goals.today.title}` : '';
  const ms = nextMilestone(goals, linearName);
  if (ms) {
    const tip = [`${ms.project} milestone${ms.progress !== undefined ? ` · ${ms.progress}% done` : ''}`, goals.company ? `Company goal: ${goals.company.name}` : '', goals.week ? `this week: ${goals.week}` : '', today].filter(Boolean).join('\n');
    return `<a class="gl1" href="#"${goals.company?.url ? ` data-url="${escapeHtml(goals.company.url)}"` : ''} title="${escapeHtml(tip)}"><span class="gk">◇</span><span class="gtx">${escapeHtml(ms.name)}</span><span class="gm">${escapeHtml([shortDate(ms.target), ms.progress !== undefined ? `${ms.progress}%` : ''].filter(Boolean).join(' · '))}</span></a>`;
  }
  if (goals.company) {
    const tip = ['Company goal', goals.week ? `this week: ${goals.week}` : '', today].filter(Boolean).join('\n');
    return `<a class="gl1" href="#"${goals.company.url ? ` data-url="${escapeHtml(goals.company.url)}"` : ''} title="${escapeHtml(tip)}"><span class="gk">◎</span><span class="gtx">${escapeHtml(goals.company.name)}</span><span class="gm">${escapeHtml(shortDate(goals.company.target))}</span></a>`;
  }
  if (goals.today) {
    return `<a class="gl2" href="#"${goals.today.url ? ` data-url="${escapeHtml(goals.today.url)}"` : ''} title="${escapeHtml(today)}"><span class="gk">☀</span><span class="gtx"><b>Today</b> ${escapeHtml(goals.today.title)}</span><span class="gm">${escapeHtml(goals.today.id)}</span></a>`;
  }
  return '';
}
