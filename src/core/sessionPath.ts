export function sessionPathUriString(filePath: string, host: string | undefined, localHost = 'this-mac'): string | undefined {
  if (!host || host === localHost) return undefined;
  return `vscode-remote://ssh-remote+${host}${filePath.startsWith('/') ? '' : '/'}${filePath}`;
}
