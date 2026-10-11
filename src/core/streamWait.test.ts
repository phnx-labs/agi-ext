import { describe, expect, test } from 'bun:test';
import { silentNote, streamWait, WAIT_BOUND_MS } from './streamWait';

// The clock is passed in, so time moves only when a test moves it.
const T0 = 1_000_000;

describe('streamWait', () => {
  test('everything answered: no wait, nothing named', () => {
    expect(streamWait({ established: true, pending: [], sinceMs: T0, nowMs: T0 + 1 }))
      .toEqual({ waiting: false, silent: [], streamSilent: false, recheckInMs: null });
  });

  test('a machine missing inside the bound: wait, and recheck exactly when the bound passes', () => {
    expect(streamWait({ established: true, pending: ['mark-1'], sinceMs: T0, nowMs: T0 + 3_000 }))
      .toEqual({ waiting: true, silent: [], streamSilent: false, recheckInMs: WAIT_BOUND_MS - 3_000 });
  });

  test('past the bound: stop waiting and name the machines that never answered', () => {
    const w = streamWait({ established: true, pending: ['mark-1', 'mac-mini'], sinceMs: T0, nowMs: T0 + WAIT_BOUND_MS });
    expect(w).toEqual({ waiting: false, silent: ['mark-1', 'mac-mini'], streamSilent: false, recheckInMs: null });
    expect(silentNote(w)).toBe("mark-1 and mac-mini didn't answer");
  });

  test('a late answer clears the note: the next read has nothing pending', () => {
    expect(streamWait({ established: true, pending: [], sinceMs: T0, nowMs: T0 + 60_000 }).silent).toEqual([]);
  });

  test('no reset at all past the bound: the stream itself is named', () => {
    const w = streamWait({ established: false, pending: [], sinceMs: T0, nowMs: T0 + WAIT_BOUND_MS + 1 });
    expect(w.waiting).toBe(false);
    expect(silentNote(w)).toBe("the session stream didn't answer");
  });

  test('a window not asking for the stream is not waiting and arms no recheck', () => {
    expect(streamWait({ established: false, pending: ['mark-1'], sinceMs: undefined, nowMs: T0 }))
      .toEqual({ waiting: false, silent: [], streamSilent: false, recheckInMs: null });
  });

  test('silentNote lists three machines readably', () => {
    expect(silentNote({ silent: ['a', 'b', 'c'], streamSilent: false })).toBe("a, b and c didn't answer");
    expect(silentNote({ silent: [], streamSilent: false })).toBe('');
  });
});
