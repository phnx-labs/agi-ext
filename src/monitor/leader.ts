// Monitor leader election — foundation 1/3 of the centralized-monitor epic (#64).
//
// Elects exactly ONE "monitor" owner across all open IDE windows using the
// lease file in `./lease.ts`. The winner runs the heavy global probes/watches
// (later migration issues); every other window is a thin follower. When the
// leader window dies, another claims within one heartbeat.
//
// Identity is `computeWindowId(sessionId, pid)`: a window RELOAD changes
// process.pid, so the windowId changes too — leadership is therefore LOST and
// must be re-elected, never silently continued (see getOwnWindowId in
// terminalRegistry.vscode.ts).
//
// Kept vscode-free: the wiring layer (extension.ts) supplies selfId/pid, so
// this module — and the lease logic it drives — runs and tests in plain
// subprocesses (see leader.test.ts).

import { holdLease, releaseLease, LEASE_FILE } from './lease';

export interface Disposable {
  dispose(): void;
}

type LeadershipListener = (isLeader: boolean) => void | Promise<void>;

export interface LeaderOptions {
  /** Stable per-window identity, e.g. computeWindowId(sessionId, pid). */
  selfId: string;
  /** OS pid recorded in the lease for liveness checks on takeover. */
  pid: number;
  /** How often we renew (as leader) or re-attempt a claim (as follower). */
  heartbeatMs?: number;
  /**
   * Lease lifetime. Must exceed heartbeatMs so a healthy leader always renews
   * before its own lease expires; defaults to 3x heartbeat.
   */
  ttlMs?: number;
  /** Override the lease file path (tests). */
  leaseFile?: string;
  /** Invoked synchronously; async cleanup on loss holds the lease until done. */
  onChange?: LeadershipListener;
}

const DEFAULT_HEARTBEAT_MS = 2_000;

export class MonitorLeader {
  private readonly selfId: string;
  private readonly pid: number;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;
  private readonly leaseFile: string;
  private readonly listeners = new Set<LeadershipListener>();

  private leader = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private transition?: Promise<void>;
  private disposal?: Promise<void>;
  private disposed = false;

  constructor(opts: LeaderOptions) {
    this.selfId = opts.selfId;
    this.pid = opts.pid;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.ttlMs = opts.ttlMs ?? this.heartbeatMs * 3;
    this.leaseFile = opts.leaseFile ?? LEASE_FILE;
    if (opts.onChange) this.listeners.add(opts.onChange);
  }

  /** Begin the heartbeat loop. Runs one tick immediately. */
  start(): this {
    if (this.timer || this.disposed) return this;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.heartbeatMs);
    // Don't keep the process alive solely for the lease loop.
    (this.timer as any)?.unref?.();
    return this;
  }

  isLeader(): boolean {
    return this.leader;
  }

  onLeadershipChange(cb: LeadershipListener): Disposable {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  /** Stop work first; only release cross-window ownership after its real reap. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.setLeader(false);
    // canClaim refuses an expired lease whose owner PID is still alive. Retain
    // that ownership throughout async teardown, even beyond the lease TTL.
    const release = () => releaseLease(this.selfId, this.leaseFile);
    if (this.transition) this.disposal = this.transition.then(release);
    else {
      release();
      this.disposal = Promise.resolve();
    }
    // VS Code subscriptions may ignore promises; keep failures observable and
    // return the ORIGINAL rejection to deactivate(). Never release on failure.
    void this.disposal.catch((error) => console.error('[MONITOR] handoff failed; retaining lease:', error));
    return this.disposal;
  }

  private tick(): void {
    if (this.disposed || this.transition) return;
    let held = false;
    try {
      held = holdLease(this.selfId, this.pid, this.ttlMs, this.leaseFile);
    } catch {
      held = false;
    }
    this.setLeader(held);
  }

  private setLeader(next: boolean): void {
    if (next === this.leader) return;
    this.leader = next;
    const pending: Promise<void>[] = [];
    for (const cb of this.listeners) {
      try {
        const result = cb(next);
        if (result) pending.push(result);
      } catch (error) {
        pending.push(Promise.reject(error));
      }
    }
    if (pending.length) {
      this.transition = Promise.all(pending).then(() => { this.transition = undefined; });
      void this.transition.catch((error) => console.error('[MONITOR] leadership cleanup failed:', error));
    }
  }
}

// ---- Module singleton: one elector per extension host -----------------------

let active: MonitorLeader | undefined;

/** Construct, start, and register the process-wide monitor elector. */
export function electLeader(opts: LeaderOptions): MonitorLeader {
  const previous = active;
  active = new MonitorLeader(opts);
  if (previous) {
    const next = active;
    void previous.dispose().then(() => next.start(), (error) => {
      console.error('[MONITOR] replacement election blocked by teardown:', error);
    });
  } else active.start();
  return active;
}

/** Synchronous read of whether THIS window currently owns the monitor. */
export function isLeader(): boolean {
  return active?.isLeader() ?? false;
}

/** Subscribe to leadership changes on the active elector. */
export function onLeadershipChange(
  cb: LeadershipListener,
): Disposable {
  if (!active) return { dispose: () => {} };
  return active.onLeadershipChange(cb);
}

/** Tear down the active elector (graceful handoff). */
export function disposeLeader(): Promise<void> {
  const previous = active;
  if (!previous) return Promise.resolve();
  const disposal = previous.dispose();
  void disposal.then(() => { if (active === previous) active = undefined; }, () => {});
  return disposal;
}
