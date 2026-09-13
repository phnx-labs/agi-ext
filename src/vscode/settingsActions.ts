import * as fs from 'fs';
import * as path from 'path';
import { ALL_SWARM_AGENTS, type SwarmAgentType } from '../core/settings';
import { shellQuote } from '../core/deviceDispatchShell';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function writeSwarmConfig(configPath: string, enabledAgents: SwarmAgentType[]): void {
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    config = { agents: {}, providers: {} };
  }
  if (!isRecord(config) || (config.agents !== undefined && !isRecord(config.agents))) {
    throw new Error(`Invalid agent configuration in ${configPath}; file left unchanged`);
  }
  const agents = isRecord(config.agents) ? config.agents : {};
  for (const agentType of ALL_SWARM_AGENTS) {
    const existing = agents[agentType];
    if (existing !== undefined && !isRecord(existing)) {
      throw new Error(`Invalid configuration for ${agentType} in ${configPath}; file left unchanged`);
    }
    agents[agentType] = {
      ...(existing ?? { models: {}, provider: '' }),
      enabled: enabledAgents.includes(agentType),
    };
  }
  config.agents = agents;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function buildCloudDispatchCommand(request: {
  provider: 'rush' | 'codex' | 'factory';
  agent: string;
  repo: string;
  branch?: string;
  mode: 'plan' | 'edit' | 'full';
  prompt: string;
}): string {
  const args = ['--provider', request.provider,
    '--agent', request.agent, '--repo', request.repo];
  const branch = request.branch?.trim();
  if (branch && !branch.toLowerCase().startsWith('auto')) args.push('--branch', branch);
  args.push('--mode', request.mode, '-p', request.prompt);
  return `agents cloud run ${args.map(shellQuote).join(' ')}`;
}
