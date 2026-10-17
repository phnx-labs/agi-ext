// Simple command-based session helpers
// Claude: generate a UUID at terminal open time (no prewarming needed).
// OpenCode: session ID is discovered from `opencode session list` after launch.

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { killProcessTree } from './processTree';

/**
 * Generate a session ID for Claude (no prewarming needed)
 */
export function generateClaudeSessionId(): string {
  return randomUUID();
}

/**
 * Get OpenCode session IDs from 'opencode session list' output
 * Returns most recent sessions first (sorted by updated time)
 */
export async function listOpencodeSessions(cwd: string): Promise<string[] | null> {
  const result = await runCommand('opencode', ['session', 'list'], cwd, 10000);
  if (!result) return null;
  // Parse session IDs from table output: ses_xxx format
  const matches = [...result.matchAll(/ses_[a-zA-Z0-9]+/g)];
  if (matches.length === 0) return [];
  return matches.map(m => m[0]);
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    let output = '';
    let resolved = false;

    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own its POSIX process group so a runaway grandchild is reclaimed by
      // killProcessTree below instead of orphaned when we kill only this
      // direct pid (the 1.22.85 fork-bomb incident).
      detached: process.platform !== 'win32',
    });

    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.on('error', () => {
      finish(null);
    });

    proc.on('close', () => {
      finish(output);
    });

    setTimeout(() => {
      if (!resolved) {
        if (!proc.killed) killProcessTree(proc);
        finish(null);
      }
    }, timeoutMs);
  });
}
