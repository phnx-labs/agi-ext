// The built-in browser, served to agents. Each window runs a loopback CDP
// WebSocket over VS Code's `browser` API proposal and announces it for
// `browser profiles list` (src/core/editorBrowser.ts). An agent's connection
// gets its own CDP session: VS Code scopes it to the tabs created through it,
// so the owner's own tabs are never visible to agents.
import * as fs from 'fs';
import * as http from 'http';
import * as vscode from 'vscode';
import type { WebSocket } from 'ws';
import {
  addProposedApiOptIn,
  argvJsonPath,
  editorWindowId,
  newBridgeToken,
  removeEditorEndpoint,
  tokensMatch,
  writeEditorEndpoint,
} from '../core/editorBrowser';

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown; sessionId?: string };

function browserApiAvailable(): boolean {
  return typeof vscode.window.openBrowserTab === 'function';
}

// VS Code's CDP root is a browser connection that must attach to its browser
// target first; plain CDP clients (browser-cli) send Target.* at the root. The
// bridge attaches once and translates that session id both ways. The blank seed
// tab it needs to start the session closes once the agent opens its own tab.
async function serveConnection(ws: WebSocket): Promise<void> {
  const queue: CdpMessage[] = [];
  let forward: ((msg: CdpMessage) => void) | undefined;
  let seed: vscode.BrowserTab | undefined;
  let session: vscode.BrowserCDPSession | undefined;
  let seedOpen = false;
  let closed = false;
  const closeSeed = () => {
    if (!seedOpen || !seed) return;
    seedOpen = false;
    void seed.close().then(undefined, () => undefined);
  };
  // Registered before any await: a client that drops during setup still
  // releases the seed tab and the session once they exist.
  const release = () => {
    closed = true;
    void session?.close().then(undefined, () => undefined);
    closeSeed();
  };
  ws.on('close', release);
  ws.on('error', () => ws.terminate());
  ws.on('message', (data) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (forward) forward(msg as CdpMessage);
    else queue.push(msg as CdpMessage);
  });

  seed = await vscode.window.openBrowserTab('about:blank', { preserveFocus: true, background: true });
  seedOpen = true;
  try {
    session = await seed.startCDPSession();
  } catch (error) {
    closeSeed();
    throw error;
  }
  if (closed) return release();
  const live = session;
  // The bridge's own calls use ids far below any a CDP client sends.
  const internal = new Map<number, (msg: CdpMessage) => void>();
  let nextInternal = -0x40000000;
  const createCalls = new Set<number>();
  let browserSessionId: string | undefined;

  const call = (method: string) =>
    new Promise<CdpMessage>((resolve) => {
      const id = nextInternal--;
      internal.set(id, resolve);
      void live.sendMessage({ id, method, params: {} });
    });

  live.onDidReceiveMessage((raw) => {
    const msg = raw as CdpMessage;
    if (typeof msg.id === 'number' && internal.has(msg.id)) {
      internal.get(msg.id)!(msg);
      internal.delete(msg.id);
      return;
    }
    const onRoot = !!browserSessionId && msg.sessionId === browserSessionId;
    if (onRoot && typeof msg.id === 'number' && createCalls.delete(msg.id) && msg.result) closeSeed();
    if (onRoot) delete msg.sessionId;
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  });
  live.onDidClose(() => ws.close());

  const attached = await call('Target.attachToBrowserTarget');
  browserSessionId = attached.result?.sessionId as string | undefined;
  if (!browserSessionId) {
    ws.close(1011, 'Could not attach to the editor browser');
    return;
  }
  forward = (msg) => {
    if (!msg.sessionId) {
      msg.sessionId = browserSessionId;
      if (msg.method === 'Target.createTarget' && typeof msg.id === 'number') createCalls.add(msg.id);
    }
    void live.sendMessage(msg);
  };
  for (const msg of queue.splice(0)) forward(msg);
}

function startBridge(context: vscode.ExtensionContext): void {
  const { WebSocketServer } = require('ws') as typeof import('ws');
  const token = newBridgeToken();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    const host = String(req.headers.host ?? '');
    const given = (req.url ?? '').replace(/^\/devtools\/browser\//, '');
    // A web page can open a WebSocket to localhost: refuse any Origin, any
    // non-loopback Host (DNS rebinding) and any other token.
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || !tokensMatch(token, given)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      serveConnection(ws).catch(() => ws.close(1011, 'The editor browser is unavailable'));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return;
    const workspaceKey = vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    const file = writeEditorEndpoint({
      v: 1,
      id: editorWindowId(vscode.env.appName, workspaceKey),
      app: vscode.env.appName,
      appVersion: vscode.version,
      workspace: vscode.workspace.name ?? null,
      pid: process.pid,
      port: address.port,
      token,
      startedAt: new Date().toISOString(),
    });
    context.subscriptions.push({ dispose: () => removeEditorEndpoint(file, token) });
  });
  context.subscriptions.push({
    dispose: () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close();
    },
  });
}

// One explicit opt-in: VS Code lets an extension use a proposed API only when
// argv.json names it, and reads argv.json once at startup.
async function letAgentsUseBrowser(): Promise<void> {
  if (browserApiAvailable()) {
    await vscode.window.showInformationMessage('Agents can already use this editor\'s built-in browser.', { modal: true });
    return;
  }
  if (vscode.env.remoteName) {
    await vscode.window.showErrorMessage(
      `Run this from a local ${vscode.env.appName} window: argv.json belongs to the editor on your machine, not the ${vscode.env.remoteName} host.`,
      { modal: true },
    );
    return;
  }
  const file = argvJsonPath(vscode.env.appRoot);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let next: string | null;
  try {
    next = addProposedApiOptIn(text);
  } catch (error) {
    await vscode.window.showErrorMessage(`${(error as Error).message}: ${file}`, { modal: true });
    return;
  }
  if (next !== null) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
  }
  const quit = await vscode.window.showInformationMessage(
    `Agents can use the built-in browser after ${vscode.env.appName} restarts. Reloading the window is not enough.`,
    { modal: true, detail: `Added the Agents extension to "enable-proposed-api" in ${file}.` },
    'Quit Now',
  );
  if (quit === 'Quit Now') await vscode.commands.executeCommand('workbench.action.quit');
}

export function registerEditorBrowser(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('agents.browser.letAgentsUse', letAgentsUseBrowser));
  if (browserApiAvailable()) startBridge(context);
}
