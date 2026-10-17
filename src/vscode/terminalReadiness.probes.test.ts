// Window-side readiness against real processes, with the monitor down (this
// window probes its own pids) and up (the leader probes; only a reset probes
// here). The vscode double is the only stand-in: every pid is a real shell.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { vscodeDouble } from '../testing/vscodeDouble';
import { killProcessTree } from '../core/processTree';

mock.module('vscode', () => vscodeDouble({
  window: {
    onDidChangeTerminalShellIntegration: () => ({ dispose: () => {} }),
    onDidCloseTerminal: () => ({ dispose: () => {} }),
  },
}));

const readiness = await import('./terminalReadiness');

const spawned: ChildProcess[] = [];
const SESSION = '7b1cf038-8761-4e46-af43-5336e7e5a776';

function spawnShell(script: string): number {
  // Own process group so cleanup reaches every descendant.
  const shell = spawn('bash', ['-c', script], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  spawned.push(shell);
  return shell.pid!;
}

// A shell idle at its prompt: `read` is a builtin, so it has no child.
const idleShell = () => spawnShell('read x');
// A shell whose child sits in 'S' state, as an agent TUI waiting on input does.
const agentShell = () => spawnShell('(node -e "setInterval(()=>{}, 1e9)") ; true');

function fakeTerminal(name: string, pid: number): vscode.Terminal {
  return { name, processId: Promise.resolve(pid) } as unknown as vscode.Terminal;
}

let armed: Array<{ op: string; pid: number }> = [];
let connected = false;

beforeEach(() => {
  readiness.__clearRegistryForTests();
  armed = [];
  connected = false;
  readiness.setMonitorConnectivity(() => connected);
  readiness.setMonitorArmSink({
    armAgent: (pid) => { armed.push({ op: 'agent', pid }); },
    armShellAdoption: (pid) => { armed.push({ op: 'adoption', pid }); },
  });
});

afterEach(() => {
  readiness.__clearRegistryForTests();
  readiness.setMonitorConnectivity(() => false);
  readiness.setMonitorArmSink(undefined);
  for (const child of spawned.splice(0)) killProcessTree(child);
});

describe('monitor down: this window probes', () => {
  test('shellReady and promptReady for an idle shell, then promptReady again after a reset', async () => {
    const term = fakeTerminal('SH-idle', idleShell());
    readiness.registerTerminal(term);
    await readiness.waitFor(term, 'shellReady', { timeoutMs: 8000 });
    await readiness.waitFor(term, 'promptReady', { timeoutMs: 8000 });

    readiness.resetAfterAgentExit(term);
    await expect(readiness.waitFor(term, 'promptReady', { timeoutMs: 10 })).rejects.toThrow();
    await readiness.waitFor(term, 'promptReady', { timeoutMs: 8000 });
  }, 20000);

  test('agentReady once armed for a shell with an idle child', async () => {
    const term = fakeTerminal('CC-agent', agentShell());
    readiness.registerTerminal(term);
    await readiness.waitFor(term, 'shellReady', { timeoutMs: 8000 });
    readiness.armAgentReady(term);
    await readiness.waitFor(term, 'agentReady', { timeoutMs: 15000 });
    expect(armed).toEqual([]);
  }, 20000);

  test('shell adoption finds the agent CLI and its session id in the tree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-adopt-'));
    const script = path.join(dir, 'claude.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1e9);\n');
    try {
      const term = fakeTerminal('SH-adopt', spawnShell(`(node ${script} --session-id ${SESSION}) ; true`));
      readiness.registerTerminal(term);
      const adopted = new Promise<{ agentKey: string; sessionId: string | undefined }>((resolve) => {
        readiness.armShellAdoption(term, resolve);
      });
      const info = await adopted;
      expect(info.agentKey).toBe('claude');
      expect(info.sessionId).toBe(SESSION);
      expect(armed).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});

describe('monitor up: the leader probes', () => {
  test('arms are forwarded with the pid and nothing is probed here', async () => {
    connected = true;
    const pid = agentShell();
    const term = fakeTerminal('CC-up', pid);
    readiness.registerTerminal(term);
    await readiness.waitFor(term, 'tabReady', { timeoutMs: 2000 });
    readiness.armAgentReady(term);
    readiness.armShellAdoption(term, () => {});
    expect(armed).toEqual([{ op: 'agent', pid }, { op: 'adoption', pid }]);
    await expect(readiness.waitFor(term, 'shellReady', { timeoutMs: 1000 })).rejects.toThrow();
  });

  test('a reset re-probes promptReady here, since the leader already reported it', async () => {
    connected = true;
    const pid = idleShell();
    const term = fakeTerminal('SH-up-reset', pid);
    readiness.registerTerminal(term);
    await readiness.waitFor(term, 'tabReady', { timeoutMs: 2000 });
    readiness.ingestReadinessFact(pid, 'promptReady');

    readiness.resetAfterAgentExit(term);
    await readiness.waitFor(term, 'promptReady', { timeoutMs: 8000 });
    readiness.armAgentReady(term);
    expect(armed).toEqual([{ op: 'agent', pid }]);
  }, 15000);

  test('losing the monitor resumes local probing for whatever is still awaited', async () => {
    connected = true;
    const term = fakeTerminal('CC-lost', agentShell());
    readiness.registerTerminal(term);
    await readiness.waitFor(term, 'tabReady', { timeoutMs: 2000 });
    readiness.armAgentReady(term);

    connected = false;
    readiness.onMonitorDisconnected();
    await readiness.waitFor(term, 'shellReady', { timeoutMs: 8000 });
    await readiness.waitFor(term, 'agentReady', { timeoutMs: 15000 });
  }, 25000);
});
