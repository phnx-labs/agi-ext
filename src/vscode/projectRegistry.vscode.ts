// The registered agents projects (`agents projects list --json`), reread at most
// once a minute and shared by the Project panel and the resume picker. It feeds the
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

/** The list as last read; one read at a time. A list older than a minute is still
 *  answered at once while a read replaces it, so no draw or click waits on the CLI
 *  (a click waited up to 3 s on a loaded machine; owner video, 2026-10-19 1:27 PM).
 *  `force` (the project menu, a pick) waits for the new read. */
export function readRegistry(force = false): Promise<ProjectRef[]> {
  if (!force && held) {
    if (Date.now() - held.at >= FRESH_MS) void reread().catch(() => undefined);
    return Promise.resolve(held.list);
  }
  return reread();
}

/** Drop the held list, so a test that reads the registry leaves none for the next. */
export function forgetRegistry(): void {
  held = undefined;
}

function reread(): Promise<ProjectRef[]> {
  if (reading) return reading;
  reading = runAgentsArgs(['projects', 'list', '--json'], { timeout: 30_000 })
    .then(({ stdout }) => { const list = parseProjectList(stdout); held = { at: Date.now(), list }; return list; })
    .finally(() => { reading = undefined; });
  return reading;
}
