import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runAgentsArgs } from '../core/agentsBin';
import { LINEAR_NOT_FOUND_MESSAGE, resolveLinearBin } from '../core/linearBin';
import { parseGoals, renderGoals } from '../core/goals';
import { mergeNow } from './prMerge.vscode';
import { blockedSessions } from '../core/sessionUpdates';
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
  parsePrs,
  parseProjectDetection,
  parseTickets,
  projectSessions,
  projectFallback,
  projectsInFolder,
  displayHome,
  renderPrs,
  prFixPrompt,
  renderPrsProgress,
  renderSessions,
  renderTickets,
  readSessionPrefs,
  readReviewPrefs,
  waitFor,
  onTicket,
  sessionTitle,
  applyReviewPref,
  sessionCount,
  sessionMade,
  answerArgv,
  answerFailure,
  type ProjectRef,
  type PrsModel,
  type SessionHere,
  type SessionLike,
  type SessionListPrefs,
  type TicketGroup,
} from '../core/projectPanel';
import { SESSION_STATE_WORD, sessionStateOf } from '../shared/sessionState';
import { readRegistry, registrySnapshot } from './projectRegistry.vscode';
import { openSearchPalette, paletteStateWords, type PaletteSession } from './searchPalette.vscode';
import { currentAgentPanelSubject, setAgentPanelSubjectFromProject } from './agentPanel.vscode';
import { LOCAL_LABEL, LOCAL_MACHINE_ID, remoteDeviceArg } from './remoteSessions.vscode';
import * as terminals from './terminals.vscode';
import { openListedArtifact } from './sessionCardActions';
import { openLink, openWebviewUrl } from './webviewSecurity';
import { PATCH_SCRIPT, THUMB_SCRIPT } from '../shared/sessionCards';
import { commentArgv, parseTicketDetail, renderTicketDetail, ticketPrompt, type TicketDetail } from '../core/ticketDetail';
import { applyPanelSetting, deviceSettingArgv, parseSettingsDevices, PICKABLE_AGENTS, renderPanelSettings, type DevicesState } from '../core/panelSettings';
import { cardSettings, validMergeMethod } from '../core/settings';
import { BUILT_IN_AGENTS } from '../core/agents';
import { getSettings, maybeUpdateTerminalTitles, saveSettings } from './agentSettings.vscode';
import { buildIconPathFromUri } from './theme.vscode';
import { rememberTicket, rememberTicketGroups } from '../core/ticketFaces';
import { notifyAgentPanelSessionUpdate } from './agentPanel.vscode';

const execFileAsync = promisify(execFile);

// The Project sidebar panel (PHNX-4289): one view with tabs (Sessions, Issues,
// Review, and a Settings gear) for one project, while the other sidebar keeps the
// focused session. Only the active tab loads. Issues and Review each read their
// one CLI verb when shown (at most once per
// FRESH_MS) or on Refresh; a ticket's detail is one `linear tasks <ID>` read on the
// click that opens it. Sessions draws the stream rows already in the presentation
// store and demands the stream only while it is the visible tab. Settings reads
// agentSettings and nothing else. Above the tabs, the company goal and today's
// goal are one `linear goals --json` read when the panel shows (at most once per
// FRESH_MS) or on Refresh. No timer anywhere.

const PICKED_PROJECT_KEY = 'agents.projectPanel.project';
const TAB_KEY = 'agents.projectPanel.tab';
const SESSION_PREFS_KEY = 'agents.projectPanel.sessionPrefs';
const REVIEW_PREFS_KEY = 'agents.projectPanel.reviewPrefs';
const FRESH_MS = 60_000;

type TabId = 'sessions' | 'tickets' | 'prs' | 'settings';
const TABS: readonly TabId[] = ['sessions', 'tickets', 'prs', 'settings'];
const DEFAULT_AGENT_KEY = 'agents.defaultAgentTitle';
const SECONDARY_AGENT_KEY = 'agents.secondaryAgentTitle';
const VIEW_ID = 'agentsProject.panel';
/** Where pasted images live on this machine: the only files the panel shows or opens. */
const IMAGE_DIRS = () => [path.join(os.homedir(), '.agents', '.history', 'attachments'), path.join(os.homedir(), '.agents', '.cache', 'attachments')];

interface SessionTarget { sessionId: string; host: string }
interface PanelMessage {
  type?: string; tab?: unknown; url?: unknown; sessionId?: unknown; host?: unknown; path?: unknown;
  targets?: SessionTarget[]; key?: unknown; value?: unknown; group?: unknown; id?: unknown; text?: unknown; repo?: unknown; number?: unknown; name?: unknown; focus?: unknown; sha?: unknown; choice?: unknown; field?: unknown; external?: unknown;
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
      else if (msg.type === 'open') openWebviewUrl(msg.url, msg.external === true);
      else if (msg.type === 'pick') void vscode.commands.executeCommand('agents.project.pick');
      else if (msg.type === 'projects') void this.listProjects();
      else if (msg.type === 'ticketTab' && typeof msg.id === 'string') void this.openTicketTab(msg.id);
      else if (msg.type === 'pickProject' && typeof msg.name === 'string') void this.controller.pickByName(msg.name).catch((e) => { void vscode.window.showErrorMessage(`Could not switch project: ${errorText(e)}`); });
      else if (msg.type === 'image' && typeof msg.path === 'string') void this.controller.openImage(msg.path);
      else if (msg.type === 'select' && typeof msg.sessionId === 'string') this.controller.select(msg.sessionId, host, msg.focus === true);
      else if (msg.type === 'openSession' && typeof msg.sessionId === 'string') void this.controller.goToSession(msg.sessionId, host);
      else if (msg.type === 'search') void vscode.commands.executeCommand('agents.searchSessions');
      else if (msg.type === 'copy' && typeof msg.text === 'string') void vscode.env.clipboard.writeText(msg.text);
      else if ((msg.type === 'focus' || msg.type === 'resume') && typeof msg.sessionId === 'string') void this.controller.goToSession(msg.sessionId, host);
      else if (msg.type === 'artifact' && typeof msg.sessionId === 'string' && typeof msg.path === 'string') void this.controller.openArtifact(msg.sessionId, host, msg.path);
      else if (msg.type === 'close') void this.controller.closeSessions(targets);
      else if (msg.type === 'reopen') void this.controller.reopen(targets);
      else if (msg.type === 'hide') void this.controller.hide(targets, true);
      else if (msg.type === 'unhide') void this.controller.hide(targets, false);
      else if (msg.type === 'closeAll') void this.controller.closeLeftoverTabs();
      else if (msg.type === 'prefs' && typeof msg.key === 'string') void this.controller.setPref(msg.key, msg.value);
      else if (msg.type === 'reviewPrefs' && typeof msg.key === 'string' && typeof msg.value === 'string') void this.controller.setReviewPref(msg.key, msg.value).then((html) => { if (html) this.post('prs', html); });
      else if (msg.type === 'fold' && typeof msg.group === 'string') void this.controller.toggleFold(msg.group);
      else if (msg.type === 'ticket' && typeof msg.id === 'string') void this.openTicket(msg.id);
      else if (msg.type === 'ticketList') void this.openTicket(null);
      else if (msg.type === 'comment' && typeof msg.id === 'string' && typeof msg.text === 'string') void this.comment(msg.id, msg.text);
      else if (msg.type === 'startTicket' && typeof msg.id === 'string') void this.controller.startOnTicket(msg.id);
      else if (msg.type === 'fixPr' && typeof msg.repo === 'string' && typeof msg.number === 'number') void this.controller.fixPr(msg.repo, msg.number);
      else if (msg.type === 'answer' && typeof msg.key === 'string' && (typeof msg.choice === 'string' || typeof msg.text === 'string')) void this.answer(msg.key, typeof msg.choice === 'string' ? { choice: msg.choice } : { text: msg.text as string });
      else if (msg.type === 'merge' && typeof msg.repo === 'string' && typeof msg.number === 'number') void this.mergeRow(msg.repo, msg.number, typeof msg.sha === 'string' ? msg.sha : undefined);
      else if (msg.type === 'setting' && typeof msg.key === 'string') {
        // Redraw either way, so a write that failed shows the stored value again.
        void this.controller.setSetting(msg.key, msg.value)
          .catch((e) => { void vscode.window.showErrorMessage(`Could not save the setting: ${errorText(e)}`); })
          .finally(() => this.post('settings', this.controller.settings(this.devices)));
      }
      else if (msg.type === 'device' && typeof msg.name === 'string' && (msg.field === 'enabled' || msg.field === 'preferred') && typeof msg.value === 'boolean') {
        const name = msg.name;
        // Only a device the CLI listed, so no page text can become a flag.
        if (this.devices && 'rows' in this.devices && this.devices.rows.some((d) => d.name === name) && !name.startsWith('-')) void this.setDevice(name, msg.field, msg.value);
      }
    });
    view.onDidChangeVisibility(() => { this.syncDemand(); if (view.visible) { void this.load(this.active, false); void this.loadGoals(false); } });
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
    void this.loadGoals(false);
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

  /** `reveal`: this load answers a ticket click, so its Linear page opens as a tab once the card
   *  is current; Refresh and a re-show never reopen it. */
  async load(tab: TabId, force: boolean, reveal = false): Promise<void> {
    const state = this.tabs.get(tab)!;
    // A forced refresh on a hidden tab still has to reread when it is shown.
    if (force) { state.loadedAt = 0; state.generation++; }
    const view = this.view;
    if (!view || !view.visible || tab !== this.active) return;
    if (tab === 'settings') {
      this.post(tab, this.controller.settings(this.devices));
      void this.loadDevices(force);
      return;
    }
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
    void view.webview.postMessage({ type: 'project', name: project?.name ?? '', picked: this.controller.picked() });
    if (!project) {
      this.post(tab, '<div class="empty">No agents project contains this workspace. <a href="#" data-pick>Pick a project</a></div>');
      return;
    }
    if (tab === 'sessions') {
      // Ticket tiles show titles from the Issues read; Sessions shares it, once per FRESH_MS.
      this.controller.warmTicketFaces(project);
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
    let ticket: TicketDetail | undefined;
    try {
      if (tab === 'tickets' && this.ticket) ({ html, ticket } = await this.controller.ticketDetail(this.ticket));
      else html = tab === 'prs' ? await this.controller.reviewByRepo(project, force, (partial) => { if (gen === state.generation) this.post(tab, partial); })
          : await this.controller.render(tab, project, force);
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
    // Only the current load's ticket becomes the shown one: a slower, superseded read never
    // replaces it (Start and the Linear tab act on what the card shows).
    if (ticket) this.controller.showTicket(ticket);
    this.post(tab, html);
    // A ticket the user just opened shows its Linear page as an editor tab beside the card.
    if (reveal && ticket?.url) void openLink(ticket.url);
  }

  redrawSessions(): Promise<void> {
    return this.load('sessions', false);
  }

  /** Scroll the card for this session into view, once the list has it. */
  reveal(sessionId: string): void {
    if (this.active === 'sessions') void this.view?.webview.postMessage({ type: 'reveal', sessionId });
  }

  /** The project menu: one `agents projects list` read when it opens. */
  private async listProjects(): Promise<void> {
    try {
      const list = await this.controller.projectsHere();
      void this.view?.webview.postMessage({ type: 'projectList', ...list });
    } catch (e) {
      void this.view?.webview.postMessage({ type: 'projectList', error: errorText(e) });
    }
  }

  /** A ticket tile, here or in the session panel, opens the ticket in Issues. */
  async openTicketTab(id: string): Promise<void> {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    // Straight to the ticket: the Issues list is not read first.
    this.ticket = id;
    if (this.active !== 'tickets') {
      this.active = 'tickets';
      void this.context.workspaceState.update(TAB_KEY, 'tickets');
      this.syncDemand();
    }
    void this.view?.webview.postMessage({ type: 'tab', tab: 'tickets' });
    this.post('tickets', '<div class="empty">Loading…</div>');
    await this.load('tickets', true, true);
  }

  /** A ticket row click opens its detail (one read); the back control returns to the list. */
  async openTicket(id: string | null): Promise<void> {
    this.ticket = id;
    const state = this.tabs.get('tickets')!;
    if (id) this.post('tickets', '<div class="empty">Loading…</div>');
    else state.loadedAt = 0;
    await this.load('tickets', !!id, !!id);
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
    void this.loadGoals(true);
  }

  private merging: Promise<void> = Promise.resolve();

  /** Merge from a PR row: one read of that PR (the list has no head commit), a
   *  method or admin merge from the menu, a dialog, then one pinned merge. */
  private async mergeRow(repo: string, number: number, sha: string | undefined): Promise<void> {
    // Merges run one after another, never dropped; Review is reread after each,
    // merged or not, so a row never stays on "Merging…".
    this.merging = this.merging.then(async () => {
      try {
        await this.controller.mergeFromRow(repo, number, sha);
      } catch (e) {
        void vscode.window.showErrorMessage(`Merge failed: ${errorText(e).split('\n').slice(0, 3).join(' ')}`);
      }
      await this.load('prs', true);
    });
    await this.merging;
  }

  /** An answer from a card, after its 5 s Undo: one `agents feed answer`; the card
   *  shows what the CLI said when it was not delivered. */
  private async answer(key: string, answer: { choice: string } | { text: string }): Promise<void> {
    const error = await this.controller.answer(key, answer);
    void this.view?.webview.postMessage({ type: 'answered', key, error });
  }

  private goalsAt = 0;

  /** The two goal lines above the tabs; a failed read says so on one faint line. */
  private async loadGoals(force: boolean): Promise<void> {
    if (!this.view?.visible) return;
    if (!force && Date.now() - this.goalsAt < FRESH_MS) return;
    this.goalsAt = Date.now();
    let html: string;
    const before = this.controller.todayId;
    try {
      html = await this.controller.goals();
    } catch (e) {
      this.goalsAt = 0;
      html = `<div class="gerr" title="${escapeHtml(errorText(e))}">Goals could not be read: ${escapeHtml(errorText(e).split('\n')[0] ?? '')}</div>`;
    }
    void this.view?.webview.postMessage({ type: 'goals', html });
    // Today's ticket marks its sessions with ☀; redraw the list when it changes.
    if (this.controller.todayId !== before && this.active === 'sessions') void this.load('sessions', false);
  }

  private devices: DevicesState = null;
  private devicesAt = 0;
  private devicesGen = 0;

  /** The Devices section's one `agents devices list --json` read: when Settings shows
   *  (at most once a minute), on Refresh, and after a checkbox or star. Never on a timer. */
  private async loadDevices(force: boolean): Promise<void> {
    if (!force && Date.now() - this.devicesAt < FRESH_MS) return;
    this.devicesAt = Date.now();
    const gen = ++this.devicesGen;
    let next: DevicesState;
    try {
      const { stdout } = await runAgentsArgs(['devices', 'list', '--json'], { timeout: 30_000 });
      next = { rows: parseSettingsDevices(stdout) };
    } catch (e) {
      this.devicesAt = 0;
      next = { error: `Devices could not be read: ${errorText(e).split('\n')[0] ?? ''}` };
    }
    if (gen !== this.devicesGen) return;
    this.devices = next;
    if (this.active === 'settings') this.post('settings', this.controller.settings(this.devices));
  }

  private async setDevice(name: string, field: 'enabled' | 'preferred', on: boolean): Promise<void> {
    try {
      await runAgentsArgs(deviceSettingArgv(name, field, on), { timeout: 30_000 });
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not change ${name}: ${errorText(e).split('\n')[0] ?? ''}`);
    }
    await this.loadDevices(true);
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
  /** One `linear tasks` read feeds Issues (and a ticket's Start agent). */
  private tickets: { project: string; at: number; groups: Promise<TicketGroup[]> } | undefined;
  /** The detail last drawn, so Start names the ticket the user is looking at. */
  private shownTicket: TicketDetail | undefined;
  /** The last Issues read that answered, for ⌘K's Tickets section. */
  private ticketsSeen: TicketGroup[] = [];
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

  /** Whether the shown project is one the user picked, rather than found from the folder. */
  picked(): boolean {
    return !!this.context.workspaceState.get<ProjectRef>(PICKED_PROJECT_KEY);
  }

  /** The project menu reads the list fresh each time it opens; the read also refreshes the shared registry. */
  private projectList(): Promise<ProjectRef[]> {
    return readRegistry(true);
  }

  /** The projects with a repository inside this window's folder, for the panel's project menu. */
  async projectsHere(): Promise<{ folder: string; current: string; projects: { name: string; repos: string[] }[] }> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const [all, current] = await Promise.all([this.projectList(), this.project()]);
    return { folder: displayHome(folder), current: current?.name ?? '', ...projectsInFolder(all, folder, os.homedir()) };
  }

  /** Show this project here; remembered for the workspace, as the quick pick does. */
  async pickByName(name: string): Promise<void> {
    const p = (await this.projectList()).find((x) => x.name === name);
    if (!p) throw new Error(`No project named ${name}`);
    await this.context.workspaceState.update(PICKED_PROJECT_KEY, { name: p.name, linearName: p.linearName });
    this.refresh(true);
  }

  private facesTriedAt = 0;

  /** Read the Issues list for ticket tiles at most once per FRESH_MS, failed or not; never throws. */
  warmTicketFaces(p: ProjectRef): void {
    if (!p.linearName || !resolveLinearBin() || Date.now() - this.facesTriedAt < FRESH_MS) return;
    this.facesTriedAt = Date.now();
    this.ticketGroups(p, false).catch(() => undefined);
  }

  /** Open PRs per repository, drawn as each repository answers. */
  async reviewByRepo(p: ProjectRef, force: boolean, partial: (html: string) => void): Promise<string> {
    const repos = (await this.projectList()).find((x) => x.name === p.name)?.repos ?? [];
    if (repos.length < 2) return this.render('prs', p, force);
    const done = new Map<string, PrsModel['repos'][number]>();
    const slugs = repos.map((r) => r.slug);
    this.reviewSeen = { slugs, done };
    const draw = () => renderPrsProgress(slugs, done, Date.now(), this.reviewOptions());
    partial(draw());
    await Promise.all(repos.map(async (r) => {
      let stdout: string;
      try {
        ({ stdout } = await runAgentsArgs(['projects', 'prs', 'list', p.name, '--json', '--repo', r.slug], { timeout: 60_000 }));
      } catch (e) {
        const out = (e as { stdout?: string }).stdout;
        if (!out || !out.trim().startsWith('{')) { done.set(r.slug, { slug: r.slug, error: errorText(e).split('\n')[0] ?? 'failed', branch: null, release: null, open: [], merged: [] }); partial(draw()); return; }
        stdout = out;
      }
      try {
        for (const repo of parsePrs(stdout).repos) done.set(r.slug, repo);
      } catch (e) {
        done.set(r.slug, { slug: r.slug, error: errorText(e), branch: null, release: null, open: [], merged: [] });
      }
      if (!done.has(r.slug)) done.set(r.slug, { slug: r.slug, error: null, branch: null, release: null, open: [], merged: [] });
      partial(draw());
    }));
    return draw();
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
      const parsed = parseTickets(stdout);
      // A read that lands after a project switch is not the shown project's.
      if (this.tickets?.project === p.name) this.ticketsSeen = parsed;
      if (rememberTicketGroups(parsed)) { void this.view.redrawSessions(); notifyAgentPanelSessionUpdate(); }
      return parsed;
    })();
    this.tickets = { project: p.name, at: Date.now(), groups };
    groups.catch(() => { if (this.tickets?.groups === groups) this.tickets = undefined; });
    return groups;
  }

  async render(id: Exclude<TabId, 'sessions' | 'settings'>, p: ProjectRef, force: boolean): Promise<string> {
    if (id === 'tickets') return renderTickets(await this.ticketGroups(p, force));
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
    const model = parsePrs(stdout);
    this.reviewSeen = { slugs: model.repos.map((r) => r.slug), done: new Map(model.repos.map((r) => [r.slug, r])) };
    return renderPrs(model, Date.now(), this.reviewOptions());
  }

  /** The PRs last read, so a ⇅ change redraws Review without reading GitHub again. */
  private reviewSeen: { slugs: string[]; done: Map<string, PrsModel['repos'][number]> } | undefined;

  private reviewOptions() {
    return { prefs: readReviewPrefs(this.context.workspaceState.get(REVIEW_PREFS_KEY)), mergeWith: getSettings(this.context).mergeMethod ?? 'squash' };
  }

  /** One Review ⇅ choice; the redrawn tab, or undefined when nothing was read yet. */
  async setReviewPref(key: string, value: string): Promise<string | undefined> {
    const next = applyReviewPref(readReviewPrefs(this.context.workspaceState.get(REVIEW_PREFS_KEY)), key, value);
    if (!next) return undefined;
    await this.context.workspaceState.update(REVIEW_PREFS_KEY, next);
    const seen = this.reviewSeen;
    return seen ? renderPrsProgress(seen.slugs, seen.done, Date.now(), this.reviewOptions()) : undefined;
  }

  /** Merge one PR from the list through the shared flow (read, pick, confirm, merge). */
  async mergeFromRow(repo: string, number: number, sha: string | undefined): Promise<boolean> {
    const project = await this.project();
    return project ? mergeNow(project.name, repo, number, validMergeMethod(getSettings(this.context).mergeMethod) ?? 'squash', sha) : false;
  }

  /** Today's goal ticket from the last goals read; the Sessions tab marks and filters by it. */
  todayId: string | undefined;

  /** Company and today's goal: one `linear goals --json` read. */
  async goals(): Promise<string> {
    const { stdout } = await execFileAsync(this.linear(), ['goals', '--json'], { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
    const goals = parseGoals(stdout);
    this.todayId = goals.today?.id;
    return renderGoals(goals);
  }

  private linear(): string {
    const bin = resolveLinearBin();
    if (!bin) throw new Error(LINEAR_NOT_FOUND_MESSAGE);
    return bin;
  }

  /** The ticket the card shows; set by the load that drew it, after its generation check. */
  showTicket(t: TicketDetail): void {
    this.shownTicket = t;
  }

  async ticketDetail(id: string): Promise<{ html: string; ticket: TicketDetail }> {
    const { stdout } = await execFileAsync(this.linear(), ['tasks', id, '--json'], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
    const t = parseTicketDetail(stdout);
    if (rememberTicket(t)) { void this.view.redrawSessions(); notifyAgentPanelSessionUpdate(); }
    const agent = this.ticketAgent(t);
    const project = await this.project().catch(() => null);
    const rows = project ? this.projectRows(project) : (preferLive(this.presented()) as unknown as SessionLike[]);
    const onIt = rows.filter((r) => sessionStateOf(r) !== 'ended' && (r.ticket === t.identifier || onTicket(r, t.identifier))).map((r) => ({
      sessionId: r.sessionId, host: r.host, title: sessionTitle(r), state: SESSION_STATE_WORD[sessionStateOf(r)], where: r.host === LOCAL_LABEL || !r.host ? 'this machine' : r.host,
    }));
    return { html: renderTicketDetail(t, { agentName: agent.name, delegated: agent.delegated }, onIt), ticket: t };
  }

  async comment(id: string, text: string): Promise<void> {
    await execFileAsync(this.linear(), commentArgv(id, text), { timeout: 60_000 });
  }

  /** Start runs the agent Linear delegates the ticket to when this version launches it
   *  ("Claude", "codex1" → Codex), else your default agent. */
  private ticketAgent(t: TicketDetail): (typeof PICKABLE_AGENTS)[number] & { delegated: boolean } {
    const d = (t.delegate ?? '').toLowerCase().replace(/\[bot\]$/, '').replace(/^app\//, '').replace(/\d+$/, '');
    const hit = d ? PICKABLE_AGENTS.find((a) => a.key === d || a.name.toLowerCase() === d) : undefined;
    return hit ? { ...hit, delegated: true } : { ...this.defaultAgent(), delegated: false };
  }

  private defaultAgent(): (typeof PICKABLE_AGENTS)[number] {
    const title = this.context.globalState.get<string>(DEFAULT_AGENT_KEY, PICKABLE_AGENTS[0].title);
    const agent = PICKABLE_AGENTS.find((a) => a.title === title);
    if (!agent) throw new Error(`The default agent "${title}" is not one this version can launch. Pick one in Settings.`);
    return agent;
  }

  /** Fix a PR from Review: the default agent in a new tab here, through the same launch as
   *  Start on a ticket, told the PR, its branch, what fails or conflicts and where the
   *  repository is checked out. It uses the PR as the list read it; nothing is read again. */
  async fixPr(slug: string, number: number): Promise<void> {
    const p = this.reviewSeen?.done.get(slug)?.open.find((x) => x.number === number);
    if (!p) return;
    try {
      const project = await this.project().catch(() => null);
      const checkout = project ? (await readRegistry()).find((x) => x.name === project.name)?.repos?.find((r) => r.slug === slug)?.path || null : null;
      await vscode.commands.executeCommand('agents.spawnWithPrompt', { agent: this.defaultAgent().key, prompt: prFixPrompt(p, slug, checkout) });
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not start an agent on #${number}: ${errorText(e)}`);
    }
  }

  /** Start on a ticket: the default agent in a new tab here, through the same
   *  launch path as Agents: Spawn With Prompt. */
  async startOnTicket(id: string): Promise<void> {
    const t = this.shownTicket;
    if (!t || t.identifier !== id) return;
    try {
      await vscode.commands.executeCommand('agents.spawnWithPrompt', { agent: this.ticketAgent(t).key, prompt: ticketPrompt(t) });
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not start an agent on ${id}: ${errorText(e)}`);
    }
  }

  settings(devices: DevicesState): string {
    return renderPanelSettings({
      settings: getSettings(this.context),
      devices,
      defaultAgentTitle: this.context.globalState.get<string>(DEFAULT_AGENT_KEY, PICKABLE_AGENTS[0].title),
      secondaryAgentTitle: this.context.globalState.get<string>(SECONDARY_AGENT_KEY, PICKABLE_AGENTS[1].title),
      modifier: process.platform === 'darwin' ? '⌘⇧' : 'Ctrl+Shift+',
    });
  }

  /** Answer an open ask the stream shows; the CLI's words when it was not delivered. */
  async answer(key: string, answer: { choice: string } | { text: string }): Promise<string | null> {
    if (!this.presented().some((r) => r.attention?.key === key && r.attention.state === 'open')) return 'This ask is no longer open.';
    try {
      const { stdout } = await runAgentsArgs(answerArgv(key, answer), { timeout: 60_000 });
      return answerFailure(stdout);
    } catch (e) {
      const out = (e as { stdout?: string }).stdout;
      return (out && answerFailure(out)) || errorText(e).split('\n')[0] || 'agents feed answer failed';
    }
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

  /** The project's sessions: the CLI's own project, plus (until agents-cli maps a
   *  project's old names) a session whose checkout is one of its repositories. */
  private projectRows(p: ProjectRef): SessionLike[] {
    const registry = registrySnapshot();
    // The registry answers once; the list redraws then. Until it has, only rows the CLI filed under no project fall back.
    if (!registry) void readRegistry().then(() => this.view.redrawSessions(), () => undefined);
    return projectSessions(preferLive(this.presented()) as unknown as SessionLike[], p.name, projectFallback(p, registry));
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
    for (const r of this.projectRows(project)) {
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
    const rows = this.projectRows(p)
      .map((r) => {
        const tab = terminals.getBySessionId(r.sessionId);
        const who = sessionPresentationStore.liveSession(r.sessionId);
        return { ...r, tabHere: !!tab, tabIndex: tab ? resolveTabIndex(tabGroups, tab.terminal.name) : undefined, account: who?.accountLabel ?? who?.account ?? undefined };
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
    const lastUserAt = (id: string) => { const live = byId.get(id) ?? byId.get('session_' + id); const turns = live?.userTurns ?? []; return turns.length ? turns[turns.length - 1]!.atMs : undefined; };
    const blockedIds = new Set(blockedSessions(sessionPresentationStore.activityEvents(), lastUserAt).keys());
    const cards = cardSettings(getSettings(this.context).cards);
    return { html: renderSessions(rows, Date.now(), { selectedId: subject?.sessionId ?? null, here, prefs, thumbsFor, madeFor, todayId: this.todayId, blockedIds, project: p.name, cards }), count: { shown: count.shown, asks: count.asks } };
  }

  /** A card click selects the session: the other sidebar shows it. Nothing opens. */
  /** A card click: the session panel shows it, and when its tab is in this window
   *  that tab comes to the front (owner, 2026-10-12). Nothing is resumed or spawned. */
  select(sessionId: string, host: string | undefined, focus = false): void {
    setAgentPanelSubjectFromProject(sessionId, host);
    void this.view.redrawSessions();
    if (!focus || (host && remoteDeviceArg(host))) return;
    terminals.getBySessionId(sessionId)?.terminal.show(false);
  }

  /** ⌘K: artifacts, sessions, tickets and PRs this window already holds, plus
   *  the Lead (src/vscode/searchPalette.vscode.ts). Enter shows the session (an
   *  artifact's maker included) and brings its tab forward when it has one here;
   *  nothing is resumed. Tickets and PRs are what the panel already read. */
  searchSessions(): void {
    const rows = preferLive(this.presented());
    const sessions: PaletteSession[] = rows.map((r) => {
      const like = r as unknown as SessionLike;
      const state = sessionStateOf(like);
      const opened = r.attention?.state === 'open' && r.attention.openedAt ? Date.parse(r.attention.openedAt) : NaN;
      const tab = terminals.getBySessionId(r.sessionId);
      return {
        sessionId: r.sessionId,
        host: r.host,
        title: sessionTitle(like),
        text: [[r.ticket, r.prStatus ? `#${r.prStatus.number}` : '', r.branch, r.model, tab ? 'tab here' : ''].filter(Boolean).join(' · '), r.request?.headline ?? r.topic].filter(Boolean).join('\n'),
        cwd: r.cwd,
        worktreePath: r.worktreePath,
        lastActivityMs: r.lastActivityMs,
        state,
        stateWords: paletteStateWords(like) + (state === 'asks' && Number.isFinite(opened) ? ` · ${waitFor(Date.now() - opened)}` : ''),
        local: !remoteDeviceArg(r.host),
      };
    });
    const tickets = this.ticketsSeen.flatMap((g) => g.tickets.map((t) => ({ identifier: t.identifier, title: t.title, state: g.state, delegate: t.delegate, assignee: t.assignee })));
    const prs = [...(this.reviewSeen?.done.values() ?? [])].flatMap((r) => r.open.map((p) => ({ repo: r.slug, number: p.number, title: p.title, url: p.url, author: p.author, date: p.date, ciState: p.ciState, isDraft: p.isDraft })));
    openSearchPalette({
      sessions,
      tickets,
      prs,
      goToSession: (sessionId, host) => { this.select(sessionId, host, true); this.view.reveal(sessionId); },
      openTicket: (id) => { void this.view.openTicketTab(id); },
    });
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
    const projects = await readRegistry(true);
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
    // ⌘K's Tickets and Pull requests are the shown project's; a switch must not keep the last one's.
    if (projectChanged) { this.ticketsSeen = []; this.reviewSeen = undefined; }
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
    // Internal: the session panel's ticket tile opens the ticket here.
    vscode.commands.registerCommand('agents.searchSessions', () => controller.searchSessions()),
    // The list follows the tab in front: switching tabs moves its selection (owner video, 2026-10-12).
    vscode.window.onDidChangeActiveTerminal((t) => {
      const id = t ? terminals.getByTerminal(t)?.sessionId : undefined;
      if (!id) return;
      void controller.redrawSessions().then(() => controller.view.reveal(id));
    }),
    vscode.commands.registerCommand('agents.project.openTicket', (id: unknown) => typeof id === 'string' && id ? controller.view.openTicketTab(id) : undefined),
    // Internal: the Lead talks to the project this panel shows (src/vscode/lead.vscode.ts).
    vscode.commands.registerCommand('agents.project.current', async () => (await controller.project())?.name),
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
  content="default-src 'none'; img-src ${cspSource} https://avatars.githubusercontent.com data:; connect-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';" />
<style>
  /* Rush register, as in the Active Terminal panel. This block is the only one
     with color literals; dark editor = Altitude, light = Day, high contrast keeps
     VS Code's own colors. */
  body {
    --r-text: #FAFAFA; --r-text-2: #D4D4D8; --r-caption: #A1A1AA; --r-faint: #71717A;
    --r-glass: rgba(255,255,255,0.05); --r-hover: rgba(255,255,255,0.08); --r-edge: rgba(255,255,255,0.12);
    --r-well: rgba(0,0,0,0.35); --r-sky: rgba(86,104,150,0.16);
    --r-ok: #86efac; --r-ok-tint: rgba(34,197,94,0.16); --r-warn: #fcd34d; --r-warn-tint: rgba(245,158,11,0.14);
    --r-bad: #fca5a5; --r-bad-tint: rgba(239,68,68,0.12); --r-info: #a5b4fc; --r-wait: #93c5fd;
    --r-doing: #4ade80; --r-review: #bef264; --r-todo: #71717a; --r-backlog: #3f3f46; --r-gold: #D4B872;
    --r-av0: #7c3aed; --r-av1: #0891b2; --r-av2: #c2410c; --r-av3: #15803d; --r-av4: #be185d; --r-av5: #4338ca; --r-on-av: #FFFFFF;
  }
  body.vscode-light {
    --r-text: #141829; --r-text-2: #4B4A55; --r-caption: #665E52; --r-faint: #8A8174;
    --r-glass: rgba(251,248,242,0.70); --r-hover: rgba(20,24,41,0.06); --r-edge: #DCD2C3;
    --r-well: rgba(20,24,41,0.06); --r-sky: rgba(184,204,220,0.30);
    --r-ok: #15803d; --r-ok-tint: rgba(22,163,74,0.12); --r-warn: #b45309; --r-warn-tint: rgba(217,119,6,0.12);
    --r-bad: #b91c1c; --r-bad-tint: rgba(220,38,38,0.08); --r-info: #4f46e5; --r-wait: #1D5FA8;
    --r-doing: #15803d; --r-review: #65a30d; --r-todo: #a8a29e; --r-backlog: #d6d3d1; --r-gold: #A8884A;
    --r-av0: #7c3aed; --r-av1: #0e7490; --r-av2: #c2410c; --r-av3: #15803d; --r-av4: #be185d; --r-av5: #4338ca; --r-on-av: #FFFFFF;
  }
  body.vscode-high-contrast, body.vscode-high-contrast-light {
    --r-text: var(--vscode-foreground); --r-text-2: var(--vscode-foreground); --r-caption: var(--vscode-descriptionForeground); --r-faint: var(--vscode-descriptionForeground);
    --r-glass: transparent; --r-hover: var(--vscode-list-hoverBackground); --r-edge: var(--vscode-contrastBorder); --r-well: transparent; --r-sky: transparent;
    --r-ok: var(--vscode-testing-iconPassed); --r-ok-tint: transparent; --r-warn: var(--vscode-editorWarning-foreground); --r-warn-tint: transparent;
    --r-bad: var(--vscode-errorForeground); --r-bad-tint: transparent; --r-info: var(--vscode-textLink-foreground); --r-wait: var(--vscode-charts-blue);
    --r-doing: var(--vscode-testing-iconPassed); --r-review: var(--vscode-testing-iconPassed); --r-todo: var(--vscode-descriptionForeground); --r-backlog: var(--vscode-contrastBorder); --r-gold: var(--vscode-focusBorder);
    --r-av0: transparent; --r-av1: transparent; --r-av2: transparent; --r-av3: transparent; --r-av4: transparent; --r-av5: transparent; --r-on-av: var(--vscode-foreground);
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
  .ms { margin-top: 8px; } .ms .t { flex: 1; }
  .note { margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: var(--r-well); color: var(--r-caption); }
  .note b { color: var(--r-text); }
  .ic { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .srow { display: grid; grid-template-columns: minmax(0,1fr) 18px; gap: 2px 8px; width: 100%; text-align: left; padding: 7px 6px; margin: 1px 0; border: none; border-radius: 8px; background: none; color: inherit; font: inherit; cursor: pointer; }
  .srow:hover { background: var(--r-hover); } .srow.sel { background: var(--r-hover); box-shadow: inset 2px 0 0 var(--r-gold); }
  .srow:focus-visible, a:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .fact { display: inline-flex; align-items: center; gap: 3px; }
  .fact.pr-ok { color: var(--r-ok); } .fact.pr-bad { color: var(--r-bad); } .fact.pr-run { color: var(--r-warn); }
  .mark { grid-column: 2; grid-row: 1 / span 2; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid currentColor; display: grid; place-items: center; font-size: 10px; font-weight: 700; margin-top: 1px; color: var(--r-faint); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .quiet summary, details summary { cursor: pointer; padding: 6px 2px 2px; color: var(--r-caption); font-size: 11.5px; }
  details > summary { list-style: revert; }
  .pri { display: inline-flex; align-items: flex-end; gap: 1.5px; width: 12px; height: 11px; flex: none; margin-top: 3px; }
  .pri i { display: block; width: 2.5px; border-radius: 1px; background: var(--r-edge); }
  .pri i.on { background: var(--r-faint); }
  .trow, .prow { display: grid; grid-template-columns: auto minmax(0,1fr) auto; gap: 8px; padding: 5px 4px; border-radius: 6px; }
  .prli { display: flex; align-items: center; gap: 4px; }
  /* People: GitHub avatars on PRs, colored initials (or the agent's logo) on issues. */
  .pav { width: 18px; height: 18px; border-radius: 50%; flex: none; align-self: center; }
  .trow, .prow { align-items: center; }
  .who { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; flex: none; }
  .iav { width: 18px; height: 18px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 8.5px; font-weight: 700; color: var(--r-on-av); flex: none; box-sizing: border-box; }
  body.vscode-high-contrast .iav, body.vscode-high-contrast-light .iav { border: 1px solid var(--r-edge); }
  .iav.av0 { background: var(--r-av0); } .iav.av1 { background: var(--r-av1); } .iav.av2 { background: var(--r-av2); }
  .iav.av3 { background: var(--r-av3); } .iav.av4 { background: var(--r-av4); } .iav.av5 { background: var(--r-av5); }
  .iav.agent { background: var(--r-glass); border: 1px solid var(--r-edge); }
  .iav.agent .hx { width: 12px; height: 12px; }
  .prli { gap: 6px; padding-left: 2px; }
  .prli .prow { flex: 1; min-width: 0; display: block; padding: 5px 2px; }
  /* The row's ↗ (the Active Session header's open icon): shown on hover, opens the PR as a tab. */
  .pro { flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; color: var(--r-caption); opacity: 0; }
  .prli:hover .pro, .pro:focus-visible { opacity: 1; }
  .pro:hover { background: var(--r-hover); color: var(--r-text); }
  .pro svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  /* A PR row: its author on the left, its state as the rightmost control (Merge when checks pass). */
  .rs { flex: none; display: inline-flex; align-items: center; gap: 4px; border-radius: 6px; padding: 2px 8px; font: 600 11px var(--vscode-font-family); border: 1px solid transparent; white-space: nowrap; }
  .rs.merge { background: var(--r-ok); color: var(--r-on-av); cursor: pointer; } .rs.merge:hover { filter: brightness(1.08); } .rs.merge:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .rs.undo { background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font-variant-numeric: tabular-nums; min-width: 62px; justify-content: center; }
  .rs.fail { color: var(--r-bad); background: var(--r-bad-tint); }
  /* Fix: a quiet button beside the failure that starts an agent tab on the PR. */
  .rs.fix { color: var(--r-text); background: transparent; border: 1px solid var(--r-edge); cursor: pointer; } .rs.fix:hover { background: var(--r-hover); } .rs.fix:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; } .rs.run { padding: 2px 4px; } .rs.draft { color: var(--r-faint); border: 1px dashed var(--r-edge); } .rs.done { color: var(--r-caption); }
  .rgrp .head { margin-bottom: 2px; } .rgrp.g-ready .label { color: var(--r-ok); } .rgrp.g-fail .label { color: var(--r-bad); }
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
  .shead .today { margin-left: 6px; flex: none; font: 500 10.5px var(--r-sans); color: var(--r-text-2); border: 1px solid var(--r-edge); border-radius: 999px; padding: 0 7px; background: transparent; cursor: pointer; }
  .shead .today.on { border-color: var(--r-selected-edge); background: var(--r-selected); color: var(--r-text); }
  .tday { margin-left: 4px; font-size: 10.5px; flex: none; }
  /* Goals: two quiet lines above the tabs, never a block. */
  .proj { position: relative; display: flex; align-items: center; gap: 8px; padding: 6px 10px 0; flex: none; min-width: 0; }
  .proj[hidden] { display: none; }
  .pp { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--r-edge); background: var(--r-glass); border-radius: 6px; padding: 2px 7px; font: inherit; font-size: 11.5px; color: var(--r-text); cursor: pointer; flex: none; }
  .pp:hover { background: var(--r-hover); }
  .pp .ti { width: 12px; height: 12px; }
  .pp b { font-weight: 600; }
  .pp .car { color: var(--r-faint); font-size: 9px; }
  .pwhy { font-size: 11px; color: var(--r-faint); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pmenu { position: absolute; z-index: 30; top: 100%; left: 8px; right: 8px; margin-top: 4px; background: var(--vscode-menu-background, var(--r-glass)); border: 1px solid var(--r-edge); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 4px; }
  .pmenu[hidden] { display: none; }
  .pms { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--r-faint); padding: 6px 8px 4px; }
  .pms.err { text-transform: none; letter-spacing: 0; color: var(--r-bad); }
  .pmenu button { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: transparent; text-align: left; font: inherit; font-size: 12px; color: var(--r-text); padding: 5px 8px; border-radius: 5px; cursor: pointer; }
  .pmenu button:hover { background: var(--r-hover); }
  .pmenu .ck { width: 12px; flex: none; color: var(--r-text-2); }
  .pmenu .pn { display: flex; flex-direction: column; min-width: 0; }
  .pmenu .pn small { color: var(--r-caption); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pmenu hr { border: 0; border-top: 1px solid var(--r-edge); margin: 4px 0; }
  .tkt { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; padding: 7px 9px; border: 1px solid var(--r-edge); border-radius: 8px; background: var(--r-glass); text-decoration: none; color: var(--r-text); max-width: 280px; }
  .tkt:hover { border-color: var(--r-caption); background: var(--r-hover); }
  .tkh { display: flex; align-items: center; gap: 5px; font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .tkh .ic { width: 12px; height: 12px; }
  .tks { margin-left: auto; font-family: var(--r-sans, inherit); font-size: 10.5px; color: var(--r-caption); }
  .tkx { font-size: 11.5px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .tkm { font-size: 10.5px; color: var(--r-caption); }
  .card .span { font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-caption); margin: 2px 0 4px; }
  .reading, .quiet { font-size: 11.5px; color: var(--r-caption); padding: 6px 2px; }
  .goals { padding: 6px 10px 4px; flex: none; }
  .goals a { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 11.5px; line-height: 1.55; color: var(--r-caption); text-decoration: none; }
  .goals a:hover .gtx { color: var(--r-text); }
  .goals .gl2 { color: var(--r-text-2); }
  .goals .gl2 b { font-weight: 600; margin-right: 3px; }
  .goals .gk { width: 13px; text-align: center; flex: none; }
  .goals .gtx { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .goals .gm { flex: none; font-family: var(--r-mono); font-size: 10px; color: var(--r-faint); }
  .goals .gerr { font-size: 11px; color: var(--r-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
  .pinned.now { background: var(--r-bad-tint); } .pinned.now .ph { color: var(--r-bad); }
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
  .card .top { display: flex; align-items: center; gap: 6px; min-width: 0; height: 20px; }
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
  .st-stuck.pill { color: var(--r-warn); border-color: var(--r-warn); } .pill.st-stuck i { background: var(--r-warn) !important; }
  .pill.st-review i, .d-review { background: var(--r-info) !important; }
  /* Waiting on its own work: a blue dot that breathes slowly, and a chip per kind. */
  .st-waiting.pill { color: var(--r-wait); border-color: color-mix(in srgb, var(--r-wait) 45%, transparent); } .pill.st-waiting i, .d-waiting { background: var(--r-wait) !important; }
  .st-waiting.pill i { animation: waitbreathe 2.2s ease-in-out infinite; }
  @keyframes waitbreathe { 0%, 100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.15); } }
  .pc { display: inline-flex; align-items: center; gap: 3px; flex: none; border: 1px solid color-mix(in srgb, var(--r-wait) 40%, transparent); color: var(--r-wait); border-radius: 4px; padding: 0 4px; font-family: var(--vscode-editor-font-family); font-size: 10.5px; line-height: 15px; cursor: default; }
  .meta .repo { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
  .fx { display: inline-flex; gap: 2px; flex: none; } .fx span { font-size: 10.5px; line-height: 1; padding: 2px 3px; border-radius: 4px; background: var(--r-well); }
  .fx .fast { color: var(--r-warn); } .fx .hi { color: var(--r-info); }
  .cbot { display: flex; align-items: flex-end; gap: 6px; margin-top: 6px; min-width: 0; } .card .cbot .cstrip { margin-top: 0; flex: 1; min-width: 0; }
  .cbot .hst { margin-left: auto; flex: none; font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); opacity: .8; }
  .cmore { position: relative; } .cmore > summary { list-style: none; font-size: 13px; line-height: 18px; text-align: center; } .cmore > summary::-webkit-details-marker { display: none; }
  .card:has(.cmore[open]) .acts { display: flex; } .card:has(.cmore[open]) .age { display: none; }
  .cmenu { position: absolute; right: 0; top: 22px; z-index: 6; width: 230px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--r-edge); background: var(--vscode-menu-background, var(--vscode-sideBar-background)); box-shadow: 0 8px 22px rgba(0,0,0,.3); cursor: default; }
  .cmenu dl { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 3px 8px; margin: 0; font-size: 11px; } .cmenu dt { color: var(--r-faint); } .cmenu dd { margin: 0; overflow-wrap: anywhere; }
  .cmenu button { display: block; width: 100%; margin-top: 6px; padding: 3px 4px; text-align: left; font: inherit; font-size: 11.5px; border: 0; border-top: 1px solid var(--r-edge); background: none; color: var(--r-text); cursor: pointer; } .cmenu button:hover { background: var(--r-hover); }
  .pill.st-blocked { color: var(--r-bad); border-color: var(--r-bad); } .pill.st-blocked i { background: var(--r-bad) !important; }
  .st-ended.pill { opacity: .8; }
  @keyframes breathe { 50% { opacity: .25; } }
  /* A card always shows the same preview; hover only reveals its icons, so nothing moves. */
  .card .ask, .card .line.said { margin-top: 5px; }
  .card .cstrip, .card .thumbs { margin-top: 6px; }
  .cstrip { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  .pill .wait { font-variant-numeric: tabular-nums; font-weight: 600; }
  .pill.st-asks i { position: relative; overflow: visible; }
  .pill.st-asks i::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--r-warn); opacity: 0; animation: askring 2.4s ease-out infinite; }
  @keyframes askring { 0% { transform: scale(.4); opacity: .7; } 70%, 100% { transform: scale(1.5); opacity: 0; } }
  /* A question that just arrived: the card glows three times, then rests. */
  .card.fresh { animation: askglow 1.1s ease-in-out 3; }
  @keyframes askglow { 0%, 100% { box-shadow: 0 0 0 0 transparent; } 45% { background: var(--r-warn-tint); box-shadow: 0 0 0 2px var(--r-warn); } }
  .card.flash { animation: flashsel .9s ease-out; }
  @keyframes flashsel { 0% { box-shadow: 0 0 0 2px var(--r-gold); } 100% { box-shadow: 0 0 0 0 transparent; } }
  .ic.mark { width: 11px; height: 11px; }
  .lab { font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--r-faint); margin: 7px 0 2px; }
  .card .line { color: var(--r-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .card .line.said { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .card .line.live { color: var(--r-caption); margin-top: 3px; } .card .line .cmd { font-family: var(--vscode-editor-font-family); font-size: 11px; } .card .line .tool { font-weight: 600; font-size: 11px; }
  .card .why { margin-top: 2px; font-size: 11px; color: var(--r-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .why.u-urgent, .card .why.u-high { color: var(--r-bad); } .card .why [data-since] { font-variant-numeric: tabular-nums; }
  .card .ask { display: block; padding: 6px 8px; border-radius: 6px; background: var(--r-warn-tint); color: var(--r-text); font-size: 12px; line-height: 1.4; cursor: default; }
  .card .ask .ah { font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--r-warn); margin-bottom: 2px; }
  .card .ask .q { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .card .ask .q[data-expand] { cursor: zoom-in; } .card .ask.open .q { display: block; cursor: zoom-out; } .card .ask .q.full { display: block; }
  .card .ask .q.cmdq { font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .card .ask [hidden] { display: none !important; }
  .card .opts { display: flex; flex-direction: column; gap: 3px; margin-top: 5px; }
  .card .opt { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; min-width: 0; text-align: left; font: inherit; font-size: 11.5px; line-height: 1.35; padding: 3px 7px; border: 1px solid var(--r-edge); border-radius: 5px; background: var(--r-glass); color: var(--r-text); cursor: pointer; }
  .card .opt:hover, .card .opt:focus-visible { background: var(--r-hover); border-color: var(--r-warn); outline: none; }
  .card .opt .k { flex: none; font-size: 10.5px; color: var(--r-faint); font-variant-numeric: tabular-nums; }
  .card .opt .ol { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .opt small { flex-basis: 100%; padding-left: 13px; color: var(--r-caption); font-size: 11px; }
  .card .alt { display: flex; gap: 12px; margin-top: 4px; }
  .card .lnk { background: none; border: 0; padding: 0; font: inherit; font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; } .card .lnk:hover { text-decoration: underline; }
  .card .aother input { width: 100%; box-sizing: border-box; margin-top: 5px; font: inherit; font-size: 11.5px; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--r-edge)); border-radius: 4px; }
  .card .asend { margin-top: 5px; font-size: 11.5px; color: var(--r-text-2); } .card .asend.err { color: var(--r-bad); }
  .made { display: grid; gap: 5px; padding: 6px; border-radius: 7px; border: 1px solid var(--r-edge); background: var(--r-well); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { display: inline-flex; align-items: center; gap: 3px; max-width: 170px; padding: 1px 6px 1px 4px; border-radius: 5px; border: 1px solid var(--r-edge); color: var(--r-caption); font-family: var(--vscode-editor-font-family); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a.chip { text-decoration: none; cursor: pointer; } a.chip:hover { border-color: var(--r-caption); color: var(--r-text); }
  .chip.pr-ok { color: var(--r-ok); } .chip.pr-bad { color: var(--r-bad); } .chip.pr-run { color: var(--r-warn); }
  .folder { display: flex; gap: 6px; align-items: flex-start; min-width: 0; color: var(--r-text-2); font-size: 11.5px; } .folder .ic { margin-top: 2px; color: var(--r-faint); }
  .folder .fx { min-width: 0; display: grid; } .folder .fx span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .folder .fp { font-size: 10.5px; color: var(--r-faint); }
  .folder:hover b { text-decoration: underline; }
  .thumbs { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-top: 3px; }
  .th { position: relative; height: 40px; border-radius: 4px; overflow: hidden; border: 1px solid var(--r-edge); display: block; flex: none; }
  .th { width: 64px; } .card .th { width: 54px; height: 34px; aspect-ratio: 54 / 34; contain: strict; background: var(--r-well); } .th.in { outline: 1.5px dashed var(--r-faint); outline-offset: 1px; } .th img { width: 100%; height: 100%; object-fit: cover; display: block; } .th:hover { border-color: var(--r-gold); }
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
  .tdetail .dwho { font-size: 12px; } .tdetail .dispatch .sh { font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--r-faint); margin-top: 4px; }
  .tdetail .onit { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .tdetail .ons { display: flex; gap: 6px; align-items: center; min-width: 0; border: 1px solid var(--r-edge); border-radius: 7px; padding: 5px 7px; }
  .tdetail .onm { flex: 1; min-width: 0; display: grid; } .tdetail .onm b { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .tdetail .onm small { color: var(--r-caption); font-size: 10.5px; }
  .tdetail .ons .primary { flex: none; }
  .tdetail button.link { background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; text-decoration: underline; }
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
  .settings .shsub { text-transform: none; letter-spacing: 0; margin-left: 4px; }
  .settings .drow { display: grid; grid-template-columns: 16px minmax(0, 1fr) 22px; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--r-edge); }
  .settings .drow input { margin: 0; }
  .settings .dname { min-width: 0; } .settings .dname b { font-weight: 500; margin-right: 6px; }
  .settings .dname small { font-variant-numeric: tabular-nums; }
  .settings .drow.out b, .settings .drow.out small { opacity: .6; }
  .settings .dskip { font-size: 10.5px; color: var(--r-bad); border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; white-space: nowrap; }
  .settings .dskip.quiet { color: var(--r-faint); }
  .settings .dlow { color: var(--r-warn); } .settings .dfull { color: var(--r-bad); }
  .settings .dstar { font: inherit; font-size: 15px; line-height: 1; background: none; border: none; color: var(--r-faint); cursor: pointer; padding: 2px; border-radius: 4px; }
  .settings .dstar[aria-pressed="true"] { color: var(--r-gold); } .settings .dstar:hover { background: var(--r-hover); }
  .settings .doff { color: var(--r-faint); font-size: 11px; padding: 6px 0; border-bottom: 1px solid var(--r-edge); }
  .settings .err { color: var(--r-bad); }
  @media (prefers-reduced-motion: reduce) { .st-waiting.pill i, .st-working.pill i, .ring .arc, .pill.st-asks i::after, .card.fresh, .card.flash { animation: none; } .gh .car { transition: none; } }
</style>
</head>
<body>
<div class="proj" hidden>
  <button class="pp" data-proj-menu aria-haspopup="menu" aria-expanded="false" title="Show another project"><svg class="ti" viewBox="0 0 16 16"><path d="M2 4.5h4l1.2 1.3H14v6.7H2z"/></svg><b class="ppn"></b><span class="car">▾</span></button>
  <span class="pwhy"></span>
  <div class="pmenu" role="menu" hidden></div>
</div>
<div class="goals" hidden></div>
<div class="tabs" role="tablist" aria-label="Project">
  <button class="tab" role="tab" data-tab="sessions" aria-selected="true" title="Sessions"><svg class="ti" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/></svg><span class="lbl">Sessions <span class="cnt" data-cnt="sessions"></span></span><span class="dot" data-asks title="Sessions that need you"></span></button>
  <button class="tab" role="tab" data-tab="prs" aria-selected="false" title="Review — pull requests"><svg class="ti" viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V7a2 2 0 0 0-2-2H7"/></svg><span class="lbl">Review</span></button>
  <button class="tab" role="tab" data-tab="tickets" aria-selected="false" title="Issues"><svg class="ti" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg><span class="lbl">Issues</span></button>
  <button class="tab" role="tab" data-tab="settings" aria-selected="false" title="Settings"><svg class="ti" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg><span class="lbl">Settings</span></button>
</div>
<main role="tabpanel"><div class="empty">Loading…</div></main>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const main = document.querySelector('main');
${PATCH_SCRIPT}
${THUMB_SCRIPT}
  // Questions the viewer opened, and Merge clicks still in their Undo window; both
  // survive a redraw of the list.
  const opened = new Set();
  const pendingMerge = new Map();
  const mergeTimers = new Map();
  // Answers from a card, by attention key: held 5 s with Undo, then sent once; what
  // the CLI said stays on the card. Asks whose Other… box is open.
  const pendingAnswer = new Map();
  const otherOpen = new Set();
  let shownProject;
  function waitWords(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
    const h = Math.floor(s / 3600);
    return h < 24 ? h + 'h ' + Math.floor((s % 3600) / 60) + 'm' : Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  // The wait on a question ticks every second; only these numbers change.
  function tickWaits() { main.querySelectorAll('[data-since]').forEach((el) => { const t = Number(el.dataset.since); if (t) el.textContent = waitWords(Date.now() - t); }); }
  setInterval(tickWaits, 1000);
  function restoreLocal() {
    main.querySelectorAll('.card[data-session] .ask').forEach((a) => a.classList.toggle('open', opened.has(a.closest('.card').dataset.session)));
    for (const [key, left] of pendingMerge) drawUndo(key, left);
    // An ask that left the list takes its answer along: a sent one is forgotten, and
    // one still counting down is stopped, since its Undo is no longer on screen.
    let dropped = 0;
    for (const [key, p] of pendingAnswer) {
      if (askEl(key)) { drawAsk(key); continue; }
      if (p.state === 'wait') { clearInterval(p.timer); dropped++; }
      if (p.state === 'wait' || p.state === 'sent') pendingAnswer.delete(key);
    }
    if (dropped) toast('Answer not sent: its card left the list before it went.');
    for (const key of otherOpen) { if (askEl(key)) drawAsk(key); else otherOpen.delete(key); }
    tickWaits();
  }
  function askEl(key) { return main.querySelector('.ask[data-ask="' + CSS.escape(key) + '"]'); }
  function drawAsk(key) {
    const el = askEl(key); if (!el) return;
    const p = pendingAnswer.get(key);
    const busy = !!p && p.state !== 'error';
    el.querySelector('.aother').hidden = busy || !otherOpen.has(key);
    el.querySelectorAll('.opts, .alt').forEach((x) => { x.hidden = busy; });
    const send = el.querySelector('.asend');
    send.hidden = !p;
    if (!p) return;
    send.className = 'asend' + (p.state === 'error' ? ' err' : '');
    const q = '\u201c' + p.label + '\u201d';
    const words = document.createElement('span');
    words.textContent = p.state === 'wait' ? 'Sending ' + q + ' in ' + p.left + 's'
      : p.state === 'sending' ? 'Sending ' + q + '\u2026' : p.state === 'sent' ? 'Sent ' + q : 'Not sent: ' + p.error;
    send.replaceChildren(words);
    if (p.state === 'wait') { const b = document.createElement('button'); b.className = 'lnk'; b.setAttribute('data-ask-undo', ''); b.textContent = 'Undo'; send.append(' \u00b7 ', b); }
  }
  // One answer per ask: a click (or key 1-9) waits 5 s, then posts once.
  function answerAsk(key, label, payload) {
    const held = pendingAnswer.get(key);
    if (held && held.state !== 'error') return;
    otherOpen.delete(key);
    const p = Object.assign({ left: 5, label, state: 'wait' }, payload);
    pendingAnswer.set(key, p); drawAsk(key);
    p.timer = setInterval(() => {
      if (pendingAnswer.get(key) !== p) { clearInterval(p.timer); return; }
      p.left -= 1;
      if (p.left > 0) { drawAsk(key); return; }
      clearInterval(p.timer); p.state = 'sending'; drawAsk(key);
      vscode.postMessage({ type: 'answer', key, choice: p.choice, text: p.text });
    }, 1000);
  }
  // Leaving Sessions stops an answer still counting down: its Undo would be off screen.
  function cancelAnswers() {
    let n = 0;
    for (const [key, p] of pendingAnswer) if (p.state === 'wait') { clearInterval(p.timer); pendingAnswer.delete(key); n++; }
    return n;
  }
  function mergeBtn(key) { const [repo, num] = key.split('#'); return main.querySelector('[data-merge-repo="' + CSS.escape(repo) + '"][data-merge-number="' + CSS.escape(num) + '"]'); }
  function drawUndo(key, left) {
    const b = mergeBtn(key); if (!b) return;
    b.className = 'rs undo'; b.textContent = 'Undo · ' + left; b.title = 'Stop this merge';
  }
  const tabs = [...document.querySelectorAll('.tab')];
  const scroll = {};
  let current = 'sessions';
  function select(tab) {
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  }
  // Leaving Review cancels a Merge still counting down: its Undo would no longer be on screen.
  function cancelMerges() {
    for (const t of mergeTimers.values()) clearInterval(t);
    const n = pendingMerge.size; mergeTimers.clear(); pendingMerge.clear();
    return n;
  }
  function choose(tab) {
    if (tab === current) return;
    if (current === 'prs' && cancelMerges()) toast('Merge cancelled: you left Review before it started.');
    if (current === 'sessions' && cancelAnswers()) toast('Answer not sent: you left Sessions before it went.');
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
      // A card's ⋯ menu keeps its own open state through the patch; only folds are matched by their summary.
      const folds = () => [...main.querySelectorAll('details:not(.cmore)')];
      const open = new Set(same ? folds().filter((d) => d.open).map((d, i) => d.querySelector('summary')?.textContent || i) : []);
      const y = same ? main.scrollTop : (scroll[m.tab] || 0);
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.session : null;
      // A stream tick must not take away an Undo, a pending "close anyway?" or the open menu.
      const keepToast = same ? main.querySelector('.toast:not([hidden])') : null;
      const keepConfirm = same ? [...main.querySelectorAll('.confirm')].map((c) => [c.closest('.card').dataset.session, c]) : [];
      const menuOpen = same && main.querySelector('.menu') && !main.querySelector('.menu').hidden;
      if (same) patchChildren(main, m.html); else main.innerHTML = m.html;
      if (keepToast) main.querySelector('.toast')?.replaceWith(keepToast);
      for (const [id, box] of keepConfirm) main.querySelector('.card[data-session="' + CSS.escape(id) + '"]')?.appendChild(box);
      if (menuOpen) { main.querySelector('.menu').hidden = false; main.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'true'); }
      main.dataset.tab = m.tab;
      if (same) folds().forEach((d, i) => { const k = d.querySelector('summary')?.textContent || i; if (open.has(k)) d.open = true; });
      observeThumbs(main);
      main.scrollTop = y;
      if (focused) { const el = main.querySelector('[data-session="' + CSS.escape(focused) + '"]'); if (el) el.focus(); }
      if (m.tab === 'sessions') syncBulk();
      restoreLocal();
      document.body.classList.remove('loading');
    }
    else if (m.type === 'project') {
      // Only a different project cancels a merge still counting down; every load re-sends the name.
      if (shownProject !== undefined && m.name !== shownProject && cancelMerges()) toast('Merge cancelled: the project changed before it started.');
      shownProject = m.name;
      const row = document.querySelector('.proj');
      row.hidden = !m.name;
      row.querySelector('.ppn').textContent = m.name;
      row.querySelector('.pwhy').textContent = m.picked ? 'picked for this window' : 'found from this folder';
    }
    else if (m.type === 'projectList') {
      const pmenu = document.querySelector('.pmenu');
      const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      if (m.error) { pmenu.innerHTML = '<div class="pms err">' + esc(m.error) + '</div>'; return; }
      pmenu.innerHTML = '<div class="pms">' + (m.projects.length ? 'Projects in ' + esc(m.folder) : 'No project has a repository in ' + esc(m.folder)) + '</div>' +
        m.projects.map((p) => '<button role="menuitemradio" aria-checked="' + (p.name === m.current) + '" data-proj-pick="' + esc(p.name) + '"><span class="ck">' + (p.name === m.current ? '✓' : '') + '</span><span class="pn"><b>' + esc(p.name) + '</b><small>' + esc(p.repos.join(' · ')) + '</small></span></button>').join('') +
        '<hr><button data-proj-all><span class="ck"></span>All projects…</button>';
    }
    else if (m.type === 'goals') { const g = document.querySelector('.goals'); g.innerHTML = m.html || ''; g.hidden = !m.html; }
    else if (m.type === 'loading') document.body.classList.add('loading');
    else if (m.type === 'idle') { document.body.classList.remove('loading'); main.querySelectorAll('[data-comment]').forEach((b) => { b.disabled = false; }); }
    else if (m.type === 'notice') toast(m.text);
    else if (m.type === 'answered') {
      const p = pendingAnswer.get(m.key); if (!p) return;
      if (m.error) { p.state = 'error'; p.error = m.error; } else p.state = 'sent';
      drawAsk(m.key);
    }
    else if (m.type === 'reveal') {
      const c = main.querySelector('.card[data-session="' + CSS.escape(m.sessionId) + '"]');
      if (c) { c.scrollIntoView({ block: 'nearest' }); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
    }
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
    box.firstChild.textContent = 'The agent is ' + (card.classList.contains('st-working') ? 'working' : card.classList.contains('st-waiting') ? 'waiting on its own background work' : 'waiting on you') + '. Closing the tab ends its process; the session stays resumable.';
    card.appendChild(box);
  }
  document.addEventListener('click', (e) => {
    // A card's ⋯ menu: its summary toggles it; a click anywhere else closes it.
    main.querySelectorAll('.cmore[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
    const more = e.target.closest('.cmore');
    if (more) {
      const copy = e.target.closest('[data-copy]');
      if (copy) { vscode.postMessage({ type: 'copy', text: copy.dataset.copy }); more.open = false; }
      return;
    }
    const tab = e.target.closest('.tab');
    if (tab) { choose(tab.dataset.tab); return; }
    // The project button: its menu lists the projects in this folder (one read when it opens).
    const pmenu = document.querySelector('.pmenu');
    if (e.target.closest('[data-proj-menu]')) {
      const opening = pmenu.hidden;
      pmenu.hidden = !opening;
      document.querySelector('[data-proj-menu]').setAttribute('aria-expanded', String(opening));
      if (opening) { pmenu.innerHTML = '<div class="pms">Reading projects…</div>'; vscode.postMessage({ type: 'projects' }); }
      return;
    }
    const pick = e.target.closest('[data-proj-pick]');
    if (pick) { pmenu.hidden = true; vscode.postMessage({ type: 'pickProject', name: pick.dataset.projPick }); return; }
    if (e.target.closest('[data-proj-all]')) { pmenu.hidden = true; vscode.postMessage({ type: 'pick' }); return; }
    if (!pmenu.hidden && !e.target.closest('.pmenu')) { pmenu.hidden = true; document.querySelector('[data-proj-menu]').setAttribute('aria-expanded', 'false'); }
    // A ticket tile or chip opens the ticket in Issues, with its comments.
    const tk = e.target.closest('[data-open-ticket]');
    if (tk) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: 'ticketTab', id: tk.dataset.openTicket }); return; }
    const merge = e.target.closest('[data-merge-repo]');
    if (merge) {
      e.preventDefault(); e.stopPropagation();
      const key = merge.dataset.mergeRepo + '#' + merge.dataset.mergeNumber;
      // A second click inside the window is Undo: nothing was sent yet.
      if (pendingMerge.has(key)) { clearInterval(mergeTimers.get(key)); mergeTimers.delete(key); pendingMerge.delete(key); merge.className = 'rs merge'; merge.textContent = 'Merge'; merge.title = 'Merge #' + merge.dataset.mergeNumber; toast('Stopped. #' + merge.dataset.mergeNumber + ' was not merged.'); return; }
      let left = 5; pendingMerge.set(key, left); drawUndo(key, left);
      const timer = setInterval(() => {
        left -= 1;
        if (!pendingMerge.has(key)) { clearInterval(timer); return; }
        if (left > 0) { pendingMerge.set(key, left); drawUndo(key, left); return; }
        clearInterval(timer); pendingMerge.delete(key); mergeTimers.delete(key);
        const b = mergeBtn(key); if (b) { b.textContent = 'Merging…'; b.disabled = true; }
        vscode.postMessage({ type: 'merge', repo: merge.dataset.mergeRepo, number: Number(merge.dataset.mergeNumber), sha: merge.dataset.mergeSha });
      }, 1000);
      mergeTimers.set(key, timer);
      return;
    }
    const fix = e.target.closest('[data-fix-repo]');
    if (fix) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: 'fixPr', repo: fix.dataset.fixRepo, number: Number(fix.dataset.fixNumber) }); toast('Starting an agent on #' + fix.dataset.fixNumber + '…'); return; }
    const rpref = e.target.closest('[data-rpref]');
    if (rpref) { vscode.postMessage({ type: 'reviewPrefs', key: rpref.dataset.rpref, value: rpref.dataset.value }); return; }
    if (e.target.closest('[data-search]')) { vscode.postMessage({ type: 'search' }); return; }
    const os = e.target.closest('[data-open-session]');
    if (os) { vscode.postMessage({ type: 'openSession', sessionId: os.dataset.openSession, host: os.dataset.host }); return; }
    // An ask on a card: each answer button carries what it sends (a choice id or words).
    const askBox = e.target.closest('.card .ask[data-ask]');
    if (askBox) {
      const key = askBox.dataset.ask;
      const opt = e.target.closest('[data-choice], [data-ask-text]');
      if (opt) { e.stopPropagation(); answerAsk(key, opt.dataset.label, opt.dataset.choice ? { choice: opt.dataset.choice } : { text: opt.dataset.askText }); return; }
      if (e.target.closest('[data-ask-other]')) { otherOpen.add(key); drawAsk(key); askBox.querySelector('[data-ask-input]').focus(); return; }
      if (e.target.closest('[data-ask-undo]')) { const p = pendingAnswer.get(key); if (p) clearInterval(p.timer); pendingAnswer.delete(key); drawAsk(key); return; }
      if (e.target.closest('.aother, .asend')) return;
    }
    const ask = e.target.closest('.card .ask [data-expand]');
    if (ask) { const id = ask.closest('.card').dataset.session; if (opened.has(id)) opened.delete(id); else opened.add(id); restoreLocal(); return; }
    const goal = e.target.closest('.goals [data-url]');
    if (goal) { e.preventDefault(); vscode.postMessage({ type: 'open', url: goal.dataset.url, external: e.metaKey || e.ctrlKey || e.altKey }); return; }
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
    if (a && a.dataset.url) { e.preventDefault(); vscode.postMessage({ type: 'open', url: a.dataset.url, external: e.metaKey || e.ctrlKey || e.altKey }); return; }
    if (card) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) { const id = card.dataset.session; if (multi.has(id)) multi.delete(id); else multi.add(id); syncBulk(); return; }
      vscode.postMessage({ type: 'select', sessionId: card.dataset.session, host: card.dataset.host, focus: card.dataset.here === '1' });
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
    const dev = e.target.closest && e.target.closest('[data-device]');
    if (dev) vscode.postMessage({ type: 'device', name: dev.dataset.device, field: 'enabled', value: dev.checked });
  });
  document.addEventListener('click', (e) => {
    const star = e.target.closest && e.target.closest('[data-star]');
    if (!star) return;
    const on = star.getAttribute('aria-pressed') !== 'true';
    star.setAttribute('aria-pressed', String(on)); star.textContent = on ? '★' : '☆';
    vscode.postMessage({ type: 'device', name: star.dataset.star, field: 'preferred', value: on });
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
    // Other…: Enter sends what was typed (after the same 5 s), Escape closes the box.
    const input = e.target.closest && e.target.closest('[data-ask-input]');
    if (input) {
      const key = input.closest('.ask').dataset.ask;
      if (e.key === 'Enter' && !e.isComposing && input.value.trim()) { e.preventDefault(); const text = input.value.trim(); input.value = ''; answerAsk(key, text.length > 40 ? text.slice(0, 40) + '\u2026' : text, { text }); }
      else if (e.key === 'Escape') { otherOpen.delete(key); drawAsk(key); }
      return;
    }
    // 1-9 answer the selected card's ask with that option.
    if (current === 'sessions' && /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target.closest && e.target.closest('input, textarea, select'))) {
      const held = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.card[data-session]') : null;
      const ask = (held || main.querySelector('.card.sel'))?.querySelector('.ask[data-ask] .opts:not([hidden])');
      const opt = ask ? ask.querySelectorAll('.opt')[Number(e.key) - 1] : null;
      if (opt) { e.preventDefault(); opt.click(); return; }
    }
    const tab = e.target.closest && e.target.closest('.tab');
    if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus(); choose(next.dataset.tab); return;
    }
    if (e.key === 'Escape') { const m = main.querySelector('.menu'); if (m) m.hidden = true; multi.clear(); syncBulk(); return; }
    if (e.target.closest && e.target.closest('a, button, summary')) return;
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
