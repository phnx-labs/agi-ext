export function sessionPathUriString(filePath: string, host: string | undefined, localHosts = ['this-mac']): string | undefined {
  if (!host || localHosts.includes(host)) return undefined;
  return `vscode-remote://ssh-remote+${host}${filePath.startsWith('/') ? '' : '/'}${filePath}`;
}
