// Elected-leader session-CLI stream (PHNX-3939, restored from e0f4831^).
//
// One long-lived `agents feed watch --json` child, owned by the elected monitor,
// projects the canonical session rows every window reads from the warm
// `sessionPresentationStore`. This is the SINGLE producer for the whole machine
// (the thin-client contract in AGENTS.md).
//
// It was removed in e0f4831 (#52) because it ran 24/7 at ~31% CPU and leaked ssh
// fan-out even with no consumer. It is restored here behind a DEMAND GATE owned by
// `host.ts`: the host only calls start() while at least one window reports demand
// (a visible dashboard/sidebar or a tracked-but-unresolved agent tuple) and calls
// stop() — after a debounce — when demand drops to zero. The stream object itself
// stays consumer-agnostic; the gate is the host's job. The exponential restart
// backoff (PHNX-3818) is retained so a broken child can't drip a spawn/sec.

import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import { createInterface } from 'readline';
import { promisify } from 'util';
import { bootstrapPath, resolveAgentsBin } from '../core/agentsBin';

import type { SessionCliFactPayload as SessionCliEvent } from './protocol';
export type { SessionCliEvent };

export interface SessionCliStreamOptions {
  emit: (event: SessionCliEvent) => void;
  onError?: (message: string) => void;
  /** Real child factory; MUST use detached:true on POSIX to own its group. */
  spawnWatch?: () => ChildProcessWithoutNullStreams;
  /** Resolve the executable before spawning (also permits delayed-resolution tests). */
  resolveBin?: () => Promise<string>;
  /** Grace before escalating SIGTERM to SIGKILL (default 2s). */
  stopGraceMs?: number;
  /** Delay before an automatic restart after the child exits (default 1s). */
  restartMs?: number;
}

/** Current CLI-owned rows retained only so a late follower can receive a reset. */
export class SessionCliReplay {
  private replaySequence = 0;
  private readonly scopes = new Map<string, {
    rows: Map<string, unknown>;
    attention: Map<string, unknown>;
    capturedAt: number;
    status?: 'available' | 'unavailable';
    reason?: string;
  }>();

  ingest(event: SessionCliEvent): void {
    const current = this.scopes.get(event.scope) ?? {
      rows: new Map<string, unknown>(), attention: new Map<string, unknown>(),
      capturedAt: event.capturedAt,
    };
    current.capturedAt = event.capturedAt;
    if (event.type === 'reset') {
      current.rows = new Map((event.agents ?? []).flatMap((row) => {
        const rowKey = row && typeof row === 'object' ? (row as { rowKey?: unknown }).rowKey : undefined;
        return typeof rowKey === 'string' ? [[rowKey, row] as const] : [];
      }));
      current.attention = new Map((Array.isArray(event.attention) ? event.attention : []).flatMap((item) => {
        const key = item && typeof item === 'object' ? (item as { key?: unknown }).key : undefined;
        return typeof key === 'string' ? [[key, item] as const] : [];
      }));
    } else if (event.type === 'agent.upsert' && event.rowKey && event.agent) {
      current.rows.set(event.rowKey, event.agent);
    } else if (event.type === 'agent.remove' && event.rowKey) {
      current.rows.delete(event.rowKey);
    } else if (event.type === 'attention.upsert' && event.rowKey && event.attention && !Array.isArray(event.attention)) {
      current.attention.set(event.rowKey, event.attention);
    } else if (event.type === 'attention.remove' && event.rowKey) {
      current.attention.delete(event.rowKey);
    } else if (event.type === 'scope' && event.status) {
      current.status = event.status;
      current.reason = event.reason;
    }
    this.scopes.set(event.scope, current);
  }

  /** Drop all cached scopes so a re-join after a stop never paints a stale
   *  "current" snapshot (the stream is gone; there is no live state to replay). */
  clear(): void {
    this.scopes.clear();
  }

  /** True once at least one scope has been observed (there is something to replay). */
  get hasState(): boolean {
    return this.scopes.size > 0;
  }

  envelopes(clientKey: string): SessionCliEvent[] {
    const events: SessionCliEvent[] = [];
    for (const [scope, current] of this.scopes) {
      const streamId = `replay:${clientKey}:${scope}:${++this.replaySequence}`;
      events.push({
        v: 1, type: 'reset', streamId, sequence: 1,
        capturedAt: current.capturedAt, scope, agents: [...current.rows.values()], attention: [...current.attention.values()],
      });
      if (current.status) {
        events.push({
          v: 1, type: 'scope', streamId, sequence: 2,
          capturedAt: current.capturedAt, scope, status: current.status,
          ...(current.reason ? { reason: current.reason } : {}),
        });
      }
    }
    return events;
  }
}

/** Owns the single long-lived CLI session stream for the elected monitor. */
export class SessionCliStream {
  private child?: ChildProcessWithoutNullStreams;
  private stopChild?: () => void;
  private startup?: Promise<void>;
  private cancelStartup?: () => void;
  /**
   * Monotonic id per spawn. Every child's async handlers capture their gen and
   * no-op once it is stale (stopped, or superseded by a newer spawn). This is
   * what stops a KILLED child's late `exit` from clearing the CURRENT child and
   * scheduling a phantom restart — the stop/start race that would leak a second
   * `agents feed watch` process.
   */
  private gen = 0;
  /** Intentionally started (not stopped by the host). Exit restarts while true. */
  private wantRunning = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  /**
   * Resolves when the CURRENT child has fully exited. A new spawn awaits it so we
   * never run two children at once (serialize stop→start), and stop() awaits it so
   * callers can rely on the OS process being reaped when stop() resolves.
   */
  private currentExit?: Promise<void>;
  /**
   * Consecutive restarts since the last healthy run (PHNX-3818). Backs off
   * exponentially from `restartMs` up to MAX_RESTART_MS and resets to 0 the moment
   * the stream produces a valid event, so a broken `agents` bin can't drip a spawn
   * every `restartMs` forever while a transient blip still recovers fast.
   */
  private restartAttempts = 0;
  private static readonly MAX_RESTART_MS = 30_000;
  /** Cap retained stderr so a chatty/looping child can't grow memory unbounded. */
  private static readonly STDERR_CAP = 8 * 1024;
  /**
   * Circuit breaker on top of the backoff above. The backoff alone still
   * respawns forever — at 30s apart, but forever — so a durably broken
   * `agents` install (the fork-bombed-`secrets __serve` shape from the
   * 1.22.85 incident) drips a spawn every 30s for the life of the window. If
   * the child exits within IMMEDIATE_FAILURE_WINDOW_MS of starting
   * BREAKER_TRIP_THRESHOLD times in a row, stop respawning entirely and fail
   * loud instead. A valid protocol event resets the counter (below, beside
   * the existing restartAttempts reset) — a child that is genuinely healthy
   * for a while never trips it.
   */
  private static readonly IMMEDIATE_FAILURE_WINDOW_MS = 3_000;
  private static readonly BREAKER_TRIP_THRESHOLD = 5;
  private consecutiveImmediateFailures = 0;
  private breakerOpen = false;

  constructor(private readonly options: SessionCliStreamOptions) {}

  /** True while the stream intends to run (started, not stopped). */
  get running(): boolean {
    return this.wantRunning;
  }

  /** True once the circuit breaker has tripped and stopped auto-respawning. */
  get breakerTripped(): boolean {
    return this.breakerOpen;
  }

  start(): void {
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.launch();
  }

  private launch(): void {
    const gen = ++this.gen;
    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => { cancel = () => resolve(undefined); });
    this.cancelStartup = cancel;
    this.startup = this.spawnChild(gen, cancelled);
  }

  private async spawnChild(gen: number, cancelled: Promise<undefined>): Promise<void> {
    const current = () => this.wantRunning && gen === this.gen;
    if (!current()) return;
    try {
      if (this.currentExit) await Promise.race([this.currentExit, cancelled]);
      if (!current() || this.child) return;
      if (this.options.spawnWatch) {
        // Synchronous spawn + attach: no unowned child across an await boundary.
        this.attach(this.options.spawnWatch(), gen);
      } else {
        const bin = await Promise.race([(this.options.resolveBin ?? resolveAgentsBin)(), cancelled]);
        if (!current() || bin === undefined) return;
        const augmented = bootstrapPath(bin);
        this.attach(spawn(bin, ['feed', 'watch', '--json'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // SIGKILL cannot run CLI cleanup. Own its POSIX process group so an
          // ssh descendant is still addressable after the producer exits.
          detached: process.platform !== 'win32',
          windowsHide: true,
          env: { ...process.env, PATH: `${augmented}:${process.env.PATH ?? ''}` },
        }), gen);
      }
    } catch (error) {
      if (!current()) return;
      this.options.onError?.(error instanceof Error ? error.message : String(error));
      // A rejected reap retains this.child: fail closed, do not retry/spawn.
      if (!this.child) this.scheduleRestart();
    }
  }

  private attach(child: ChildProcessWithoutNullStreams, gen: number): void {
    this.child = child;
    const startedAt = Date.now();
    let settled = false;
    let resolveExit!: () => void;
    let rejectExit!: (error: unknown) => void;
    this.currentExit = new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
    void this.currentExit.catch(() => {});
    let reaped!: () => void;
    const directExit = new Promise<void>((resolve) => { reaped = resolve; });
    let cleanup: Promise<void> | undefined;
    let exitReason: string | undefined;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (!this.wantRunning || gen !== this.gen) return;
      try {
        const event = JSON.parse(line) as SessionCliEvent;
        if ((event?.v === 1 || event?.version === 1) && typeof event.streamId === 'string'
          && Number.isInteger(event.sequence) && typeof event.type === 'string') {
          // A valid event proves this child is healthy — reset the backoff
          // and the circuit breaker's failure streak.
          this.restartAttempts = 0;
          this.consecutiveImmediateFailures = 0;
          this.options.emit(event);
        }
      } catch {
        this.options.onError?.(`agents feed watch emitted invalid JSON: ${line.slice(0, 160)}`);
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-SessionCliStream.STDERR_CAP);
    });
    // Spawn failure has no PID. Errors on a live child (such as a failed kill)
    // are not evidence of exit: retain ownership until the OS reports exit.
    const settle = (reason: string | undefined) => {
      if (settled) return;
      settled = true;
      try { lines.close(); } catch { /* already closed */ }
      const isCurrent = gen === this.gen;
      if (this.child === child) {
        this.child = undefined;
        this.stopChild = undefined;
        this.currentExit = undefined;
      }
      if (reason && this.wantRunning && isCurrent) this.options.onError?.(reason);
      resolveExit();
      // Only the current, still-wanted generation restarts — a stopped or
      // superseded child never resurrects itself.
      if (this.wantRunning && isCurrent) {
        // Circuit breaker: a child that exits within IMMEDIATE_FAILURE_WINDOW_MS
        // of starting is crash-looping, not merely unlucky. The backoff above
        // still lets that repeat forever (30s apart, forever); after
        // BREAKER_TRIP_THRESHOLD in a row, stop respawning and fail loud
        // instead of drip-spawning a broken `agents` install forever.
        if (Date.now() - startedAt < SessionCliStream.IMMEDIATE_FAILURE_WINDOW_MS) {
          this.consecutiveImmediateFailures += 1;
          if (this.consecutiveImmediateFailures >= SessionCliStream.BREAKER_TRIP_THRESHOLD) {
            this.breakerOpen = true;
            this.options.onError?.(
              `agents feed watch crashed ${this.consecutiveImmediateFailures} times in a row within ` +
              `${SessionCliStream.IMMEDIATE_FAILURE_WINDOW_MS}ms of starting — giving up on the session ` +
              'stream. Run `agents doctor` to check the install, or `agents upgrade` to update the CLI, ' +
              'then reopen the Fleet dashboard or a session sidebar to retry.'
            );
            return;
          }
        }
        this.scheduleRestart();
      }
    };
    this.stopChild = () => {
      if (cleanup) return;
      cleanup = terminateProducer(child, directExit, this.options.stopGraceMs ?? 2_000);
      void cleanup.then(() => settle(exitReason), (error) => {
        // Keep the failed ownership promise and child identity. Neither a
        // demand restart nor a leadership handoff can treat failure as exit.
        this.options.onError?.(`agents feed watch cleanup failed: ${String(error)}`);
        rejectExit(error);
      });
    };
    child.on('error', (err: Error) => {
      const message = err?.message || 'agents feed watch failed';
      if (!child.pid) { reaped(); settle(message); }
      else this.options.onError?.(message);
    });
    child.once('exit', (code) => {
      reaped();
      exitReason = code === 0 ? undefined : (stderr.trim() || 'agents feed watch exited; restarting stream');
      // Even an unexpected producer exit must clean its remaining group before
      // restart; direct PID exit is not proof that its descendants are gone.
      this.stopChild?.();
    });
  }

  private scheduleRestart(): void {
    if (!this.wantRunning || this.restartTimer) return;
    const base = this.options.restartMs ?? 1_000;
    const ms = Math.min(base * 2 ** this.restartAttempts, SessionCliStream.MAX_RESTART_MS);
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.launch();
    }, ms);
  }

  /** Reap the producer and terminate its POSIX group before releasing ownership. */
  async stop(): Promise<void> {
    this.wantRunning = false;
    this.restartAttempts = 0;
    // A stop/start cycle is a deliberate lifecycle transition (demand dropped
    // to zero and came back) — give a tripped breaker a fresh slate rather
    // than leaving the stream permanently wedged for the rest of the window.
    this.consecutiveImmediateFailures = 0;
    this.breakerOpen = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    // Invalidate the current generation so its handlers stop restarting, then
    // kill and await the real exit (currentExit resolves in settle()).
    this.gen += 1;
    this.cancelStartup?.();
    const startup = this.startup;
    const exited = this.currentExit;
    this.stopChild?.();
    await startup;
    await exited;
  }
}

const execFileAsync = promisify(execFile);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Signal only the group we created. Permission failures must retain ownership. */
async function signalGroup(pid: number, signal: NodeJS.Signals | 0): Promise<boolean> {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // Darwin returns EPERM for a group containing only unreaped zombies. That
    // is not a live permission-denied producer; verify the group before treating
    // it as terminated. A live member or failed inspection still rejects.
    if (process.platform === 'darwin' && (error as NodeJS.ErrnoException).code === 'EPERM'
      && !await groupHasLiveMembers(pid)) return false;
    throw error;
  }
}

async function groupHasLiveMembers(pid: number): Promise<boolean> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pgid=,stat='], { timeout: 1_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim().split('\n').some((row) => {
    const [group, state] = row.trim().split(/\s+/);
    return Number(group) === pid && !state?.startsWith('Z');
  });
}

async function terminateProducer(child: ChildProcessWithoutNullStreams, reaped: Promise<void>, graceMs: number): Promise<void> {
  if (!child.pid) { await reaped; return; }
  if (process.platform === 'win32') {
    // Node's Windows kill terminates the direct process; detached does NOT
    // provide POSIX group semantics. Descendant cleanup is not guaranteed here.
    // Full parity needs CLI-owned Job Object/tree cleanup, including crash exit.
    child.kill('SIGTERM');
    await reaped;
    return;
  }
  const pid = child.pid;
  const deadline = Date.now() + graceMs;
  await signalGroup(pid, 'SIGTERM');
  while (await signalGroup(pid, 0)) {
    if (Date.now() >= deadline) {
      await signalGroup(pid, 'SIGKILL');
      break;
    }
    await pause(10);
  }
  await reaped;
  // kill() means signal delivered, not exit observed. Verify no running group
  // member remains. Orphan zombies have already terminated; only their new
  // parent can reap them (not this extension). Query only during owned teardown.
  const killDeadline = Date.now() + 2_000;
  while (await signalGroup(pid, 0)) {
    if (!await groupHasLiveMembers(pid)) break;
    if (Date.now() >= killDeadline) throw new Error(`process group ${pid} still running after SIGKILL`);
    await pause(10);
  }
}
