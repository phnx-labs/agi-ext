import { expect, test } from 'bun:test';
import { blockedSessions, blockedUpdate, sessionUpdates } from './sessionUpdates';

// Shapes as `agents feed watch --json` appends them (activity.append), from real logs.
const ev = (o: Record<string, unknown>) => ({ v: 1, tier: 'milestone', host: 'yosemite-m6', mailboxId: 'x', ...o });
const EVENTS = [
  ev({ event: 'status.posted', sessionId: 'aaa', ts: '2026-10-12T10:00:00Z', title: 'Prototype v2 ready', detail: 'Chips + Other.', attachments: [{ kind: 'file', href: '/u/a/index.html', name: 'index.html' }] }),
  ev({ event: 'file.edited', sessionId: 'aaa', ts: '2026-10-12T10:05:00Z', detail: 'index.html' }),
  ev({ event: 'status.blocked', sessionId: 'session_aaa', ts: '2026-10-12T11:00:00Z', title: '1.22.48 publish blocked', detail: 'npm token 401 on mac-mini. Need npm login.' }),
  ev({ event: 'status.posted', sessionId: 'bbb', ts: '2026-10-12T09:00:00Z', title: 'Other session' }),
];

test("updates: only this session's status posts, oldest first, with their links; ids match with or without session_", () => {
  const u = sessionUpdates(EVENTS, 'aaa');
  expect(u.map((x) => x.title)).toEqual(['Prototype v2 ready', '1.22.48 publish blocked']);
  expect(u[0]!.links).toEqual([{ name: 'index.html', href: '/u/a/index.html' }]);
  expect(u[1]!.blocked).toBe(true);
  expect(sessionUpdates(EVENTS, 'session_aaa')).toHaveLength(2);
});

test('blocked: the agent says so in its latest post, and it stands until you write after it', () => {
  const u = sessionUpdates(EVENTS, 'aaa');
  expect(blockedUpdate(u, undefined)?.title).toBe('1.22.48 publish blocked');
  expect(blockedUpdate(u, Date.parse('2026-10-12T10:30:00Z'))?.title).toBe('1.22.48 publish blocked');
  expect(blockedUpdate(u, Date.parse('2026-10-12T11:30:00Z'))).toBeUndefined();
  expect(blockedUpdate(sessionUpdates(EVENTS, 'bbb'), undefined)).toBeUndefined();
  expect([...blockedSessions(EVENTS, () => undefined).keys()]).toEqual(['aaa']);
});
