import * as fs from 'fs';
import * as path from 'path';
import { ALL_SWARM_AGENTS, type SwarmAgentType } from '../core/settings';
import type { AgentLaunchMode } from '../core/agents';

export type WatchdogPolicyMsg = 'off' | 'keep' | 'handsoff';
export interface NotifyPrefsMsg {
  events: { stall: boolean; question: boolean; plan: boolean; finish: boolean; fail: boolean };
  channel: 'imessage' | 'slack' | 'desktop';
  dnd: boolean;
}
export interface DispatchAttachmentMsg { type: 'image' | 'file'; name: string; ref?: string }
export interface DispatchRequestMsg {
  prompt: string;
  ticketIds: string[];
  attachments: DispatchAttachmentMsg[];
  agent: string;
  runOn: string;
  project?: string;
  projectPath?: string;
  repo?: string;
  branch?: string;
  mode: AgentLaunchMode;
  headless?: boolean;
  watchdog: WatchdogPolicyMsg;
  notify: NotifyPrefsMsg;
  batch: 'all' | 'per';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDispatchRequest(value: unknown): value is DispatchRequestMsg {
  if (!isRecord(value)) return false;
  const notify = value.notify;
  const events = isRecord(notify) ? notify.events : undefined;
  return typeof value.prompt === 'string' && typeof value.agent === 'string' && !!value.agent.trim()
    && typeof value.runOn === 'string'
    && ['project', 'projectPath', 'repo', 'branch'].every(key => value[key] === undefined || typeof value[key] === 'string')
    && (value.mode === 'plan' || value.mode === 'edit' || value.mode === 'auto')
    && (value.watchdog === 'off' || value.watchdog === 'keep' || value.watchdog === 'handsoff')
    && (value.batch === 'all' || value.batch === 'per')
    && (value.headless === undefined || typeof value.headless === 'boolean')
    && Array.isArray(value.ticketIds) && value.ticketIds.every(id => typeof id === 'string')
    && Array.isArray(value.attachments) && value.attachments.every(attachment => isRecord(attachment)
      && (attachment.type === 'image' || attachment.type === 'file') && typeof attachment.name === 'string'
      && (attachment.ref === undefined || typeof attachment.ref === 'string'))
    && isRecord(notify) && typeof notify.dnd === 'boolean'
    && (notify.channel === 'imessage' || notify.channel === 'slack' || notify.channel === 'desktop')
    && isRecord(events)
    && ['stall', 'question', 'plan', 'finish', 'fail'].every(key => typeof events[key] === 'boolean');
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

export function buildCloudDispatchArgs(request: {
  provider: 'rush' | 'codex' | 'factory';
  agent: string;
  repo: string;
  branch?: string;
  mode: 'plan' | 'edit' | 'full';
  prompt: string;
}): string[] {
  const args = ['cloud', 'run', '--no-follow', '--provider', request.provider,
    '--agent', request.agent, '--repo', request.repo];
  const branch = request.branch?.trim();
  if (branch && !branch.toLowerCase().startsWith('auto')) args.push('--branch', branch);
  args.push('--mode', request.mode, '-p', request.prompt);
  return args;
}
