import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import { MonitorBroadcastClient } from './broadcast';
import { MONITOR_OP } from './protocol';
import { readLease } from './lease';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('cross-window handoff deadline exceeded');
    await pause(10);
  }
}

for (const gateFirst of [false, true]) {
  test.skipIf(process.platform === 'win32')(`TWO window processes retain lease/socket through SIGKILL reap (${gateFirst ? 'gate' : 'elector'} disposed first)`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-handoff-'));
    const leaseFile = path.join(dir, 'lease.json');
    const socketPath = path.join(dir, 'feed.sock');
    const windows: ChildProcessWithoutNullStreams[] = [];
    const events: Array<{ type: string; selfId: string; pid?: number; overlap?: boolean }> = [];
    const errors: string[] = [];
    const launch = (selfId: string) => {
      const child = spawn(process.execPath, [path.join(import.meta.dir, 'testdata/monitor-window.ts'), dir, selfId], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      windows.push(child);
      createInterface({ input: child.stdout }).on('line', (line) => events.push(JSON.parse(line)));
      child.stderr.on('data', (data) => errors.push(String(data)));
      return child;
    };
    const event = (selfId: string, type: string) => events.find((entry) => entry.selfId === selfId && entry.type === type);
    const client = new MonitorBroadcastClient({ socketPath, minReconnectDelayMs: 100, maxReconnectDelayMs: 100,
      onStateChange: (state) => {
        if (state === 'connected') void client.request({ op: MONITOR_OP.reportTuples, windowId: 'visible-pane', tuples: [], sessionDemand: true }).catch((error) => errors.push(String(error)));
      },
    });
    try {
      const a = launch('window-a');
      await until(() => !!event('window-a', 'bound'));
      client.connect();
      await until(() => !!event('window-a', 'producer'));
      const firstPid = event('window-a', 'producer')!.pid!;
      const b = launch('window-b');
      await until(() => !!event('window-b', 'window'));
      expect(a.pid).not.toBe(b.pid);
      a.stdin.write(gateFirst ? 'drain gate-first\n' : 'drain\n');
      await until(() => !!event('window-a', 'draining'));
      // Many real peer heartbeats and well beyond the 60ms TTL, while the old
      // producer ignores TERM for the production 2s escalation grace.
      await pause(200);
      expect(alive(firstPid)).toBe(true);
      expect(readLease(leaseFile)?.leaderId).toBe('window-a');
      expect(fs.existsSync(socketPath)).toBe(true);
      expect(event('window-b', 'leader')).toBeUndefined();
      await until(() => !!event('window-b', 'producer'));
      expect(event('window-a', 'reaped')).toBeDefined();
      expect(alive(firstPid)).toBe(false);
      expect(event('window-b', 'producer')!.overlap).toBe(false);
      expect(readLease(leaseFile)?.leaderId).toBe('window-b');
      expect(alive(a.pid!)).toBe(true); // clean handoff works before old window exits
      // Prove old teardown did not unlink the replacement's live endpoint.
      const probe = new MonitorBroadcastClient({ socketPath });
      try {
        probe.connect();
        await until(() => probe.connected);
        expect(await probe.request({ op: MONITOR_OP.snapshot })).toEqual({ tuples: [] });
      } finally { probe.close(); }
      expect(events.filter((entry) => entry.type === 'error')).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      client.close();
      for (const child of windows) child.stdin.write('exit\n');
      try { await until(() => windows.every((child) => child.exitCode !== null)); }
      finally {
        for (const child of windows) if (alive(child.pid!)) child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 15_000);
}
