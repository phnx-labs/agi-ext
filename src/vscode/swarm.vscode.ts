// Swarm MCP configuration - VS Code dependent functions

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  AgentCli,
  isAgentCliAvailable,
  isAgentMcpEnabled,
  isAgentCommandInstalled,
  isAgentsCliAvailable,
  getAgentsCliVersion,
} from '../core/swarm.detect';

// Re-export for consumers that need the union type
export type { AgentCli } from '../core/swarm.detect';
const execAsync = promisify(exec);

interface AgentInstallStatus {
  installed: boolean;
  cliAvailable: boolean;
  mcpEnabled: boolean;
  commandInstalled: boolean;
}

export interface SwarmStatus {
  agentsCliAvailable: boolean;
  agentsCliVersion: string | null;
  mcpEnabled: boolean;
  commandInstalled: boolean;
  agents: {
    claude: AgentInstallStatus;
    codex: AgentInstallStatus;
    opencode: AgentInstallStatus;
  };
}

// Get full swarm integration status (per-agent, not globally shared)
export async function getSwarmStatus(): Promise<SwarmStatus> {
  // Run ALL CLI availability checks in parallel (including agents-cli)
  const [
    agentsCliAvail,
    agentsCliVer,
    claudeCliAvailable,
    codexCliAvailable,
    opencodeCliAvailable,
  ] = await Promise.all([
    isAgentsCliAvailable(),
    getAgentsCliVersion(),
    isAgentCliAvailable('claude'),
    isAgentCliAvailable('codex'),
    isAgentCliAvailable('opencode'),
  ]);

  // Run MCP checks in parallel (only for available CLIs)
  const [claudeMcp, codexMcp, opencodeMcp] = await Promise.all([
    claudeCliAvailable ? isAgentMcpEnabled('claude') : Promise.resolve(false),
    codexCliAvailable ? isAgentMcpEnabled('codex') : Promise.resolve(false),
    opencodeCliAvailable ? isAgentMcpEnabled('opencode') : Promise.resolve(false),
  ]);

  // Command checks are sync (fs.existsSync) - no need to parallelize
  const claudeCmd = claudeCliAvailable ? isAgentCommandInstalled('claude', 'swarm') : false;
  const codexCmd = codexCliAvailable ? isAgentCommandInstalled('codex', 'swarm') : false;
  const opencodeCmd = opencodeCliAvailable ? isAgentCommandInstalled('opencode', 'swarm') : false;

  const mcpEnabled = (!claudeCliAvailable || claudeMcp) &&
    (!codexCliAvailable || codexMcp) &&
    (!opencodeCliAvailable || opencodeMcp);

  const commandInstalled = (!claudeCliAvailable || claudeCmd) &&
    (!codexCliAvailable || codexCmd) &&
    (!opencodeCliAvailable || opencodeCmd);

  return {
    agentsCliAvailable: agentsCliAvail,
    agentsCliVersion: agentsCliVer,
    mcpEnabled,
    commandInstalled,
    agents: {
      claude: {
        installed: claudeMcp && claudeCmd && claudeCliAvailable,
        cliAvailable: claudeCliAvailable,
        mcpEnabled: claudeMcp,
        commandInstalled: claudeCmd,
      },
      codex: {
        installed: codexMcp && codexCmd && codexCliAvailable,
        cliAvailable: codexCliAvailable,
        mcpEnabled: codexMcp,
        commandInstalled: codexCmd,
      },
      opencode: {
        installed: opencodeMcp && opencodeCmd && opencodeCliAvailable,
        cliAvailable: opencodeCliAvailable,
        mcpEnabled: opencodeMcp,
        commandInstalled: opencodeCmd,
      },
    },
  };
}

// Check if swarm is fully enabled (MCP registered and commands installed)
export async function isSwarmEnabled(): Promise<boolean> {
  const status = await getSwarmStatus();
  return status.mcpEnabled && status.commandInstalled;
}

const AGENTS_CLI_PACKAGE = '@swarmify/agents-cli';

// Install agents-cli if not present
async function ensureAgentsCli(): Promise<boolean> {
  if (await isAgentsCliAvailable()) {
    return true;
  }

  try {
    vscode.window.showInformationMessage('Installing agents CLI...');
    await execAsync(`npm install -g ${AGENTS_CLI_PACKAGE}`);
    return true;
  } catch (err) {
    const error = err as Error & { stderr?: string };
    vscode.window.showErrorMessage(`Failed to install agents CLI: ${error.stderr || error.message}`);
    return false;
  }
}

// Materialize the agent's resources through agents-cli.
async function setupWithAgentsCli(agent: AgentCli): Promise<boolean> {
  try {
    const { runAgents } = await import('../core/agentsBin');
    await runAgents(`sync ${agent}`, { timeout: 120000 });
    return true;
  } catch (err) {
    const error = err as Error & { stderr?: string };
    vscode.window.showErrorMessage(`agents sync failed for ${agent}: ${error.stderr || error.message}`);
    return false;
  }
}

export async function setupSwarmIntegrationForAgent(agent: AgentCli): Promise<void> {
  const status = await getSwarmStatus();
  const agentStatus = status.agents[agent];
  if (agentStatus.cliAvailable && agentStatus.mcpEnabled && agentStatus.commandInstalled) {
    vscode.window.showInformationMessage('Swarm is already enabled.');
    return;
  }

  // Ensure agents-cli is installed (auto-install if needed)
  const agentsCliReady = await ensureAgentsCli();
  if (!agentsCliReady) {
    vscode.window.showErrorMessage('Failed to install agents CLI. Run: npm install -g @swarmify/agents-cli');
    return;
  }

  // agents sync requires the agent's CLI to be present.
  if (!agentStatus.cliAvailable) return;
  if (await setupWithAgentsCli(agent)) {
    vscode.window.showInformationMessage(`Configured ${agent.charAt(0).toUpperCase() + agent.slice(1)} via agents CLI. Reload your IDE agents.`);
  } else {
    vscode.window.showWarningMessage('Setup failed. Check that agent CLIs are installed.');
  }
}
