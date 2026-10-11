interface DisplayPathOptions {
  cwd?: string;
  home?: string;
  isRemote?: boolean;
  hostHome?: string;
  sessionId?: string;
  maxLength?: number;
}

/** Compact directories while preserving the complete filename. */
export function displayPath(file: string, { cwd, home, isRemote = false, hostHome, sessionId, maxLength = 56 }: DisplayPathOptions): string {
  file = file.replace(/\\/g, '/');
  cwd = cwd?.replace(/\\/g, '/');
  home = (hostHome ?? (isRemote ? undefined : home))?.replace(/\\/g, '/');
  const inside = (base: string | undefined) => base && file.startsWith(base.replace(/\/$/, '') + '/')
    ? file.slice(base.replace(/\/$/, '').length + 1) : undefined;
  let label = inside(cwd);
  if (label === undefined) {
    const scratch = file.match(/^\/(?:private\/)?tmp\/claude-[^/]+\/([^/]+)\/([^/]+)\/(.+)$/);
    const encodedCwd = cwd?.replace(/[^a-zA-Z0-9]/g, '-');
    if (scratch && scratch[1] === encodedCwd && scratch[2] === sessionId) label = scratch[3]!;
    else if (/^\/(?:private\/)?tmp\/claude-/.test(file)) label = 'scratch/…/' + file.slice(file.lastIndexOf('/') + 1);
    else label = inside(home) !== undefined ? '~/' + inside(home) : file;
  }
  if (label.length <= maxLength) return label;
  const slash = label.lastIndexOf('/');
  if (slash < 0) return label;
  const basename = label.slice(slash + 1);
  const directory = label.slice(0, slash);
  const budget = Math.max(0, maxLength - basename.length - 1);
  if (budget < 3) return '…/' + basename;
  const left = Math.ceil((budget - 1) / 2);
  const right = Math.floor((budget - 1) / 2);
  return directory.slice(0, left) + '…' + (right ? directory.slice(-right) : '') + '/' + basename;
}
