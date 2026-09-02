import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createInterface } from 'readline';
import { bootstrapPath, resolveAgentsBin } from '../core/agentsBin';

import type { SessionCliFactPayload as SessionCliEvent } from './protocol';
export type { SessionCliEvent };

export interface SessionCliStreamOptions {
  emit: (event: SessionCliEvent) => void;
  onError?: (message: string) => void;
  spawnWatch?: () => ChildProcessWithoutNullStreams;
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
  /** Intentionally started (not stopped by the host). Exit restarts while true. */
  private wantRunning = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  /**
   * Consecutive restarts since the last healthy run (PHNX-3818). A child that
   * exits immediately and repeatedly — a broken/half-upgraded `agents` bin, bad
   * `feed watch` args, an invalid-JSON crash — used to respawn every fixed
   * `restartMs` (1s) forever with no ceiling: a steady 1 spawn/sec drip. The
   * restart delay now backs off exponentially from `restartMs` up to
   * MAX_RESTART_MS, and resets to 0 the moment the stream produces a valid event
   * (proof the child works), so a transient blip still recovers fast.
   */
  private restartAttempts = 0;
  private static readonly MAX_RESTART_MS = 30_000;

  constructor(private readonly options: SessionCliStreamOptions) {}

  start(): void {
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.spawnChild();
  }

  private spawnChild(): void {
    if (!this.wantRunning || this.child) return;
    if (this.options.spawnWatch) {
      this.attach(this.options.spawnWatch());
      return;
    }
    void resolveAgentsBin().then((bin) => {
      if (!this.wantRunning || this.child) return;
      const augmented = bootstrapPath(bin);
      this.attach(spawn(bin, ['feed', 'watch', '--json'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${augmented}:${process.env.PATH ?? ''}` },
      }));
    }).catch((error) => {
      this.options.onError?.(error instanceof Error ? error.message : String(error));
      this.scheduleRestart();
    });
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    if (!this.wantRunning) { child.kill(); return; }
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line) as SessionCliEvent;
        if ((event?.v === 1 || event?.version === 1) && typeof event.streamId === 'string'
          && Number.isInteger(event.sequence) && typeof event.type === 'string') {
          // A valid event means this child is healthy — reset the restart backoff
          // so a later transient exit restarts fast rather than at the drip cap.
          this.restartAttempts = 0;
          this.options.emit(event);
        }
      } catch {
        this.options.onError?.(`agents feed watch emitted invalid JSON: ${line.slice(0, 160)}`);
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('exit', (code) => {
      this.child = undefined;
      try { lines.close(); } catch { /* already closed */ }
      if (!this.wantRunning) return;
      if (code !== 0) {
        this.options.onError?.(
          stderr.trim() || 'agents feed watch exited; restarting stream',
        );
      }
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (!this.wantRunning || this.restartTimer) return;
    const base = this.options.restartMs ?? 1_000;
    // Exponential backoff, capped, so a child that keeps dying can't drip a
    // spawn every `base` ms forever (PHNX-3818). A healthy event resets the count.
    const ms = Math.min(base * 2 ** this.restartAttempts, SessionCliStream.MAX_RESTART_MS);
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawnChild();
    }, ms);
  }

  stop(): void {
    this.wantRunning = false;
    this.restartAttempts = 0;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.child?.kill();
    this.child = undefined;
  }
}
