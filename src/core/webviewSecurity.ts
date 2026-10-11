// Pure, vscode-free gate on the URLs a webview message may open. Webview messages
// are untrusted input (a crafted PR title, an agent-supplied link), so this
// allowlist is what stops one from opening a `file:`/`command:` URL.

// Schemes a webview is permitted to open externally. Anything else — `file:`,
// `command:`, `vscode:`, `javascript:`, `data:` — is refused.
const ALLOWED_EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

// True only if `rawUrl` is a non-empty string that parses to an allowed scheme.
export function isAllowedExternalUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  let scheme: string;
  try {
    scheme = new URL(rawUrl).protocol.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_EXTERNAL_SCHEMES.has(scheme);
}
