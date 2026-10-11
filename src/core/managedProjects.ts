// The project list behind `New <Harness> (Pick Project)`, read only through
// `agents projects list --json`. Never read ~/.agents/projects/*.yaml directly.
// Errors propagate so the VS Code host can show them inline.

import { runAgents } from './agentsBin';

/** The fields of one ProjectDef the project quickpick shows. */
export interface ManagedProject {
  id: string;
  name: string;
  description?: string;
  /** "owner/repo": the top-level `repo`, else `repos[0].slug`. */
  repoSlug?: string;
}

/** Map a ProjectDef JSON shape (from `agents projects list --json`) to a ManagedProject. */
export function defToManaged(def: Record<string, unknown>): ManagedProject {
  const name = typeof def.name === 'string' ? def.name : '';
  const repos = Array.isArray(def.repos) ? (def.repos as Array<Record<string, unknown>>) : [];
  const repoSlug =
    typeof def.repo === 'string'
      ? def.repo
      : typeof repos[0]?.slug === 'string'
        ? repos[0].slug
        : undefined;
  return {
    id: name,
    name,
    description: typeof def.description === 'string' ? def.description : undefined,
    repoSlug,
  };
}

/**
 * Read the project list by shelling out to `agents projects list --json`.
 * Throws when the CLI is unavailable or returns unparseable output.
 */
export async function readManagedProjects(): Promise<ManagedProject[]> {
  const { stdout } = await runAgents('projects list --json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `agents projects list --json returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('agents projects list --json: expected a JSON array of ProjectDef objects');
  }
  return parsed
    .filter((d) => d && typeof d === 'object' && typeof (d as Record<string, unknown>).name === 'string')
    .map((d) => defToManaged(d as Record<string, unknown>));
}
