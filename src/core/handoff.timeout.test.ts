import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AGENTS_SESSIONS_TIMEOUT_MS, runAgentsSessions } from './handoff';

// PHNX-3467: a one-shot `agents` refresh spawn must be bounded. A wedged CLI
// child (the sleep/wake / stuck-read failure mode) must be killed by the
// deadline, not orphaned and left holding the caller's in-flight guard forever.
// This drives the REAL execFile path against a fake `agents` on PATH that hangs;
// with no timeout the promise would never settle and the test would hit the
// suite timeout. A tiny injected budget proves the child is actually killed.
describe('runAgentsSessions bounding (PHNX-3467)', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agi-ext-agents-stub-'));
    const stub = join(dir, 'agents');
    // Sleeps far past any test budget; if the deadline does not fire, the test
    // hangs — which is exactly the production bug being guarded against.
    writeFileSync(stub, '#!/bin/sh\nsleep 30\n');
    chmodSync(stub, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  test('a hung agents child is killed at the deadline instead of orphaned', async () => {
    const started = Date.now();
    let rejected = false;
    try {
      await runAgentsSessions(['sessions', 'abc', '--json'], undefined, 200);
    } catch {
      rejected = true;
    }
    const elapsed = Date.now() - started;
    expect(rejected).toBe(true);
    // Killed near the 200ms deadline, nowhere near the stub's 30s sleep.
    expect(elapsed).toBeLessThan(5_000);
  });

  test('default production budget is a real, bounded deadline', () => {
    expect(AGENTS_SESSIONS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(AGENTS_SESSIONS_TIMEOUT_MS)).toBe(true);
  });
});
