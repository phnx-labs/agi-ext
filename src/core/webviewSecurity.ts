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

/** Which browser tab a link lands in: `reuse` brings a tab already showing the page forward,
 *  `single` shows every link in one browser tab, `new` opens a tab per click. */
export type LinkTabs = 'reuse' | 'single' | 'new';

/** Matches every http(s) page: the scheme-less filter skips the scheme check, `*` is any
 *  host and `/**` any path (`workbench.action.browser.open` globs each part). */
const ANY_PAGE = '//*/**';

/** The argument for `workbench.action.browser.open` that shows `url` as an editor tab, or
 *  null when it is not a web page (mailto:, agents:) or the link should leave the editor.
 *  `reuseUrlFilter` picks the tab the browser navigates instead of opening another. */
export function browserTabArgs(rawUrl: string, target: LinkTarget, tabs: LinkTabs = 'reuse'): { url: string; reuseUrlFilter?: string } | null {
  if (target !== 'editor') return null;
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (tabs === 'new') return { url: rawUrl };
  return { url: rawUrl, reuseUrlFilter: tabs === 'single' ? ANY_PAGE : rawUrl };
}

/** What opening a link needs from the editor, injected so the decision is testable. */
export interface LinkOpeners {
  /** Whether the integrated browser command is registered. */
  hasBrowser(): Promise<boolean>;
  openTab(args: { url: string; reuseUrlFilter?: string }): PromiseLike<unknown>;
  openExternal(url: string): PromiseLike<unknown>;
}

/** Open `rawUrl` (trimmed) as a browser tab when it is a web page and `target` is the editor;
 *  otherwise, or when the editor has no integrated browser or the tab fails to open, outside
 *  the editor. Returns where it went. */
export async function openWith(rawUrl: string, target: LinkTarget, io: LinkOpeners, tabs: LinkTabs = 'reuse'): Promise<'tab' | 'external'> {
  const url = rawUrl.trim();
  const args = browserTabArgs(url, target, tabs);
  if (args) {
    try {
      if (await io.hasBrowser()) { await io.openTab(args); return 'tab'; }
    } catch {
      // A browser the policy disabled or a build with another argument shape: leave the editor instead.
    }
  }
  await io.openExternal(url);
  return 'external';
}

/** A web page link in one terminal line: where it sits and what it opens. */
export interface TextLink { startIndex: number; length: number; url: string }

// A run of URL characters after http(s)://, ending on one that is not sentence punctuation,
// so "…/runs/39244608931." and "(https://x.dev)" stop before the period and the parenthesis.
const WEB_LINK = /https?:\/\/[^\s"'`<>()[\]{}]*[^\s"'`<>()[\]{}.,;:!?]/g;

/** Every http(s) link in `line`, in order. */
export function webLinksIn(line: string): TextLink[] {
  return [...line.matchAll(WEB_LINK)].map((m) => ({ startIndex: m.index, length: m[0].length, url: m[0] }));
}
