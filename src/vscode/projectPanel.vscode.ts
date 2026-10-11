import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runAgentsArgs } from '../core/agentsBin';
import { LINEAR_NOT_FOUND_MESSAGE, resolveLinearBin } from '../core/linearBin';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import { coalesceTrailing, createTrailingCoalesce } from '../core/cachedInFlight';
import { requestImageThumbs } from '../core/sessionCardFields';
import type { RemoteSession } from '../core/remoteSessions';
import { sessionStreamDemand } from '../monitor/sessionDemand';
import {
  escapeHtml,
  heldInTab,
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
  sessionCount,
  type ProjectRef,
  type SessionLike,
  type TicketGroup,
} from '../core/projectPanel';
import { currentAgentPanelSubject, setAgentPanelSubjectFromFleet } from './agentPanel.vscode';
import { LOCAL_LABEL, LOCAL_MACHINE_ID, remoteDeviceArg } from './remoteSessions.vscode';
import * as terminals from './terminals.vscode';
import { openExternalUrl } from './webviewSecurity';

const execFileAsync = promisify(execFile);

// The Project sidebar panel (PHNX-4289): one view with four icon tabs (Overview,
// Sessions, Pull requests, Tickets) for one project, while the other sidebar keeps
// the focused session. Only the active tab loads. Overview, Pull requests and
// Tickets each read their one CLI verb when shown (at most once per FRESH_MS) or on
// Refresh; Sessions draws the stream rows already in the presentation store and
// demands the stream only while it is the visible tab. No timer anywhere.

const PICKED_PROJECT_KEY = 'agents.projectPanel.project';
const TAB_KEY = 'agents.projectPanel.tab';
const FRESH_MS = 60_000;

type TabId = 'overview' | 'sessions' | 'prs' | 'tickets';
const TABS: readonly TabId[] = ['overview', 'sessions', 'prs', 'tickets'];
const VIEW_ID = 'agentsProject.panel';

interface TabState {
  html: string | undefined;
  loadedFor: string | undefined;
  loadedAt: number;
  generation: number;
}

class ProjectView implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | undefined;
  private active: TabId;
  private readonly tabs = new Map<TabId, TabState>(TABS.map((t) => [t, { html: undefined, loadedFor: undefined, loadedAt: 0, generation: 0 }]));

  constructor(private readonly controller: ProjectPanelController, private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<string>(TAB_KEY);
    this.active = (TABS as readonly string[]).includes(saved ?? '') ? saved as TabId : 'sessions';
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(os.homedir())] };
    view.webview.html = shell(view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg: { type?: string; tab?: unknown; url?: unknown; sessionId?: unknown; host?: unknown; path?: unknown }) => {
      if (msg.type === 'ready') this.onReady();
      else if (msg.type === 'tab' && typeof msg.tab === 'string' && (TABS as readonly string[]).includes(msg.tab)) void this.show(msg.tab as TabId);
      else if (msg.type === 'open') openExternalUrl(msg.url);
      else if (msg.type === 'pick') void vscode.commands.executeCommand('agents.project.pick');
      else if (msg.type === 'image' && typeof msg.path === 'string') void this.controller.openImage(msg.path);
      else if (msg.type === 'session' && typeof msg.sessionId === 'string') {
        void this.controller.goToSession(msg.sessionId, typeof msg.host === 'string' ? msg.host : undefined);
      }
    });
    view.onDidChangeVisibility(() => { this.syncDemand(); if (view.visible) void this.load(this.active, false); });
    view.onDidDispose(() => {
      this.view = undefined;
      for (const t of this.tabs.values()) { t.loadedFor = undefined; t.generation++; }
      sessionStreamDemand.setProjectSessionsVisible(false);
    });
    this.syncDemand();
    void this.load(this.active, false);
  }

  private syncDemand(): void {
    sessionStreamDemand.setProjectSessionsVisible(!!this.view?.visible && this.active === 'sessions');
  }

  /** A message posted before the webview's script listens is dropped, so the first
   *  draw can be lost; the script says when it is ready and gets the tab again. */
  private onReady(): void {
    void this.view?.webview.postMessage({ type: 'tab', tab: this.active });
    const cached = this.tabs.get(this.active)!.html;
    if (cached) this.post(this.active, cached);
    else void this.load(this.active, false);
  }

  private async show(tab: TabId): Promise<void> {
    if (tab === this.active) return;
    this.active = tab;
    void this.context.workspaceState.update(TAB_KEY, tab);
    this.syncDemand();
    const cached = this.tabs.get(tab)!.html;
    if (cached) this.post(tab, cached);
    await this.load(tab, false);
  }

  async load(tab: TabId, force: boolean): Promise<void> {
    const state = this.tabs.get(tab)!;
    // A forced refresh on a hidden tab still has to reread when it is shown.
    if (force) state.loadedAt = 0;
    const view = this.view;
    if (!view || !view.visible || tab !== this.active) return;
    const gen = ++state.generation;
    let project: ProjectRef | null;
    try {
      project = await this.controller.project();
    } catch (e) {
      if (gen === state.generation) this.post(tab, `<div class="err">${escapeHtml(errorText(e))}</div>`);
      return;
    }
    if (gen !== state.generation) return;
    view.description = project?.name;
    if (!project) {
      this.post(tab, '<div class="empty">No agents project contains this workspace. <a href="#" data-pick>Pick a project</a></div>');
      return;
    }
    if (tab === 'sessions') {
      const { html, count } = this.controller.sessions(project, view.webview);
      void view.webview.postMessage({ type: 'count', tab: 'sessions', n: count.shown, asks: count.asks });
      this.post(tab, html);
      return;
    }
    const fresh = state.loadedFor === project.name && Date.now() - state.loadedAt < FRESH_MS;
    if (fresh && !force) return;
    if (state.loadedFor !== project.name) this.post(tab, '<div class="empty">Loading…</div>');
    else void view.webview.postMessage({ type: 'loading' });
    let html: string;
    let ok = true;
    try {
      html = await this.controller.render(tab, project, force);
    } catch (e) {
      ok = false;
      html = `<div class="err">${escapeHtml(errorText(e))}</div>`;
    }
    if (gen !== state.generation) return; // a newer load (refresh / project switch) owns the tab
    state.loadedFor = project.name;
    // An error is not a fresh result: the next show reads again.
    state.loadedAt = ok ? Date.now() : 0;
    this.post(tab, html);
  }

  redrawSessions(): Promise<void> {
    return this.load('sessions', false);
  }

  refresh(): void {
    for (const t of TABS) void this.load(t, true);
  }

  private post(tab: TabId, html: string): void {
    this.tabs.get(tab)!.html = html;
    if (tab === this.active) void this.view?.webview.postMessage({ type: 'html', tab, html });
  }
}

function errorText(e: unknown): string {
  return (e as { stderr?: string }).stderr?.trim() || (e instanceof Error ? e.message : String(e));
}

class ProjectPanelController {
  private detected: Promise<ProjectRef | null> | undefined;
  /** One `linear tasks` read feeds both Tickets and Overview's state bar. */
  private tickets: { project: string; at: number; groups: Promise<TicketGroup[]> } | undefined;
  readonly view: ProjectView;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.view = new ProjectView(this, context);
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

  async render(id: Exclude<TabId, 'sessions'>, p: ProjectRef, force: boolean): Promise<string> {
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

  private presented(): RemoteSession[] {
    return sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL);
  }

  sessions(p: ProjectRef, webview: vscode.Webview): { html: string; count: { shown: number; asks: number } } {
    if (!sessionPresentationStore.hasSeenReset()) return { html: '<div class="empty">Waiting for the session stream…</div>', count: { shown: 0, asks: 0 } };
    const rows = projectSessions(this.presented() as unknown as SessionLike[], p.name);
    const byId = new Map(this.presented().map((r) => [r.sessionId, r]));
    const thumbsFor = (s: SessionLike) => {
      const live = byId.get(s.sessionId);
      return live ? requestImageThumbs(live, {
        home: os.homedir(),
        remoteDevice: remoteDeviceArg(live.host),
        exists: (f) => fs.existsSync(f),
        previewUri: (f) => webview.asWebviewUri(vscode.Uri.file(f)).toString(),
      }) : [];
    };
    const subject = currentAgentPanelSubject();
    return { html: renderSessions(rows, Date.now(), subject?.sessionId ?? null, thumbsFor), count: sessionCount(rows) };
  }

  /** A card click goes to the session: its tab in this window, else the tab the CLI
   *  says holds it in another window, else a new tab resuming it on its device. The
   *  other sidebar points at it in every case, as a Fleet row click does. */
  async goToSession(sessionId: string, host: string | undefined): Promise<void> {
    setAgentPanelSubjectFromFleet(sessionId, host);
    void this.view.redrawSessions();
    const local = terminals.getBySessionId(sessionId);
    if (local) { local.terminal.show(false); return; }
    const row = this.presented().find((r) => r.sessionId === sessionId);
    if (row && heldInTab(row)) {
      try {
        await runAgentsArgs(['ps', 'focus', sessionId, '--attach-only'], { timeout: 30_000 });
        return;
      } catch (e) {
        void vscode.window.showWarningMessage(`Could not focus the tab holding ${sessionId.slice(0, 8)}: ${errorText(e)}`);
        return;
      }
    }
    if (row?.resumable === false) {
      void vscode.window.showInformationMessage(`${row.agentType || 'This harness'} sessions cannot be resumed, so ${sessionId.slice(0, 8)} has no tab to open.`);
      return;
    }
    const { openAgentSessionByRecovery } = require('./extension') as typeof import('./extension');
    const device = remoteDeviceArg(row?.host ?? host);
    await openAgentSessionByRecovery(this.context, { sessionId, agentType: row?.agentType ?? '', ...(device ? { device } : {}) });
  }

  async openImage(filePath: string): Promise<void> {
    // Only a file a card offered: a pasted image in this machine's stores.
    const home = os.homedir();
    const allowed = [`${home}/.agents/.history/attachments/`, `${home}/.agents/.cache/attachments/`];
    if (!allowed.some((dir) => filePath.startsWith(dir)) || filePath.includes('..')) return;
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), { preview: true });
  }

  redrawSessions(): Promise<void> {
    return this.view.redrawSessions();
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
    this.view.refresh();
  }
}

let activeController: ProjectPanelController | undefined;
const sessionsCoalesce = createTrailingCoalesce();

/** Called by extension.ts when a session-stream fact changed the store; the
 *  Sessions tab redraws from memory (no subprocess).
 *  @public loaded with require('./projectPanel.vscode') in extension.ts, which knip cannot see */
export function notifyProjectPanelSessionUpdate(): void {
  const controller = activeController;
  if (!controller) return;
  // A burst of facts collapses into one redraw plus one catch-up, as in the other sidebar.
  void coalesceTrailing(sessionsCoalesce, 'projectSessions', () => controller.redrawSessions());
}

/** @public loaded with require('./projectPanel.vscode') in extension.ts, which knip cannot see */
export function registerProjectPanel(context: vscode.ExtensionContext): void {
  const controller = new ProjectPanelController(context);
  activeController = controller;
  context.subscriptions.push({ dispose: () => { if (activeController === controller) activeController = undefined; } });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, controller.view, {
    webviewOptions: { retainContextWhenHidden: true },
  }));
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
  content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';" />
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
  body { margin: 0; font-family: var(--vscode-font-family); font-size: 12px; color: var(--r-text);
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
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; padding: 0; }
  .tabs { display: flex; align-items: center; gap: 2px; padding: 4px 8px 6px; border-bottom: 1px solid var(--r-edge); flex: none; }
  .tab { height: 26px; padding: 0 8px; border: none; border-radius: 6px; background: none; color: var(--r-caption); font: inherit; display: inline-flex; gap: 5px; align-items: center; position: relative; cursor: pointer; }
  .tab .lbl { display: none; font-size: 12px; white-space: nowrap; }
  .tab:hover { background: var(--r-hover); }
  .tab[aria-selected="true"] { background: var(--r-hover); color: var(--r-text); font-weight: 600; }
  .tab[aria-selected="true"] .lbl { display: inline; }
  .tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .tab .ti { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .tab .cnt { font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); font-weight: 400; }
  .tab .dot { position: absolute; top: -1px; right: -2px; min-width: 14px; height: 14px; line-height: 14px; border-radius: 7px; background: var(--r-warn-tint); color: var(--r-warn); font-size: 9.5px; font-weight: 700; text-align: center; padding: 0 3px; box-sizing: border-box; transform: scale(.85); }
  .tab[aria-selected="true"] .dot { position: static; transform: none; }
  .tab .dot:empty { display: none; }
  main { padding: 2px 8px 12px; overflow: auto; flex: 1; min-height: 0; }
  .divider { display: flex; gap: 6px; align-items: center; margin: 10px 4px 4px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .14em; color: var(--r-caption); }
  .divider::after { content: ''; flex: 1; height: 1px; background: var(--r-edge); }
  .card { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; width: 100%; box-sizing: border-box; text-align: left; padding: 8px 8px 9px; margin: 2px 0; border-radius: 8px; color: inherit; cursor: pointer; }
  .card:hover { background: var(--r-hover); } .card.sel { background: var(--r-hover); box-shadow: inset 2px 0 0 var(--r-gold); }
  .card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .card .top { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .card .ttl { flex: 1; min-width: 0; font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .age { font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); flex: none; }
  .card .go { display: none; font-size: 10.5px; color: var(--r-caption); border: 1px solid var(--r-edge); border-radius: 9px; padding: 0 7px; line-height: 16px; flex: none; }
  .card:hover .go, .card:focus-visible .go { display: inline; } .card:hover .age, .card:focus-visible .age { display: none; }
  .mk { width: 14px; height: 14px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 9px; font-weight: 700; border: 1.5px solid currentColor; box-sizing: border-box; }
  .mk-asks { color: var(--r-warn); background: var(--r-warn-tint); } .mk-stopped { color: var(--r-bad); }
  .mk-working { color: var(--r-ok); border-style: dotted; animation: spin 2.4s linear infinite; }
  .mk-yours { color: var(--r-gold); border-width: 0; } .mk-yours::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .mk-ended { color: var(--r-faint); opacity: .7; } .mk-unknown { color: var(--r-faint); border-style: dashed; }
  .card .line { display: grid; grid-template-columns: 14px minmax(0,1fr); gap: 0 7px; align-items: start; font-size: 12px; line-height: 1.4; }
  .card .line .ic { margin-top: 2px; color: var(--r-faint); width: 14px; height: 14px; }
  .card .you span { color: var(--r-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .said span { color: var(--r-text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .card .live span { color: var(--r-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-ended .ttl, .st-unknown .ttl { font-weight: 500; color: var(--r-text-2); } .st-ended .said span { color: var(--r-caption); }
  .card .ask { margin-left: 21px; padding: 5px 8px; border-radius: 6px; background: var(--r-warn-tint); color: var(--r-text); font-size: 12px; line-height: 1.4; }
  .card .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-left: 21px; margin-top: 1px; }
  .chip { display: inline-flex; align-items: center; gap: 3px; max-width: 150px; padding: 1px 6px 1px 4px; border-radius: 9px; background: var(--r-well); color: var(--r-caption); font-family: var(--vscode-editor-font-family); font-size: 10.5px; }
  .chip .trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip.pr-ok { color: var(--r-ok); background: var(--r-ok-tint); } .chip.pr-bad { color: var(--r-bad); background: var(--r-bad-tint); } .chip.pr-run { color: var(--r-warn); background: var(--r-warn-tint); }
  .card .thumbs { display: flex; gap: 4px; margin-left: 21px; }
  .th { position: relative; width: 64px; height: 44px; border-radius: 5px; overflow: hidden; border: 1px solid var(--r-edge); display: block; flex: none; }
  .th img { width: 100%; height: 100%; object-fit: cover; display: block; } .th:hover { border-color: var(--r-gold); }
  .th b { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.45); color: #fff; font-size: 11px; }
  details.bare summary { font-size: 11px; color: var(--r-caption); padding: 8px 4px; }
  @media (prefers-reduced-motion: reduce) { .m-working, .mk-working, .ring .arc { animation: none; } }
</style>
</head>
<body>
<div class="tabs" role="tablist" aria-label="Project">
  <button class="tab" role="tab" data-tab="overview" aria-selected="false" title="Overview"><svg class="ti" viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg><span class="lbl">Overview</span></button>
  <button class="tab" role="tab" data-tab="sessions" aria-selected="true" title="Sessions"><svg class="ti" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/></svg><span class="lbl">Sessions <span class="cnt" data-cnt="sessions"></span></span><span class="dot" data-asks title="Sessions that need you"></span></button>
  <button class="tab" role="tab" data-tab="prs" aria-selected="false" title="Pull requests"><svg class="ti" viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V7a2 2 0 0 0-2-2H7"/></svg><span class="lbl">Pull requests</span></button>
  <button class="tab" role="tab" data-tab="tickets" aria-selected="false" title="Tickets"><svg class="ti" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg><span class="lbl">Tickets</span></button>
</div>
<main role="tabpanel"><div class="empty">Loading…</div></main>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const main = document.querySelector('main');
  const tabs = [...document.querySelectorAll('.tab')];
  const scroll = {};
  let current = 'sessions';
  function select(tab) {
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  }
  function choose(tab) {
    if (tab === current) return;
    scroll[current] = main.scrollTop;
    current = tab;
    select(tab);
    vscode.postMessage({ type: 'tab', tab });
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'tab') { current = m.tab; select(m.tab); }
    else if (m.type === 'count') {
      const c = document.querySelector('[data-cnt="sessions"]'); if (c) c.textContent = m.n ? String(m.n) : '';
      const d = document.querySelector('[data-asks]'); if (d) d.textContent = m.asks ? String(m.asks) : '';
    }
    else if (m.type === 'html' && m.tab === current) {
      // A redraw of the same tab keeps what the viewer opened and where they scrolled.
      const same = main.dataset.tab === m.tab;
      const open = new Set(same ? [...main.querySelectorAll('details')].filter((d) => d.open).map((d, i) => d.querySelector('summary')?.textContent || i) : []);
      const y = same ? main.scrollTop : (scroll[m.tab] || 0);
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.session : null;
      main.innerHTML = m.html;
      main.dataset.tab = m.tab;
      if (same) main.querySelectorAll('details').forEach((d, i) => { const k = d.querySelector('summary')?.textContent || i; if (open.has(k)) d.open = true; });
      main.scrollTop = y;
      if (focused) { const el = main.querySelector('[data-session="' + CSS.escape(focused) + '"]'); if (el) el.focus(); }
      document.body.classList.remove('loading');
    }
    else if (m.type === 'loading') document.body.classList.add('loading');
  });
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) { choose(tab.dataset.tab); return; }
    const th = e.target.closest('.th');
    if (th) { e.preventDefault(); vscode.postMessage({ type: 'image', path: th.dataset.path }); return; }
    const card = e.target.closest('[data-session]');
    if (card) { vscode.postMessage({ type: 'session', sessionId: card.dataset.session, host: card.dataset.host }); return; }
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.url) vscode.postMessage({ type: 'open', url: a.dataset.url });
    else if (a.hasAttribute('data-pick')) vscode.postMessage({ type: 'pick' });
  });
  document.addEventListener('keydown', (e) => {
    const tab = e.target.closest && e.target.closest('.tab');
    if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus(); choose(next.dataset.tab); return;
    }
    const card = e.target.closest && e.target.closest('[data-session]');
    if (card && e.key === 'Enter') card.click();
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
