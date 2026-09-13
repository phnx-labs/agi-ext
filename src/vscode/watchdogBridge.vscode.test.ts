import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vscodeDouble } from '../testing/vscodeDouble';

// The bridge wires vscode terminals; the double is enough here because this
// test only exercises the leader-gated socket lifecycle, never a nudge.
mock.module('vscode', () => vscodeDouble({}));

const { startWatchdogBridge } = await import('./watchdogBridge.vscode');
const { requestWatchdog } = await import('../mcp/watchdogProtocol');
const { electLeader, disposeLeader } = await import('../monitor/leader');

let counter = 0;
const dirs: string[] = [];
const bridges: { dispose(): void | Promise<void> }[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `watchdog-bridge-test-${process.pid}-${counter++}-`)
  );
  dirs.push(dir);
  return dir;
}

function tempSocketPath(dir: string): string {
  return path.join(dir, 'watchdog.sock');
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = 'condition'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

// The gate subscribes to the ACTIVE elector at wire-up (onLeadershipChange
// no-ops without one), so leadership must be held before the bridge is built.
function becomeLeader(dir: string): void {
  electLeader({
    selfId: `bridge-test-${counter}`,
    pid: process.pid,
    heartbeatMs: 50,
    ttlMs: 150,
    leaseFile: path.join(dir, 'monitor-lease.json'),
  });
}

function makeBridge(dir: string, socketPath: string) {
  const bridge = startWatchdogBridge(
    { extensionPath: dir } as never,
    { socketPath }
  );
  bridges.push(bridge);
  return bridge;
}

beforeEach(async () => {
  await disposeLeader();
});

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
  await disposeLeader();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('startWatchdogBridge lifecycle', () => {
  test('binds the socket path while leader, releases it when leadership is lost', async () => {
    const dir = tempDir();
    const socketPath = tempSocketPath(dir);

    becomeLeader(dir);
    const bridge = makeBridge(dir, socketPath);
    await waitFor(() => fs.existsSync(socketPath), 5000, 'socket file while leader');

    // The bound bridge really answers requests (success:false + error string —
    // no terminals in the double, and sibling suites may leak registry state
    // into this process, so the exact message is not asserted).
    const response = await requestWatchdog(
      { kind: 'nudge', sessionId: 'sess-x', text: 'go', reason: 'test' },
      { socketPath, timeoutMs: 2000 }
    );
    expect(response.success).toBe(false);
    expect(typeof response.error).toBe('string');

    // dispose() settles only after the socket file is actually gone — the
    // gate holds the elector lease until the returned promise resolves.
    const teardown = bridge.dispose();
    expect(teardown).toBeInstanceOf(Promise);
    await teardown;
    expect(fs.existsSync(socketPath)).toBe(false);

    // A later leadership loss with nothing running resolves quietly too.
    await disposeLeader();
  });

  test('dispose during an in-flight bind never publishes a stale socket', async () => {
    const dir = tempDir();
    const socketPath = tempSocketPath(dir);

    becomeLeader(dir);
    const bridge = makeBridge(dir, socketPath);
    // Tear down in the same breath: the bind races the dispose.
    await bridge.dispose();

    // Give a wrongly-published bind time to appear, then prove the path is
    // free for the next leader.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  test('a new leader rebinds the same path only after the old teardown settles', async () => {
    const dir = tempDir();
    const socketPath = tempSocketPath(dir);

    becomeLeader(dir);
    const first = makeBridge(dir, socketPath);
    await waitFor(() => fs.existsSync(socketPath), 5000, 'first bind');

    await disposeLeader();
    await first.dispose();
    expect(fs.existsSync(socketPath)).toBe(false);

    // Leadership flips to a second window on a fresh elector in the same dir.
    becomeLeader(dir);
    const second = makeBridge(dir, socketPath);
    await waitFor(() => fs.existsSync(socketPath), 5000, 'second bind');

    const response = await requestWatchdog(
      { kind: 'nudge', sessionId: 'sess-y', text: 'go', reason: 'test' },
      { socketPath, timeoutMs: 2000 }
    );
    expect(response.success).toBe(false);
    expect(typeof response.error).toBe('string');
  });
});
