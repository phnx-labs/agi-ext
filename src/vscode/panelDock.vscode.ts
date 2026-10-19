// A sidebar panel moved into a window of its own, for a second monitor.
//
// VS Code moves only editor tabs into a new window; views stay in their bar. So a
// panel pops out by drawing into an editor tab and moving that tab with VS Code's
// own `workbench.action.moveEditorToNewWindow`. The panel draws into one host at a
// time: while the tab is out, the sidebar view shows only a way back, and closing
// the tab (or its window) draws the panel in the sidebar again. A serializer
// re-adopts the tab when VS Code restores the window after a restart.

import * as vscode from 'vscode';

/** What a panel draws into: its sidebar view, or the tab it popped out into.
 *  A `vscode.WebviewView` is one as it stands. */
export interface PanelHost {
  readonly webview: vscode.Webview;
  readonly visible: boolean;
  /** The view's title (VS Code draws "PROJECT: RUSH"); in a tab, after the tab's name.
   *  A view's description is never drawn while it is its bar's only view. */
  title?: string;
  show(preserveFocus?: boolean): void;
  readonly onDidChangeVisibility: vscode.Event<void>;
}

function tabHost(tab: vscode.WebviewPanel, title: string): PanelHost {
  let named: string | undefined;
  return {
    webview: tab.webview,
    get visible() { return tab.visible; },
    get title() { return named; },
    set title(d) { named = d; tab.title = d ? `${title}: ${d}` : title; },
    show: (preserveFocus) => tab.reveal(undefined, preserveFocus),
    // A tab's view state also changes when it gains or loses focus; a view's
    // visibility event fires only when it shows or hides, so pass only that.
    onDidChangeVisibility: (listener, thisArgs, disposables) => {
      let shown = tab.visible;
      return tab.onDidChangeViewState(() => { if (tab.visible !== shown) { shown = tab.visible; listener.call(thisArgs); } }, undefined, disposables);
    },
  };
}

interface DockOptions {
  /** The editor tab's webview type, also the serializer's key. */
  viewType: string;
  /** The command the view's title bar runs to pop it out. */
  command: string;
  title: string;
  /** Draws the panel into a host; disposing the result stops drawing there. */
  attach(host: PanelHost): vscode.Disposable;
}

export class PanelDock {
  private sidebar: vscode.WebviewView | undefined;
  private tab: vscode.WebviewPanel | undefined;
  private drawing: vscode.Disposable | undefined;
  private placeholder: vscode.Disposable | undefined;

  constructor(private readonly o: DockOptions) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(this.o.command, () => this.popOut()),
      vscode.window.registerWebviewPanelSerializer(this.o.viewType, { deserializeWebviewPanel: async (tab) => this.adopt(tab) }),
      { dispose: () => this.stopDrawing() },
    );
  }

  /** The view provider's resolve: the sidebar draws the panel unless it is out. */
  resolveSidebar(view: vscode.WebviewView): void {
    this.sidebar = view;
    view.onDidDispose(() => {
      if (this.sidebar !== view) return;
      this.sidebar = undefined;
      this.placeholder?.dispose();
      if (!this.tab) this.stopDrawing();
    });
    if (this.tab) this.showPlaceholder(view);
    else this.drawInto(view);
  }

  private async popOut(): Promise<void> {
    if (this.tab) { this.tab.reveal(); return; }
    this.adopt(vscode.window.createWebviewPanel(this.o.viewType, this.o.title, vscode.ViewColumn.Active, { retainContextWhenHidden: true }));
    // If the editor cannot open a window, the panel goes back where it was.
    await Promise.resolve(vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow')).catch(() => this.tab?.dispose());
  }

  private adopt(tab: vscode.WebviewPanel): void {
    // Two restored windows, or a restore racing a press: the panel has one tab.
    const previous = this.tab;
    this.tab = tab;
    previous?.dispose();
    tab.title = this.o.title;
    this.drawInto(tabHost(tab, this.o.title));
    if (this.sidebar) this.showPlaceholder(this.sidebar);
    tab.onDidDispose(() => {
      if (this.tab !== tab) return;
      this.tab = undefined;
      this.stopDrawing();
      if (this.sidebar) this.drawInto(this.sidebar);
    });
  }

  private drawInto(host: PanelHost): void {
    this.stopDrawing();
    this.placeholder?.dispose();
    this.placeholder = undefined;
    this.drawing = this.o.attach(host);
  }

  private stopDrawing(): void {
    this.drawing?.dispose();
    this.drawing = undefined;
  }

  private showPlaceholder(view: vscode.WebviewView): void {
    this.placeholder?.dispose();
    view.webview.options = { enableScripts: true };
    view.webview.html = placeholderHtml(this.o.title);
    this.placeholder = view.webview.onDidReceiveMessage((m: { type?: unknown }) => { if (m?.type === 'dockBack') this.tab?.dispose(); });
  }
}

function placeholderHtml(title: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-descriptionForeground); padding: 16px 12px; }
  button { margin-top: 8px; font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 2px; padding: 4px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style></head><body>
<div>${title} is open in its own window.</div>
<button>Bring it back here</button>
<script>const api = acquireVsCodeApi(); document.querySelector('button').addEventListener('click', () => api.postMessage({ type: 'dockBack' }));</script>
</body></html>`;
}
