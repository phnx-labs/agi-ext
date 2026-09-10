/**
 * Remote shell selection for AGI EXT device dispatch (RUSH-1481).
 * Mirrors agents-cli remoteShellFor / PowerShell -EncodedCommand.
 */

/** True when the device platform string is Windows. */
export function isWindowsDevicePlatform(platform: string | undefined): boolean {
  return /^win/i.test((platform ?? '').trim());
}

/** PowerShell -EncodedCommand payload (UTF-16LE base64). */
export function encodePowershellScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Single-quote a value for interpolation into a POSIX shell command. The one
 * shell quoter in the extension: always quotes, so the emitted command never
 * depends on which characters a value happens to contain.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the remote command string passed after `ssh -- <target>`.
 * Windows → powershell -EncodedCommand; otherwise bash -lc.
 */
export function buildDeviceDispatchRemoteCmd(remoteSnippet: string, platform?: string): string {
  if (isWindowsDevicePlatform(platform)) {
    return `powershell -NoProfile -EncodedCommand ${encodePowershellScript(remoteSnippet)}`;
  }
  return `bash -lc ${shellQuote(remoteSnippet)}`;
}
