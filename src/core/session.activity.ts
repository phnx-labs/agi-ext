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
 * Distinct from `todoProgressFromCli`, which normalizes the RAW CLI payload.
 * `done`/`total` are computed from the items so a bad upstream tally can't drive
 * the progress bar. Returns null for an empty/absent checklist. Pure — unit-tested.
 */
export function todoProgressFromItems(items: TodoProgressItem[] | undefined | null): TodoProgress | null {
  if (!items || !items.length) return null;
  return { todos: items, done: items.filter((t) => t.status === 'completed').length, total: items.length };
}

/**
 * Map the CLI's computed checklist into the panel's TodoProgress shape (RUSH-1503).
 *
 * The CLI state engine derives the latest `TodoWrite` (Claude) / `update_plan`
 * (Codex) for EVERY agent and carries it on a session's transcript read as
 * `session.todos` ({ items: [{ content, status, activeForm }], done, total }). The
 * extension consumes that here instead of re-parsing the raw transcript itself — one
 * source of truth for checklist state. `done`/`total` are recomputed from the mapped
 * items so a malformed tally can't drive the progress bar. Returns null when the
 * payload carries no usable checklist. Pure, so it's unit-tested.
 */
export function todoProgressFromCli(raw: unknown): TodoProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const todos: TodoProgressItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const content = typeof (it as { content?: unknown }).content === 'string'
      ? ((it as { content: string }).content).trim()
      : '';
    if (!content) continue;
    const item: TodoProgressItem = { content, status: normalizeTodoStatus((it as { status?: unknown }).status) };
    const activeForm = (it as { activeForm?: unknown }).activeForm;
    if (typeof activeForm === 'string' && activeForm.trim()) item.activeForm = activeForm.trim();
    todos.push(item);
  }
  if (todos.length === 0) return null;
  return {
    todos,
    done: todos.filter(t => t.status === 'completed').length,
    total: todos.length,
  };
}

function normalizeTodoStatus(s: unknown): TodoProgressStatus {
  return s === 'completed' || s === 'in_progress' ? s : 'pending';
}
