// isLeader() gate — foundation 3/3 of the centralized-monitor epic (#64).
//
// `runOnLeaderOnly` is the single seam every heavy starter is wrapped in: the
// monitor host (here, today) and the migrated probes/watchers/watchdog/panel
// (#68-71, later). `start` runs once when this window GAINS leadership (or
// immediately if it already holds it); the Disposable it returns is disposed
// the moment leadership is LOST. Re-gaining leadership starts a fresh instance.
//
// Driven entirely by the leader elector (#65) — no vscode dependency — so it
// runs and tests in a plain process (see gate.test.ts).

import { isLeader, onLeadershipChange } from './leader';

export interface LeaderDisposable {
  dispose(): void | Promise<void>;
  /**
   * Settles once the work is live (e.g. its socket is bound). A rejection tears
   * the instance down and starts a fresh one after a bounded backoff, all while
   * the lease is held, so a failed bind never leaves a leader serving nothing.
   */
  ready?: Promise<void>;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Start `start()` only while this window is the elected monitor leader; dispose
 * it on leadership loss. The returned Disposable detaches the leadership
 * listener and tears down any running instance.
 */
export function runOnLeaderOnly(start: () => LeaderDisposable): LeaderDisposable {
  let current: LeaderDisposable | undefined;
  let stopping: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let lastFailure = '';
  let wanted = false;
  let disposed = false;

  const fail = (instance: LeaderDisposable | undefined, err: unknown): void => {
    failures++;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    const message = err instanceof Error ? err.message : String(err);
    // One line per distinct failure: a persistent conflict must not flood the log.
    if (message !== lastFailure) console.error(`[MONITOR] leader-only start failed; retrying with backoff up to ${RETRY_MAX_MS / 1000}s:`, err);
    lastFailure = message;
    if (instance && current === instance) stop();
    retry = setTimeout(() => { retry = undefined; apply(wanted); }, delay);
    (retry as { unref?: () => void }).unref?.();
  };

  const launch = (): void => {
    let instance: LeaderDisposable;
    try {
      instance = start();
    } catch (err) {
      fail(undefined, err);
      return;
    }
    current = instance;
    instance.ready?.then(() => {
      if (current !== instance) return;
      if (failures) console.log(`[MONITOR] leader-only work started after ${failures} failed attempt(s)`);
      failures = 0;
      lastFailure = '';
    }, (err) => {
      if (current === instance) fail(instance, err);
    });
  };

  const stop = (): void => {
    const previous = current;
    if (!previous) return;
    current = undefined;
    try {
      const result = previous.dispose();
      if (result) {
        stopping = Promise.resolve(result);
        void stopping.then(() => {
          stopping = undefined;
          apply(wanted);
        }, (err) => {
          // A failed teardown is not permission to overlap producers.
          console.error('[MONITOR] leader-only dispose rejected:', err);
        });
      }
    } catch (err) {
      stopping = Promise.reject(err);
      void stopping.catch(() => {});
      console.error('[MONITOR] leader-only dispose threw:', err);
    }
  };

  const apply = (leader: boolean): void | Promise<void> => {
    wanted = leader && !disposed;
    if (!wanted) {
      if (retry) clearTimeout(retry);
      retry = undefined;
      failures = 0;
      lastFailure = '';
    }
    if (stopping) return stopping;
    if (wanted && !current && !retry) launch();
    else if (!wanted && current) stop();
    // This promise also holds the elector's ON-DISK lease, not just this gate.
    return stopping;
  };

  const sub = onLeadershipChange(apply);
  apply(isLeader());

  return {
    dispose(): void | Promise<void> {
      disposed = true;
      apply(false);
      // Subscription disposal order is not guaranteed. If the gate is disposed
      // before the elector, its listener must still return the pending reap.
      if (stopping) void stopping.then(() => sub.dispose(), () => {});
      else sub.dispose();
      return stopping;
    },
  };
}
