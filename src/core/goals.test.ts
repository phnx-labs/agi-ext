import { expect, test } from 'bun:test';
import { goalTitle, issuesMenu, parseGoals } from './goals';

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

test("the view's title names the next unfinished milestone, else the company goal, else today's ticket (owner, 2026-10-27 1:26 PM)", () => {
  const raw = JSON.parse(RAW);
  raw.company.milestones = [
    { name: '0.2.2 - Better and safer integrations', project: 'Rush', targetDate: '2026-10-26', progress: 2 },
    { name: '0.2.0 - Done already', project: 'Rush', targetDate: '2026-10-01', progress: 100 },
    { name: '0.2.1 - Stable for running agents', project: 'Rush', targetDate: '2026-10-23', progress: 12 },
    { name: 'Other project', project: 'AGI UI', targetDate: '2026-10-20', progress: 0 },
  ];
  const goals = parseGoals(JSON.stringify(raw));
  expect(goals.milestones).toHaveLength(4);
  expect(goalTitle(goals, 'rush')).toBe('0.2.1 - Stable for running agents');
  // The milestone picked in Issues' ⇅ is the one named.
  expect(goalTitle(goals, 'rush', '0.2.2 - Better and safer integrations')).toBe('0.2.2 - Better and safer integrations');
  // A project with no milestone, or no Linear project, keeps the company goal; with none, today's ticket; else nothing.
  expect(goalTitle(goals, 'Nothing here')).toBe('Rush Cloud - first paying customers');
  expect(goalTitle(goals)).toBe('Rush Cloud - first paying customers');
  expect(goalTitle({ today: { id: 'PHNX-4353', title: 'Ship it', url: 'https://linear.app/x/issue/PHNX-4353' } })).toBe('Ship it');
  expect(goalTitle({})).toBe('');
  // Issues' ⇅ lists the open milestones, ✓ on the one shown; a project with none has no menu.
  const menu = issuesMenu(goals, 'rush', '0.2.2 - Better and safer integrations')!;
  expect(menu).toContain('data-milestone="0.2.1 - Stable for running agents"');
  expect(menu).toContain('aria-checked="true" data-milestone="0.2.2 - Better and safer integrations"');
  expect(menu).not.toContain('Done already');
  expect(issuesMenu(goals, 'Nothing here')).toBeNull();
});
