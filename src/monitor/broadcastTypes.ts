/**
 * Wire types for the monitor broadcast channel (#66).
 *
 * The elected monitor (#65) runs a {@link MonitorBroadcastServer} and pushes
 * computed, pid/sessionId-keyed facts to every follower window. The transport
 * is a Unix-domain socket carrying newline-delimited JSON ("NDJSON") frames so
 * a single connection can multiplex three message kinds:
 *
 *   - `event`    server -> all clients   (fan-out push)
 *   - `request`  client -> server        (e.g. "register pids", "snapshot")
 *   - `response` server -> one client     (reply correlated by request id)
 */

/** The fact the monitor pushes to followers. `payload` is type-specific. */
export interface MonitorEvent {
  type: string;
  sessionId?: string;
  pid?: number;
  payload: unknown;
  ts: number;
}

/** Server -> clients: a broadcast push. */
interface MonitorEventFrame {
  kind: 'event';
  event: MonitorEvent;
}

/** Client -> server: a correlated request on the persistent connection. */
interface MonitorRequestFrame {
  kind: 'request';
  id: number;
  payload: unknown;
}

/** Server -> one client: the reply to a {@link MonitorRequestFrame}. */
interface MonitorResponseFrame {
  kind: 'response';
  id: number;
  payload?: unknown;
  error?: string;
}

export type MonitorFrame =
  | MonitorEventFrame
  | MonitorRequestFrame
  | MonitorResponseFrame;

/** Serialize a frame as a single NDJSON line (trailing newline included). */
export function encodeFrame(frame: MonitorFrame): string {
  return JSON.stringify(frame) + '\n';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Structural validation for one decoded line. `JSON.parse` happily accepts
 * `null`, numbers, and strings, and a frame missing its discriminant or
 * required fields would otherwise flow into switch statements as undefined.
 */
export function isMonitorFrame(value: unknown): value is MonitorFrame {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return false;
  }
  if (value.kind === 'event') {
    const event = value.event;
    return (
      isRecord(event) &&
      typeof event.type === 'string' &&
      'payload' in event &&
      isFiniteNumber(event.ts)
    );
  }
  if (value.kind === 'request') {
    return isFiniteNumber(value.id) && 'payload' in value;
  }
  if (value.kind === 'response') {
    if (!isFiniteNumber(value.id)) {
      return false;
    }
    return value.error === undefined || typeof value.error === 'string';
  }
  return false;
}

/**
 * Incremental NDJSON decoder. Socket reads do not align to line boundaries, so
 * the decoder buffers partial lines and emits complete frames as they arrive.
 * Malformed or structurally invalid lines are dropped rather than throwing, so
 * one corrupt frame never tears down a persistent connection. A bounded buffer
 * caps how much incomplete data a silent peer can pin: on overflow the pending
 * partial frame is discarded and buffering restarts.
 */
export class FrameDecoder {
  private buf = '';
  private dropped = 0;
  private readonly maxBufferedChars: number;

  constructor(options: { maxBufferedChars?: number } = {}) {
    this.maxBufferedChars = options.maxBufferedChars ?? 64 * 1024;
  }

  /** Number of lines dropped so far (unparseable or failed validation). */
  get droppedCount(): number {
    return this.dropped;
  }

  push(chunk: string): MonitorFrame[] {
    this.buf += chunk;
    if (this.buf.length > this.maxBufferedChars) {
      // A complete frame never exceeds one line; a buffer this large without
      // a newline means the peer is dribbling data or silent. Drop the partial
      // frame instead of growing without bound.
      this.buf = '';
      this.dropped += 1;
    }
    const frames: MonitorFrame[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (isMonitorFrame(parsed)) {
          frames.push(parsed);
        } else {
          this.dropped += 1;
        }
      } catch {
        // Drop the malformed line; the connection stays alive.
        this.dropped += 1;
      }
    }
    return frames;
  }
}
