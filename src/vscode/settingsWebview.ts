// The Fleet dashboard webview's shell: its local resource roots and HTML.

import * as vscode from 'vscode';
import { homedir } from 'os';

// Home, as the sidebar grants (agentPanel.vscode.ts): pasted images, the CLI
// caches and the artifact thumbnails a stream row names all live under it.
export function webviewLocalResourceRoots(context: vscode.ExtensionContext): vscode.Uri[] {
  return [
    vscode.Uri.joinPath(context.extensionUri, 'out', 'ui'),
    vscode.Uri.joinPath(context.extensionUri, 'assets'),
    vscode.Uri.file(homedir()),
  ];
}

/** The dashboard HTML: the React bundle plus the icon and font URIs it reads. */
export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'ui', 'settings', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'ui', 'settings', 'main.css'));

  // Get asset URIs for icons
  const claudeIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'claude.png'));
  const codexIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'chatgpt.png'));
  const codexIconLight = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'chatgpt-light.png'));
  const opencodeIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'opencode.png'));
  const cursorIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'cursor.png'));
  const cursorIconLight = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'cursor-light.png'));
  const agentsIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'agents.png'));
  const githubIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'github.png'));
  const antigravityIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'antigravity.png'));
  const grokIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'grok.png'));
  const grokIconLight = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'grok-light.png'));
  const kimiIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'kimi.png'));
  const droidIcon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'droid.png'));
  const droidIconLight = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'droid-light.png'));
  const fontJost = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'fonts', 'jost-var.woff2'));
  const fontInter = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'fonts', 'InterVariable.woff2'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <script>
    // Inject icon paths for the React app
    window.__ICONS__ = {
      claude: "${claudeIcon}",
      codex: { dark: "${codexIcon}", light: "${codexIconLight}" },
      opencode: "${opencodeIcon}",
      cursor: { dark: "${cursorIcon}", light: "${cursorIconLight}" },
      shell: "${agentsIcon}",
      agents: "${agentsIcon}",
      github: "${githubIcon}",
      antigravity: "${antigravityIcon}",
      grok: { dark: "${grokIcon}", light: "${grokIconLight}" },
      kimi: "${kimiIcon}",
      droid: { dark: "${droidIcon}", light: "${droidIconLight}" }
    };
    // The session panel faces, for the shared session cards in an expanded row.
    window.__SESSION_FONTS__ = { jost: "${fontJost}", inter: "${fontInter}" };
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
