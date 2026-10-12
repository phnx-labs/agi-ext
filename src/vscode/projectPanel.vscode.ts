import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runAgentsArgs } from '../core/agentsBin';
import { LINEAR_NOT_FOUND_MESSAGE, resolveLinearBin } from '../core/linearBin';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import { coalesceTrailing, createTrailingCoalesce } from '../core/cachedInFlight';
import { requestImageThumbs, sessionCardFields } from '../core/sessionCardFields';
import { resolveTabIndex, type TabView } from '../core/tabIndex';
import { normalizeHost } from '../shared/project';
import type { RemoteSession } from '../core/remoteSessions';
import { sessionStreamDemand } from '../monitor/sessionDemand';
import {
  escapeHtml,
  preferLive,
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
  readSessionPrefs,
  sessionCount,
  sessionMade,
  type ProjectRef,
  type SessionHere,
  type SessionLike,
  type SessionListPrefs,
  type TicketGroup,
} from '../core/projectPanel';
import { sessionStateOf } from '../shared/sessionState';
import { currentAgentPanelSubject, setAgentPanelSubjectFromProject } from './agentPanel.vscode';
import { LOCAL_LABEL, LOCAL_MACHINE_ID, remoteDeviceArg } from './remoteSessions.vscode';
import * as terminals from './terminals.vscode';
import { openListedArtifact } from './sessionCardActions';
import { openExternalUrl } from './webviewSecurity';
import { commentArgv, parseTicketDetail, renderTicketDetail, ticketPrompt, type TicketDetail } from '../core/ticketDetail';
import { applyPanelSetting, PICKABLE_AGENTS, renderPanelSettings } from '../core/panelSettings';
import { BUILT_IN_AGENTS } from '../core/agents';
import { getSettings, maybeUpdateTerminalTitles, saveSettings } from './agentSettings.vscode';
import { buildIconPathFromUri } from './theme.vscode';

const execFileAsync = promisify(execFile);

// The Project sidebar panel (PHNX-4289): one view with icon tabs (Overview,
// Sessions, Pull requests, Tickets, Settings) for one project, while the other
// sidebar keeps the focused session. Only the active tab loads. Overview, Pull
// requests and Tickets each read their one CLI verb when shown (at most once per
// FRESH_MS) or on Refresh; a ticket's detail is one `linear tasks <ID>` read on the
// click that opens it. Sessions draws the stream rows already in the presentation
// store and demands the stream only while it is the visible tab. Settings reads
// agentSettings and nothing else. No timer anywhere.

const PICKED_PROJECT_KEY = 'agents.projectPanel.project';
const TAB_KEY = 'agents.projectPanel.tab';
const SESSION_PREFS_KEY = 'agents.projectPanel.sessionPrefs';
const FRESH_MS = 60_000;

type TabId = 'overview' | 'sessions' | 'prs' | 'tickets' | 'settings';
const TABS: readonly TabId[] = ['overview', 'sessions', 'prs', 'tickets', 'settings'];
const DEFAULT_AGENT_KEY = 'agents.defaultAgentTitle';
const SECONDARY_AGENT_KEY = 'agents.secondaryAgentTitle';
const VIEW_ID = 'agentsProject.panel';
/** Where pasted images live on this machine: the only files the panel shows or opens. */
const IMAGE_DIRS = () => [path.join(os.homedir(), '.agents', '.history', 'attachments'), path.join(os.homedir(), '.agents', '.cache', 'attachments')];

interface SessionTarget { sessionId: string; host: string }
interface PanelMessage {
  type?: string; tab?: unknown; url?: unknown; sessionId?: unknown; host?: unknown; path?: unknown;
  targets?: SessionTarget[]; key?: unknown; value?: unknown; group?: unknown; id?: unknown; text?: unknown;
}

interface TabState {
  html: string | undefined;
  loadedFor: string | undefined;
  loadedAt: number;
  generation: number;
}

class ProjectView implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | undefined;
  private active: TabId;
  /** The ticket whose detail the Tickets tab shows, or null for the list. */
  private ticket: string | null = null;
  private readonly tabs = new Map<TabId, TabState>(TABS.map((t) => [t, { html: undefined, loadedFor: undefined, loadedAt: 0, generation: 0 }]));

  constructor(private readonly controller: ProjectPanelController, private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<string>(TAB_KEY);
    this.active = (TABS as readonly string[]).includes(saved ?? '') ? saved as TabId : 'sessions';
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // The editor's app icons ship in assets/; artifact images the agent made live
    // under home, as in the session sidebar.
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'assets'), vscode.Uri.file(os.homedir()), ...IMAGE_DIRS().map((d) => vscode.Uri.file(d))] };
    view.webview.html = shell(view.webview.cspSource, harnessLogoCss(view.webview, this.context.extensionUri));
    view.webview.onDidReceiveMessage((msg: PanelMessage) => {
      const host = typeof msg.host === 'string' ? msg.host : undefined;
      const targets = Array.isArray(msg.targets) ? msg.targets.filter((x): x is SessionTarget => !!x && typeof x.sessionId === 'string' && typeof x.host === 'string') : [];
      if (msg.type === 'ready') this.onReady();
      else if (msg.type === 'tab' && typeof msg.tab === 'string' && (TABS as readonly string[]).includes(msg.tab)) void this.show(msg.tab as TabId);
      else if (msg.type === 'open') openExternalUrl(msg.url);
      else if (msg.type === 'pick') void vscode.commands.executeCommand('agents.project.pick');
      else if (msg.type === 'image' && typeof msg.path === 'string') void this.controller.openImage(msg.path);
      else if (msg.type === 'select' && typeof msg.sessionId === 'string') this.controller.select(msg.sessionId, host);
      else if ((msg.type === 'focus' || msg.type === 'resume') && typeof msg.sessionId === 'string') void this.controller.goToSession(msg.sessionId, host);
      else if (msg.type === 'artifact' && typeof msg.sessionId === 'string' && typeof msg.path === 'string') void this.controller.openArtifact(msg.sessionId, host, msg.path);
      else if (msg.type === 'close') void this.controller.closeSessions(targets);
      else if (msg.type === 'reopen') void this.controller.reopen(targets);
      else if (msg.type === 'hide') void this.controller.hide(targets, true);
      else if (msg.type === 'unhide') void this.controller.hide(targets, false);
      else if (msg.type === 'closeAll') void this.controller.closeLeftoverTabs();
      else if (msg.type === 'prefs' && typeof msg.key === 'string') void this.controller.setPref(msg.key, msg.value);
      else if (msg.type === 'fold' && typeof msg.group === 'string') void this.controller.toggleFold(msg.group);
      else if (msg.type === 'ticket' && typeof msg.id === 'string') void this.openTicket(msg.id);
      else if (msg.type === 'ticketList') void this.openTicket(null);
      else if (msg.type === 'comment' && typeof msg.id === 'string' && typeof msg.text === 'string') void this.comment(msg.id, msg.text);
      else if (msg.type === 'startTicket' && typeof msg.id === 'string') void this.controller.startOnTicket(msg.id);
      else if (msg.type === 'setting' && typeof msg.key === 'string') {
        // Redraw either way, so a write that failed shows the stored value again.
        void this.controller.setSetting(msg.key, msg.value)
          .catch((e) => { void vscode.window.showErrorMessage(`Could not save the setting: ${errorText(e)}`); })
          .finally(() => this.load('settings', true));
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
    if (force) { state.loadedAt = 0; state.generation++; }
    const view = this.view;
    if (!view || !view.visible || tab !== this.active) return;
    if (tab === 'settings') { this.post(tab, this.controller.settings()); return; }
    // An open ticket rereads only on Refresh; showing the tab again keeps what is drawn.
    if (tab === 'tickets' && this.ticket && !force) return;
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
      html = tab === 'tickets' && this.ticket ? await this.controller.ticketDetail(this.ticket) : await this.controller.render(tab, project, force);
    } catch (e) {
      ok = false;
      html = `<div class="err">${escapeHtml(errorText(e))}</div>`;
      // A failed ticket read still offers the way back to the list.
      if (tab === 'tickets' && this.ticket) html = `<button class="back" data-back>‹ Tickets</button>${html}`;
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

  /** A ticket row click opens its detail (one read); the back control returns to the list. */
  async openTicket(id: string | null): Promise<void> {
    this.ticket = id;
    const state = this.tabs.get('tickets')!;
    if (id) this.post('tickets', '<div class="empty">Loading…</div>');
    else state.loadedAt = 0;
    await this.load('tickets', !!id);
  }

  private commenting = false;

  private async comment(id: string, text: string): Promise<void> {
    // One `linear update` at a time: a second click must not post the comment twice.
    if (!text.trim() || this.ticket !== id || this.commenting) return;
    this.commenting = true;
    void this.view?.webview.postMessage({ type: 'loading' });
    try {
      await this.controller.comment(id, text);
    } catch (e) {
      void this.view?.webview.postMessage({ type: 'idle' });
      void vscode.window.showErrorMessage(`Could not comment on ${id}: ${errorText(e)}`);
      return;
    } finally {
      this.commenting = false;
    }
    await this.load('tickets', true);
  }

  notice(text: string): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage({ type: 'notice', text });
  }

  /** Refresh rereads what is shown; a new project starts on the ticket list. */
  refresh(projectChanged = false): void {
    if (projectChanged) this.ticket = null;
    for (const t of TABS) { this.tabs.get(t)!.html = undefined; void this.load(t, true); }
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
  /** The detail last drawn, so Start names the ticket the user is looking at. */
  private shownTicket: TicketDetail | undefined;
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

  async render(id: Exclude<TabId, 'sessions' | 'settings'>, p: ProjectRef, force: boolean): Promise<string> {
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

  private linear(): string {
    const bin = resolveLinearBin();
    if (!bin) throw new Error(LINEAR_NOT_FOUND_MESSAGE);
    return bin;
  }

  async ticketDetail(id: string): Promise<string> {
    const { stdout } = await execFileAsync(this.linear(), ['tasks', id, '--json'], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
    const t = parseTicketDetail(stdout);
    this.shownTicket = t;
    return renderTicketDetail(t, this.defaultAgent().name);
  }

  async comment(id: string, text: string): Promise<void> {
    await execFileAsync(this.linear(), commentArgv(id, text), { timeout: 60_000 });
  }

  private defaultAgent(): (typeof PICKABLE_AGENTS)[number] {
    const title = this.context.globalState.get<string>(DEFAULT_AGENT_KEY, PICKABLE_AGENTS[0].title);
    const agent = PICKABLE_AGENTS.find((a) => a.title === title);
    if (!agent) throw new Error(`The default agent "${title}" is not one this version can launch. Pick one in Settings.`);
    return agent;
  }

  /** Start on a ticket: the default agent in a new tab here, through the same
   *  launch path as Agents: Spawn With Prompt. */
  async startOnTicket(id: string): Promise<void> {
    const t = this.shownTicket;
    if (!t || t.identifier !== id) return;
    try {
      await vscode.commands.executeCommand('agents.spawnWithPrompt', { agent: this.defaultAgent().key, prompt: ticketPrompt(t) });
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not start an agent on ${id}: ${errorText(e)}`);
    }
  }

  settings(): string {
    return renderPanelSettings({
      settings: getSettings(this.context),
      defaultAgentTitle: this.context.globalState.get<string>(DEFAULT_AGENT_KEY, PICKABLE_AGENTS[0].title),
      secondaryAgentTitle: this.context.globalState.get<string>(SECONDARY_AGENT_KEY, PICKABLE_AGENTS[1].title),
      modifier: process.platform === 'darwin' ? '⌘⇧' : 'Ctrl+Shift+',
    });
  }

  /** One Settings-tab change, written where that setting already lives. */
  async setSetting(key: string, value: unknown): Promise<void> {
    if (key === 'defaultAgent' || key === 'secondaryAgent') {
      if (!PICKABLE_AGENTS.some((a) => a.title === value)) return;
      await vscode.commands.executeCommand(key === 'defaultAgent' ? 'agents.setDefaultAgentTitle' : 'agents.setSecondaryAgentTitle', value);
      return;
    }
    // The Reader commands also sync the editor association and its context keys.
    if (key === 'editor.markdownViewerEnabled' && typeof value === 'boolean') {
      await vscode.commands.executeCommand(value ? 'agents.enableReader' : 'agents.disableReader');
      return;
    }
    const previous = getSettings(this.context);
    const next = applyPanelSetting(previous, key, value);
    if (!next) return;
    await saveSettings(this.context, next);
    if (key.startsWith('display.')) await maybeUpdateTerminalTitles(previous, next);
  }

  private presented(): RemoteSession[] {
    return sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL);
  }

  private prefs(): SessionListPrefs {
    return readSessionPrefs(this.context.workspaceState.get(SESSION_PREFS_KEY));
  }

  private async savePrefs(prefs: SessionListPrefs): Promise<void> {
    await this.context.workspaceState.update(SESSION_PREFS_KEY, prefs);
    void this.view.redrawSessions();
  }

  async setPref(key: string, value: unknown): Promise<void> {
    await this.savePrefs(readSessionPrefs({ ...this.prefs(), [key]: value === 'true' ? true : value === 'false' ? false : value }));
  }

  async toggleFold(group: string): Promise<void> {
    const prefs = this.prefs();
    const folded = prefs.folded.includes(group) ? prefs.folded.filter((g) => g !== group) : [...prefs.folded, group];
    await this.savePrefs({ ...prefs, folded });
  }

  /** Hide a session until it moves again, or bring it back. */
  async hide(targets: SessionTarget[], on: boolean): Promise<void> {
    const prefs = this.prefs();
    const hidden = { ...prefs.hidden };
    const rows = new Map(this.presented().map((r) => [r.sessionId, r]));
    for (const { sessionId } of targets) {
      if (on) hidden[sessionId] = rows.get(sessionId)?.lastActivityMs ?? Date.now();
      else delete hidden[sessionId];
    }
    // Ids that left the stream are forgotten so the store does not grow forever.
    for (const id of Object.keys(hidden)) if (!rows.has(id)) delete hidden[id];
    await this.savePrefs({ ...prefs, hidden });
  }

  /** × on a card: close every tab in this window bound to the session. Closing a
   *  tab ends the agent's process there; the session stays resumable (Undo). */
  async closeSessions(targets: SessionTarget[]): Promise<void> {
    for (const { sessionId } of targets) {
      const { live, dead } = await terminals.sessionTabs(sessionId);
      terminals.closeTabs([...(live ? [live] : []), ...dead]);
    }
    void this.view.redrawSessions();
  }

  async reopen(targets: SessionTarget[]): Promise<void> {
    for (const t of targets) await this.goToSession(t.sessionId, t.host);
  }

  /** "Close all" on Tabs with no agent: the shells whose agent already exited. */
  async closeLeftoverTabs(): Promise<void> {
    const project = await this.project();
    if (!project) return;
    let closed = 0;
    // Only sessions the CLI says ended: a live agent whose process probe missed keeps its tab.
    for (const r of projectSessions(preferLive(this.presented()) as unknown as SessionLike[], project.name)) {
      if (sessionStateOf(r) !== 'ended') continue;
      const { live, dead } = await terminals.sessionTabs(r.sessionId);
      if (!live && dead.length) { terminals.closeTabs(dead); closed += dead.length; }
    }
    void this.view.notice(closed ? `Closed ${closed} tab${closed === 1 ? '' : 's'} whose agent was not running` : 'No tab here was left without its agent');
    void this.view.redrawSessions();
  }

  async openArtifact(sessionId: string, host: string | undefined, filePath: string): Promise<void> {
    await openListedArtifact(sessionId, host, filePath, this.presented());
  }

  private here(webview: vscode.Webview): SessionHere {
    const app = vscode.env.appName;
    const editor: SessionHere['editor'] = /codium/i.test(app) ? 'vscodium' : /cursor/i.test(app) ? 'cursor' : 'vscode';
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', ...p)).toString();
    return {
      device: normalizeHost(os.hostname()),
      localHost: LOCAL_LABEL,
      workspace: (vscode.workspace.name ?? 'this window').replace(/ \(Workspace\)$/, ''),
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => path.basename(f.uri.fsPath)),
      editor,
      editorName: editor === 'vscodium' ? 'VSCodium' : editor === 'cursor' ? 'Cursor' : 'VS Code',
      icons: { vscodium: asset('apps', 'vscodium.png'), vscode: asset('apps', 'vscode.png'), cursor: asset('cursor.png'), ghostty: asset('apps', 'ghostty.png') },
    };
  }

  sessions(p: ProjectRef, webview: vscode.Webview): { html: string; count: { shown: number; asks: number } } {
    if (!sessionPresentationStore.hasSeenReset()) return { html: '<div class="empty">Waiting for the session stream…</div>', count: { shown: 0, asks: 0 } };
    const tabGroups: TabView[][] = vscode.window.tabGroups.all.map((g) => g.tabs.map((tab) => ({ label: tab.label, isTerminal: tab.input instanceof vscode.TabInputTerminal })));
    const rows = projectSessions(preferLive(this.presented()) as unknown as SessionLike[], p.name)
      .map((r) => {
        const tab = terminals.getBySessionId(r.sessionId);
        return { ...r, tabHere: !!tab, tabIndex: tab ? resolveTabIndex(tabGroups, tab.terminal.name) : undefined };
      });
    const byId = new Map(this.presented().map((r) => [r.sessionId, r]));
    const previewUri = (f: string) => webview.asWebviewUri(vscode.Uri.file(f)).toString();
    const thumbsFor = (s: SessionLike) => {
      const live = byId.get(s.sessionId);
      return live ? requestImageThumbs(live, { home: os.homedir(), remoteDevice: remoteDeviceArg(live.host), exists: (f) => fs.existsSync(f), previewUri }) : [];
    };
    const madeFor = (s: SessionLike) => {
      const live = byId.get(s.sessionId);
      if (!live) return null;
      const remoteDevice = remoteDeviceArg(live.host);
      return sessionMade(sessionCardFields(live, { sessionId: live.sessionId, home: os.homedir(), remoteDevice, previewUri: remoteDevice ? undefined : previewUri }));
    };
    const here = this.here(webview);
    const prefs = this.prefs();
    const subject = currentAgentPanelSubject();
    const count = sessionCount(rows, here, prefs);
    return { html: renderSessions(rows, Date.now(), { selectedId: subject?.sessionId ?? null, here, prefs, thumbsFor, madeFor }), count: { shown: count.shown, asks: count.asks } };
  }

  /** A card click selects the session: the other sidebar shows it. Nothing opens. */
  select(sessionId: string, host: string | undefined): void {
    setAgentPanelSubjectFromProject(sessionId, host);
    void this.view.redrawSessions();
  }

  /** The focus and resume icons: its tab comes to the front, else the live agent
   *  opens in the window that owns its project (resumeAndNotify, the one path). */
  async goToSession(sessionId: string, host: string | undefined): Promise<void> {
    const row = preferLive(this.presented().filter((r) => r.sessionId === sessionId))[0];
    const { resumeAndNotify } = await import('./resumeSession.vscode');
    await resumeAndNotify({ sessionId, host: row?.host ?? host ?? '', title: row?.title || row?.label || row?.topic || '' });
  }

  async openImage(filePath: string): Promise<void> {
    // Only a file a card offered: a pasted image in this machine's stores.
    let real: string;
    try { real = await fs.promises.realpath(path.resolve(filePath)); } catch { return; }
    if (!IMAGE_DIRS().some((dir) => real.startsWith(dir + path.sep))) return;
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(real), { preview: true });
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
    this.refresh(true);
  }

  refresh(projectChanged = false): void {
    this.tickets = undefined;
    this.detected = undefined;
    this.view.refresh(projectChanged);
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

/** One class per harness (`.hx-claude`), each drawing that harness's logo from
 *  assets/, with the light variant on a light editor theme. */
function harnessLogoCss(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return BUILT_IN_AGENTS.filter((a) => a.key !== 'shell').map((a) => {
    const { dark, light } = buildIconPathFromUri(extensionUri, a.icon);
    return `.hx-${a.key} { background-image: url("${webview.asWebviewUri(dark)}"); } body.vscode-light .hx-${a.key} { background-image: url("${webview.asWebviewUri(light)}"); }`;
  }).join('\n  ');
}

/** The panel's webview document; exported for the script syntax test. */
export function shell(cspSource: string, logoCss = ''): string {
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
  /* Sessions: outlined cards, compact until hovered or selected (AGENTS.md Design). */
  .shead { display: flex; align-items: center; gap: 8px; margin: 8px 2px 4px; position: relative; }
  .shead .sum { margin-left: auto; font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .icon { width: 24px; height: 22px; display: grid; place-items: center; border-radius: 5px; border: 1px solid transparent; background: none; color: var(--r-caption); cursor: pointer; padding: 0; flex: none; }
  .icon:hover, .icon[aria-expanded="true"] { background: var(--r-hover); border-color: var(--r-edge); color: var(--r-text); }
  .icon .ic { width: 14px; height: 14px; }
  .menu { position: absolute; right: 0; top: 26px; z-index: 5; min-width: 176px; padding: 5px; border-radius: 9px; border: 1px solid var(--r-edge); background: var(--vscode-menu-background, var(--vscode-sideBar-background)); box-shadow: 0 10px 28px rgba(0,0,0,.28); }
  .menu .sec { font-size: 11px; color: var(--r-faint); padding: 6px 8px 2px; }
  .menu button { display: flex; gap: 8px; align-items: center; width: 100%; border: 0; background: none; color: var(--r-text); font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 5px; cursor: pointer; text-align: left; }
  .menu button:hover { background: var(--r-hover); }
  .menu .ck { width: 12px; } .menu .mi { width: 13px; height: 13px; fill: none; stroke: var(--r-caption); stroke-width: 1.4; }
  .menu hr { border: 0; border-top: 1px solid var(--r-edge); margin: 4px 2px; }
  .pinned { margin: 6px 0 10px; padding: 2px 5px 6px; border-radius: 9px; background: var(--r-warn-tint); }
  .pinned .ph { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--r-warn); padding: 5px 4px 4px; }
  .grp { margin-top: 8px; }
  .gh { display: flex; align-items: center; gap: 7px; padding: 4px; border-radius: 6px; cursor: pointer; user-select: none; }
  .gh:hover { background: var(--r-hover); }
  .gh .car { width: 10px; color: var(--r-faint); font-size: 10px; transition: transform .15s; } .grp.closed .car { transform: rotate(-90deg); }
  .gi-box { width: 20px; height: 20px; display: grid; place-items: center; flex: none; }
  .appic { width: 20px; height: 20px; display: block; }
  .gi { width: 14px; height: 14px; fill: none; stroke: var(--r-caption); stroke-width: 1.4; }
  .gname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; } .gname b { font-weight: 600; } .gs { color: var(--r-faint); font-size: 11px; }
  .dots { margin-left: auto; display: flex; gap: 3px; } .dots i { width: 6px; height: 6px; border-radius: 50%; display: block; }
  .gact { margin-left: auto; font: inherit; font-size: 10.5px; border: 1px solid var(--r-edge); background: none; color: var(--r-caption); border-radius: 5px; padding: 0 7px; cursor: pointer; }
  .gact:hover { color: var(--r-text); border-color: var(--r-faint); } .gact + .dots { margin-left: 6px; }
  .items, .flat { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; margin-top: 4px; } .pinned .card + .card { margin-top: 6px; }
  .card { display: block; min-width: 0; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--r-edge); background: var(--r-glass); color: inherit; cursor: pointer; transition: background .12s, border-color .12s; }
  .card:hover, .card.sel, .card:focus-visible { background: var(--r-hover); border-color: var(--r-faint); outline: none; }
  .card.multi { border-color: var(--r-gold); }
  .card .top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .card .ttl { flex: 1; min-width: 0; font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .age { font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); flex: none; }
  .acts { display: none; gap: 2px; flex: none; }
  .card:hover .acts, .card.sel .acts, .card:focus-within .acts { display: flex; } .card:hover .age, .card.sel .age, .card:focus-within .age { display: none; }
  .act { width: 22px; height: 20px; display: grid; place-items: center; border: 1px solid transparent; background: none; border-radius: 5px; color: var(--r-caption); cursor: pointer; padding: 0; }
  .act:hover { background: var(--r-hover); border-color: var(--r-edge); color: var(--r-text); } .act.x:hover { color: var(--r-bad); }
  .act .ic { width: 13px; height: 13px; stroke-width: 1.6; }
  .meta { display: flex; gap: 6px; align-items: center; margin-top: 4px; min-width: 0; font-size: 10.5px; color: var(--r-faint); }
  .meta .where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
  .pill { display: inline-flex; align-items: center; gap: 4px; flex: none; border: 1px solid var(--r-edge); border-radius: 999px; padding: 0 7px 0 6px; font-size: 10.5px; line-height: 16px; color: var(--r-text-2); }
  .pill i, .dots i { background: var(--r-faint); } .pill i { width: 6px; height: 6px; border-radius: 50%; display: block; }
  .pill.solo { padding: 0 4px; border: 0; }
  .st-asks.pill { color: var(--r-warn); border-color: var(--r-warn); } .pill.st-asks i, .d-asks { background: var(--r-warn) !important; }
  .st-working.pill { color: var(--r-ok); } .pill.st-working i, .d-working { background: var(--r-ok) !important; } .st-working.pill i { animation: breathe 1.6s ease-in-out infinite; }
  .pill.st-yours i, .d-yours { background: var(--r-gold) !important; }
  .st-ended.pill { opacity: .8; }
  @keyframes breathe { 50% { opacity: .25; } }
  .compact { display: grid; gap: 4px; margin-top: 4px; }
  .cline { color: var(--r-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
  .st-asks .cline { color: var(--r-text); }
  .cstrip { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  .tiny { height: 20px; width: 28px; object-fit: cover; border-radius: 3px; border: 1px solid var(--r-edge); display: block; } .tiny.in { outline: 1.5px dashed var(--r-faint); outline-offset: 1px; }
  .full { display: none; }
  .card:hover .full, .card.sel .full, .card:focus-within .full { display: block; } .card:hover .compact, .card.sel .compact, .card:focus-within .compact { display: none; }
  .lab { font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--r-faint); margin: 7px 0 2px; }
  .card .line { color: var(--r-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .card .line.said { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .card .line.live { color: var(--r-caption); margin-top: 3px; } .card .line .cmd { font-family: var(--vscode-editor-font-family); font-size: 11px; } .card .line .tool { font-weight: 600; font-size: 11px; }
  .card .ask { padding: 6px 8px; border-radius: 6px; background: var(--r-warn-tint); color: var(--r-text); font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .made { display: grid; gap: 5px; padding: 6px; border-radius: 7px; border: 1px solid var(--r-edge); background: var(--r-well); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { display: inline-flex; align-items: center; gap: 3px; max-width: 170px; padding: 1px 6px 1px 4px; border-radius: 5px; border: 1px solid var(--r-edge); color: var(--r-caption); font-family: var(--vscode-editor-font-family); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip.pr-ok { color: var(--r-ok); } .chip.pr-bad { color: var(--r-bad); } .chip.pr-run { color: var(--r-warn); }
  .folder { display: flex; gap: 6px; align-items: flex-start; min-width: 0; color: var(--r-text-2); font-size: 11.5px; } .folder .ic { margin-top: 2px; color: var(--r-faint); }
  .folder .fx { min-width: 0; display: grid; } .folder .fx span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .folder .fp { font-size: 10.5px; color: var(--r-faint); }
  .folder:hover b { text-decoration: underline; }
  .thumbs { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-top: 3px; }
  .th { position: relative; height: 40px; border-radius: 4px; overflow: hidden; border: 1px solid var(--r-edge); display: block; flex: none; }
  .th { width: 64px; } .th img { width: 100%; height: 100%; object-fit: cover; display: block; } .th:hover { border-color: var(--r-gold); }
  .th i { position: absolute; left: 3px; bottom: 3px; font-style: normal; font-size: 9px; background: rgba(0,0,0,.62); color: #fff; border-radius: 3px; padding: 0 3px; }
  .th b { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.45); color: #fff; font-size: 11px; }
  .more { font-size: 10.5px; border: 1px solid var(--r-edge); border-radius: 5px; padding: 0 6px; color: var(--r-caption); }
  .confirm { margin-top: 8px; padding: 8px; border-radius: 7px; background: var(--r-warn-tint); color: var(--r-text-2); font-size: 11.5px; display: grid; gap: 6px; cursor: default; }
  .confirm .cb { display: flex; gap: 6px; } .confirm button, .bulk button, .toast button { font: inherit; font-size: 11px; border: 1px solid var(--r-edge); background: none; color: var(--r-text); border-radius: 5px; padding: 2px 9px; cursor: pointer; }
  .confirm .danger { color: var(--r-warn); border-color: var(--r-warn); }
  .bulk, .toast { position: sticky; bottom: 6px; display: flex; gap: 8px; align-items: center; margin-top: 8px; padding: 6px 8px; border-radius: 9px; font-size: 11.5px; }
  .bulk { background: var(--vscode-menu-background, var(--vscode-sideBar-background)); border: 1px solid var(--r-faint); box-shadow: 0 8px 22px rgba(0,0,0,.3); }
  .bulk span, .toast span { flex: 1; } .toast { background: var(--r-text); color: var(--vscode-sideBar-background); } .toast button { color: inherit; border-color: transparent; font-weight: 700; text-decoration: underline; }
  .bulk[hidden], .toast[hidden], .menu[hidden] { display: none; }
  .reveal { position: fixed; z-index: 20; pointer-events: none; border-radius: 8px; border: 1px solid var(--r-faint); background: var(--vscode-sideBar-background); padding: 3px; display: none; }
  .reveal img { display: block; max-width: 260px; max-height: 180px; border-radius: 5px; } .reveal span { display: block; font-size: 10.5px; color: var(--r-caption); padding: 3px 2px 0; }
  .card .top .hx { display: inline-block; width: 14px; height: 14px; border-radius: 3px; flex: none; background-position: center; background-size: contain; background-repeat: no-repeat; }
  ${logoCss}
  .meta .mdl { margin-left: auto; flex: none; font-family: var(--vscode-editor-font-family); font-size: 10px; color: var(--r-faint); border: 1px solid var(--r-edge); border-radius: 4px; padding: 0 4px; white-space: nowrap; }
  .tab[data-tab="settings"] { margin-left: auto; }
  /* Ticket detail and Settings (PHNX-4329). */
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 5px 9px; cursor: pointer; font: inherit; font-weight: 600; align-self: flex-start; }
  button.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  .tdetail { padding: 6px 2px 14px; }
  .tdetail .back { background: none; border: 0; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 2px 0; font: inherit; }
  .tdetail .th1 { display: flex; gap: 6px; align-items: center; margin-top: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--r-caption); }
  .tdetail .tstate { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--r-edge); border-radius: 999px; padding: 0 7px 0 6px; }
  .tdetail .tstate i { width: 6px; height: 6px; border-radius: 50%; background: var(--r-faint); display: block; }
  .tdetail h3 { margin: 6px 0 4px; font-size: 13px; line-height: 1.35; }
  .tdetail .tmeta { color: var(--r-caption); font-size: 11px; margin-bottom: 8px; }
  .tdetail .tmeta a, .tdetail .tbody a, .tdetail .cbody a { color: var(--vscode-textLink-foreground); }
  .tdetail .dispatch { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--r-edge); border-radius: 8px; margin: 8px 0; }
  .tdetail .hint, .tdetail .older, .tdetail .none { color: var(--r-caption); font-size: 11px; }
  .tdetail .tbody, .tdetail .cbody { font-size: 12px; line-height: 1.45; color: var(--r-text-2); overflow-wrap: anywhere; }
  .tdetail .tbody p, .tdetail .cbody p { margin: 4px 0; } .tdetail h4 { margin: 8px 0 2px; font-size: 12px; }
  .tdetail ul { list-style: disc; padding-left: 18px; margin: 4px 0; }
  .tdetail code, .tdetail pre { font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .tdetail pre { white-space: pre-wrap; background: var(--r-well); border-radius: 6px; padding: 6px; }
  .tdetail .cmt { border: 1px solid var(--r-edge); border-radius: 8px; padding: 6px 8px; margin: 6px 0; }
  .tdetail .cby { font-size: 11px; color: var(--r-caption); margin-bottom: 2px; }
  .tdetail .cnew { width: 100%; box-sizing: border-box; border: 1px solid var(--vscode-input-border, var(--r-edge)); border-radius: 4px; padding: 6px; font: inherit; color: var(--vscode-input-foreground, var(--r-text)); background: var(--vscode-input-background); margin: 6px 0; resize: vertical; }
  .settings { padding: 4px 2px 16px; }
  .settings .sh { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--r-faint); margin: 14px 0 4px; }
  .settings .srow { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--r-edge); cursor: pointer; }
  .settings .srow b { display: block; font-weight: 500; } .settings small { display: block; color: var(--r-caption); font-size: 11px; }
  .settings .krow { display: grid; grid-template-columns: 64px minmax(0, 1fr) 96px; align-items: center; gap: 6px; padding: 4px 0; }
  .settings .krow small { display: inline; margin-left: 4px; }
  .settings kbd { font-family: var(--vscode-editor-font-family); font-size: 10.5px; border: 1px solid var(--r-edge); border-radius: 4px; padding: 1px 4px; text-align: center; }
  .settings select { font: inherit; font-size: 11px; color: var(--vscode-dropdown-foreground, var(--r-text)); border: 1px solid var(--vscode-dropdown-border, var(--r-edge)); border-radius: 4px; background: var(--vscode-dropdown-background, var(--r-glass)); padding: 2px; }
  .settings .auto { font-size: 11px; color: var(--r-caption); padding-left: 3px; }
  .settings .foot { color: var(--r-caption); font-size: 11px; margin-top: 14px; }
  @media (prefers-reduced-motion: reduce) { .m-working, .st-working.pill i, .ring .arc { animation: none; } .gh .car { transition: none; } }
</style>
</head>
<body>
<div class="tabs" role="tablist" aria-label="Project">
  <button class="tab" role="tab" data-tab="overview" aria-selected="false" title="Overview"><svg class="ti" viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg><span class="lbl">Overview</span></button>
  <button class="tab" role="tab" data-tab="sessions" aria-selected="true" title="Sessions"><svg class="ti" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/></svg><span class="lbl">Sessions <span class="cnt" data-cnt="sessions"></span></span><span class="dot" data-asks title="Sessions that need you"></span></button>
  <button class="tab" role="tab" data-tab="prs" aria-selected="false" title="Pull requests"><svg class="ti" viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V7a2 2 0 0 0-2-2H7"/></svg><span class="lbl">Pull requests</span></button>
  <button class="tab" role="tab" data-tab="tickets" aria-selected="false" title="Tickets"><svg class="ti" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg><span class="lbl">Tickets</span></button>
  <button class="tab" role="tab" data-tab="settings" aria-selected="false" title="Settings"><svg class="ti" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg><span class="lbl">Settings</span></button>
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
      // A stream tick must not take away an Undo, a pending "close anyway?" or the open menu.
      const keepToast = same ? main.querySelector('.toast:not([hidden])') : null;
      const keepConfirm = same ? [...main.querySelectorAll('.confirm')].map((c) => [c.closest('.card').dataset.session, c]) : [];
      const menuOpen = same && main.querySelector('.menu') && !main.querySelector('.menu').hidden;
      main.innerHTML = m.html;
      if (keepToast) main.querySelector('.toast')?.replaceWith(keepToast);
      for (const [id, box] of keepConfirm) main.querySelector('.card[data-session="' + CSS.escape(id) + '"]')?.appendChild(box);
      if (menuOpen) { main.querySelector('.menu').hidden = false; main.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'true'); }
      main.dataset.tab = m.tab;
      if (same) main.querySelectorAll('details').forEach((d, i) => { const k = d.querySelector('summary')?.textContent || i; if (open.has(k)) d.open = true; });
      main.scrollTop = y;
      if (focused) { const el = main.querySelector('[data-session="' + CSS.escape(focused) + '"]'); if (el) el.focus(); }
      if (m.tab === 'sessions') syncBulk();
      document.body.classList.remove('loading');
    }
    else if (m.type === 'loading') document.body.classList.add('loading');
    else if (m.type === 'idle') { document.body.classList.remove('loading'); main.querySelectorAll('[data-comment]').forEach((b) => { b.disabled = false; }); }
    else if (m.type === 'notice') toast(m.text);
  });
  // Sessions: a click selects; icons focus, resume, close or hide. Closing a tab
  // whose agent is working or waiting asks first; everything else offers Undo.
  const multi = new Set();
  let bulkSure = false;
  let toastTimer = 0;
  let undo = null;
  const target = (card) => ({ sessionId: card.dataset.session, host: card.dataset.host });
  function toast(text, onUndo) {
    const el = main.querySelector('.toast'); if (!el) return;
    el.innerHTML = '<span></span>' + (onUndo ? '<button data-undo>Undo</button>' : '');
    el.firstChild.textContent = text; el.hidden = false; undo = onUndo || null;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; undo = null; }, 6000);
  }
  function syncBulk() {
    main.querySelectorAll('.card').forEach((c) => c.classList.toggle('multi', multi.has(c.dataset.session)));
    const bar = main.querySelector('.bulk'); if (!bar) return;
    if (multi.size < 2) { bar.hidden = true; bulkSure = false; return; }
    const cards = [...multi].map((id) => main.querySelector('.card[data-session="' + CSS.escape(id) + '"]')).filter(Boolean);
    const tabs = cards.filter((c) => c.dataset.tab === '1').length;
    const hide = cards.length - tabs;
    const words = [tabs ? 'Close ' + tabs + ' tab' + (tabs === 1 ? '' : 's') : '', hide ? (tabs ? 'hide ' : 'Hide ') + hide : ''].filter(Boolean).join(', ');
    const busy = cards.filter((c) => c.dataset.tab === '1' && c.dataset.busy === '1').length;
    bar.innerHTML = '<span>' + multi.size + ' selected</span><button data-bulk="close">' + (bulkSure && busy ? busy + ' still running · close anyway' : words) + '</button><button data-bulk="clear">Clear</button>';
    bar.hidden = false;
  }
  function closeCards(cards) {
    const tabs = cards.filter((c) => c.dataset.tab === '1').map(target);
    const hide = cards.filter((c) => c.dataset.tab !== '1').map(target);
    if (tabs.length) vscode.postMessage({ type: 'close', targets: tabs });
    if (hide.length) vscode.postMessage({ type: 'hide', targets: hide });
    multi.clear(); syncBulk();
    const words = [tabs.length ? 'Closed ' + tabs.length + ' tab' + (tabs.length === 1 ? '' : 's') : '', hide.length ? 'hid ' + hide.length : ''].filter(Boolean).join(', ');
    toast(words, () => {
      if (tabs.length) vscode.postMessage({ type: 'reopen', targets: tabs });
      if (hide.length) vscode.postMessage({ type: 'unhide', targets: hide });
    });
  }
  function askClose(card) {
    if (card.querySelector('.confirm')) return;
    const box = document.createElement('div');
    box.className = 'confirm';
    box.innerHTML = '<div></div><div class="cb"><button class="danger" data-confirm="yes">Close tab</button><button data-confirm="no">Keep</button></div>';
    box.firstChild.textContent = 'The agent is ' + (card.classList.contains('st-working') ? 'working' : 'waiting on you') + '. Closing the tab ends its process; the session stays resumable.';
    card.appendChild(box);
  }
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) { choose(tab.dataset.tab); return; }
    const menuBtn = e.target.closest('[data-menu]');
    const menu = main.querySelector('.menu');
    if (menuBtn && menu) { const open = menu.hidden; menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); return; }
    const pref = e.target.closest('[data-pref]');
    if (pref) { vscode.postMessage({ type: 'prefs', key: pref.dataset.pref, value: pref.dataset.value }); return; }
    if (menu && !menu.hidden && !e.target.closest('.menu')) { menu.hidden = true; main.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'false'); }
    if (e.target.closest('[data-undo]')) { const u = undo; undo = null; main.querySelector('.toast').hidden = true; if (u) u(); return; }
    const bulk = e.target.closest('[data-bulk]');
    if (bulk) {
      if (bulk.dataset.bulk === 'clear') { multi.clear(); syncBulk(); return; }
      const cards = [...multi].map((id) => main.querySelector('.card[data-session="' + CSS.escape(id) + '"]')).filter(Boolean);
      const busy = cards.filter((c) => c.dataset.tab === '1' && c.dataset.busy === '1').length;
      if (busy && !bulkSure) { bulkSure = true; syncBulk(); return; }
      bulkSure = false;
      closeCards(cards); return;
    }
    if (e.target.closest('[data-act="close-all"]')) { e.stopPropagation(); vscode.postMessage({ type: 'closeAll' }); return; }
    const gh = e.target.closest('.gh');
    if (gh) { vscode.postMessage({ type: 'fold', group: gh.parentElement.dataset.group }); return; }
    const card = e.target.closest('.card[data-session]');
    const confirm = e.target.closest('[data-confirm]');
    if (confirm && card) { const yes = confirm.dataset.confirm === 'yes'; card.querySelector('.confirm')?.remove(); if (yes) closeCards([card]); return; }
    const act = e.target.closest('[data-act]');
    if (act && card) {
      const kind = act.dataset.act;
      if (kind === 'focus' || kind === 'resume') vscode.postMessage({ type: kind, sessionId: card.dataset.session, host: card.dataset.host });
      else if (kind === 'close') { if (card.dataset.busy === '1') askClose(card); else closeCards([card]); }
      else if (kind === 'hide') closeCards([card]);
      return;
    }
    const th = e.target.closest('.th[data-path]');
    if (th) { e.preventDefault(); vscode.postMessage({ type: 'image', path: th.dataset.path }); return; }
    // Tickets: a row opens its detail here; the detail's controls each post one message.
    const trow = e.target.closest('[data-ticket]');
    const detail = main.querySelector('.tdetail');
    if (trow && trow.classList.contains('trow')) { e.preventDefault(); vscode.postMessage({ type: 'ticket', id: trow.dataset.ticket }); return; }
    if (e.target.closest('[data-back]')) { vscode.postMessage({ type: 'ticketList' }); return; }
    if (detail && e.target.closest('[data-start]')) { vscode.postMessage({ type: 'startTicket', id: detail.dataset.ticket }); return; }
    if (detail && e.target.closest('[data-comment]')) {
      const box = detail.querySelector('.cnew');
      const btn = e.target.closest('[data-comment]');
      if (box && box.value.trim() && !btn.disabled) { btn.disabled = true; vscode.postMessage({ type: 'comment', id: detail.dataset.ticket, text: box.value }); }
      return;
    }
    const art = e.target.closest('[data-artifact]');
    if (art && card) { e.preventDefault(); vscode.postMessage({ type: 'artifact', sessionId: card.dataset.session, host: card.dataset.host, path: art.dataset.artifact }); return; }
    const a = e.target.closest('a');
    if (a && a.dataset.url) { e.preventDefault(); vscode.postMessage({ type: 'open', url: a.dataset.url }); return; }
    if (card) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) { const id = card.dataset.session; if (multi.has(id)) multi.delete(id); else multi.add(id); syncBulk(); return; }
      vscode.postMessage({ type: 'select', sessionId: card.dataset.session, host: card.dataset.host });
      return;
    }
    if (!a) return;
    e.preventDefault();
    if (a.hasAttribute('data-pick')) vscode.postMessage({ type: 'pick' });
  });
  // Settings: each control writes its one key as it changes.
  document.addEventListener('change', (e) => {
    const el = e.target.closest && e.target.closest('[data-setting]');
    if (el) vscode.postMessage({ type: 'setting', key: el.dataset.setting, value: el.type === 'checkbox' ? el.checked : el.value });
  });
  // Hovering a small image floats a larger one, saying whose it is.
  const reveal = document.createElement('div');
  reveal.className = 'reveal'; reveal.innerHTML = '<img alt=""><span></span>';
  document.body.appendChild(reveal);
  document.addEventListener('mouseover', (e) => {
    const img = e.target.closest && e.target.closest('.tiny, .th img');
    if (!img) { reveal.style.display = 'none'; return; }
    reveal.querySelector('img').src = img.src;
    reveal.querySelector('span').textContent = img.classList.contains('in') || img.closest('.th.in') ? 'Attached by you' : 'Made by the agent';
    reveal.style.display = 'block';
  });
  document.addEventListener('mousemove', (e) => {
    if (reveal.style.display !== 'block') return;
    reveal.style.left = Math.min(e.clientX + 12, innerWidth - 272) + 'px';
    reveal.style.top = Math.min(e.clientY + 12, innerHeight - 200) + 'px';
  });
  document.addEventListener('keydown', (e) => {
    const tab = e.target.closest && e.target.closest('.tab');
    if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus(); choose(next.dataset.tab); return;
    }
    if (e.key === 'Escape') { const m = main.querySelector('.menu'); if (m) m.hidden = true; multi.clear(); syncBulk(); return; }
    if (e.target.closest && e.target.closest('a, button')) return;
    const gh = e.target.closest && e.target.closest('.gh');
    if (gh && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); gh.click(); return; }
    const card = e.target.closest && e.target.closest('.card[data-session]');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.click(); }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
