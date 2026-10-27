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

/** The project's unfinished milestones, earliest target first. */
export function openMilestones(goals: Goals, linearName: string | null | undefined): Milestone[] {
  if (!linearName) return [];
  return (goals.milestones ?? []).filter((m) => m.project.toLowerCase() === linearName.toLowerCase() && (m.progress ?? 0) < 100)
    .sort((a, b) => (a.target ?? '9999').localeCompare(b.target ?? '9999'));
}

/** The project's next milestone: the earliest unfinished one by target date. */
export function nextMilestone(goals: Goals, linearName: string | null | undefined): Milestone | undefined {
  return openMilestones(goals, linearName)[0];
}

const msMeta = (m: Milestone) => [shortDate(m.target), m.progress !== undefined ? `${m.progress}%` : ''].filter(Boolean).join(' · ');

/** The milestone menu Issues' ⇅ opens (owner videos, 2026-10-27 5:48 AM and 1:19 PM):
 *  the project's open milestones, ✓ on the one Issues shows, All milestones, and the
 *  Linear page. A pick is one `milestone` message; the host remembers it per project. */
function milestoneMenu(all: Milestone[], chosen: string | undefined, url: string | undefined): string {
  const item = (value: string, label: string, meta: string) => `<button role="menuitemradio" aria-checked="${chosen === (value || undefined)}" data-milestone="${escapeHtml(value)}"><span class="ck">${chosen === (value || undefined) ? '✓' : ''}</span><span class="mn">${escapeHtml(label)}</span><span class="mm">${escapeHtml(meta)}</span></button>`;
  return `<div class="menu gmenu-pop" role="menu" hidden><div class="sec">Issues shows</div>${item('', 'All milestones', '')}${all.map((m) => item(m.name, m.name, msMeta(m))).join('')}${url ? `<hr><button data-url="${escapeHtml(url)}"><span class="ck"></span><span class="mn">Open goals in Linear</span><span class="mm">↗</span></button>` : ''}</div>`;
}

/** What follows the project in the view's title, "Rush / 0.2.1 - Stable for running agents"
 *  (owner video, 2026-10-27 1:19 PM: the project and its milestone in the top row, no row of
 *  its own): the milestone Issues shows, else the next unfinished one, else the company goal,
 *  else today's ticket; '' with none. */
export function goalTitle(goals: Goals, linearName?: string | null, chosen?: string): string {
  const all = openMilestones(goals, linearName);
  const ms = all.find((m) => m.name === chosen) ?? all[0];
  return ms?.name ?? goals.company?.name ?? goals.today?.title ?? '';
}

/** Issues' ⇅: which milestone it lists; null for a project with no open milestone. */
export function issuesMenu(goals: Goals, linearName?: string | null, chosen?: string): string | null {
  const all = openMilestones(goals, linearName);
  return all.length ? milestoneMenu(all, all.find((m) => m.name === chosen)?.name, goals.company?.url) : null;
}
