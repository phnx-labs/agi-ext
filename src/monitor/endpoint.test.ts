// listenOwned over real Unix sockets: a contender never displaces a live
// endpoint, a superseded owner's close never removes its replacement, and a
// leftover path from a dead server is taken over.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { listenOwned, type OwnedEndpoint } from './endpoint';

const dirs: string[] = [];
const endpoints: OwnedEndpoint[] = [];

afterEach(async () => {
  await Promise.allSettled(endpoints.splice(0).map((endpoint) => endpoint.close()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function socketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-endpoint-'));
  dirs.push(dir);
  return path.join(dir, 'feed.sock');
}

/** A server that answers every connection with `name` and hangs up. */
function namedServer(name: string): net.Server {
  return net.createServer((socket) => socket.end(`${name}\n`));
}

async function serve(name: string, at: string): Promise<OwnedEndpoint> {
  const endpoint = await listenOwned(namedServer(name), at);
  endpoints.push(endpoint);
  return endpoint;
}

/** Read the greeting of whoever serves `at`, within a bound. */
function whoServes(at: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer on ${at}`)); }, 2000);
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => { clearTimeout(timer); socket.destroy(); resolve(data.trim()); });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.connect(at);
  });
}

const leftovers = (at: string) => fs.readdirSync(path.dirname(at)).filter((name) => name !== path.basename(at));

test('a contender fails with EADDRINUSE and leaves the live endpoint serving', async () => {
  const at = socketPath();
  await serve('first', at);
  await expect(listenOwned(namedServer('second'), at)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(await whoServes(at)).toBe('first');
  expect(leftovers(at)).toEqual([]);
});

test('a superseded owner closing late does not remove its replacement', async () => {
  const at = socketPath();
  const first = await serve('first', at);
  // The path is renamed away, as by a peer cleaning up a name it judged stale.
  fs.renameSync(at, `${at}.moved`);
  await serve('second', at);
  await first.close();
  expect(await whoServes(at)).toBe('second');
});

test('a leftover path from a dead server is taken over', async () => {
  const at = socketPath();
  const bind = `require('net').createServer().listen(${JSON.stringify(at)}, () => process.kill(process.pid, 'SIGKILL'))`;
  spawnSync('node', ['-e', bind], { timeout: 5000 });
  expect(fs.existsSync(at)).toBe(true);
  await serve('successor', at);
  expect(await whoServes(at)).toBe('successor');
});

test('close returns while a peer still holds an accepted connection open', async () => {
  const at = socketPath();
  const endpoint = await listenOwned(net.createServer(() => { /* never ends the connection */ }), at);
  const peer = new net.Socket();
  await new Promise<void>((resolve, reject) => { peer.once('connect', resolve); peer.once('error', reject); peer.connect(at); });
  try {
    const closed = await Promise.race([
      endpoint.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    expect(closed).toBe(true);
    expect(fs.existsSync(at)).toBe(false);
  } finally {
    peer.destroy();
  }
});
