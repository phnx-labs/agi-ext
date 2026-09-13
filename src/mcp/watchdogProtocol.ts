import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

/**
 * Shared wire contract for the one-shot watchdog socket
 * (`~/.agents/.tmp/watchdog.sock`). The MCP server (`watchdog-server.ts`) is
 * the client; the extension host (`watchdog-bridge.ts`) is the server.
 *
 * Both directions are newline-delimited JSON ("NDJSON"): one request line, one
 * response line. Neither side may wait for EOF to know a message is complete —
 * the client never half-closes, and the server replies as soon as a full line
 * arrives. Requests carry an explicit `kind` discriminant validated by
 * {@link parseWatchdogRequest} before any handler sees them.
 */

export const WATCHDOG_SOCKET_PATH = path.join(
  os.homedir(),
  '.agents',
  '.tmp',
  'watchdog.sock'
);

export type WatchdogRequest =
  | { kind: 'nudge'; sessionId: string; text: string; reason: string }
  | { kind: 'peer'; senderSessionId: string; targetSessionId: string; text: string };

/** Success payload fields beyond `success` are per-tool (nudgedAt, sentAt, …). */
export interface WatchdogResponse {
  success: boolean;
  error?: string;
  [extra: string]: unknown;
}

type WatchdogRequestHandler = (
  request: WatchdogRequest
) => Promise<WatchdogResponse> | WatchdogResponse;

export function encodeWatchdogLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Parse and validate one request line. Returns the request, or an error
 * message suitable for the response's `error` field. `JSON.parse` accepting
 * `null`/`42`/`"x"` and frames missing the `kind` discriminant both land here.
 */
export function parseWatchdogRequest(
  line: string
): { request: WatchdogRequest } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: 'Malformed request: not valid JSON' };
  }
  if (!isRecord(parsed) || typeof parsed.kind !== 'string') {
    return { error: 'Malformed request: missing kind discriminant' };
  }
  if (parsed.kind === 'nudge') {
    if (
      nonEmptyString(parsed.sessionId) &&
      nonEmptyString(parsed.text) &&
      nonEmptyString(parsed.reason)
    ) {
      return {
        request: {
          kind: 'nudge',
          sessionId: parsed.sessionId,
          text: parsed.text,
          reason: parsed.reason,
        },
      };
    }
    return { error: 'Malformed request: nudge requires sessionId, text, reason' };
  }
  if (parsed.kind === 'peer') {
    if (
      typeof parsed.senderSessionId === 'string' &&
      nonEmptyString(parsed.targetSessionId) &&
      nonEmptyString(parsed.text)
    ) {
      return {
        request: {
          kind: 'peer',
          senderSessionId: parsed.senderSessionId,
          targetSessionId: parsed.targetSessionId,
          text: parsed.text,
        },
      };
    }
    return { error: 'Malformed request: peer requires senderSessionId, targetSessionId, text' };
  }
  return { error: `Malformed request: unknown kind "${parsed.kind}"` };
}

function isWatchdogResponse(value: unknown): value is WatchdogResponse {
  return (
    isRecord(value) &&
    typeof value.success === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

const RESPONSE_TIMEOUT_MS = 5000;

/**
 * Client side of the watchdog socket: connect, send one NDJSON request line,
 * resolve with the first NDJSON response line. The socket is never half-closed
 * to signal end-of-request; the newline is the frame boundary in both
 * directions. Resolves with an error payload (never rejects) so MCP tool calls
 * surface failures as data, matching the previous behavior.
 */
export function requestWatchdog(
  request: WatchdogRequest,
  options: { socketPath?: string; timeoutMs?: number } = {}
): Promise<WatchdogResponse> {
  const socketPath = options.socketPath ?? WATCHDOG_SOCKET_PATH;
  const timeoutMs = options.timeoutMs ?? RESPONSE_TIMEOUT_MS;
  return new Promise<WatchdogResponse>((resolve) => {
    const settle = (response: WatchdogResponse) => {
      clearTimeout(timer);
      cleanup();
      client.destroy();
      resolve(response);
    };
    const fail = (error: string) => settle({ success: false, error });

    const client = net.createConnection(socketPath, () => {
      client.write(encodeWatchdogLine(request));
    });

    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) {
        return;
      }
      const line = buf.slice(0, idx).trim();
      if (!line) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail('Invalid response from extension');
        return;
      }
      if (!isWatchdogResponse(parsed)) {
        fail('Invalid response from extension');
        return;
      }
      settle(parsed);
    });

    const onError = (err: Error) => fail(`Socket error: ${err.message}`);
    const onClose = () => fail('Extension closed the connection without a response');
    client.on('error', onError);
    client.on('close', onClose);

    const cleanup = () => {
      client.removeListener('error', onError);
      client.removeListener('close', onClose);
    };
    const timer = setTimeout(() => {
      fail('Timeout connecting to extension');
    }, timeoutMs);
  });
}

export interface WatchdogServerOptions {
  socketPath?: string;
  onRequest: WatchdogRequestHandler;
  /** Fired when the server is listening. */
  onListening?: (socketPath: string) => void;
  /** Fired on server/connection errors; defaults to console.error. */
  onError?: (err: Error) => void;
}

export interface WatchdogServer {
  socketPath: string;
  /**
   * Stop listening and drop all client connections. Safe to call after a new
   * server has rebound the same path: the socket file is only removed when it
   * still belongs to this server.
   */
  close(): Promise<void>;
}

/**
 * Server side of the watchdog socket. Each complete request line is validated
 * and dispatched as it arrives — no EOF wait, so a client that keeps its side
 * open (like {@link requestWatchdog}) still gets a reply. One response line is
 * written per request line; handler throws become `{success: false, error}`.
 */
export async function startWatchdogServer(
  options: WatchdogServerOptions
): Promise<WatchdogServer> {
  const socketPath = options.socketPath ?? WATCHDOG_SOCKET_PATH;
  const onError = options.onError ?? ((err) => console.error('[WATCHDOG] Socket error:', err));
  const clients = new Set<net.Socket>();

  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  try {
    await fs.unlink(socketPath);
  } catch {
    // Socket doesn't exist, that's fine.
  }

  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setEncoding('utf8');
    let buf = '';

    socket.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) {
          continue;
        }
        void dispatch(line, socket);
      }
    });

    const drop = () => clients.delete(socket);
    socket.on('error', (err) => {
      drop();
      onError(err);
    });
    socket.on('close', drop);
  });

  async function dispatch(line: string, socket: net.Socket): Promise<void> {
    const parsed = parseWatchdogRequest(line);
    let response: WatchdogResponse;
    if ('error' in parsed) {
      response = { success: false, error: parsed.error };
    } else {
      try {
        response = await options.onRequest(parsed.request);
      } catch (err) {
        response = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (socket.destroyed || !socket.writable) {
      clients.delete(socket);
      return;
    }
    try {
      socket.write(encodeWatchdogLine(response));
    } catch {
      clients.delete(socket);
      socket.destroy();
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  // Identity of the socket file we bound, so close() can tell "our file" from
  // a replacement bound by a new leader after a leadership flip.
  let socketIdentity: { dev: number; ino: number } | null = null;
  try {
    const st = await fs.stat(socketPath);
    socketIdentity = { dev: st.dev, ino: st.ino };
  } catch {
    // Path vanished between listen and stat; nothing to guard.
  }

  options.onListening?.(socketPath);

  return {
    socketPath,
    async close() {
      for (const socket of clients) {
        socket.destroy();
      }
      clients.clear();
      // `server.close()` unlinks the socket path itself (libuv does it when
      // the listening handle closes) — even if a new leader has already
      // rebound the path. If the path no longer belongs to us, move it aside
      // for the duration of the close and restore it afterwards, so a late
      // teardown from an old leader cannot sever the new leader's socket.
      let displaced: string | null = null;
      try {
        const st = await fs.stat(socketPath);
        if (
          socketIdentity &&
          (st.dev !== socketIdentity.dev || st.ino !== socketIdentity.ino)
        ) {
          displaced = `${socketPath}.displaced-${process.pid}`;
          await fs.rename(socketPath, displaced);
        }
      } catch {
        // Path already gone: there is nothing for close() to unlink either.
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (displaced) {
        try {
          await fs.rename(displaced, socketPath);
        } catch {
          // The successor removed its own file; nothing to restore.
        }
      }
    },
  };
}
