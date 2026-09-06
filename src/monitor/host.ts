// Monitor host runtime — foundation 3/3 of the centralized-monitor epic (#64),
// extended by the readiness and canonical CLI session-stream migrations.
//
// The elected leader (#65) == the monitor. While this window holds the lease it
// runs ONE `MonitorBroadcastServer` (#66); followers connect to it, report their
// terminal tuples, and receive the merged snapshot back as a broadcast fact.
// When `detectors` is enabled the host ALSO runs the centralized work:
//   - a ReadinessDetector (#68) fed the union of all windows' shell pids, which
//     broadcasts tabReady/shellReady/promptReady/agentReady + ShellAdoptionInfo
//     facts keyed by pid;
// Followers map every fact back to their own terminals window-locally.
//
// Kept vscode-free so it runs and tests in a plain process against real Unix
// sockets and real subprocesses/files (see *.test.ts).

import type { ChildProcessWithoutNullStreams } from 'child_process';
import type * as net from 'net';
import { MonitorBroadcastServer } from './broadcast';
import { MonitorEvent } from './broadcastTypes';
import {
  ArmAck,
  ArmAgentRequest,
  ArmShellAdoptionRequest,
  MONITOR_FACT,
  MONITOR_OP,
  MonitorRequest,
  ReadinessFactPayload,
  ReportTuplesAck,
  ShellAdoptionFactPayload,
  SnapshotReply,
  TerminalTuple,
  TuplesSnapshotPayload,
} from './protocol';
import { ReadinessDetector } from './readinessDetector';
import { SessionCliReplay, SessionCliStream, type SessionCliEvent } from './sessionCliStream';

/** Enable + configure the centralized presentation detectors. */
export interface MonitorDetectorOptions {
  /** Run the pid-keyed readiness detector. Default true. */
  readiness?: boolean;
}

/** Demand-gated session-CLI stream (PHNX-3939). */
export interface MonitorSessionStreamOptions {
  /** Turn on the demand-gated `agents feed watch` producer. Off -> never spawns. */
  enabled?: boolean;
  /** Test seam: supply a real child, in its own process group on POSIX. */
  spawnWatch?: () => ChildProcessWithoutNullStreams;
  /** Grace period before teardown after demand hits zero (default 5s). */
  stopDebounceMs?: number;
  /** Restart backoff base handed to SessionCliStream (default 1s). */
  restartMs?: number;
}

export interface MonitorHostOptions {
  /** Override the broadcast socket path (tests). */
  socketPath?: string;
  /**
   * Run the centralized probes/watchers (#68, #69). Omit (or undefined) to run
   * a tuple-only host — the foundation behavior used by the #67 tests.
   */
  detectors?: MonitorDetectorOptions;
  /**
   * Own the single demand-gated `agents feed watch --json` producer (PHNX-3939).
   * The stream spawns only while a window reports demand and is torn down when
   * none do — the receive side (`sessionPresentationStore`) survived e0f4831; this
   * restores the producer without the always-on CPU/ssh load that removal fixed.
   */
  sessionStream?: MonitorSessionStreamOptions;
}

export class MonitorHost {
  private readonly server: MonitorBroadcastServer;
  // windowId -> that window's last-reported tuple slice. The union across all
  // slices is the global terminal set the monitor broadcasts. Slices are keyed
  // by window so a re-report replaces (never appends) a window's terminals.
  private readonly slices = new Map<string, TerminalTuple[]>();
  private running = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;

  private readonly detectorOpts?: MonitorDetectorOptions;
  private readinessDetector?: ReadinessDetector;

  // Demand-gated session-CLI stream (PHNX-3939). Leases are keyed by the follower
  // SOCKET (not windowId) so a dropped connection releases its demand immediately
  // via onDisconnect, and a replacement window's demand is never cancelled by the
  // old socket's teardown. The replay cache lets a window that gains demand paint
  // the current rows without waiting for the next live event.
  private readonly sessionStreamOpts?: MonitorSessionStreamOptions;
  private sessionStream?: SessionCliStream;
  private readonly sessionReplay = new SessionCliReplay();
  private readonly demandLeases = new Map<net.Socket, boolean>();
  private stopStreamTimer?: ReturnType<typeof setTimeout>;
  private replayClientSeq = 0;

  constructor(options: MonitorHostOptions = {}) {
    this.detectorOpts = options.detectors;
    this.sessionStreamOpts = options.sessionStream;
    this.server = new MonitorBroadcastServer({
      socketPath: options.socketPath,
      onRequest: (payload, socket) => this.handleRequest(payload, socket),
      onDisconnect: (socket) => this.releaseDemand(socket),
    });
  }

  /** True while the demand-gated session stream intends to run (tests/observability). */
  get sessionStreamRunning(): boolean {
    return !!this.sessionStream?.running;
  }

  /** Number of currently-connected follower sockets. */
  get clientCount(): number {
    return this.server.clientCount;
  }


  /** Bind the broadcast socket, start detectors, and begin serving followers. */
  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.running) return;
    if (!this.starting) {
      this.starting = this.server.start().then(() => {
        this.running = true;
        this.startDetectors();
      }).finally(() => { this.starting = undefined; });
    }
    await this.starting;
  }

  /** Stop serving immediately; retain ownership until startup and reap finish. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    this.stopping = this.shutdown();
    void this.stopping.then(() => { this.stopping = undefined; }, () => {});
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    // A leader can lose its lease while the socket bind is still pending.
    try { await this.starting; } catch { /* failed bind still needs cleanup */ }
    this.running = false;
    this.readinessDetector?.stop();
    this.readinessDetector = undefined;
    if (this.stopStreamTimer) { clearTimeout(this.stopStreamTimer); this.stopStreamTimer = undefined; }
    // Keep the old endpoint bound until the producer is fully reaped. The
    // elector awaits this entire disposer before releasing the lease; a peer
    // can then bind without our late close unlinking its replacement socket.
    await this.sessionStream?.stop();
    await this.server.close();
    this.sessionStream = undefined;
    this.sessionReplay.clear();
    this.demandLeases.clear();
    this.slices.clear();
  }

  /** The union of every window's reported tuples. */
  snapshot(): TerminalTuple[] {
    const out: TerminalTuple[] = [];
    for (const slice of this.slices.values()) out.push(...slice);
    return out;
  }

  private startDetectors(): void {
    const opts = this.detectorOpts;
    if (!opts) return;
    if (opts.readiness !== false) {
      this.readinessDetector = new ReadinessDetector({
        emit: (fact) => this.broadcastReadiness(fact),
        emitAdoption: (fact) => this.broadcastShellAdoption(fact),
      });
      this.syncDetectorPids();
    }
  }

  private handleRequest(
    payload: unknown,
    socket: net.Socket,
  ): ReportTuplesAck | SnapshotReply | ArmAck {
    const req = payload as MonitorRequest | undefined;
    const op = req?.op;
    if (req && op === MONITOR_OP.reportTuples) {
      this.slices.set(req.windowId, req.tuples ?? []);
      this.syncDetectorPids();
      this.setDemand(socket, !!req.sessionDemand);
      this.broadcastSnapshot();
      return { ok: true, windowId: req.windowId, count: req.tuples?.length ?? 0 };
    }
    if (req && op === MONITOR_OP.snapshot) {
      return { tuples: this.snapshot() };
    }
    if (req && op === MONITOR_OP.armAgent) {
      const r = req as ArmAgentRequest;
      this.readinessDetector?.armAgent(r.pid, r.agentKey, r.sessionId);
      return { ok: true };
    }
    if (req && op === MONITOR_OP.armShellAdoption) {
      const r = req as ArmShellAdoptionRequest;
      this.readinessDetector?.armShellAdoption(r.pid);
      return { ok: true };
    }
    throw new Error(`Unknown monitor request op: ${JSON.stringify(op)}`);
  }

  private syncDetectorPids(): void {
    if (!this.readinessDetector) return;
    const pids = new Set<number>();
    for (const slice of this.slices.values()) {
      for (const t of slice) {
        if (typeof t.pid === 'number') pids.add(t.pid);
      }
    }
    this.readinessDetector.setPids(pids);
  }

  private broadcast(type: string, payload: unknown): void {
    const event: MonitorEvent = { type, payload, ts: Date.now() };
    this.server.broadcast(event);
  }

  private broadcastSnapshot(): void {
    const payload: TuplesSnapshotPayload = { tuples: this.snapshot() };
    this.broadcast(MONITOR_FACT.tuplesSnapshot, payload);
  }

  private broadcastReadiness(payload: ReadinessFactPayload): void {
    this.broadcast(MONITOR_FACT.readiness, payload);
  }

  private broadcastShellAdoption(payload: ShellAdoptionFactPayload): void {
    this.broadcast(MONITOR_FACT.shellAdoption, payload);
  }

  // ── Demand-gated session-CLI stream (PHNX-3939) ─────────────────────────────

  /** Record this socket's demand, (re)evaluate the gate, and replay to a window
   *  that JUST gained demand so it paints without waiting for the next event. */
  private setDemand(socket: net.Socket, demand: boolean): void {
    const prev = this.demandLeases.get(socket) ?? false;
    this.demandLeases.set(socket, demand);
    this.evaluateSessionStream();
    if (demand && !prev && this.sessionStreamRunning && this.sessionReplay.hasState) {
      this.replayTo(socket);
    }
  }

  /** A dropped follower releases its lease. An OLD socket's teardown must never
   *  cancel a REPLACEMENT window's demand — leases are per-socket, so it can't. */
  private releaseDemand(socket: net.Socket): void {
    if (this.demandLeases.delete(socket)) this.evaluateSessionStream();
  }

  private get anyDemand(): boolean {
    for (const demand of this.demandLeases.values()) if (demand) return true;
    return false;
  }

  /** Start the stream while any window demands it; tear it down (debounced) when
   *  none do. Cancelling a pending stop on renewed demand avoids tab-switch flap. */
  private evaluateSessionStream(): void {
    if (!this.running || this.stopping || !this.sessionStreamOpts?.enabled) return;
    if (this.anyDemand) {
      if (this.stopStreamTimer) { clearTimeout(this.stopStreamTimer); this.stopStreamTimer = undefined; }
      this.startSessionStream();
      return;
    }
    if (this.sessionStreamRunning && !this.stopStreamTimer) {
      const ms = this.sessionStreamOpts.stopDebounceMs ?? 5_000;
      this.stopStreamTimer = setTimeout(() => {
        this.stopStreamTimer = undefined;
        if (!this.anyDemand) this.stopSessionStream();
      }, ms);
    }
  }

  private startSessionStream(): void {
    if (!this.running || this.stopping || this.sessionStreamRunning) return;
    if (!this.sessionStream) {
      this.sessionStream = new SessionCliStream({
        emit: (event) => this.onSessionCliEvent(event),
        onError: (message) => console.error('[MONITOR] session stream:', message),
        spawnWatch: this.sessionStreamOpts?.spawnWatch,
        restartMs: this.sessionStreamOpts?.restartMs,
      });
    }
    this.sessionStream.start();
  }

  private stopSessionStream(): void {
    // Fire-and-forget: the stop() promise only awaits the OS reap; the gen bump
    // inside it already blocks any in-flight line from this child, so clearing the
    // replay cache now is safe. host.stop() awaits stop() for clean shutdown.
    void this.sessionStream?.stop().catch((error) => {
      console.error('[MONITOR] session stream cleanup failed; retaining ownership:', error);
    });
    // The producer is gone — clear the replay cache so a later re-join never
    // paints a stale "current" snapshot (there is no live state behind it).
    this.sessionReplay.clear();
  }

  private onSessionCliEvent(event: SessionCliEvent): void {
    this.sessionReplay.ingest(event);
    this.broadcast(MONITOR_FACT.sessionCli, event);
  }

  /** Replay the current rows to ONE follower via sendTo — other followers are
   *  untouched (no global reset storm on a late join). */
  private replayTo(socket: net.Socket): void {
    const clientKey = `sock-${++this.replayClientSeq}`;
    for (const envelope of this.sessionReplay.envelopes(clientKey)) {
      this.server.sendTo(socket, { type: MONITOR_FACT.sessionCli, payload: envelope, ts: Date.now() });
    }
  }

}
