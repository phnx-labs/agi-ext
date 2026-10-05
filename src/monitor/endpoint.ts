// Leader-owned Unix socket endpoints: the monitor broadcast and watchdog sockets.
//
// Closing a Unix-socket server unlinks its path BY NAME, even after another
// server has been bound there, and listen() refuses a path that exists. So the
// server listens on a private path and is published at the shared path with
// link(), which fails instead of replacing a live endpoint. Teardown removes
// the shared name only while it still names this server's socket.
//
// A leftover name from a crashed owner is removed only when nothing accepts on
// it. Callers hold the monitor lease, so no other current-version window is
// binding the same path concurrently.

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

export interface OwnedEndpoint {
  /** Stop listening, drop every accepted connection, and remove the shared path if it is still ours. */
  close(): Promise<void>;
}

let privateSeq = 0;

/** Resolve true when something accepts connections on `socketPath`. */
function accepting(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Listeners first: Bun reports a missing path synchronously from connect().
    const probe = new net.Socket();
    const done = (live: boolean) => { probe.destroy(); resolve(live); };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.connect(socketPath);
  });
}

function addressInUse(socketPath: string): Error {
  return Object.assign(new Error(`listen EADDRINUSE: another process is serving ${socketPath}`), { code: 'EADDRINUSE' });
}

/** Listen on `socketPath` without ever displacing or later removing another server's endpoint. */
export async function listenOwned(server: net.Server, socketPath: string): Promise<OwnedEndpoint> {
  await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
  // Unique to this live process; a file by this name belongs to a dead pid.
  const privatePath = `${socketPath}.${process.pid}-${++privateSeq}`;
  await fs.promises.rm(privatePath, { force: true });
  // server.close() waits for every accepted connection, including ones a
  // caller already stopped tracking, so the endpoint destroys them all itself.
  const connections = new Set<net.Socket>();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(privatePath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const close = () => new Promise<void>((resolve) => {
    server.close(() => resolve());
    for (const socket of connections) socket.destroy();
  });
  try {
    const { dev, ino } = await fs.promises.lstat(privatePath);
    if (!(await publish(privatePath, socketPath))) throw addressInUse(socketPath);
    await fs.promises.rm(privatePath, { force: true });
    return {
      async close() {
        try {
          const now = fs.lstatSync(socketPath);
          if (now.dev === dev && now.ino === ino) fs.unlinkSync(socketPath);
        } catch {
          // Already gone.
        }
        await close();
      },
    };
  } catch (err) {
    await close();
    throw err;
  }
}

async function publish(privatePath: string, socketPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.promises.link(privatePath, socketPath);
      return true;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      if (attempt > 0 || (await accepting(socketPath))) return false;
      await fs.promises.rm(socketPath, { force: true });
    }
  }
  return false;
}
