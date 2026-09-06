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

/**
 * Start `start()` only while this window is the elected monitor leader; dispose
 * it on leadership loss. The returned Disposable detaches the leadership
 * listener and tears down any running instance.
 */
export interface LeaderDisposable {
  dispose(): void | Promise<void>;
}

export function runOnLeaderOnly(start: () => LeaderDisposable): LeaderDisposable {
  let current: LeaderDisposable | undefined;
  let stopping: Promise<void> | undefined;
  let wanted = false;
  let disposed = false;

  const apply = (leader: boolean): void | Promise<void> => {
    wanted = leader && !disposed;
    if (stopping) return stopping;
    if (wanted && !current) {
      try {
        current = start();
      } catch (err) {
        console.error('[MONITOR] leader-only start threw:', err);
      }
    } else if (!wanted && current) {
      const previous = current;
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
    }
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
