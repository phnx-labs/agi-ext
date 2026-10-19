import * as vscode from 'vscode';
import { isAllowedExternalUrl, openWith, webLinksIn, type LinkTabs, type LinkTarget, type TextLink } from '../core/webviewSecurity';
import { isAgentTerminal } from './terminals.vscode';

/** VS Code's integrated browser (1.10x+, VSCodium included): opens a page as an editor tab. */
const BROWSER_OPEN = 'workbench.action.browser.open';
// Only a found command is remembered: a lookup that ran before the browser registered asks again.
let browserFound = false;

const opener = {
  hasBrowser: async (): Promise<boolean> => (browserFound ||= (await vscode.commands.getCommands(true)).includes(BROWSER_OPEN)),
  openTab: (args: { url: string; reuseUrlFilter?: string }) => vscode.commands.executeCommand(BROWSER_OPEN, args),
  openExternal: (url: string) => vscode.env.openExternal(vscode.Uri.parse(url)),
};

/** Open a link the extension trusts. A web page opens as an editor tab in the integrated
 *  browser, in the tab `agents.links.tabs` picks; `external` (a ⌘, Ctrl or ⌥ click), the
 *  `agents.links.openIn` setting, an editor without the browser, or any other scheme opens
 *  it outside the editor as before. Never rejects. */
export async function openLink(url: string, external = false): Promise<void> {
  const config = vscode.workspace.getConfiguration('agents');
  const target: LinkTarget = external ? 'browser' : config.get<LinkTarget>('links.openIn', 'editor');
  try {
    await openWith(url, target, opener, config.get<LinkTabs>('links.tabs', 'reuse'));
  } catch (e) {
    void vscode.window.showWarningMessage(`Could not open ${url.trim()}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Open a webview-supplied URL, but only if it parses and carries an allowed scheme (see
// src/core/webviewSecurity). Silently drops empty/non-string values; warns on a blocked
// scheme so the drop is visible rather than mysterious.
export function openWebviewUrl(rawUrl: unknown, external = false): Promise<void> {
  if (!isAllowedExternalUrl(rawUrl)) {
    if (typeof rawUrl === 'string' && rawUrl) {
      void vscode.window.showWarningMessage('Blocked opening a URL with a disallowed scheme.');
    }
    return Promise.resolve();
  }
  return openLink(rawUrl as string, external);
}

/** Web links in a tab the extension opened (agents and its shell tabs) open the way the
 *  extension's own links do: a click with the terminal's link modifier opens the page in the
 *  integrated browser. Extension link providers run ahead of the editor's own URL detector,
 *  so ours wins on the same text. Terminals the editor opened, and every tab while
 *  `agents.links.openIn` is `browser`, keep the editor's own handling. Those tabs start with
 *  `plainLinks` (see `openTrackedTab`), since an OSC 8 hyperlink never reaches a provider. */
export function registerTerminalLinks(): vscode.Disposable {
  const provider: vscode.TerminalLinkProvider<vscode.TerminalLink & TextLink> = {
    provideTerminalLinks(context) {
      if (!isAgentTerminal(context.terminal)) return [];
      if (vscode.workspace.getConfiguration('agents').get<LinkTarget>('links.openIn', 'editor') !== 'editor') return [];
      return webLinksIn(context.line).map((l) => ({ ...l, tooltip: 'Open in the editor' }));
    },
    handleTerminalLink: (link) => openLink(link.url),
  };
  return vscode.window.registerTerminalLinkProvider(provider);
}
