import * as vscode from 'vscode';
import { browserTabArgs, isAllowedExternalUrl, type LinkTarget } from '../core/webviewSecurity';

/** VS Code's integrated browser (1.10x+, VSCodium included): opens a page as an editor tab. */
const BROWSER_OPEN = 'workbench.action.browser.open';
let hasBrowser: Thenable<boolean> | undefined;

/** Open a link the extension trusts. A web page opens as an editor tab in the integrated
 *  browser, a second click on the same page bringing its tab forward; `external` (a ⌘ or ⌥
 *  click), the `agents.links.openIn` setting, an editor without the browser, or any other
 *  scheme opens it outside the editor as before. */
export async function openLink(url: string, external = false): Promise<void> {
  const target: LinkTarget = external ? 'browser' : vscode.workspace.getConfiguration('agents').get<LinkTarget>('links.openIn', 'editor');
  const args = browserTabArgs(url, target);
  hasBrowser ??= vscode.commands.getCommands(true).then((all) => all.includes(BROWSER_OPEN));
  if (args && await hasBrowser) {
    await vscode.commands.executeCommand(BROWSER_OPEN, args);
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url, true));
}

// Open a webview-supplied URL, but only if it parses and carries an allowed scheme (see
// src/core/webviewSecurity). Silently drops empty/non-string values; warns on a blocked
// scheme so the drop is visible rather than mysterious.
export function openWebviewUrl(rawUrl: unknown, external = false): void {
  if (!isAllowedExternalUrl(rawUrl)) {
    if (typeof rawUrl === 'string' && rawUrl) {
      void vscode.window.showWarningMessage('Blocked opening a URL with a disallowed scheme.');
    }
    return;
  }
  void openLink(rawUrl as string, external);
}
