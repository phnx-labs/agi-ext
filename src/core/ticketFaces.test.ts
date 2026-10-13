import { test, expect } from 'bun:test';
import { rememberTicket, rememberTicketGroups, ticketFace } from './ticketFaces';

test('a ticket nobody read shows its id alone; an Issues read or a detail read fills its title and state', () => {
  expect(ticketFace('PHNX-9001')).toEqual({ id: 'PHNX-9001' });
  const groups = [{ state: 'In Progress', tickets: [{ identifier: 'PHNX-9001', title: 'Ship round 13', priority: 2, milestone: null, assignee: null, delegate: null }] }];
  expect(rememberTicketGroups(groups)).toBe(true);
  expect(rememberTicketGroups(groups)).toBe(false);
  expect(ticketFace('PHNX-9001')).toEqual({ id: 'PHNX-9001', title: 'Ship round 13', state: 'In Progress' });
  expect(rememberTicket({ identifier: 'PHNX-9001', title: 'Ship round 13', state: 'Done' })).toBe(true);
  expect(ticketFace('PHNX-9001').state).toBe('Done');
});
