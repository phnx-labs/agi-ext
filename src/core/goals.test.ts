import { expect, test } from 'bun:test';
import { parseGoals, renderGoals } from './goals';

// The shape `linear goals --json` returns (2026-10-12), trimmed to what the panel reads.
const RAW = JSON.stringify({
  company: { initiative: { name: 'Rush Cloud - first paying customers', url: 'https://linear.app/x/initiative/a', targetDate: '2026-12-31' } },
  week: { cycle: { name: 'Launch gate green on all three harnesses' }, goal: 'Launch gate green on all three harnesses' },
  me: { weekGoal: null, dayGoal: { identifier: 'PHNX-4353', title: 'Make the Rush Cloud infrastructure work with secrets', url: 'https://linear.app/x/issue/PHNX-4353', dueDate: '2026-10-12' } },
});

test('goals: the company initiative, the week and my day goal, from linear goals --json', () => {
  expect(parseGoals(RAW)).toEqual({
    company: { name: 'Rush Cloud - first paying customers', target: '2026-12-31', url: 'https://linear.app/x/initiative/a' },
    week: 'Launch gate green on all three harnesses',
    today: { id: 'PHNX-4353', title: 'Make the Rush Cloud infrastructure work with secrets', url: 'https://linear.app/x/issue/PHNX-4353', due: '2026-10-12' },
  });
  // No day goal set: no Today line, and nothing invented.
  expect(parseGoals(JSON.stringify({ company: { initiative: { name: 'C' } }, me: { dayGoal: null } }))).toEqual({ company: { name: 'C', target: undefined, url: undefined } });
});

test('goals render as one quiet line for the header row; the week and the day ride the tooltip', () => {
  const html = renderGoals(parseGoals(RAW));
  expect(html).toContain('class="gl1"');
  expect(html).toContain('title="Company goal\nthis week: Launch gate green on all three harnesses\nToday · PHNX-4353: Make the Rush Cloud infrastructure work with secrets"');
  expect((html.match(/<a class="gl/g) || []).length).toBe(1);
  // No company goal: the day goal is the line.
  const day = renderGoals({ today: { id: 'PHNX-4353', title: 'Ship it', url: 'https://linear.app/x/issue/PHNX-4353' } });
  expect(day).toContain('<b>Today</b> Ship it');
  expect(day).toContain('data-url="https://linear.app/x/issue/PHNX-4353"');
  expect(renderGoals({})).toBe('');
});

test("the project's next unfinished milestone leads the line, with its date and progress; the company goal moves to the tooltip (owner video, 2026-10-22 6:42 AM)", () => {
  const raw = JSON.parse(RAW);
  raw.company.milestones = [
    { name: '0.2.2 - Better and safer integrations', project: 'Rush', targetDate: '2026-10-26', progress: 2 },
    { name: '0.2.0 - Done already', project: 'Rush', targetDate: '2026-10-01', progress: 100 },
    { name: '0.2.1 - Stable for running agents', project: 'Rush', targetDate: '2026-10-23', progress: 12 },
    { name: 'Other project', project: 'AGI UI', targetDate: '2026-10-20', progress: 0 },
  ];
  const goals = parseGoals(JSON.stringify(raw));
  expect(goals.milestones).toHaveLength(4);
  const html = renderGoals(goals, 'rush');
  expect(html).toContain('<span class="gk">◇</span><span class="gtx">0.2.1 - Stable for running agents</span><span class="gm">Oct 23 · 12%</span>');
  expect(html).toContain('Company goal: Rush Cloud - first paying customers');
  // A project with no milestone, or no Linear project, keeps the company goal.
  expect(renderGoals(goals, 'Nothing here')).toContain('<span class="gtx">Rush Cloud - first paying customers</span>');
  expect(renderGoals(goals)).toContain('<span class="gtx">Rush Cloud - first paying customers</span>');
});
