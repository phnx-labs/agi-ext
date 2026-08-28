import { describe, test, expect } from 'bun:test';
import { createTimedCache, cachedInFlight, createTrailingCoalesce, coalesceTrailing } from './cachedInFlight';

/** Resolve after the current microtask + timer queue drains. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('cachedInFlight', () => {
  test('coalesces concurrent calls for the same key into ONE invocation', async () => {
    const store = createTimedCache<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    };
    // Five callers fire at the same instant (the full-fleet fan-out from
    // several uncoordinated timers) — they must share one in-flight run.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cachedInFlight(store, 'host-a', 6000, fn, 1000)),
    );
    expect(calls).toBe(1);
    expect(results).toEqual([42, 42, 42, 42, 42]);
  });

  test('serves the cache within the TTL instead of re-invoking', async () => {
    const store = createTimedCache<number>();
    let calls = 0;
    const fn = async () => (++calls, calls);
    expect(await cachedInFlight(store, 'h', 6000, fn, 1000)).toBe(1);
    // A later caller still inside the TTL window gets the cached value.
    expect(await cachedInFlight(store, 'h', 6000, fn, 1000 + 5999)).toBe(1);
    expect(calls).toBe(1);
  });

  test('re-invokes once the TTL has elapsed', async () => {
    const store = createTimedCache<number>();
    let calls = 0;
    const fn = async () => (++calls, calls);
    expect(await cachedInFlight(store, 'h', 6000, fn, 1000)).toBe(1);
    expect(await cachedInFlight(store, 'h', 6000, fn, 1000 + 6001)).toBe(2);
    expect(calls).toBe(2);
  });

  test('a zero TTL still coalesces concurrent callers but never serves a stale value', async () => {
    // The contract pushFloorUpdate relies on: overlapping floor rebuilds share
    // one run, but a later refresh must always re-scan. Giving that call site a
    // non-zero TTL would post a stale terminal snapshot to the panel.
    const store = createTimedCache<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return calls;
    };
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => cachedInFlight(store, 'floor', 0, fn, 1000)),
    );
    expect(concurrent).toEqual([1, 1, 1, 1]);
    expect(calls).toBe(1);

    // Same instant, but no longer in flight — must re-run rather than cache-hit.
    expect(await cachedInFlight(store, 'floor', 0, fn, 1000)).toBe(2);
    expect(calls).toBe(2);
  });

  test('keys are independent — one host in flight does not block another', async () => {
    const store = createTimedCache<string>();
    const seen: string[] = [];
    const make = (id: string) => async () => {
      seen.push(id);
      return id;
    };
    const [a, b] = await Promise.all([
      cachedInFlight(store, 'a', 6000, make('a'), 1000),
      cachedInFlight(store, 'b', 6000, make('b'), 1000),
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});

describe('coalesceTrailing (PHNX-2978 — never drop the trailing run)', () => {
  // A controllable fn: each invocation parks on a deferred the test resolves by hand,
  // so we can land a "mid-flight" call precisely while a run is in progress.
  function controllable() {
    let calls = 0;
    const releases: Array<() => void> = [];
    const fn = () => {
      calls++;
      return new Promise<void>((resolve) => releases.push(resolve));
    };
    return {
      fn,
      get calls() { return calls; },
      releaseNext() { const r = releases.shift(); if (r) r(); },
    };
  }

  test('a call arriving mid-flight forces exactly one trailing run', async () => {
    const store = createTrailingCoalesce();
    const c = controllable();

    coalesceTrailing(store, 'k', c.fn);          // leading run starts
    await settle();
    expect(c.calls).toBe(1);

    coalesceTrailing(store, 'k', c.fn);          // arrives mid-flight -> flags pending
    coalesceTrailing(store, 'k', c.fn);          // also mid-flight -> still one trailing
    await settle();
    expect(c.calls).toBe(1);                      // no new run yet; the leading one owns it

    c.releaseNext();                              // leading run settles
    await settle();
    expect(c.calls).toBe(2);                      // exactly one trailing run fires

    c.releaseNext();                              // trailing run settles
    await settle();
    expect(c.calls).toBe(2);                      // no pending left -> converges, no extra run
  });

  test('a quiet burst with no overlap does NOT schedule a trailing run', async () => {
    const store = createTrailingCoalesce();
    const c = controllable();

    const first = coalesceTrailing(store, 'k', c.fn);
    c.releaseNext();                              // settles before the next call arrives
    await first;
    await settle();
    expect(c.calls).toBe(1);

    const second = coalesceTrailing(store, 'k', c.fn);   // idle again -> a fresh leading run
    c.releaseNext();
    await second;
    await settle();
    expect(c.calls).toBe(2);                      // two discrete runs, no phantom trailing
  });

  test('keys are independent', async () => {
    const store = createTrailingCoalesce();
    const a = controllable();
    const b = controllable();
    coalesceTrailing(store, 'a', a.fn);
    coalesceTrailing(store, 'b', b.fn);
    await settle();
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    a.releaseNext();
    b.releaseNext();
  });

  test('a rejecting leading run propagates to its awaiter', async () => {
    const store = createTrailingCoalesce();
    const boom = () => Promise.reject(new Error('floor scan failed'));
    await expect(coalesceTrailing(store, 'k', boom)).rejects.toThrow('floor scan failed');
    // The store is left clean so the next fact starts fresh.
    expect(store.inFlight.has('k')).toBe(false);
    expect(store.pending.has('k')).toBe(false);
  });

  test('a rejecting TRAILING run does not surface as an unhandled rejection', async () => {
    // Guards the orphaned-trailing-promise case: the leading caller has returned, so
    // nobody awaits the trailing run — a reject must be caught internally, not crash.
    const store = createTrailingCoalesce();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent | { reason?: unknown }) =>
      unhandled.push((e as { reason?: unknown }).reason ?? e);
    process.on('unhandledRejection', onUnhandled as (r: unknown) => void);
    try {
      let n = 0;
      // First (leading) run resolves; the mid-flight call forces a trailing run whose
      // fn rejects with nobody awaiting it.
      const fn = () => (++n === 1 ? Promise.resolve() : Promise.reject(new Error('trailing boom')));
      const lead = coalesceTrailing(store, 'k', fn);   // leading run (resolves)
      coalesceTrailing(store, 'k', fn);                // mid-flight -> schedules trailing (rejects)
      await lead;
      await settle();
      await settle();
      expect(n).toBe(2);                                // the trailing run did fire
      expect(unhandled).toEqual([]);                    // and its rejection was caught
    } finally {
      process.off('unhandledRejection', onUnhandled as (r: unknown) => void);
    }
  });
});
