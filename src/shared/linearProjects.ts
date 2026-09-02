// Linear project matching for managed projects.
//
// A project's identity shows up three ways — a Linear project name ("Agents CLI"),
// a GitHub repo slug ("phnx-labs/agents-cli"), and a filesystem folder
// (".../agents-cli"). normalizeProjectKey() collapses all three to one comparison
// key so they compare equal, and matchLinearProject() binds a repo/folder to the
// Linear project the user most likely means.
//
// This module is PURE (no CLI, no fs, no vscode) so it unit-tests without a live
// `linear` binary. The actual `linear projects --json` shell-out lives in
// linear.vscode.ts (reusing its cached CLI-path resolver). It lives in src/shared
// because BOTH sides match on project identity: the host suggests a Linear project
// for a managed folder, and the webview attributes a session to a project from the
// hints its stream row carries (sessionProjects.ts). One matcher, no second copy.

/** The minimal Linear project shape the webview needs (id + name). */
export interface LinearProjectLite {
  id: string;
  name: string;
}

/**
 * Collapse a Linear name / repo slug / folder path to one comparison key:
 * lowercase, keep only the last path segment, strip separators.
 *   "Agents CLI"            -> "agentscli"
 *   "phnx-labs/agents-cli"  -> "agentscli"
 *   "~/src/.../agents-cli"  -> "agentscli"
 */
export function normalizeProjectKey(s: string): string {
  const last = s.toLowerCase().split('/').filter(Boolean).pop() ?? '';
  return last.replace(/[-_\s.]/g, '');
}

/**
 * Find the Linear project that best matches a repo slug or folder name.
 * Exact normalized match first, then a containment fallback (either direction),
 * so "agents-cli-web" still suggests "Agents CLI" when no exact peer exists.
 *
 * `fuzzy: false` keeps only the exact normalized match. Weak hints — a branch, a
 * worktree slug, a team name — are near-arbitrary strings, and containment across
 * a short project name mis-binds them ("flush-fix" would "match" project "Rush").
 * Session attribution passes fuzzy:false for those and keeps containment for real
 * repo slugs, where it is the whole point.
 */
export function matchLinearProject(
  slugOrName: string,
  projects: LinearProjectLite[],
  opts: { fuzzy?: boolean } = {}
): LinearProjectLite | undefined {
  const key = normalizeProjectKey(slugOrName);
  if (!key) return undefined;
  const exact = projects.find((p) => normalizeProjectKey(p.name) === key);
  if (exact) return exact;
  if (opts.fuzzy === false) return undefined;
  return projects.find((p) => {
    const pk = normalizeProjectKey(p.name);
    return pk.length > 0 && (pk.includes(key) || key.includes(pk));
  });
}
