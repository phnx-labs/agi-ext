import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { runAgents } from './agentsBin';

const execAsync = promisify(exec);

export type AgentCli = 'claude' | 'codex' | 'opencode';

// Paths where the /swarm command file lives for each CLI
// Supported harnesses use markdown commands.
export function getAgentCommandPath(agent: AgentCli, command: string = 'swarm'): string {
  const baseDirs: Record<AgentCli, string> = {
    claude: path.join(os.homedir(), '.claude', 'commands'),
    codex: path.join(os.homedir(), '.codex', 'prompts'),
    opencode: path.join(os.homedir(), '.opencode', 'commands'),
  };

  const ext = 'md';
  return path.join(baseDirs[agent], `${command}.${ext}`);
}

// Detect whether a CLI binary is available
export async function isAgentCliAvailable(agent: AgentCli): Promise<boolean> {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execAsync(`${which} ${agent}`);
    return true;
  } catch {
    return false;
  }
}

// Detect whether the Swarm MCP server is registered for a CLI
export async function isAgentMcpEnabled(agent: AgentCli): Promise<boolean> {
  const commands: Record<AgentCli, string> = {
    claude: 'claude mcp list',
    codex: 'codex mcp list',
    opencode: 'opencode mcp list',
  };

  try {
    const { stdout } = await execAsync(commands[agent], { timeout: 5000 });
    return /swarm/i.test(stdout) || /swarmify-agents/i.test(stdout);
  } catch {
    return false;
  }
}

// Detect whether the /swarm slash-command file is present for a CLI
export function isAgentCommandInstalled(agent: AgentCli, command: string = 'swarm'): boolean {
  const target = getAgentCommandPath(agent, command);
  return fs.existsSync(target);
}

// Detect whether the agents CLI (@swarmify/agents-cli) is available
export async function isAgentsCliAvailable(): Promise<boolean> {
  try {
    await runAgents('--version', { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// Get the version of the agents CLI
export async function getAgentsCliVersion(): Promise<string | null> {
  try {
    const { stdout } = await runAgents('--version', { timeout: 5_000 });
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : stdout.trim();
  } catch {
    return null;
  }
}
