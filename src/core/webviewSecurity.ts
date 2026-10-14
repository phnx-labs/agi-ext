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

/** How a web link opens: `editor` is a tab in the editor's integrated browser, `browser` the OS default. */
export type LinkTarget = 'editor' | 'browser';

/** The argument for `workbench.action.browser.open` that shows `url` as an editor tab, or
 *  null when it is not a web page (mailto:, agents:) or the link should leave the editor.
 *  `reuseUrlFilter` is the same URL, so a second click brings its tab forward instead of
 *  opening another. */
export function browserTabArgs(rawUrl: string, target: LinkTarget): { url: string; reuseUrlFilter: string } | null {
  if (target !== 'editor') return null;
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return { url: rawUrl, reuseUrlFilter: rawUrl };
}
