import { escapeHtml } from '../shared/sessionCards';

// The goals the Project panel shows above its tabs (owner, 2026-10-12: "show the
// company goal, then my goal: what I'm focusing on today; succinct, not a block").
// Read from one `linear goals --json`: the company initiative, this week's cycle
// goal, and my day goal (an issue). Two quiet lines; the week rides the tooltip.

export interface Goals {
  company?: { name: string; target?: string; url?: string };
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

/** Two lines: ◎ the company goal (faint; the week's goal in its tooltip), then ☀ Today. */
export function renderGoals(goals: Goals): string {
  const lines: string[] = [];
  if (goals.company) {
    const tip = goals.week ? `Company goal · this week: ${goals.week}` : 'Company goal';
    lines.push(`<a class="gl1" href="#"${goals.company.url ? ` data-url="${escapeHtml(goals.company.url)}"` : ''} title="${escapeHtml(tip)}"><span class="gk">◎</span><span class="gtx">${escapeHtml(goals.company.name)}</span><span class="gm">${escapeHtml(shortDate(goals.company.target))}</span></a>`);
  }
  if (goals.today) {
    lines.push(`<a class="gl2" href="#"${goals.today.url ? ` data-url="${escapeHtml(goals.today.url)}"` : ''} title="${escapeHtml(`Today's goal · ${goals.today.id}`)}"><span class="gk">☀</span><span class="gtx"><b>Today</b> ${escapeHtml(goals.today.title)}</span><span class="gm">${escapeHtml(goals.today.id)}</span></a>`);
  }
  return lines.join('');
}
