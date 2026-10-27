// A picture is downloaded once, then drawn from disk: in the same window, in a new
// window over the same folder, and never again while it fails.
import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AvatarCache } from './avatarCache';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const hits: Record<string, number> = {};
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    hits[p] = (hits[p] ?? 0) + 1;
    if (p === '/empty') return new Response('', { headers: { 'content-type': 'image/png' } });
    return p === '/a' ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : new Response('no', { status: 404 });
  },
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatars-'));
afterAll(() => { server.stop(true); fs.rmSync(dir, { recursive: true, force: true }); });

const until = (cond: () => boolean) => new Promise<void>((resolve) => { const t = setInterval(() => { if (cond()) { clearInterval(t); resolve(); } }, 5); });

test('one download per picture; every later draw, in this window or a new one, reads the file', async () => {
  const url = `http://localhost:${server.port}/a`;
  let fetched = 0;
  const cache = new AvatarCache(dir, () => fetched++);
  expect(cache.file(url)).toBeNull();
  expect(cache.file(url)).toBeNull();
  await until(() => fetched === 1);
  const file = cache.file(url)!;
  expect(file.endsWith('.png')).toBe(true);
  expect(fs.readFileSync(file)).toEqual(PNG);
  expect(new AvatarCache(dir, () => fetched++).file(url)).toBe(file);
  expect(hits['/a']).toBe(1);
});

test('a picture that fails is not asked for again on every draw', async () => {
  const url = `http://localhost:${server.port}/gone`;
  const cache = new AvatarCache(dir, () => undefined);
  expect(cache.file(url)).toBeNull();
  await until(() => hits['/gone'] === 1);
  await Bun.sleep(20);
  expect(cache.file(url)).toBeNull();
  await Bun.sleep(20);
  expect(hits['/gone']).toBe(1);
  expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
});

test('an empty picture is a failure, and an empty file on disk is not served', async () => {
  const url = `http://localhost:${server.port}/empty`;
  const cache = new AvatarCache(dir, () => undefined);
  expect(cache.file(url)).toBeNull();
  await until(() => hits['/empty'] === 1);
  await Bun.sleep(20);
  expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  const a = `http://localhost:${server.port}/a`;
  const file = new AvatarCache(dir, () => undefined).file(a)!;
  fs.writeFileSync(file, '');
  expect(new AvatarCache(dir, () => undefined).file(a)).toBeNull();
});
