import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  encodeWatchdogLine,
  parseWatchdogRequest,
  requestWatchdog,
  startWatchdogServer,
  WatchdogRequest,
  WatchdogServer,
} from './watchdogProtocol';

// Real Unix sockets over a temp path — no mocks. Each test gets a fresh path so
// parallel runs and leftover files never collide.
let counter = 0;
const created: string[] = [];

function tempSocketPath(): string {
  const p = path.join(
    os.tmpdir(),
    `watchdog-protocol-test-${process.pid}-${counter++}.sock`
  );
  created.push(p);
  return p;
}

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      // Server.close() already removed it.
    }
  }
});

const NUDGE: WatchdogRequest = {
  kind: 'nudge',
  sessionId: 'sess-1',
  text: 'continue',
  reason: 'stalled on test',
};

describe('parseWatchdogRequest', () => {
  test('accepts a nudge request', () => {
    const parsed = parseWatchdogRequest(JSON.stringify(NUDGE));
    expect(parsed).toEqual({ request: NUDGE });
  });

  test('accepts a peer request with an empty sender id', () => {
    const peer = {
      kind: 'peer',
      senderSessionId: '',
      targetSessionId: 'sess-2',
      text: 'hello',
    };
    const parsed = parseWatchdogRequest(JSON.stringify(peer));
    expect(parsed).toEqual({ request: peer });
  });

  test('rejects JSON scalars, missing discriminants, and unknown kinds', () => {
    expect(parseWatchdogRequest('null')).toEqual({
      error: 'Malformed request: missing kind discriminant',
    });
    expect(parseWatchdogRequest('42')).toEqual({
      error: 'Malformed request: missing kind discriminant',
    });
    expect(parseWatchdogRequest('{"sessionId":"s","text":"t","reason":"r"}')).toEqual({
      error: 'Malformed request: missing kind discriminant',
    });
    expect(
      parseWatchdogRequest('{"kind":"nope","sessionId":"s"}')
    ).toEqual({ error: 'Malformed request: unknown kind "nope"' });
  });

  test('rejects requests missing required fields', () => {
    expect(
      parseWatchdogRequest('{"kind":"nudge","sessionId":"s","text":"t"}')
    ).toEqual({ error: 'Malformed request: nudge requires sessionId, text, reason' });
    expect(parseWatchdogRequest('{"kind":"peer","targetSessionId":"s","text":"t"}')).toEqual({
      error: 'Malformed request: peer requires senderSessionId, targetSessionId, text',
    });
    expect(
      parseWatchdogRequest('{"kind":"nudge","sessionId":"s","text":"","reason":"r"}')
    ).toEqual({ error: 'Malformed request: nudge requires sessionId, text, reason' });
  });

  test('rejects unparseable lines', () => {
    expect(parseWatchdogRequest('not json')).toEqual({
      error: 'Malformed request: not valid JSON',
    });
  });
});

describe('watchdog socket framing (server + client over real sockets)', () => {
  test('request/reply round-trips without the client half-closing (no EOF)', async () => {
    const socketPath = tempSocketPath();
    const seen: WatchdogRequest[] = [];
    const server = await startWatchdogServer({
      socketPath,
      onRequest: (request) => {
        seen.push(request);
        return { success: true, echoed: request.sessionId ?? request.targetSessionId };
      },
    });

    try {
      const response = await requestWatchdog(NUDGE, { socketPath, timeoutMs: 2000 });
      expect(response.success).toBe(true);
      expect(response.echoed).toBe('sess-1');
      expect(seen).toEqual([NUDGE]);
    } finally {
      await server.close();
    }
  });

  test('a request written byte-by-byte (fragmented) still gets a reply', async () => {
    const socketPath = tempSocketPath();
    const server = await startWatchdogServer({
      socketPath,
      onRequest: () => ({ success: true }),
    });

    try {
      // Deliberately no newline until the end and no end() call: framing must
      // come from the line terminator, not from the write pattern or EOF.
      const line = encodeWatchdogLine(NUDGE);
      const response = await new Promise<{ success: boolean }>(
        (resolve, reject) => {
          const client = net.createConnection(socketPath, () => {
            for (let i = 0; i < line.length; i++) {
              client.write(line.slice(i, i + 1));
            }
          });
          let buf = '';
          client.on('data', (chunk) => {
            buf += chunk.toString();
            if (buf.includes('\n')) {
              client.destroy();
              resolve(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
            }
          });
          client.on('error', reject);
          setTimeout(() => {
            client.destroy();
            reject(new Error('fragmented request got no response'));
          }, 2000);
        }
      );
      expect(response.success).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('a malformed line gets an error response, not a dead connection', async () => {
    const socketPath = tempSocketPath();
    const handled: string[] = [];
    const server = await startWatchdogServer({
      socketPath,
      onRequest: (request) => {
        handled.push(request.kind);
        return { success: true };
      },
    });

    try {
      const { errorResponse, okResponse } = await new Promise<{
        errorResponse: { success: boolean; error?: string };
        okResponse: { success: boolean };
      }>((resolve, reject) => {
        const responses: { success: boolean; error?: string }[] = [];
        let buf = '';
        const client = net.createConnection(socketPath, () => {
          client.write('garbage-not-json\n');
          client.write(encodeWatchdogLine(NUDGE));
        });
        client.on('data', (chunk) => {
          buf += chunk.toString();
          let idx: number;
          while ((idx = buf.indexOf('\n')) !== -1) {
            responses.push(JSON.parse(buf.slice(0, idx)));
            buf = buf.slice(idx + 1);
          }
          if (responses.length === 2) {
            client.destroy();
            resolve({
              errorResponse: responses[0],
              okResponse: responses[1],
            });
          }
        });
        client.on('error', reject);
        setTimeout(() => {
          client.destroy();
          reject(new Error(`expected 2 responses, got ${responses.length}`));
        }, 2000);
      });

      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error).toBe('Malformed request: not valid JSON');
      expect(okResponse.success).toBe(true);
      expect(handled).toEqual(['nudge']);
    } finally {
      await server.close();
    }
  });

  test('times out against a socket that accepts but never replies', async () => {
    const socketPath = tempSocketPath();
    const silent = net.createServer((socket) => {
      // Accept and swallow: no response line, no EOF.
      socket.on('data', () => undefined);
    });
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve));

    try {
      const start = Date.now();
      const response = await requestWatchdog(NUDGE, {
        socketPath,
        timeoutMs: 300,
      });
      expect(response.success).toBe(false);
      expect(response.error).toBe('Timeout connecting to extension');
      expect(Date.now() - start).toBeGreaterThanOrEqual(300);
    } finally {
      silent.close();
    }
  });

  test('a connection closed without a response resolves as an error', async () => {
    const socketPath = tempSocketPath();
    // A server that accepts, reads the request, then hangs up without a
    // response: the client must report the missing response instead of
    // hanging or parsing empty data.
    const closer = net.createServer((socket) => {
      socket.on('data', () => socket.destroy());
    });
    await new Promise<void>((resolve) => closer.listen(socketPath, resolve));

    try {
      const response = await requestWatchdog(NUDGE, {
        socketPath,
        timeoutMs: 2000,
      });
      expect(response.success).toBe(false);
      expect(response.error).toBe(
        'Extension closed the connection without a response'
      );
    } finally {
      closer.close();
    }
  });

  test('a throwing handler surfaces as a failed response, connection stays up', async () => {
    const socketPath = tempSocketPath();
    const server = await startWatchdogServer({
      socketPath,
      onRequest: () => {
        throw new Error('handler failed on purpose');
      },
    });

    try {
      const response = await requestWatchdog(NUDGE, { socketPath, timeoutMs: 2000 });
      expect(response.success).toBe(false);
      expect(response.error).toBe('handler failed on purpose');
    } finally {
      await server.close();
    }
  });

  test('close() removes the socket file', async () => {
    const socketPath = tempSocketPath();
    const server: WatchdogServer = await startWatchdogServer({
      socketPath,
      onRequest: () => ({ success: true }),
    });
    expect(fs.existsSync(socketPath)).toBe(true);
    await server.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
