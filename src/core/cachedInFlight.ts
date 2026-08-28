// Coalesce concurrent + repeated async fetches keyed by a string. Two callers
// asking for the same key at the same time share ONE in-flight promise; a call
// within `ttlMs` of the last resolved value gets the cache instead of re-running.
//
// This is the guard that stops several uncoordinated drivers (the launch-health
// timer, the Dispatch panel's deviceHealth probe, each agent launch) from EACH
// spawning a full-fleet fan-out of `agents` subprocesses for the same host —
// the pile-up that thrashed dozens of duplicate `agents sessions --active
// --device <box>` processes on a loaded box. `fetchDeviceStats` had this guard
// inline; `countRunningAgents` did not, so it was the one probe that stacked.

export interface TimedCache<T> {
  cache: Map<string, { value: T; at: number }>;
  inFlight: Map<string, Promise<T>>;
}

export function createTimedCache<T>(): TimedCache<T> {
  return { cache: new Map(), inFlight: new Map() };
}

export async function cachedInFlight<T>(
  store: TimedCache<T>,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const cached = store.cache.get(key);
  if (cached && now - cached.at < ttlMs) return cached.value;
  const existing = store.inFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const value = await fn();
    // Cache at the call-entry time so the TTL window measures from when the
    // caller asked, matching the prior inline behavior in fetchDeviceStats.
    store.cache.set(key, { value, at: now });
    return value;
  })();
  store.inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    store.inFlight.delete(key);
  }
}

// Leading + TRAILING coalescer, keyed by a string. Unlike cachedInFlight (which is
// leading-edge only — a caller arriving mid-flight joins the running promise and no
// further run is ever scheduled), this GUARANTEES one more run after the last call in
// a burst. That trailing run is what stops the final fact — structurally the
// running -> idle transition, the one with no follow-up event to rescue it — from
// being observed-but-never-rendered until an unrelated later trigger fires (PHNX-2978).
//
// A burst of N calls collapses to a leading run + exactly one trailing run; the
// trailing run itself absorbs any calls that arrive while IT is in flight, so a
// steady stream converges to "always one more run pending", never a dropped tail.
export interface TrailingCoalesce {
  inFlight: Map<string, Promise<void>>;
  pending: Set<string>;
}

export function createTrailingCoalesce(): TrailingCoalesce {
  return { inFlight: new Map(), pending: new Set() };
}

export function coalesceTrailing(
  store: TrailingCoalesce,
  key: string,
  fn: () => Promise<void>,
): Promise<void> {
  const active = store.inFlight.get(key);
  if (active) {
    // A run is already in flight — flag that its result may be stale by the time it
    // settles, so a trailing run must follow to capture this call's state.
    store.pending.add(key);
    return active;
  }
  const start = (): Promise<void> => {
    const p = (async () => {
      try {
        await fn();
      } finally {
        if (store.pending.has(key)) {
          store.pending.delete(key);
          // Chain exactly one more run for the state that arrived mid-flight, and
          // keep inFlight pointing at it so concurrent callers still coalesce.
          store.inFlight.set(key, start());
        } else {
          store.inFlight.delete(key);
        }
      }
    })();
    return p;
  };
  const p = start();
  store.inFlight.set(key, p);
  return p;
}
