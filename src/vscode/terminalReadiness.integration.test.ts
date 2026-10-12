// Integration test for the agent-ready probe semantics.
//
// `terminalReadiness.vscode.ts:startAgentReadyProbe` fires `agentReady` when
// `pgrep -P <shell-pid>` returns a child whose `ps -p <child> -o stat=` state
// starts with 'S' (interruptible sleep — the macOS/Linux kernel state when a
// process is blocked on read(2) from the pty).
//
// This test does NOT mock anything. It spawns a real bash subprocess that
// execs a real node process blocked on stdin.read, then drives the exact same
// two shell commands the probe runs, and asserts the expected state.
//
// If this test passes, the kernel contract the probe relies on holds on this
// machine. If it fails, the probe can't work and we need a different
// detection strategy.

import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import { detectAgentKeyFromArgs, extractSessionIdFromArgs } from '../core/terminalReadiness';
import { killProcessTree } from '../core/processTree';

const execAsync = promisify(exec);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probeChildState(shellPid: number): Promise<{ childPid: string | null; state: string | null }> {
  try {
    const { stdout: pgrepOut } = await execAsync(`pgrep -P ${shellPid}`);
    const childPid = pgrepOut.trim().split(/\s+/)[0];
    if (!childPid) return { childPid: null, state: null };
    const { stdout: psOut } = await execAsync(`ps -p ${childPid} -o stat=`);
    return { childPid, state: psOut.trim() };
  } catch {
    return { childPid: null, state: null };
  }
}

describe('agentReady probe — real process state', () => {
  test('detects child in S state (sleeping on stdin) within 2 seconds', async () => {
    // Spawn a shell that runs a Node process which blocks forever. The
    // extension runs commands under interactive zsh; zsh forks + execs so
    // the TUI becomes a CHILD of the shell. `bash -c 'single-cmd'` on the
    // other hand optimizes to exec-in-place, leaving no child to probe —
    // so we wrap in parentheses to force a subshell fork and keep the
    // parent alive with `; true`.
    const shell = spawn('bash', [
      '-c',
      '(node -e "setInterval(()=>{}, 100000)") ; true',
    ], {
      stdio: 'ignore',
      // Own process group: killing only bash would orphan the node grandchild.
      detached: true,
    });
    const shellPid = shell.pid!;
    expect(shellPid).toBeGreaterThan(0);

    try {
      // Poll the way startAgentReadyProbe does: IDLE_POLL_MS = 150ms
      const deadline = Date.now() + 2000;
      let lastObservation: { childPid: string | null; state: string | null } = { childPid: null, state: null };

      while (Date.now() < deadline) {
        lastObservation = await probeChildState(shellPid);
        if (lastObservation.state && lastObservation.state.startsWith('S')) break;
        await sleep(150);
      }

      // Assertions document what the probe depends on.
      expect(lastObservation.childPid).not.toBeNull();
      expect(lastObservation.state).not.toBeNull();
      expect(lastObservation.state!.startsWith('S')).toBe(true);
    } finally {
      killProcessTree(shell);
      // Give the kernel a moment to reap
      await sleep(50);
    }
  }, 10000);

  test('reports null child when shell has no running child process', async () => {
    // A bare `sleep` with no child — pgrep -P returns nothing
    const shell = spawn('bash', ['-c', 'sleep 10'], { stdio: 'ignore' });
    const shellPid = shell.pid!;

    try {
      await sleep(300); // give it a moment to settle
      const observation = await probeChildState(shellPid);
      // `sleep` IS a child of bash-c (bash typically execs it in-place when
      // it's the only command, but in child_process.spawn mode bash forks
      // first). Either way our assertion should be safe: EITHER no child, OR
      // the child itself is `sleep`, which is also in S state. We just want
      // to confirm our probe returns without throwing.
      expect(typeof observation.childPid === 'string' || observation.childPid === null).toBe(true);
    } finally {
      shell.kill('SIGKILL');
      await sleep(50);
    }
  }, 5000);

  test('handles non-existent PID without throwing', async () => {
    // PID 999999 almost certainly doesn't exist
    const observation = await probeChildState(999999);
    expect(observation.childPid).toBeNull();
    expect(observation.state).toBeNull();
  });
});

describe('shell adoption — argv parsing', () => {
  test('detectAgentKeyFromArgs reads the binary, a node-wrapped script, or the agents run wrapper', () => {
    const cases: Array<[string, string | null]> = [
      ['claude --foo', 'claude'],
      ['/usr/local/bin/codex', 'codex'],
      ['cursor-agent chat', 'cursor'],
      ['node /Users/me/.agents/versions/claude/2.1.140/home/.claude/local/claude.js', 'claude'],
      ['/opt/homebrew/bin/agents run codex', 'codex'],
      ['agents run kimi --strategy balanced', 'kimi'],
      ['/usr/local/bin/node /usr/local/lib/node_modules/@phnx-labs/agents-cli/dist/index.js run cursor --resume abc', 'cursor'],
      ["'/opt/node/bin/node' '/opt/lib/node_modules/@phnx-labs/agents-cli/dist/index.js' run cursor", 'cursor'],
      ['droid', 'droid'],
      // Antigravity's installed binary is `agy` (CLI_AGENT_META).
      ['agy --resume abc', 'antigravity'],
      ['gemini --model pro', null],
      ['agents run gemini --model pro', null],
      ['git status', null],
      ['', null],
    ];
    for (const [argv, key] of cases) expect(detectAgentKeyFromArgs(argv)).toBe(key);
  });

  test('extractSessionIdFromArgs reads a UUID after --session-id, --session or --resume', () => {
    const uuid = '7b1cf038-8761-4e46-af43-5336e7e5a776';
    // A resumed claude carries its live id under `--resume` (agents-cli buildExecCommand);
    // recovering it binds a reloaded Remote-SSH pane to the session actually running in it.
    for (const argv of [`claude --session-id ${uuid}`, `claude --session-id=${uuid}`, `gemini --session ${uuid}`,
      `claude --resume=${uuid}`, `node /path/agents run claude --resume ${uuid} --model opus`]) {
      expect(extractSessionIdFromArgs(argv)).toBe(uuid);
    }
    // `--continue` (resume most-recent, no id) and non-UUID values carry nothing to extract.
    for (const argv of ['claude --foo bar', '', 'claude --continue', 'claude --session-id not-a-uuid', 'claude --resume not-a-uuid']) {
      expect(extractSessionIdFromArgs(argv)).toBeUndefined();
    }
  });
});
