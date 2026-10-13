// The registered agents projects (`agents projects list --json`), cached for a
// minute and shared by the Project panel and the resume picker. It feeds the
// repository-path stopgap (`projectFallback`, src/core/projectPanel.ts): a
// session the CLI filed under a name no registered project has, working in one of
// the project's repositories, is listed with that project until agents-cli maps a
// renamed project's old names. Delete with that stopgap.

import { runAgentsArgs } from '../core/agentsBin';
import { parseProjectList, type ProjectRef } from '../core/projectPanel';

const FRESH_MS = 60_000;
let held: { at: number; list: ProjectRef[] } | undefined;
let reading: Promise<ProjectRef[]> | undefined;

/** The list as last read, or null before the first read answered. */
export function registrySnapshot(): ProjectRef[] | null {
  return held?.list ?? null;
}

/** Read the list unless a read in the last minute answered; one read at a time. */
export function readRegistry(force = false): Promise<ProjectRef[]> {
  if (!force && held && Date.now() - held.at < FRESH_MS) return Promise.resolve(held.list);
  if (reading) return reading;
  reading = runAgentsArgs(['projects', 'list', '--json'], { timeout: 30_000 })
    .then(({ stdout }) => { const list = parseProjectList(stdout); held = { at: Date.now(), list }; return list; })
    .finally(() => { reading = undefined; });
  return reading;
}
