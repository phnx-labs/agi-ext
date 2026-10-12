// Resolve the absolute path to an agents-cli family binary (`agents`, and the
// standalone `sessions` and `secrets` it installs beside itself) and run
// commands against it.
//
// VS Code Electron processes (Cursor, Code, Codium) launched from Dock or
// Finder inherit a minimal PATH that doesn't include the user's nvm bin or
// `~/.agents/shims`. Calling `execAsync('agents ...')` directly fails with
// "command not found" even though the user's terminal has it. This module
// resolves each binary once via the shell + filesystem probes, then runs all
// subsequent commands with an absolute path and a bootstrapped PATH that
// includes node so the `#!/usr/bin/env node` shebang resolves.

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shellQuote } from './shellQuote';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 60_000;

/** The agents-cli family: `agents`, the standalone CLIs that own sessions and secrets,
 *  and `artifacts`, which publishes an artifact as a shareable Rush link. */
export type CliTool = 'agents' | 'sessions' | 'secrets' | 'artifacts';

const cachedBins = new Map<CliTool, { bin: string; at: number }>();

export class AgentsBinNotFoundError extends Error {
  constructor(tool: CliTool = 'agents') {
    super(`${tool} CLI not found on PATH or in common install locations (~/.agents/shims, nvm bins, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin)`);
    this.name = 'AgentsBinNotFoundError';
  }
}

/**
 * Resolve the absolute path to one agents-cli family binary. Cached for 60s per tool.
 *
 * Order of attempts:
 *   1. `$SHELL -c 'command -v <tool>'` (non-login so .zshenv loads nvm
 *      without /etc/zprofile prepending stale brew paths).
 *   2. Filesystem probes: ~/.agents/shims/<tool>, nvm bins (newest first),
 *      ~/.local/bin, /opt/homebrew/bin, /usr/local/bin.
 *
 * Throws AgentsBinNotFoundError if no candidate exists as a file.
 */
async function resolveCliBin(tool: CliTool): Promise<string> {
  // Test/escape hatch: explicitly mark agents-cli as unavailable. Lets tests
  // simulate the missing-CLI fallback without playing PATH games (the regular
  // resolver intentionally ignores PATH so it works from the VS Code host).
  if (process.env.AGENTS_CLI_DISABLED === '1') {
    throw new AgentsBinNotFoundError(tool);
  }
  const cached = cachedBins.get(tool);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.bin;
  const remember = (bin: string) => {
    cachedBins.set(tool, { bin, at: Date.now() });
    return bin;
  };

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const { stdout } = await execAsync(`${shell} -c 'command -v ${tool}'`, { timeout: 5_000 });
    const p = stdout.trim();
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return remember(p);
  } catch {
    /* fall through to filesystem probes */
  }

  const candidates: string[] = [path.join(os.homedir(), '.agents', 'shims', tool)];
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    for (const v of versions) candidates.push(path.join(nvmDir, v, 'bin', tool));
  } catch {
    /* no nvm */
  }
  candidates.push(path.join(os.homedir(), '.local', 'bin', tool), `/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`);

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      return remember(p);
    } catch {
      /* next */
    }
  }

  throw new AgentsBinNotFoundError(tool);
}

/** Resolve the absolute path to the `agents` CLI binary. */
export function resolveAgentsBin(): Promise<string> {
  return resolveCliBin('agents');
}

/**
 * Build a PATH that lets the agents shebang find node: the newest nvm node,
 * the binary's own dir, the agents shims, the usual system dirs, then whatever
 * PATH the extension host already had.
 */
export function bootstrapPath(binPath: string): string {
  // Newest nvm node goes first: a homebrew node in the binary's own dir can be
  // stale, and the shebang must resolve the node the agents CLI was built for.
  const dirs: string[] = [];
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    if (versions[0]) dirs.push(path.join(nvmDir, versions[0], 'bin'));
  } catch {
    /* no nvm */
  }
  dirs.push(path.dirname(binPath), path.join(os.homedir(), '.agents', 'shims'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  dirs.push(...(process.env.PATH ?? '').split(':').filter(Boolean));
  return [...new Set(dirs)].join(':');
}

export interface RunAgentsOptions {
  timeout?: number;
  maxBuffer?: number;
  cwd?: string;
}

/**
 * Run `agents <args>` using the resolved absolute binary path and a PATH
 * that includes node so the shebang resolves. Throws if the binary can't
 * be found.
 *
 * Pass arguments as a single string (the same way you'd type them after
 * `agents` on the command line). Quote your own args if they contain
 * shell metacharacters.
 */
export async function runAgents(
  args: string,
  options: RunAgentsOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = await resolveAgentsBin();
  const augmented = bootstrapPath(bin);
  const escaped = shellQuote(bin);
  return execAsync(`${escaped} ${args}`, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    cwd: options.cwd,
    env: { ...process.env, PATH: `${augmented}:${process.env.PATH ?? ''}` },
  });
}

/** Run one agents-cli family binary through an argv boundary; use this whenever arguments contain user data. */
export async function runCliArgs(
  tool: CliTool,
  args: string[],
  options: RunAgentsOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = await resolveCliBin(tool);
  const augmented = bootstrapPath(bin);
  return execFileAsync(bin, args, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    cwd: options.cwd,
    env: { ...process.env, PATH: `${augmented}:${process.env.PATH ?? ''}` },
  });
}

/** Run agents through an argv boundary; use this whenever arguments contain user data. */
export function runAgentsArgs(
  args: string[],
  options: RunAgentsOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCliArgs('agents', args, options);
}

/** Test-only: drop the cached paths so the next call re-resolves. */
export function clearAgentsBinCache(): void {
  cachedBins.clear();
}
