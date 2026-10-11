// Project/host resolution: the one mapping from a session cwd to a display
// project. Pure functions, no vscode/node imports.

/** The `<slug>` under `.agents/worktrees/<slug>/`, or '' when the cwd isn't a
 *  worktree. This is the strong per-session disambiguator (two agents in sibling
 *  worktrees of the same repo differ only by slug) — surfaced on the card even
 *  though resolveProject folds it away to the repo name. */
export function worktreeSlugOf(cwd: string | null | undefined): string {
  if (!cwd) return '';
  const m = cwd.match(/\/\.agents\/worktrees\/([^/]+)/);
  return m?.[1] ?? '';
}

/** Resolve a session cwd to a display project: a worktree folds to its repo
 *  (`.../<repo>/.agents/worktrees/<slug>` -> `<repo>`), anything else is the
 *  cwd's last path segment. */
export function resolveProject(cwd: string): string {
  if (!cwd) return '';
  const norm = cwd.replace(/\/+$/, '');
  const worktreeProject = norm.match(/\/([^/]+)\/\.agents\/worktrees\//)?.[1];
  if (worktreeProject) return worktreeProject;
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] || norm;
}

/** Canonicalize a host name to its device label: 'mac-mini', 'ZION', a FQDN all
 *  fold onto the registry device id. */
export function normalizeHost(raw: string): string {
  const [hostname = ''] = (raw || '').split('.');
  return hostname
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
