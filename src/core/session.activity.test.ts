import { describe, test, expect } from 'bun:test';
import { todoProgressFromItems } from './session.activity';
import type { TodoProgressItem } from './session.activity';

// todoProgressFromItems tallies an ALREADY-normalized checklist
// (RemoteSession.todos, structurally TodoProgressItem[]) — what the instant
// sidebar reads off the CLI stream (PHNX-3517).
describe('todoProgressFromItems', () => {
  const items = (statuses: TodoProgressItem['status'][]): TodoProgressItem[] =>
    statuses.map((status, i) => ({ content: `task ${i}`, status }));

  test('counts done as completed-only, total as length', () => {
    const p = todoProgressFromItems(items(['completed', 'completed', 'in_progress', 'pending']));
    expect(p).toEqual({
      todos: items(['completed', 'completed', 'in_progress', 'pending']),
      done: 2,
      total: 4,
    });
  });

  test('in_progress does not count toward done', () => {
    expect(todoProgressFromItems(items(['in_progress']))?.done).toBe(0);
    expect(todoProgressFromItems(items(['completed']))?.done).toBe(1);
  });

  test('returns null for empty / undefined / null', () => {
    expect(todoProgressFromItems([])).toBeNull();
    expect(todoProgressFromItems(undefined)).toBeNull();
    expect(todoProgressFromItems(null)).toBeNull();
  });
});
