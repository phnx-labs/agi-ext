import { describe, expect, test } from 'bun:test';
import { createConcurrencyLimiter } from './concurrencyLimiter';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('createConcurrencyLimiter', () => {
  test('never exceeds the cap under a burst, and still runs every task (PHNX-3816)', async () => {
    const limiter = createConcurrencyLimiter(2);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    const done: number[] = [];

    // Fire 6 tasks at once — the exact "N tabs open together" shape.
    const all = gates.map((gate, i) =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
        done.push(i);
      }),
    );

    // Let microtasks settle: only the first `max` should be executing.
    await Promise.resolve();
    await Promise.resolve();
    expect(limiter.active).toBe(2);
    expect(limiter.queued).toBe(4);
    expect(peak).toBe(2);

    // Drain: each completion admits exactly one waiter, cap never breached.
    for (let i = 0; i < gates.length; i += 1) {
      gates[i].resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(peak).toBeLessThanOrEqual(2);
    }
    await Promise.all(all);

    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  test('admits queued tasks in FIFO order — the oldest-queued tab is never starved', async () => {
    // cap=1 makes admission fully deterministic: task 0 runs, 1-3 queue, and each
    // release must admit the NEXT-oldest. A LIFO regression (waiters.pop()) would
    // admit [0,3,...] and fail at the first release. Flush with a real macrotask
    // (setTimeout) so the full release→admit→exec microtask chain settles.
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    const limiter = createConcurrencyLimiter(1);
    const startOrder: number[] = [];
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const all = gates.map((gate, i) =>
      limiter.run(async () => {
        startOrder.push(i); // records EXEC-start order, not gate-resolution order
        await gate.promise;
      }),
    );

    await flush();
    expect(startOrder).toEqual([0]); // only the first is admitted

    gates[0].resolve();
    await flush();
    expect(startOrder).toEqual([0, 1]); // FIFO: 1 next, not 3

    gates[1].resolve();
    await flush();
    expect(startOrder).toEqual([0, 1, 2]);

    gates[2].resolve();
    gates[3].resolve();
    await Promise.all(all);
    expect(startOrder).toEqual([0, 1, 2, 3]);
  });

  test('a task that throws frees its slot (no deadlock)', async () => {
    const limiter = createConcurrencyLimiter(1);
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Slot was released despite the throw — the next task runs.
    const result = await limiter.run(async () => 'ok');
    expect(result).toBe('ok');
    expect(limiter.active).toBe(0);
  });

  test('a synchronous throw in fn also frees the slot', async () => {
    const limiter = createConcurrencyLimiter(1);
    await expect(limiter.run((() => { throw new Error('sync'); }) as unknown as () => Promise<never>)).rejects.toThrow('sync');
    expect(limiter.active).toBe(0);
    expect(await limiter.run(async () => 42)).toBe(42);
  });

  test('rejects a non-positive cap', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow();
    expect(() => createConcurrencyLimiter(-1)).toThrow();
  });
});
