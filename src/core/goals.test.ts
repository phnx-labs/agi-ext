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

test('goals render as two quiet lines, not a block; the week rides the tooltip', () => {
  const html = renderGoals(parseGoals(RAW));
  expect(html).toContain('class="gl1"');
  expect(html).toContain('title="Company goal · this week: Launch gate green on all three harnesses"');
  expect(html).toContain('<b>Today</b> Make the Rush Cloud infrastructure work with secrets');
  expect(html).toContain('data-url="https://linear.app/x/issue/PHNX-4353"');
  expect((html.match(/<a class="gl/g) || []).length).toBe(2);
  expect(renderGoals({})).toBe('');
});
