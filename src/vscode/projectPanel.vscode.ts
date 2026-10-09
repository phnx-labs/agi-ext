import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runAgentsArgs } from '../core/agentsBin';
import { LINEAR_NOT_FOUND_MESSAGE, resolveLinearBin } from '../core/linearBin';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import { coalesceTrailing, createTrailingCoalesce } from '../core/cachedInFlight';
import { sessionStreamDemand } from '../monitor/sessionDemand';
import {
  escapeHtml,
  parseOverview,
  parsePrs,
  parseProjectDetection,
  parseProjectList,
  parseTickets,
  projectSessions,
  renderOverview,
  renderPrs,
  renderSessions,
  renderTickets,
  type ProjectRef,
  type SessionLike,
  type TicketGroup,
} from '../core/projectPanel';
import { currentAgentPanelSubject, setAgentPanelSubjectFromFleet } from './agentPanel.vscode';
import { LOCAL_LABEL, LOCAL_MACHINE_ID } from './remoteSessions.vscode';
import { openExternalUrl } from './webviewSecurity';

const execFileAsync = promisify(execFile);

// The Project container in the left sidebar (PHNX-4289): Overview, Sessions, Pull
// requests and Tickets for one project, while the right sidebar keeps the focused
// session. Overview, Pull requests and Tickets each read their one CLI verb when the
// view becomes visible (at most once per FRESH_MS) or on Refresh. Sessions draws the
// stream rows already in the presentation store and redraws on stream facts, so it
// spawns nothing. No timer anywhere: a hidden view costs nothing.

const PICKED_PROJECT_KEY = 'agents.projectPanel.project';
const FRESH_MS = 60_000;

type SectionId = 'overview' | 'sessions' | 'prs' | 'tickets';
const VIEW_IDS: Record<SectionId, string> = {
  overview: 'agentsProject.overview',
  sessions: 'agentsProject.sessions',
  prs: 'agentsProject.prs',
  tickets: 'agentsProject.tickets',
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
    view.webview.onDidReceiveMessage((msg: { type?: string; url?: unknown; sessionId?: unknown; host?: unknown }) => {
      if (msg.type === 'open') openExternalUrl(msg.url);
      else if (msg.type === 'pick') void vscode.commands.executeCommand('agents.project.pick');
      else if (msg.type === 'select' && typeof msg.sessionId === 'string') {
        setAgentPanelSubjectFromFleet(msg.sessionId, typeof msg.host === 'string' ? msg.host : undefined);
        void this.controller.redrawSessions();
      }
    });
    const demand = (visible: boolean) => { if (this.id === 'sessions') sessionStreamDemand.setProjectSessionsVisible(visible); };
    view.onDidChangeVisibility(() => { demand(view.visible); if (view.visible) void this.load(false); });
    view.onDidDispose(() => { this.view = undefined; this.loadedFor = undefined; this.generation++; demand(false); });
    demand(view.visible);
    void this.load(false);
  }

  async load(force: boolean): Promise<void> {
    const view = this.view;
    // A forced refresh on a hidden view still has to reread on its next reveal.
    if (force) this.loadedAt = 0;
    if (!view || !view.visible) return;
    const gen = ++this.generation;
    let project: ProjectRef | null;
    try {
      project = await this.controller.project();
    } catch (e) {
      if (gen === this.generation) this.post(`<div class="err">${escapeHtml(errorText(e))}</div>`);
      return;
    }
    if (gen !== this.generation) return;
    view.description = project?.name;
    if (!project) {
      this.post('<div class="empty">No agents project contains this workspace. <a href="#" data-pick>Pick a project</a></div>');
      return;
    }
    if (this.id === 'sessions') { this.post(this.controller.sessionsHtml(project)); return; }
    const fresh = this.loadedFor === project.name && Date.now() - this.loadedAt < FRESH_MS;
    if (fresh && !force) return;
    if (this.loadedFor !== project.name) this.post('<div class="empty">Loading…</div>');
    else void view.webview.postMessage({ type: 'loading' });
    let html: string;
    let ok = true;
    try {
      html = await this.controller.render(this.id, project, force);
    } catch (e) {
      ok = false;
      html = `<div class="err">${escapeHtml(errorText(e))}</div>`;
    }
    if (gen !== this.generation) return; // a newer load (refresh / project switch) owns the view
    this.loadedFor = project.name;
    // An error is not a fresh result: the next reveal reads again.
    this.loadedAt = ok ? Date.now() : 0;
    this.post(html);
  }

  post(html: string): void {
    void this.view?.webview.postMessage({ type: 'html', html });
  }
}

function errorText(e: unknown): string {
  return (e as { stderr?: string }).stderr?.trim() || (e instanceof Error ? e.message : String(e));
}

class ProjectPanelController {
  private detected: Promise<ProjectRef | null> | undefined;
  /** One `linear tasks` read feeds both Tickets and Overview's state bar. */
  private tickets: { project: string; at: number; groups: Promise<TicketGroup[]> } | undefined;
  readonly views: Record<SectionId, SectionView>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.views = {
      overview: new SectionView('overview', this),
      sessions: new SectionView('sessions', this),
      prs: new SectionView('prs', this),
      tickets: new SectionView('tickets', this),
    };
  }

  /** The picked project for this workspace, else the one containing its first folder. */
  project(): Promise<ProjectRef | null> {
    const picked = this.context.workspaceState.get<ProjectRef>(PICKED_PROJECT_KEY);
    if (picked) return Promise.resolve(picked);
    if (!this.detected) {
      const detected = this.detect();
      this.detected = detected;
      // Keep only a found project; a failure or "no project" is asked again next time.
      detected.then((p) => { if (!p && this.detected === detected) this.detected = undefined; },
        () => { if (this.detected === detected) this.detected = undefined; });
    }
    return this.detected;
  }

  private async detect(): Promise<ProjectRef | null> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return null;
    const { stdout } = await runAgentsArgs(['projects', 'status', '--path', folder, '--json'], { timeout: 30_000 });
    return parseProjectDetection(stdout);
  }

  private ticketGroups(p: ProjectRef, force: boolean): Promise<TicketGroup[]> {
    const cached = this.tickets;
    if (!force && cached && cached.project === p.name && Date.now() - cached.at < FRESH_MS) return cached.groups;
    const groups = (async () => {
      if (!p.linearName) throw new Error(`Project "${p.name}" has no Linear project. Link one: agents projects link ${p.name}`);
      const bin = resolveLinearBin();
      if (!bin) throw new Error(LINEAR_NOT_FOUND_MESSAGE);
      const { stdout } = await execFileAsync(bin, ['tasks', '--project', p.linearName, '--json'], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
      return parseTickets(stdout);
    })();
    this.tickets = { project: p.name, at: Date.now(), groups };
    groups.catch(() => { if (this.tickets?.groups === groups) this.tickets = undefined; });
    return groups;
  }

  async render(id: Exclude<SectionId, 'sessions'>, p: ProjectRef, force: boolean): Promise<string> {
    if (id === 'tickets') return renderTickets(await this.ticketGroups(p, force));
    if (id === 'overview') {
      // Fans out to the fleet for live-session counts, so it is the slow read (~15s).
      const [status, tickets] = await Promise.all([
        runAgentsArgs(['projects', 'status', p.name, '--json'], { timeout: 90_000 }),
        // A failed ticket read is shown in place, never drawn as "no tickets".
        this.ticketGroups(p, force).then((groups) => ({ groups, error: null as string | null }), (e) => ({ groups: [] as TicketGroup[], error: errorText(e) })),
      ]);
      return renderOverview(parseOverview(status.stdout), new Date().toISOString().slice(0, 10), tickets.groups, tickets.error);
    }
    // `prs list` exits 1 when a repo could not be read but still prints the envelope
    // with `partial: true`; render it rather than discarding it.
    let stdout: string;
    try {
      ({ stdout } = await runAgentsArgs(['projects', 'prs', 'list', p.name, '--json'], { timeout: 60_000 }));
    } catch (e) {
      const out = (e as { stdout?: string }).stdout;
      if (!out || !out.trim().startsWith('{')) throw e;
      stdout = out;
    }
    return renderPrs(parsePrs(stdout), Date.now());
  }

  sessionsHtml(p: ProjectRef): string {
    if (!sessionPresentationStore.hasSeenReset()) return '<div class="empty">Waiting for the session stream…</div>';
    const rows = sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL) as unknown as SessionLike[];
    const subject = currentAgentPanelSubject();
    return renderSessions(projectSessions(rows, p.name), Date.now(), subject?.sessionId ?? null);
  }

  redrawSessions(): Promise<void> {
    return this.views.sessions.load(false);
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
    this.tickets = undefined;
    this.detected = undefined;
    for (const v of Object.values(this.views)) void v.load(true);
  }
}

let activeController: ProjectPanelController | undefined;
const sessionsCoalesce = createTrailingCoalesce();

/** Called by extension.ts when a session-stream fact changed the store; the
 *  Sessions view redraws from memory (no subprocess).
 *  @public loaded with require('./projectPanel.vscode') in extension.ts, which knip cannot see */
export function notifyProjectPanelSessionUpdate(): void {
  const controller = activeController;
  if (!controller) return;
  // A burst of facts collapses into one redraw plus one catch-up, as in the right sidebar.
  void coalesceTrailing(sessionsCoalesce, 'projectSessions', () => controller.redrawSessions());
}

/** @public loaded with require('./projectPanel.vscode') in extension.ts, which knip cannot see */
export function registerProjectPanel(context: vscode.ExtensionContext): void {
  const controller = new ProjectPanelController(context);
  activeController = controller;
  context.subscriptions.push({ dispose: () => { if (activeController === controller) activeController = undefined; } });
  for (const id of Object.keys(VIEW_IDS) as SectionId[]) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_IDS[id], controller.views[id], {
      webviewOptions: { retainContextWhenHidden: true },
    }));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.project.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('agents.project.pick', () => controller.pick().catch((e) => {
      void vscode.window.showErrorMessage(`Could not list projects: ${errorText(e)}`);
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
  /* Rush register, as in the Active Terminal panel. This block is the only one
     with color literals; dark editor = Altitude, light = Day, high contrast keeps
     VS Code's own colors. */
  body {
    --r-text: #FAFAFA; --r-text-2: #D4D4D8; --r-caption: #A1A1AA; --r-faint: #71717A;
    --r-glass: rgba(255,255,255,0.05); --r-hover: rgba(255,255,255,0.08); --r-edge: rgba(255,255,255,0.12);
    --r-well: rgba(0,0,0,0.35); --r-sky: rgba(86,104,150,0.16);
    --r-ok: #86efac; --r-ok-tint: rgba(34,197,94,0.16); --r-warn: #fcd34d; --r-warn-tint: rgba(245,158,11,0.14);
    --r-bad: #fca5a5; --r-bad-tint: rgba(239,68,68,0.12); --r-info: #a5b4fc;
    --r-doing: #4ade80; --r-review: #bef264; --r-todo: #71717a; --r-backlog: #3f3f46; --r-gold: #D4B872;
  }
  body.vscode-light {
    --r-text: #141829; --r-text-2: #4B4A55; --r-caption: #665E52; --r-faint: #8A8174;
    --r-glass: rgba(251,248,242,0.70); --r-hover: rgba(20,24,41,0.06); --r-edge: #DCD2C3;
    --r-well: rgba(20,24,41,0.06); --r-sky: rgba(184,204,220,0.30);
    --r-ok: #15803d; --r-ok-tint: rgba(22,163,74,0.12); --r-warn: #b45309; --r-warn-tint: rgba(217,119,6,0.12);
    --r-bad: #b91c1c; --r-bad-tint: rgba(220,38,38,0.08); --r-info: #4f46e5;
    --r-doing: #15803d; --r-review: #65a30d; --r-todo: #a8a29e; --r-backlog: #d6d3d1; --r-gold: #A8884A;
  }
  body.vscode-high-contrast, body.vscode-high-contrast-light {
    --r-text: var(--vscode-foreground); --r-text-2: var(--vscode-foreground); --r-caption: var(--vscode-descriptionForeground); --r-faint: var(--vscode-descriptionForeground);
    --r-glass: transparent; --r-hover: var(--vscode-list-hoverBackground); --r-edge: var(--vscode-contrastBorder); --r-well: transparent; --r-sky: transparent;
    --r-ok: var(--vscode-testing-iconPassed); --r-ok-tint: transparent; --r-warn: var(--vscode-editorWarning-foreground); --r-warn-tint: transparent;
    --r-bad: var(--vscode-errorForeground); --r-bad-tint: transparent; --r-info: var(--vscode-textLink-foreground);
    --r-doing: var(--vscode-testing-iconPassed); --r-review: var(--vscode-testing-iconPassed); --r-todo: var(--vscode-descriptionForeground); --r-backlog: var(--vscode-contrastBorder); --r-gold: var(--vscode-focusBorder);
  }
  body { padding: 2px 10px 12px; margin: 0; font-family: var(--vscode-font-family); font-size: 12px; color: var(--r-text);
    background: var(--vscode-sideBar-background); background-image: radial-gradient(130% 55% at 72% 0%, var(--r-sky), transparent 70%); }
  body.loading main { opacity: 0.55; }
  section { padding: 8px 0; border-bottom: 1px solid var(--r-edge); }
  section:last-child { border-bottom: none; }
  ul { list-style: none; margin: 0; padding: 0; }
  a { color: inherit; text-decoration: none; }
  .head, .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .title { font-weight: 600; font-size: 15px; flex: 1; }
  .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--r-caption); flex: 1; }
  .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--r-text); }
  .n { color: var(--r-faint); font-variant-numeric: tabular-nums; font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .sub { color: var(--r-caption); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sbar { display: flex; gap: 2px; height: 6px; border-radius: 3px; overflow: hidden; margin: 8px 0 5px; }
  .sbar span, .legend i { display: block; }
  .legend { display: flex; flex-wrap: wrap; gap: 3px 10px; font-size: 11px; color: var(--r-caption); }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
  .st-doing { background: var(--r-doing); } .st-review { background: var(--r-review); } .st-todo { background: var(--r-todo); } .st-backlog { background: var(--r-backlog); }
  .ms { margin-top: 8px; } .ms .t { flex: 1; }
  .mbar { height: 3px; border-radius: 2px; background: var(--r-well); margin-top: 4px; overflow: hidden; }
  .mbar span { display: block; height: 100%; background: var(--r-ok); }
  .note { margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: var(--r-well); color: var(--r-caption); }
  .note b { color: var(--r-text); }
  .ic { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .srow { display: grid; grid-template-columns: minmax(0,1fr) 18px; gap: 2px 8px; width: 100%; text-align: left; padding: 7px 6px; margin: 1px 0; border: none; border-radius: 8px; background: none; color: inherit; font: inherit; cursor: pointer; }
  .srow:hover { background: var(--r-hover); } .srow.sel { background: var(--r-hover); box-shadow: inset 2px 0 0 var(--r-gold); }
  .srow:focus-visible, a:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .l1 { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l2 { grid-column: 1; color: var(--r-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l2.act { color: var(--r-caption); }
  .l2 .cmd { font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .l2 .tool { color: var(--r-text-2); font-weight: 600; font-size: 11px; }
  .l3 { grid-column: 1; display: flex; flex-wrap: wrap; gap: 2px 10px; color: var(--r-caption); font-size: 11px; font-family: var(--vscode-editor-font-family); }
  .fact { display: inline-flex; align-items: center; gap: 3px; }
  .fact.pr-ok { color: var(--r-ok); } .fact.pr-bad { color: var(--r-bad); } .fact.pr-run { color: var(--r-warn); }
  .mark { grid-column: 2; grid-row: 1 / span 2; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid currentColor; display: grid; place-items: center; font-size: 10px; font-weight: 700; margin-top: 1px; color: var(--r-faint); }
  .m-asks { color: var(--r-warn); } .m-stopped, .m-failed { color: var(--r-bad); } .m-done { color: var(--r-ok); }
  .m-working { color: var(--r-ok); border-style: dotted; animation: spin 2.4s linear infinite; }
  .m-idle { border-style: dashed; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .quiet summary, details summary { cursor: pointer; padding: 6px 2px 2px; color: var(--r-caption); font-size: 11.5px; }
  details > summary { list-style: revert; }
  .pri { display: inline-flex; align-items: flex-end; gap: 1.5px; width: 12px; height: 11px; flex: none; margin-top: 3px; }
  .pri i { display: block; width: 2.5px; border-radius: 1px; background: var(--r-edge); }
  .pri i.on { background: var(--r-faint); } .pri.p1 i.on { background: var(--r-bad); } .pri.p2 i.on { background: var(--r-warn); }
  .trow, .prow { display: grid; grid-template-columns: auto minmax(0,1fr); gap: 8px; padding: 5px 4px; border-radius: 6px; }
  .trow:hover, .prow:hover { background: var(--r-hover); }
  .tm { display: grid; min-width: 0; gap: 1px; }
  .ring { width: 14px; height: 14px; flex: none; margin-top: 1px; display: inline-block; }
  .ring svg { width: 14px; height: 14px; display: block; fill: none; stroke-width: 2; }
  .ring .trk { stroke: var(--r-edge); }
  .ring .arc { stroke: var(--r-warn); stroke-dasharray: 14 40; transform-origin: 9px 9px; stroke-linecap: round; animation: spin 1s linear infinite; }
  .r-ok .arc { stroke: var(--r-ok); stroke-dasharray: 50 0; animation: none; } .r-ok .chk { stroke: var(--r-ok); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .r-bad .arc { stroke: var(--r-bad); stroke-dasharray: 50 0; animation: none; }
  .r-draft .arc { stroke: var(--r-faint); stroke-dasharray: 3 3; animation: none; }
  .r-none .arc { stroke: transparent; animation: none; }
  .rmeta { display: inline-flex; align-items: center; gap: 4px; color: var(--r-caption); font-size: 11px; font-family: var(--vscode-editor-font-family); }
  .warn { color: var(--r-warn); padding: 6px 0; }
  .err { color: var(--r-bad); white-space: pre-wrap; padding: 8px 0; }
  .empty { color: var(--r-caption); padding: 8px 0; }
  .empty a { color: var(--vscode-textLink-foreground); }
  @media (prefers-reduced-motion: reduce) { .m-working, .ring .arc { animation: none; } }
</style>
</head>
<body>
<main><div class="empty">Loading…</div></main>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const main = document.querySelector('main');
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'html') {
      // Redraws keep what the viewer opened and where they scrolled.
      const open = new Set([...main.querySelectorAll('details')].map((d, i) => d.open ? (d.querySelector('summary')?.textContent || i) : null).filter((k) => k !== null));
      const y = window.scrollY;
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.session : null;
      main.innerHTML = m.html;
      main.querySelectorAll('details').forEach((d, i) => { const k = d.querySelector('summary')?.textContent || i; if (open.has(k)) d.open = true; });
      window.scrollTo(0, y);
      if (focused) { const el = main.querySelector('[data-session="' + CSS.escape(focused) + '"]'); if (el) el.focus(); }
      document.body.classList.remove('loading');
    }
    else if (m.type === 'loading') document.body.classList.add('loading');
  });
  document.addEventListener('click', (e) => {
    const row = e.target.closest('[data-session]');
    if (row) { vscode.postMessage({ type: 'select', sessionId: row.dataset.session, host: row.dataset.host }); return; }
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
