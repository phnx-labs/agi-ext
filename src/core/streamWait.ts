// How long a view waits on the merged session stream before it stops saying
// "loading" and shows what it has. Any machine can go quiet (offline, asleep, a bad
// ssh key, an old CLI), so the wait is bounded: after WAIT_BOUND_MS since this
// window began demanding the stream, the view shows its rows and names the machines
// that have not answered. A late answer still merges in, because the store keeps
// applying resets; only the waiting stops.

export const WAIT_BOUND_MS = 8_000;

export interface StreamWait {
  /** Still inside the bound with something missing: show a spinner. */
  waiting: boolean;
  /** Past the bound: machines that have not answered, to name next to the rows. */
  silent: string[];
  /** Past the bound with no reset at all: the stream itself has not answered. */
  streamSilent: boolean;
  /** Milliseconds until the bound passes while still waiting; null otherwise. */
  recheckInMs: number | null;
}

export function streamWait(input: {
  established: boolean;
  pending: readonly string[];
  /** When this window began demanding the stream; undefined when it is not. */
  sinceMs: number | undefined;
  nowMs: number;
  boundMs?: number;
}): StreamWait {
  const bound = input.boundMs ?? WAIT_BOUND_MS;
  const missing = !input.established || input.pending.length > 0;
  // Nothing missing, or this window is not asking for the stream at all: no view is
  // waiting on it, so there is nothing to show as loading and nothing to recheck.
  if (!missing || input.sinceMs === undefined) return { waiting: false, silent: [], streamSilent: false, recheckInMs: null };
  const elapsed = input.nowMs - input.sinceMs;
  if (elapsed < bound) return { waiting: true, silent: [], streamSilent: false, recheckInMs: bound - elapsed };
  return { waiting: false, silent: [...input.pending], streamSilent: !input.established, recheckInMs: null };
}

/** "mark-1 didn't answer", "mark-1 and mac-mini didn't answer"; '' when none. */
export function silentNote(w: Pick<StreamWait, 'silent' | 'streamSilent'>): string {
  if (w.streamSilent) return "the session stream didn't answer";
  if (!w.silent.length) return '';
  const names = w.silent.length === 1 ? w.silent[0]! : `${w.silent.slice(0, -1).join(', ')} and ${w.silent[w.silent.length - 1]}`;
  return `${names} didn't answer`;
}
