import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runAgentsArgs } from '../core/agentsBin';
import { LINEAR_NOT_FOUND_MESSAGE, resolveLinearBin } from '../core/linearBin';
import {
  escapeHtml,
  parseOverview,
  parsePrs,
  parseProjectDetection,
  parseProjectList,
  parseTickets,
  renderOverview,
  renderPrs,
  renderTickets,
  type ProjectRef,
} from '../core/projectPanel';
import { openExternalUrl } from './webviewSecurity';

const execFileAsync = promisify(execFile);

// Secondary-sidebar Project container (PHNX-4289): Overview, Tickets, Pull
// requests for one project. Each view reads its one CLI verb when it becomes
// visible (at most once per FRESH_MS) or on Refresh. No timer: a hidden view
// costs nothing.

const PICKED_PROJECT_KEY = 'agents.projectPanel.project';
const FRESH_MS = 60_000;

type SectionId = 'overview' | 'tickets' | 'prs';

const SECTIONS: Record<SectionId, { viewId: string; load: (p: ProjectRef) => Promise<string> }> = {
  overview: {
    viewId: 'agentsProject.overview',
    // Fans out to the fleet for live-session counts, so it is the slow one (~15s).
    load: async (p) => {
      const { stdout } = await runAgentsArgs(['projects', 'status', p.name, '--json'], { timeout: 90_000 });
      return renderOverview(parseOverview(stdout), new Date().toISOString().slice(0, 10));
    },
  },
  tickets: {
    viewId: 'agentsProject.tickets',
    load: async (p) => {
      if (!p.linearName) throw new Error(`Project "${p.name}" has no Linear project. Link one: agents projects link ${p.name}`);
      const bin = resolveLinearBin();
      if (!bin) throw new Error(LINEAR_NOT_FOUND_MESSAGE);
      const { stdout } = await execFileAsync(bin, ['tasks', '--project', p.linearName, '--json'], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
      return renderTickets(parseTickets(stdout));
    },
  },
  prs: {
    viewId: 'agentsProject.prs',
    load: async (p) => {
      // `prs list` exits 1 when a repo could not be fetched but still prints the
      // envelope with `partial: true`; render it rather than discarding it.
      let stdout: string;
      try {
        ({ stdout } = await runAgentsArgs(['projects', 'prs', 'list', p.name, '--json'], { timeout: 60_000 }));
      } catch (e) {
        const out = (e as { stdout?: string }).stdout;
        if (!out || !out.trim().startsWith('{')) throw e;
        stdout = out;
      }
      return renderPrs(parsePrs(stdout));
    },
  },
};

class SectionView implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | undefined;
  private loadedFor: string | undefined;
  private loadedAt = 0;
  private generation = 0;

  constructor(private readonly id: SectionId, private readonly controller: ProjectPanelController) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = shell(view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg: { type?: string; url?: unknown }) => {
      if (msg.type === 'open') openExternalUrl(msg.url);
      else if (msg.type === 'pick') void vscode.commands.executeCommand('agents.project.pick');
    });
    view.onDidChangeVisibility(() => { if (view.visible) void this.load(false); });
    view.onDidDispose(() => { this.view = undefined; this.loadedFor = undefined; });
    void this.load(false);
  }

  async load(force: boolean): Promise<void> {
    const view = this.view;
    if (!view || !view.visible) return;
    const project = await this.controller.project();
    view.description = project?.name;
    if (!project) {
      this.post(`<div class="empty">No agents project contains this workspace.
        <a href="#" data-pick>Pick a project</a></div>`);
      return;
    }
    const fresh = this.loadedFor === project.name && Date.now() - this.loadedAt < FRESH_MS;
    if (fresh && !force) return;
    const gen = ++this.generation;
    if (this.loadedFor !== project.name) this.post('<div class="empty">Loading…</div>');
    else view.webview.postMessage({ type: 'loading' });
    let html: string;
    try {
      html = await SECTIONS[this.id].load(project);
    } catch (e) {
      const msg = (e as { stderr?: string }).stderr?.trim() || (e instanceof Error ? e.message : String(e));
      html = `<div class="err">${escapeHtml(msg)}</div>`;
    }
    if (gen !== this.generation) return; // a newer load (refresh / project switch) owns the view
    this.loadedFor = project.name;
    this.loadedAt = Date.now();
    this.post(html);
  }

  private post(html: string): void {
    void this.view?.webview.postMessage({ type: 'html', html });
  }
}

class ProjectPanelController {
  private detected: Promise<ProjectRef | null> | undefined;
  readonly views: SectionView[];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.views = (Object.keys(SECTIONS) as SectionId[]).map((id) => new SectionView(id, this));
  }

  /** The picked project for this workspace, else the one containing its first folder. */
  project(): Promise<ProjectRef | null> {
    const picked = this.context.workspaceState.get<ProjectRef>(PICKED_PROJECT_KEY);
    if (picked) return Promise.resolve(picked);
    this.detected ??= this.detect();
    return this.detected;
  }

  private async detect(): Promise<ProjectRef | null> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return null;
    const { stdout } = await runAgentsArgs(['projects', 'status', '--path', folder, '--json'], { timeout: 30_000 });
    return parseProjectDetection(stdout);
  }

  async pick(): Promise<void> {
    const { stdout } = await runAgentsArgs(['projects', 'list', '--json'], { timeout: 30_000 });
    const projects = parseProjectList(stdout);
    const current = await this.project();
    const choice = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.name, description: p.linearName ?? 'no Linear project', picked: p.name === current?.name, project: p })),
      { placeHolder: 'Show which project in the Project sidebar?' },
    );
    if (!choice) return;
    await this.context.workspaceState.update(PICKED_PROJECT_KEY, choice.project);
    this.refresh();
  }

  refresh(): void {
    for (const v of this.views) void v.load(true);
  }
}

export function registerProjectPanel(context: vscode.ExtensionContext): void {
  const controller = new ProjectPanelController(context);
  for (const [i, id] of (Object.keys(SECTIONS) as SectionId[]).entries()) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(SECTIONS[id].viewId, controller.views[i], {
      webviewOptions: { retainContextWhenHidden: true },
    }));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.project.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('agents.project.pick', () => controller.pick().catch((e) => {
      void vscode.window.showErrorMessage(`Could not list projects: ${e instanceof Error ? e.message : String(e)}`);
    })),
  );
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function shell(cspSource: string): string {
  const n = nonce();
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';" />
<style>
  body { padding: 4px 12px 12px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  body.loading main { opacity: 0.55; }
  section { padding: 8px 0; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border, transparent)); }
  section:last-child { border-bottom: none; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 5px 0; }
  .head, .row { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .title { font-weight: 600; font-size: 1.1em; flex: 1; }
  .label { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); flex: 1; margin-bottom: 4px; }
  .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .n { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 2px; }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; margin-top: 8px; color: var(--vscode-descriptionForeground); }
  .stats b { color: var(--vscode-foreground); }
  .bar { height: 4px; border-radius: 2px; background: var(--vscode-widget-border); background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); margin-top: 4px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--vscode-progressBar-background); }
  .ms.late .bar span { background: var(--vscode-editorWarning-foreground); }
  .tag { font-size: 0.8em; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .id { font-family: var(--vscode-editor-font-family); font-size: 0.92em; white-space: nowrap; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; align-self: center; margin-right: 1px; }
  .dot.ok { background: var(--vscode-testing-iconPassed, #3fb950); }
  .dot.bad { background: var(--vscode-testing-iconFailed, #f85149); }
  .dot.warn { background: var(--vscode-editorWarning-foreground); }
  .dot.none { border: 1px solid var(--vscode-descriptionForeground); }
  .p1 { color: var(--vscode-errorForeground); } .p2 { color: var(--vscode-editorWarning-foreground); }
  .warn { color: var(--vscode-editorWarning-foreground); margin-top: 6px; }
  .err { color: var(--vscode-errorForeground); white-space: pre-wrap; padding: 8px 0; }
  .empty { color: var(--vscode-descriptionForeground); padding: 8px 0; }
  summary { cursor: pointer; padding: 6px 0 2px; font-weight: 600; }
  details details summary, section details summary { font-weight: normal; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<main><div class="empty">Loading…</div></main>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const main = document.querySelector('main');
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'html') { main.innerHTML = m.html; document.body.classList.remove('loading'); }
    else if (m.type === 'loading') document.body.classList.add('loading');
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.url) vscode.postMessage({ type: 'open', url: a.dataset.url });
    else if (a.hasAttribute('data-pick')) vscode.postMessage({ type: 'pick' });
  });
</script>
</body>
</html>`;
}
