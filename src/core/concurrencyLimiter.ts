// A tiny bounded-concurrency limiter: run at most `max` async tasks at once,
// queueing the rest FIFO. Pure and dependency-free so it is unit-testable and
// reusable anywhere the extension would otherwise fan out N subprocesses at
// once (see PHNX-3816: the auto-label `agents run claude` spawns).

export interface ConcurrencyLimiter {
  /** Run `fn` once a slot is free; resolves/rejects with `fn`'s result. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Slots currently executing (for tests / diagnostics). */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly queued: number;
}

export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`concurrency limit must be a positive integer, got ${max}`);
  }
  let active = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    const next = waiters.shift();
    // Hand the just-freed slot straight to the next waiter (active stays put),
    // or give it back if nobody is waiting. `active` therefore never exceeds max.
    if (next) next();
    else active -= 1;
  };

  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const exec = (): Promise<T> => {
      // Run fn in its own promise so a synchronous throw still releases the slot.
      return Promise.resolve()
        .then(fn)
        .finally(release);
    };
    if (active < max) {
      active += 1;
      return exec();
    }
    return new Promise<void>((resolve) => waiters.push(resolve)).then(exec);
  };

  return {
    run,
    get active() { return active; },
    get queued() { return waiters.length; },
  };
}
