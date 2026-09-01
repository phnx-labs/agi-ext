// Simple command-based session helpers
// Claude: generate a UUID at terminal open time (no prewarming needed).
// OpenCode: session ID is discovered from `opencode session list` after launch.

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

/**
 * Generate a session ID for Claude (no prewarming needed)
 */
export function generateClaudeSessionId(): string {
  return randomUUID();
}

/**
 * Build the open command for Claude with a session ID
 */
export function buildClaudeOpenCommand(sessionId: string): string {
  return `claude --session-id ${sessionId}`;
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
        if (!proc.killed) {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 500);
        }
        finish(null);
      }
    }, timeoutMs);
  });
}
