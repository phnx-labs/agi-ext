// Signed-in and healthy install counts per harness, from one `agents view --json`
// call. They rank the `Agents: Resume (Pick Harness)` list (resumeTarget.ts).

import { runAgents } from './agentsBin';

/** The part of one `agents view --json` entry the counts read. */
interface AgentsViewJsonAgent {
  agent: string;
  versions: Array<{
    signedIn: boolean;
    usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  }>;
}

export interface AgentInventory {
  agent: string;
  signedInCount: number;
  healthyCount: number;
}

export function summarizeAgentInventory(view: AgentsViewJsonAgent): AgentInventory {
  const signedIn = view.versions.filter((version) => version.signedIn);
  return {
    agent: view.agent,
    signedInCount: signedIn.length,
    healthyCount: signedIn.filter((version) => version.usageStatus !== 'out_of_credits').length,
  };
}

// One `agents view --json` call covers every harness, 3-5x faster than one CLI
// process per agent.
export async function fetchAgentInventories(agentKeys: string[]): Promise<Record<string, AgentInventory>> {
  const wanted = new Set(agentKeys);
  try {
    const { stdout } = await runAgents('view --json', {
      timeout: 12000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as AgentsViewJsonAgent[];
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, AgentInventory> = {};
    for (const entry of parsed) {
      if (!entry || typeof entry.agent !== 'string') continue;
      if (!wanted.has(entry.agent)) continue;
      if (!Array.isArray(entry.versions)) continue;
      out[entry.agent] = summarizeAgentInventory(entry);
    }
    return out;
  } catch {
    return {};
  }
}
