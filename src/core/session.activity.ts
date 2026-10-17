/**
 * Session checklist progress, as the panel draws it. The CLI carries the
 * computed checklist on the stream row (`summaryChecklist` / `todos`); this maps
 * it into the panel shape. Per-line transcript parsing for a recent-activity
 * card was removed with that card: the session sidebar's feed reads the CLI's
 * timeline and status posts instead.
 */

type TodoProgressStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoProgressItem {
  content: string;             // the task text
  status: TodoProgressStatus;
  activeForm?: string;         // Claude's present-tense form, when the write carries it
}

/** An agent's current checklist plus a done/total tally for a live progress pill. */
export interface TodoProgress {
  todos: TodoProgressItem[];
  done: number;                // count of status === 'completed'
  total: number;               // todos.length
}

/**
 * Tally an ALREADY-NORMALIZED checklist into TodoProgress. The sidebar reads
 * `RemoteSession.todos` (the CLI-normalized `RemoteTodoItem[]`, structurally a
 * `TodoProgressItem[]`), so there's nothing to parse — only a done/total count.
 * `done`/`total` are computed from the items so a bad upstream tally can't drive
 * the progress bar. Returns null for an empty/absent checklist. Pure — unit-tested.
 */
export function todoProgressFromItems(items: TodoProgressItem[] | undefined | null): TodoProgress | null {
  if (!items || !items.length) return null;
  return { todos: items, done: items.filter((t) => t.status === 'completed').length, total: items.length };
}
