import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { SessionCliStream } from './sessionCliStream';

const fixture = path.join(import.meta.dir, 'testdata/fake-watch.mjs');
const streams: SessionCliStream[] = [];
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture deadline exceeded');
    await delay(10);
  }
}
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.stop();
  for (const child of children.splice(0)) { if (alive(child.pid)) child.kill('SIGKILL'); }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

for (const invalid of [false, true]) {
  test(`stop cancels pending executable resolution before spawn (${invalid ? 'ENOENT' : 'valid executable'})`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-resolution-'));
    dirs.push(dir);
    const bin = path.join(dir, 'watch');
    const marker = path.join(dir, 'started');
    if (!invalid) {
      fs.writeFileSync(bin, '#!/usr/bin/env node\n' +
        `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n`);
      fs.chmodSync(bin, 0o755);
    }
    let release!: (bin: string) => void;
    let resolving = false;
    const errors: string[] = [];
    const stream = new SessionCliStream({ emit: () => {}, onError: (error) => errors.push(error),
      resolveBin: () => { resolving = true; return new Promise((resolve) => { release = resolve; }); },
    });
    streams.push(stream);
    stream.start();
    expect(resolving).toBe(true);
    await stream.stop(); // Must finish before the resolver does; cancellation owns continuation.
    release(bin);
    await delay(100);
    expect(fs.existsSync(marker)).toBe(false);
    expect(errors).toEqual([]);
    expect(stream.running).toBe(false);
  });
}

test('real resolved invalid executable is handled and stop cancels retry', async () => {
  const errors: string[] = [];
  const stream = new SessionCliStream({ emit: () => {}, onError: (error) => errors.push(error),
    resolveBin: async () => '/no-such-stream-executable', restartMs: 100,
  });
  streams.push(stream);
  stream.start();
  await until(() => errors.length > 0);
  await stream.stop();
  const count = errors.length;
  await delay(150);
  expect(errors.length).toBe(count);
  expect(errors[0]).toContain('ENOENT');
});

test.skipIf(process.platform === 'win32')('SIGTERM-ignoring Node child is SIGKILLed and reaped before immediate restart', async () => {
  let ready = false;
  let overlap = false;
  const stream = new SessionCliStream({ emit: () => {}, stopGraceMs: 80, spawnWatch: () => {
    overlap ||= children.some((child) => alive(child.pid));
    const child = spawn('node', [fixture], { stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, FAKE_WATCH_IGNORE_SIGTERM: '1' },
    });
    child.stderr.on('data', (data) => { if (String(data).includes('READY')) ready = true; });
    children.push(child);
    return child;
  } });
  streams.push(stream);
  stream.start();
  await until(() => ready);
  const first = children[0];
  const begin = Date.now();
  const stopped = stream.stop();
  stream.start();
  await stopped;
  expect(Date.now() - begin).toBeLessThan(1500);
  expect(alive(first.pid)).toBe(false);
  expect(first.signalCode).toBe('SIGKILL');
  await until(() => children.length === 2);
  expect(overlap).toBe(false);
  await stream.stop();
  expect(children.every((child) => !alive(child.pid))).toBe(true);
});

// Observe actual OS state: a zombie has exited but can only be reaped by its
// new parent. A Linux container's PID 1 may not reap adopted descendants.
function executing(pid: number): boolean {
  if (!alive(pid)) return false;
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().split(/\s+/).some((state) => state && !state.startsWith('Z'));
  } catch { return false; }
}

for (const mode of ['ignore-term', 'exit-on-term', 'crash'] as const) {
  test.skipIf(process.platform === 'win32')(`real resolved producer + TERM-ignoring descendant are terminated before restart (${mode})`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-tree-'));
    dirs.push(dir);
    const bin = path.join(dir, 'watch');
    const marker = path.join(dir, 'ready.json');
    // Exercise the production resolveBin -> spawn(detached) path, not a custom
    // spawnWatch factory. The executable starts a genuine Node grandchild.
    fs.writeFileSync(bin, '#!/usr/bin/env node\n' +
      `process.env.FAKE_WATCH_DESCENDANT = '1';\n` +
      `process.env.FAKE_WATCH_IGNORE_SIGTERM = ${JSON.stringify(mode === 'ignore-term' ? '1' : '0')};\n` +
      `process.env.FAKE_WATCH_READY_FILE = ${JSON.stringify(marker)};\n` +
      `import(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
    fs.chmodSync(bin, 0o755);
    const read = (): { pid: number; descendantPid: number } | undefined => {
      try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return undefined; }
    };
    let previous: { pid: number; descendantPid: number } | undefined;
    let overlap = false;
    const stream = new SessionCliStream({ emit: () => {}, stopGraceMs: 80, restartMs: 10,
      resolveBin: async () => {
        if (previous) overlap ||= executing(previous.pid) || executing(previous.descendantPid);
        return bin;
      },
    });
    streams.push(stream);
    try {
      stream.start();
      await until(() => !!read());
      previous = read()!;
      expect(executing(previous.pid)).toBe(true);
      expect(executing(previous.descendantPid)).toBe(true);
      if (mode === 'crash') process.kill(previous.pid, 'SIGKILL');
      else {
        const stopped = stream.stop();
        stream.start();
        await stopped;
        expect(alive(previous.pid)).toBe(false); // direct child really reaped
        expect(executing(previous.descendantPid)).toBe(false);
      }
      await until(() => !!read() && read()!.pid !== previous!.pid);
      expect(alive(previous.pid)).toBe(false);
      expect(executing(previous.descendantPid)).toBe(false);
      expect(overlap).toBe(false);
      const replacement = read()!;
      await stream.stop();
      expect(alive(replacement.pid)).toBe(false);
      expect(executing(replacement.descendantPid)).toBe(false);
    } finally {
      await stream.stop();
      // Bounded fixtures also expire on failure; do not leave live groups even
      // if an assertion regresses before their normal cleanup path executes.
      for (const pid of [previous?.pid, read()?.pid]) if (pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* group gone */ }
      }
    }
  });
}
