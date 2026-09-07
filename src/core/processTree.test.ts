import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { killProcessTree } from './processTree';

// Real bounded subprocess tree — no mocking — so this exercises the actual OS
// process-group semantics `detached: true` + killProcessTree rely on.
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until(predicate: () => boolean, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('deadline exceeded');
    await delay(10);
  }
}

const spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test.skipIf(process.platform === 'win32')(
  'killProcessTree reaps a grandchild that a plain child.kill() would orphan',
  async () => {
    // A real Node parent that forks a real detached-from-us grandchild (a
    // `sleep`), reports its pid over stdout, then idles. This is the exact
    // shape of the 1.22.85 incident: the extension only ever sees the direct
    // child, and the child itself has descendants.
    const script =
      "const { spawn } = require('child_process');" +
      "const gc = spawn('sleep', ['30'], { stdio: 'ignore' });" +
      "process.stdout.write(String(gc.pid) + '\\n');" +
      "setInterval(() => {}, 1000);";
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    if (child.pid) spawned.push(child.pid);

    let grandchildPid = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      const n = Number(chunk.toString('utf8').trim());
      if (Number.isFinite(n) && n > 0) grandchildPid = n;
    });
    await until(() => grandchildPid > 0 && alive(grandchildPid));
    spawned.push(grandchildPid);

    expect(alive(child.pid)).toBe(true);
    expect(alive(grandchildPid)).toBe(true);

    killProcessTree(child, 200);

    await until(() => !alive(child.pid) && !alive(grandchildPid));
    expect(alive(child.pid)).toBe(false);
    expect(alive(grandchildPid)).toBe(false);
  },
);

test.skipIf(process.platform === 'win32')(
  'killProcessTree is a no-op once the group is already gone (ESRCH is swallowed)',
  async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(() => killProcessTree(child)).not.toThrow();
  },
);

test('killProcessTree on a child with no pid is a no-op', () => {
  const fakeChild = { pid: undefined, exitCode: null, signalCode: null, kill: () => true } as unknown as Parameters<typeof killProcessTree>[0];
  expect(() => killProcessTree(fakeChild)).not.toThrow();
});
