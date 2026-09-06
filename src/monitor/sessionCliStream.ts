// Elected-leader session-CLI stream (PHNX-3939, restored from e0f4831^).
//
// One long-lived `agents sessions watch --json --local` child per SCOPE, owned by
// the elected monitor, projects the canonical session rows every window reads from
// the warm `sessionPresentationStore`. This is the SINGLE producer for the whole
// machine (the thin-client contract in AGENTS.md). `host.ts` owns one instance for
// the local device plus one per REMOTE device that currently has an open agent tab.
//
// TRANSPORT — read this before changing the argv:
//   `agents sessions watch --json --local` is a journal tail. Steady state is one
//   `fs.watchFile` stat every 250 ms plus a 15 s heartbeat, and on append it reads
//   only `size - offset` bytes (agents-cli `session/remote/watch.ts:366-368`,
//   `:384-391`, `:407-413`).
//   `agents feed watch --json` is NOT that. It adds a 500 ms `setInterval` that
//   `readdirSync`s every session ever recorded and tail-parses 256 KiB of each
//   (1,420 files / 63 MB on the owner's box), then reconciles PR rows with `gh`.
//   That loop is the ~31% CPU / leaked-ssh-fan-out reason e0f4831 (#52) deleted
//   this file outright. Never put `feed` back in these spawn args;
//   `sessionCliStream.transport.test.ts` asserts it.
//
// Two independent guards, both required:
//   - the DEMAND GATE in `host.ts` — start() only while a window reports demand
//     (a visible dashboard/sidebar or a tracked-but-unresolved agent tuple), stop()
//     after a debounce once demand hits zero. The stream stays consumer-agnostic.
//   - the SCOPE SET — a remote device earns its own `-D <device>` child by owning
//     an open tab and loses it with its last tab, so the fleet-wide ssh fan-out
//     that removal fixed can never return.
// The exponential restart backoff (PHNX-3818) is retained so a broken child can't
// drip a spawn/sec.

import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import { createInterface } from 'readline';
import { promisify } from 'util';
import { bootstrapPath, resolveAgentsBin } from '../core/agentsBin';

import type { SessionCliFactPayload as SessionCliEvent } from './protocol';
export type { SessionCliEvent };

/** The scope key for the local device's child. Not a device name. */
export const LOCAL_SCOPE_KEY = 'local';

/**
 * The argv for one scope's watch child. Exported so the transport test asserts
 * the exact command instead of re-deriving it — this is the load-bearing choice
 * of the whole file (see the TRANSPORT note above).
 */
export function sessionWatchArgs(device?: string): string[] {
  const args = ['sessions', 'watch', '--json', '--local'];
  return device ? [...args, '-D', device] : args;
}

/**
 * The canonical `agents sessions watch` NDJSON envelope (agents-cli
 * `SessionWatchEnvelope`, `session/remote/watch.ts:30-36`). Rows ride as `rows`
 * on a reset and `row` on an upsert; the presentation store speaks the older
 * `agents`/`agent` names, so `adaptSessionWatchEnvelope` is the ONE place the two
 * vocabularies meet.
 */
interface SessionWatchEnvelope {
  version?: number;
  v?: number;
  type?: string;
  streamId?: string;
  sequence?: number;
  capturedAt?: number;
  scope?: string;
  rows?: unknown[];
  row?: unknown;
  rowKey?: string;
  status?: 'available' | 'unavailable';
  reason?: string;
}

/**
 * Bridge one producer line into the `SessionCliFactPayload` the receive path
 * speaks (`extension.ts` -> `sessionPresentationStore.apply`).
 *
 * The store's event vocabulary is a SUPERSET of what any one producer emits, and
 * the two producers name the same things differently:
 *   `sessions watch` says reset/upsert/remove and carries `rows`/`row`;
 *   the store says reset/agent.upsert/agent.remove and carries `agents`/`agent`,
 *   and additionally understands attention.* and activity.append, which only
 *   `feed watch` ever produces.
 * So this renames the session vocabulary and passes the store vocabulary through
 * untouched — it is a bridge, not a filter. Which facts actually exist is decided
 * by `sessionWatchArgs`, not here.
 *
 * Returns undefined for anything that is not a well-formed v1 envelope, so a
 * partial line or a future event type is dropped rather than half-applied.
 */
const STORE_EVENT_TYPES = new Set([
  'reset', 'agent.upsert', 'agent.remove',
  'attention.upsert', 'attention.remove', 'activity.append',
  'scope', 'heartbeat',
]);

export function adaptSessionWatchEnvelope(raw: unknown): SessionCliEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as SessionWatchEnvelope;
  if (e.version !== 1 && e.v !== 1) return undefined;
  if (typeof e.streamId !== 'string' || !e.streamId) return undefined;
  if (!Number.isInteger(e.sequence)) return undefined;
  if (typeof e.scope !== 'string' || !e.scope) return undefined;
  const base = {
    v: 1 as const,
    streamId: e.streamId,
    sequence: e.sequence as number,
    capturedAt: typeof e.capturedAt === 'number' ? e.capturedAt : Date.now(),
    scope: e.scope,
  };
  switch (e.type) {
    // `sessions watch` names, renamed onto the store's.
    case 'upsert':
      if (typeof e.rowKey !== 'string' || !e.rowKey || !e.row) return undefined;
      return { ...base, type: 'agent.upsert', rowKey: e.rowKey, agent: e.row };
    case 'remove':
      if (typeof e.rowKey !== 'string' || !e.rowKey) return undefined;
      return { ...base, type: 'agent.remove', rowKey: e.rowKey };
    // `reset` exists in both; take rows from whichever field carries them.
    case 'reset':
      return {
        ...base,
        type: 'reset',
        agents: Array.isArray(e.rows) ? e.rows : Array.isArray((raw as { agents?: unknown[] }).agents) ? (raw as { agents: unknown[] }).agents : [],
        attention: Array.isArray((raw as { attention?: unknown[] }).attention) ? (raw as { attention: unknown[] }).attention : [],
      };
    default:
      // Already the store's vocabulary (attention.*, activity.append,
      // agent.*, scope, heartbeat): forward verbatim, field names and all.
      return STORE_EVENT_TYPES.has(e.type as string) ? (raw as SessionCliEvent) : undefined;
  }
}

export interface SessionCliStreamOptions {
  emit: (event: SessionCliEvent) => void;
  /**
   * A FAULT: spawn failure, a non-zero exit (with the retained stderr tail), or a
   * failed cleanup. Not routine chatter — `leader.handoff.test.ts` asserts this
   * channel stays silent through a clean handoff, and it should.
   */
  onError?: (message: string) => void;
  /**
   * The child's live stderr, line by line, as it arrives. Separate from onError
   * because a healthy child talks on stderr (a slow ssh hop, a deprecation) and
   * that is diagnostics, not a fault. The extension routes this to the
   * "Agents: Monitor" output channel, so in the shipping product nothing is
   * discarded; with no sink it is still retained for the exit message below.
   * 0.9.361's fleet fan-out threw stderr away outright and its failures were
   * invisible.
   */
  onStderr?: (message: string) => void;
  /**
   * The REMOTE device this instance watches, i.e. the `-D <device>` target.
   * Omitted for the local child. `host.ts` creates one instance per device that
   * owns an open agent tab and disposes it with that device's last tab.
   */
  device?: string;
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

  /** Forget ONE scope — its device lost its last tab, so its child is gone and a
   *  later window must not be replayed rows nothing is producing any more. */
  drop(scope: string): void {
    this.scopes.delete(scope);
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
   * session-watch process.
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

  constructor(private readonly options: SessionCliStreamOptions) {}

  /** The scope this instance produces for: 'local', or the `-D` device name. */
  get scopeKey(): string {
    return this.options.device ?? LOCAL_SCOPE_KEY;
  }

  /** Diagnostics prefix naming the exact child a message came from. */
  private get label(): string {
    return `[${this.scopeKey}] agents ${sessionWatchArgs(this.options.device).join(' ')}`;
  }

  /** True while the stream intends to run (started, not stopped). */
  get running(): boolean {
    return this.wantRunning;
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
        this.attach(spawn(bin, sessionWatchArgs(this.options.device), {
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
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.options.onError?.(`${this.label} emitted invalid JSON: ${line.slice(0, 160)}`);
        return;
      }
      const event = adaptSessionWatchEnvelope(parsed);
      if (!event) return;
      // A valid event proves this child is healthy — reset the backoff.
      this.restartAttempts = 0;
      this.options.emit(event);
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr = (stderr + text).slice(-SessionCliStream.STDERR_CAP);
      // Surface stderr AS IT ARRIVES, not only on a non-zero exit: a child that
      // stays up while complaining (an unsupported flag on an older CLI, a slow
      // ssh hop) otherwise reports nothing at all. 0.9.361's fleet fan-out
      // discarded stderr entirely and the failure was invisible.
      for (const trimmed of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
        this.options.onStderr?.(`${this.label} ${trimmed}`);
      }
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
      if (this.wantRunning && isCurrent) this.scheduleRestart();
    };
    this.stopChild = () => {
      if (cleanup) return;
      cleanup = terminateProducer(child, directExit, this.options.stopGraceMs ?? 2_000);
      void cleanup.then(() => settle(exitReason), (error) => {
        // Keep the failed ownership promise and child identity. Neither a
        // demand restart nor a leadership handoff can treat failure as exit.
        this.options.onError?.(`${this.label} cleanup failed: ${String(error)}`);
        rejectExit(error);
      });
    };
    child.on('error', (err: Error) => {
      const message = err?.message || `${this.label} failed`;
      if (!child.pid) { reaped(); settle(message); }
      else this.options.onError?.(message);
    });
    child.once('exit', (code) => {
      reaped();
      exitReason = code === 0 ? undefined : (stderr.trim() || `${this.label} exited ${code}; restarting stream`);
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
