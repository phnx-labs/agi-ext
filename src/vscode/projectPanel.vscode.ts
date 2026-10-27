import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runAgentsArgs, runCliArgs } from '../core/agentsBin';
import { AvatarCache } from '../core/avatarCache';
import { nextMilestone, openMilestones, parseGoals, renderGoals, type Goals } from '../core/goals';
import { resolveLaunchTarget, type LaunchTarget } from '../core/launchTarget';
import { mergeNow } from './prMerge.vscode';
import { blockedSessions } from '../core/sessionUpdates';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import { coalesceTrailing, createTrailingCoalesce } from '../core/cachedInFlight';
import { madeShelf, requestImageThumbs, sessionCardFields } from '../core/sessionCardFields';
import { frontTerminal, onDidChangeFrontTab, terminalTabNumbers } from './frontTab.vscode';
import { normalizeHost } from '../shared/project';
import type { RemoteSession } from '../core/remoteSessions';
import { sessionStreamDemand } from '../monitor/sessionDemand';
import {
  preferLive,
  parsePrs,
  parseProjectDetection,
  parseTickets,
  projectSessions,
  projectFallback,
  parseLinearProjects,
  projectMenu,
  displayHome,
  renderPrs,
  prFixPrompt,
  renderPrsProgress,
  paletteMatch,
  saidSnippet,
  renderPalette,
  renderSessions,
  nextThatNeedsYou,
  renderTickets, type TicketRowExtras,
  readSessionPrefs,
  readReviewPrefs,
  onTicket,
  sessionTitle,
  applyReviewPref,
  sessionCount,
  sessionMade,
  answerArgv,
  answerFailure,
  type LinearProject,
  type ProjectMenuRow,
  type ProjectRef,
  type PrsModel,
  type SessionHere,
  type SessionLike,
  type SessionListPrefs,
  type Ticket,
  type TicketGroup,
} from '../core/projectPanel';
import { SESSION_STATE_WORD, relTime, sessionStateOf, waitFor } from '../shared/sessionState';
import { readRegistry, registrySnapshot } from './projectRegistry.vscode';
import { currentAgentPanelSubject, followFrontTerminal, revealAgentPanel, setAgentPanelSubjectFromProject } from './agentPanel.vscode';
import { deliverReply, renameSession } from './sessionReply';
import { dictationMessage } from './dictation.vscode';
import { LOCAL_LABEL, LOCAL_MACHINE_ID, remoteDeviceArg } from './remoteSessions.vscode';
import * as terminals from './terminals.vscode';
import { openListedArtifact } from './sessionCardActions';
import { openLink, openWebviewUrl } from './webviewSecurity';
import { MADE_CSS, MADE_SCRIPT, PATCH_SCRIPT, RUSH_THEME_CSS, THUMB_SCRIPT, escapeHtml } from '../shared/sessionCards';
import { REPLY_BOX_CSS, REPLY_SCRIPT } from '../shared/replyBox';
import { LEAD_TAB_CSS, renderLeadTab } from '../core/leadView';
import { leadPanel } from './lead.vscode';
import { getNonce } from './htmlReader';
import { parseTicketView, renderTicketPeek, ticketPrompt } from '../core/ticketPeek';
import { applyPanelSetting, deviceSettingArgv, parseSettingsDevices, PICKABLE_AGENTS, renderPanelSettings, type DevicesState } from '../core/panelSettings';
import { cardSettings, panelTabs, validMergeMethod } from '../core/settings';
import { FrontHistory } from '../core/frontNav';
import { getSettings, maybeUpdateTerminalTitles, saveSettings } from './agentSettings.vscode';
import { harnessLogoCss } from './theme.vscode';
import { rememberTicket, rememberTicketGroups } from '../core/ticketFaces';
import { notifyAgentPanelSessionUpdate } from './agentPanel.vscode';
import { PanelDock, type PanelHost } from './panelDock.vscode';


// The Project sidebar panel (PHNX-4289): one view with tabs (Sessions, Issues,
// Review, and a Settings gear) for one project, while the other sidebar keeps the
// focused session. Only the active tab loads. Issues and Review each read their
// one CLI verb when shown (at most once per
// FRESH_MS) or on Refresh; a ticket row opens its Linear page as a tab and peeks at the
// description that read carried. Sessions draws the stream rows already in the presentation
// store and demands the stream only while it is the visible tab. Settings reads
// agentSettings and nothing else. Above the tabs, the company goal and today's
// goal are one `linear goals` read when the panel shows (at most once per
// FRESH_MS) or on Refresh. No timer anywhere.

const PICKED_PROJECT_KEY = 'agents.projectPanel.project';
const TAB_KEY = 'agents.projectPanel.tab';
const MILESTONE_KEY = 'agents.projectPanel.milestone';
const SESSION_PREFS_KEY = 'agents.projectPanel.sessionPrefs';
const REVIEW_PREFS_KEY = 'agents.projectPanel.reviewPrefs';
/** Starred session ids: a per-user preference, kept across windows and reloads. */
const FAVORITES_KEY = 'agents.projectPanel.favorites';
const FRESH_MS = 60_000;

type TabId = 'sessions' | 'tickets' | 'prs' | 'lead' | 'settings';
const TABS: readonly TabId[] = ['sessions', 'tickets', 'prs', 'lead', 'settings'];
const DEFAULT_AGENT_KEY = 'agents.defaultAgentTitle';
const SECONDARY_AGENT_KEY = 'agents.secondaryAgentTitle';
const VIEW_ID = 'agentsProject.panel';
/** Where pasted images live on this machine: the only files the panel shows or opens. */
const IMAGE_DIRS = () => [path.join(os.homedir(), '.agents', '.history', 'attachments'), path.join(os.homedir(), '.agents', '.cache', 'attachments')];

interface SessionTarget { sessionId: string; host: string }
interface PanelMessage {
  type?: string; tab?: unknown; url?: unknown; sessionId?: unknown; host?: unknown; path?: unknown;
  targets?: SessionTarget[]; tokens?: unknown; ref?: unknown; key?: unknown; value?: unknown; group?: unknown; id?: unknown; text?: unknown; repo?: unknown; number?: unknown; name?: unknown; agent?: unknown; where?: unknown; focus?: unknown; here?: unknown; answer?: unknown; step?: unknown; back?: unknown; sha?: unknown; choice?: unknown; field?: unknown; external?: unknown;
}

interface TabState {
  html: string | undefined;
  loadedFor: string | undefined;
  loadedAt: number;
  generation: number;
}

class ProjectView implements vscode.WebviewViewProvider {
  view: PanelHost | undefined;
  readonly dock = new PanelDock({ viewType: 'agents.project', command: 'agents.project.popOut', title: 'Project', attach: (host) => this.attach(host) });
  private active: TabId;
  private paletteOpen = false;
  private leadProject: string | undefined;
  private leadSub: vscode.Disposable | undefined;
  private readonly tabs = new Map<TabId, TabState>(TABS.map((t) => [t, { html: undefined, loadedFor: undefined, loadedAt: 0, generation: 0 }]));

  constructor(private readonly controller: ProjectPanelController, private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<string>(TAB_KEY);
    this.active = (TABS as readonly string[]).includes(saved ?? '') ? saved as TabId : 'sessions';
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.dock.resolveSidebar(view);
  }

  /** Draws the panel into the sidebar view or the tab it popped out into. */
  private attach(view: PanelHost): vscode.Disposable {
    this.view = view;
    // The editor's app icons ship in assets/; artifact images the agent made live
    // under home, as in the session sidebar.
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'assets'), vscode.Uri.file(os.homedir()), ...IMAGE_DIRS().map((d) => vscode.Uri.file(d))] };
    view.webview.html = shell(view.webview.cspSource, harnessLogoCss(view.webview, this.context.extensionUri));
    // A click that opens something says "Opening …" in the page until the host has acted.
    const opened = (p: unknown) => { void Promise.resolve(p).finally(() => view.webview.postMessage({ type: 'opened' })); };
    const onMessage = view.webview.onDidReceiveMessage((msg: PanelMessage) => {
      const host = typeof msg.host === 'string' ? msg.host : undefined;
      const targets = Array.isArray(msg.targets) ? msg.targets.filter((x): x is SessionTarget => !!x && typeof x.sessionId === 'string' && typeof x.host === 'string') : [];
      if (msg.type === 'ready') this.onReady();
      else if (msg.type === 'refresh') this.controller.refresh();
      else if (msg.type === 'tab' && typeof msg.tab === 'string' && (TABS as readonly string[]).includes(msg.tab)) void this.show(msg.tab as TabId);
      else if (msg.type === 'open') opened(openWebviewUrl(msg.url, msg.external === true));
      // The Lead tab: each gesture is one bridge call, which is one `agents lead …` verb.
      else if (msg.type === 'leadAsk' && typeof msg.text === 'string' && msg.text.trim()) void leadPanel()?.ask(msg.text.trim());
      else if (msg.type === 'leadTalk') void leadPanel()?.talk();
      else if (msg.type === 'leadConfirm' && typeof msg.key === 'string') void leadPanel()?.confirm(msg.key);
      else if (msg.type === 'leadConfirmAll' && typeof msg.tokens === 'string') void leadPanel()?.confirmAll(msg.tokens.split(' ').filter(Boolean));
      else if (msg.type === 'leadRef') void leadPanel()?.openRef(msg.ref, msg.external === true);
      else if (msg.type === 'pick') void vscode.commands.executeCommand('agents.project.pick');
      else if (msg.type === 'ticketTab' && typeof msg.id === 'string') opened(this.openTicketTab(msg.id));
      else if (msg.type === 'image' && typeof msg.path === 'string') opened(this.controller.openImage(msg.path));
      else if (msg.type === 'select' && typeof msg.sessionId === 'string' && msg.back === true) this.controller.back(msg.sessionId, host);
      else if (msg.type === 'select' && typeof msg.sessionId === 'string') opened(this.controller.select(msg.sessionId, host, msg.focus === true ? (msg.answer === true || msg.step === true ? 'always' : 'card') : 'no'));
      else if (msg.type === 'favorite' && typeof msg.sessionId === 'string' && typeof msg.value === 'boolean') void this.controller.setFavorite(msg.sessionId, msg.value);
      else if (msg.type === 'rename' && typeof msg.sessionId === 'string' && typeof msg.name === 'string') this.controller.rename(msg.sessionId, msg.name);
      else if (msg.type === 'openSession' && typeof msg.sessionId === 'string') void this.controller.goToSession(msg.sessionId, host);
      else if (msg.type === 'search') void this.openPalette();
      else if (msg.type === 'paletteClosed') this.paletteOpen = false;
      else if (msg.type === 'paletteGo' && typeof msg.sessionId === 'string') opened(this.controller.paletteGo(msg.sessionId, host, msg.here === true));
      else if (msg.type === 'copy' && typeof msg.text === 'string') void vscode.env.clipboard.writeText(msg.text);
      else if ((msg.type === 'focus' || msg.type === 'resume') && typeof msg.sessionId === 'string') opened(this.controller.goToSession(msg.sessionId, host));
      else if (msg.type === 'artifact' && typeof msg.sessionId === 'string' && typeof msg.path === 'string') opened(this.controller.openArtifact(msg.sessionId, host, msg.path));
      else if (msg.type === 'close') void this.controller.closeSessions(targets);
      else if (msg.type === 'reopen') void this.controller.reopen(targets);
      else if (msg.type === 'hide') void this.controller.hide(targets, true);
      else if (msg.type === 'unhide') void this.controller.hide(targets, false);
      else if (msg.type === 'closeAll') void this.controller.closeLeftoverTabs();
      else if (msg.type === 'prefs' && typeof msg.key === 'string') void this.controller.setPref(msg.key, msg.value);
      else if (msg.type === 'reviewPrefs' && typeof msg.key === 'string' && typeof msg.value === 'string') void this.controller.setReviewPref(msg.key, msg.value).then((html) => { if (html) this.post('prs', html); });
      else if (msg.type === 'fold' && typeof msg.group === 'string') void this.controller.toggleFold(msg.group);
      else if (msg.type === 'startTicket' && typeof msg.id === 'string') void this.controller.startOnTicket(msg.id, typeof msg.agent === 'string' ? msg.agent : undefined, typeof msg.where === 'string' ? resolveLaunchTarget(msg.where) : undefined);
      else if (msg.type === 'milestone' && typeof msg.name === 'string') void this.pickMilestone(msg.name);
      else if (msg.type === 'fixPr' && typeof msg.repo === 'string' && typeof msg.number === 'number') void this.controller.fixPr(msg.repo, msg.number);
      // The front card's reply box: its words go into that session's tab here, through
      // the one reply rail; the mic is the Active Session sidebar's recorder.
      else if (msg.type === 'reply' && typeof msg.sessionId === 'string' && typeof msg.text === 'string') {
        const error = deliverReply(terminals.getBySessionId(msg.sessionId), msg.text);
        void view.webview.postMessage({ type: 'replyResult', ok: !error, ...(error ? { error } : {}) });
      }
      else if (msg.type === 'dictate' || msg.type === 'dictationState') dictationMessage(msg, view.webview);
      else if (msg.type === 'openSidebar') revealAgentPanel();
      else if (msg.type === 'answer' && typeof msg.key === 'string' && (typeof msg.choice === 'string' || typeof msg.text === 'string')) void this.answer(msg.key, typeof msg.choice === 'string' ? { choice: msg.choice } : { text: msg.text as string });
      else if (msg.type === 'merge' && typeof msg.repo === 'string' && typeof msg.number === 'number') void this.mergeRow(msg.repo, msg.number, typeof msg.sha === 'string' ? msg.sha : undefined);
      else if (msg.type === 'setting' && typeof msg.key === 'string') {
        // Redraw either way, so a write that failed shows the stored value again.
        void this.controller.setSetting(msg.key, msg.value)
          .catch((e) => { void vscode.window.showErrorMessage(`Could not save the setting: ${errorText(e)}`); })
          .finally(() => { this.post('settings', this.controller.settings(this.devices)); this.postTabs(); });
      }
      else if (msg.type === 'device' && typeof msg.name === 'string' && (msg.field === 'enabled' || msg.field === 'preferred') && typeof msg.value === 'boolean') {
        const name = msg.name;
        // Only a device the CLI listed, so no page text can become a flag.
        if (this.devices && 'rows' in this.devices && this.devices.rows.some((d) => d.name === name) && !name.startsWith('-')) void this.setDevice(name, msg.field, msg.value);
      }
    });
    const onVisible = view.onDidChangeVisibility(() => { this.syncDemand(); if (view.visible) { void this.load(this.active, false); void this.loadGoals(false); } });
    this.syncDemand();
    void this.load(this.active, false);
    return {
      dispose: () => {
        onMessage.dispose();
        onVisible.dispose();
        this.leadSub?.dispose();
        this.leadSub = undefined;
        this.view = undefined;
        this.paletteOpen = false;
        for (const t of this.tabs.values()) { t.loadedFor = undefined; t.generation++; }
        sessionStreamDemand.setProjectSessionsVisible(false);
      },
    };
  }

  /** The Lead tab, drawn again from the bridge whenever the Lead or its mic changes. */
  private drawLead(): void {
    const lead = leadPanel();
    if (!lead || this.active !== 'lead' || !this.view?.visible) return;
    this.post('lead', renderLeadTab(lead.model(this.leadProject)));
  }

  private syncDemand(): void {
    sessionStreamDemand.setProjectSessionsVisible(!!this.view?.visible && this.active === 'sessions');
  }

  /** A message posted before the webview's script listens is dropped, so the first
   *  draw can be lost; the script says when it is ready and gets the tab again. */
  private onReady(): void {
    void this.view?.webview.postMessage({ type: 'tab', tab: this.active });
    this.postTabs();
    if (this.goalsHtml) void this.view?.webview.postMessage({ type: 'goals', html: this.goalsHtml });
    void this.loadGoals(false);
    const cached = this.tabs.get(this.active)!.html;
    if (cached) this.post(this.active, cached);
    else void this.load(this.active, false);
    this.postPalette();
  }

  /** Which of Review and Issues Settings shows beside Sessions. */
  private postTabs(): void {
    void this.view?.webview.postMessage({ type: 'tabs', ...panelTabs(getSettings(this.context).tabs) });
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
    if (tab === 'settings') {
      this.post(tab, this.controller.settings(this.devices));
      void this.loadDevices(force);
      // The view's title names the project on every tab, Settings included.
      void this.controller.project().then((p) => { if (this.view === view) view.title = p?.name; }, () => undefined);
      return;
    }
    const gen = ++state.generation;
    let project: ProjectRef | null;
    try {
      project = await this.controller.project();
    } catch (e) {
      if (gen === state.generation) this.post(tab, `<div class="err">${escapeHtml(errorText(e))}</div>`);
      return;
    }
    if (gen !== state.generation) return;
    // The project's name is the view's title, "PROJECT: RUSH"; ⇄ beside it switches it.
    view.title = project?.name;
    void view.webview.postMessage({ type: 'project', name: project?.name ?? '', picked: this.controller.picked() });
    if (!project) {
      this.post(tab, '<div class="empty">No project found for this folder. <a href="#" data-pick>Pick a project</a></div>');
      return;
    }
    if (tab === 'lead') {
      const lead = leadPanel();
      if (!lead) { this.post(tab, '<div class="err">The Lead is not loaded in this window.</div>'); return; }
      this.leadProject = project.name;
      if (!this.leadSub) this.leadSub = lead.onChange(() => this.drawLead());
      this.drawLead();
      void lead.load(project.name, force);
      return;
    }
    if (tab !== 'tickets' && this.controller.ticketsOnly(project)) {
      this.post(tab, `<div class="empty">${escapeHtml(project.name)} is a Linear project no agents project links, so it has tickets but no sessions or pull requests here.</div>`);
      return;
    }
    if (tab === 'sessions') {
      // Ticket tiles show titles from the Issues read; Sessions shares it, once per FRESH_MS.
      this.controller.warmTicketFaces(project);
      const { html, count } = this.controller.sessions(project, view.webview);
      void view.webview.postMessage({ type: 'count', tab: 'sessions', n: count.shown, asks: count.asks });
      // Most stream facts are another project's: the page already shows this list, so a
      // copy of it (hundreds of KB for hundreds of sessions) is neither sent nor parsed.
      if (html !== state.html) this.post(tab, html);
      this.postPalette();
      return;
    }
    const fresh = state.loadedFor === project.name && Date.now() - state.loadedAt < FRESH_MS;
    if (fresh && !force) return;
    if (state.loadedFor !== project.name) this.post(tab, '<div class="empty">Loading…</div>');
    else void view.webview.postMessage({ type: 'loading' });
    let html: string;
    let ok = true;
    try {
      html = tab === 'prs' ? await this.controller.reviewByRepo(project, force, (partial) => { if (gen === state.generation) this.post(tab, partial); })
          : await this.controller.render(tab, project, force);
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

  private readonly redraws = createTrailingCoalesce();

  /** A burst of redraws (stream facts, a click, the tab it fronts) is one draw plus one catch-up. */
  redrawSessions(): Promise<void> {
    return coalesceTrailing(this.redraws, 'sessions', () => this.load('sessions', false));
  }

  /** The title bar's gear and ⌃1–⌃4: the panel comes up on that tab, through the page's own switch. */
  async open(tab: TabId): Promise<void> {
    // Not drawn yet: its ready message asks for the tab, so that is the one it shows.
    if (!this.view) { this.active = tab; void this.context.workspaceState.update(TAB_KEY, tab); }
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    void this.view?.webview.postMessage({ type: 'choose', tab });
  }

  /** ⌘K: the panel comes up on Sessions (its own view or the window it popped out into)
   *  and its page draws the session palette over the list; nothing else is opened. */
  async openPalette(): Promise<void> {
    this.paletteOpen = true;
    if (this.view) this.view.show(false);
    else await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    void this.view?.webview.postMessage({ type: 'choose', tab: 'sessions' });
    this.postPalette();
  }

  /** While ⌘K is open its rows follow the stream, as the list does. */
  private postPalette(): void {
    const view = this.view;
    if (!this.paletteOpen || !view) return;
    const waiting = !sessionPresentationStore.hasSeenReset();
    void view.webview.postMessage({ type: 'palette', html: waiting ? '' : this.controller.palette(view.webview), waiting });
  }

  /** Scroll the card for this session into view, once the list has it. */
  reveal(sessionId: string, flash = true): void {
    if (this.active === 'sessions') void this.view?.webview.postMessage({ type: 'reveal', sessionId, flash });
  }


  /** A ticket tile, here or in the session panel: its row peeks in Issues and its Linear
   *  page opens as a tab. */
  async openTicketTab(id: string): Promise<void> {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    if (this.active !== 'tickets') {
      this.active = 'tickets';
      void this.context.workspaceState.update(TAB_KEY, 'tickets');
      this.syncDemand();
    }
    void this.view?.webview.postMessage({ type: 'tab', tab: 'tickets' });
    void this.view?.webview.postMessage({ type: 'peek', id });
    const cached = this.tabs.get('tickets')!.html;
    if (cached) this.post('tickets', cached);
    await Promise.all([this.load('tickets', false), this.controller.openTicketPage(id)]);
  }

  notice(text: string): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage({ type: 'notice', text });
  }

  /** Refresh rereads what is shown. */
  refresh(projectChanged = false): void {
    for (const t of TABS) { this.tabs.get(t)!.html = undefined; void this.load(t, true); }
    // Another project's milestone never stays up while this one's is read.
    if (projectChanged) { this.goalsHtml = ''; void this.view?.webview.postMessage({ type: 'goals', html: '' }); }
    void this.loadGoals(true);
  }

  private merging: Promise<void> = Promise.resolve();

  /** Merge from a PR row: one read of that PR (the list has no head commit), a
   *  method or admin merge from the menu, a dialog, then one pinned merge. */
  private async mergeRow(repo: string, number: number, sha: string | undefined): Promise<void> {
    // Merges run one after another, never dropped; Review is reread after each merge,
    // and a refused one keeps its reason on the row until the next read.
    this.merging = this.merging.then(async () => {
      // The row's ring says how it went: violet and Merged, or red with GitHub's reason on its meta line.
      let merged = false;
      let error = '';
      try {
        merged = await this.controller.mergeFromRow(repo, number, sha);
      } catch (e) {
        error = errorText(e).split('\n')[0] ?? 'merge failed';
      }
      // Merged: violet, then Review rereads. Refused by GitHub: red with its reason, and a
      // click tries again. Turned down here (a closed dialog, a new commit; its warning
      // says why): Review rereads, so the row shows what is true now.
      void this.view?.webview.postMessage({ type: 'merged', repo, number, error, merged });
      if (!error) await this.load('prs', true);
    });
    await this.merging;
  }

  /** An answer from a card (at once, or after the 5 s Undo Settings asks for): one
   *  `agents feed answer`; the card shows what the CLI said when it was not delivered. */
  private async answer(key: string, answer: { choice: string } | { text: string }): Promise<void> {
    const error = await this.controller.answer(key, answer);
    void this.view?.webview.postMessage({ type: 'answered', key, error });
  }

  private goalsAt = 0;
  /** The last goals line drawn: a page the editor rebuilt (moved, popped out) gets it again on ready. */
  private goalsHtml = '';
  private goalsGen = 0;

  /** The two goal lines above the tabs; a failed read says so on one faint line. */
  /** A pick in the header's milestone menu: the header names it and Issues lists only its tickets. */
  private async pickMilestone(name: string): Promise<void> {
    const html = await this.controller.pickMilestone(name);
    if (html === undefined) return;
    this.goalsHtml = html;
    void this.view?.webview.postMessage({ type: 'goals', html });
    if (this.active === 'tickets') void this.load('tickets', false);
  }

  private async loadGoals(force: boolean): Promise<void> {
    if (!this.view?.visible) return;
    if (!force && Date.now() - this.goalsAt < FRESH_MS) return;
    this.goalsAt = Date.now();
    const gen = ++this.goalsGen;
    let html: string;
    const before = this.controller.todayId;
    try {
      html = await this.controller.goals();
    } catch (e) {
      this.goalsAt = 0;
      html = `<div class="gerr" title="${escapeHtml(errorText(e))}">Goals could not be read: ${escapeHtml(errorText(e).split('\n')[0] ?? '')}</div>`;
    }
    // A read overtaken by a newer one (a project switch while it ran) is dropped.
    if (gen !== this.goalsGen) return;
    this.goalsHtml = html;
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

  private avatarTimer: ReturnType<typeof setTimeout> | undefined;

  /** Pictures that just reached the avatar cache: Issues or Review is drawn again from what it last read. */
  avatarsArrived(): void {
    clearTimeout(this.avatarTimer);
    this.avatarTimer = setTimeout(async () => {
      const tab = this.active;
      if ((tab !== 'tickets' && tab !== 'prs') || !this.view?.visible) return;
      const p = await this.controller.project().catch(() => null);
      const html = p ? await this.controller.redrawn(tab, p).catch(() => undefined) : undefined;
      if (html !== undefined && this.active === tab) this.post(tab, html);
    }, 250);
  }

  private post(tab: TabId, html: string): void {
    this.tabs.get(tab)!.html = html;
    if (tab === this.active) void this.view?.webview.postMessage({ type: 'html', tab, html });
  }
}

/** One `linear` call in a project's Linear workspace. An unset profile is `default`, so the
 *  extension host's own folder never picks the workspace. */
function runLinear(args: string[], profile: string | null, timeout: number): Promise<{ stdout: string }> {
  return runCliArgs('linear', args, { timeout, maxBuffer: 20 * 1024 * 1024, env: { LINEAR_PROFILE: profile ?? 'default' } });
}

/** What the project menu stores for a window: an agents project, or a Linear project no
 *  agents project links. */
type PickedProject = { name: string; linear?: undefined } | { name?: undefined; linear: LinearProject & { profile: string | null } };

function errorText(e: unknown): string {
  return (e as { stderr?: string }).stderr?.trim() || (e instanceof Error ? e.message : String(e));
}

class ProjectPanelController {
  private detected: Promise<ProjectRef | null> | undefined;
  /** One `linear tasks` read feeds Issues (and a ticket's Start agent and peek). */
  private tickets: { project: string; at: number; groups: Promise<TicketGroup[]> } | undefined;
  /** The last Issues read that answered: Start and a ticket's page find a ticket in it. */
  private ticketsSeen: TicketGroup[] = [];
  readonly view: ProjectView;
  /** Which session tabs this window had in front, and when: Next that needs you and Back read it. */
  readonly history = new FrontHistory();

  private readonly avatars: AvatarCache;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.view = new ProjectView(this, context);
    this.avatars = new AvatarCache(path.join(os.homedir(), '.agents', '.cache', 'avatars'), () => this.view.avatarsArrived());
  }

  /** A person's picture from the avatar cache as the webview loads it; null (initials) until it is there. */
  private avatarUri(url: string): string | null {
    const file = this.avatars.file(url);
    const webview = this.view.view?.webview;
    return file && webview ? webview.asWebviewUri(vscode.Uri.file(file)).toString() : null;
  }

  /** Issues or Review drawn again from the read already made, never a new one. */
  async redrawn(tab: 'tickets' | 'prs', p: ProjectRef): Promise<string | undefined> {
    if (tab === 'tickets') return this.tickets?.project === p.name ? this.drawTickets(p, await this.tickets.groups) : undefined;
    const seen = this.reviewSeen;
    return seen ? renderPrsProgress(seen.slugs, seen.done, Date.now(), this.reviewOptions()) : undefined;
  }

  /** The picked project for this workspace, else the one containing its first folder. */
  project(): Promise<ProjectRef | null> {
    const picked = this.pickedState();
    if (picked?.linear) {
      const l = picked.linear;
      // A project linked to it since the pick takes over, so Sessions and Review follow.
      return readRegistry().then((all) => all.find((p) => p.linearId === l.id)
        ?? { name: l.name, linearName: l.name, linearId: l.id, linearProfile: l.profile, repos: [] });
    }
    if (picked?.name) {
      const name = picked.name;
      return readRegistry().then((all) => {
        const found = all.find((p) => p.name === name);
        if (!found) throw new Error(`The project picked for this window, ${name}, is no longer in agents projects list. Pick another.`);
        return found;
      });
    }
    return this.detectedProject();
  }

  private pickedState(): PickedProject | undefined {
    const v = this.context.workspaceState.get<PickedProject>(PICKED_PROJECT_KEY);
    return v?.name || v?.linear?.id ? v : undefined;
  }

  /** What detection gives this window's folder, asked once until it finds one. */
  private detectedProject(): Promise<ProjectRef | null> {
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
    return !!this.pickedState();
  }

  /** A picked Linear project no agents project links: it has tickets, but no sessions or PRs. */
  ticketsOnly(p: ProjectRef): boolean {
    const l = this.pickedState()?.linear;
    return !!l && p.linearId === l.id && p.name === l.name && !p.repos?.length;
  }

  /** The project menu reads the list fresh each time it opens; the read also refreshes the shared registry. */
  private projectList(): Promise<ProjectRef[]> {
    return readRegistry(true);
  }

  /** The Linear projects the menu last read, so a pick stores the one it showed. */
  private linearSeen: { projects: LinearProject[]; profile: string | null } = { projects: [], profile: null };

  /** The project menu: one `agents projects list` and one `linear projects --json` read
   *  when it opens, in the shown project's Linear workspace. */
  async menu(): Promise<{ folder: string; picked: boolean; rows: ProjectMenuRow[]; linearError?: string }> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const [all, current, found] = await Promise.all([this.projectList(), this.project().catch(() => null), this.detectedProject().catch(() => null)]);
    const profile = current?.linearProfile ?? null;
    let linear: LinearProject[] | null = null;
    let linearError: string | undefined;
    try {
      linear = parseLinearProjects((await runLinear(['projects', '--json'], profile, 30_000)).stdout);
      this.linearSeen = { projects: linear, profile };
    } catch (e) {
      linearError = errorText(e).split('\n')[0] ?? 'failed';
    }
    return { folder: displayHome(folder), picked: this.picked(), rows: projectMenu(all, linear, current, found?.name ?? null), ...(linearError ? { linearError } : {}) };
  }

  /** Show what a menu row names here, remembered for the workspace; '' goes back to detection. */
  async pickByName(pick: string): Promise<void> {
    let next: PickedProject | undefined;
    if (pick.startsWith('linear:')) {
      const l = this.linearSeen.projects.find((x) => `linear:${x.id}` === pick);
      if (!l) throw new Error('That Linear project is not in the list just read. Open the menu again.');
      next = { linear: { ...l, profile: this.linearSeen.profile } };
    } else if (pick) {
      const p = (await this.projectList()).find((x) => x.name === pick);
      if (!p) throw new Error(`No project named ${pick}`);
      next = { name: p.name };
    }
    await this.context.workspaceState.update(PICKED_PROJECT_KEY, next);
    this.refresh(true);
  }

  private facesTriedAt = 0;

  /** Read the Issues list for ticket tiles at most once per FRESH_MS, failed or not; never throws. */
  warmTicketFaces(p: ProjectRef): void {
    if (!p.linearId || Date.now() - this.facesTriedAt < FRESH_MS) return;
    this.facesTriedAt = Date.now();
    this.ticketGroups(p, false).catch(() => undefined);
  }

  /** Open PRs per repository, drawn as each repository answers. */
  async reviewByRepo(p: ProjectRef, force: boolean, partial: (html: string) => void): Promise<string> {
    // The list as last read: Review's first draw waited on a fresh `agents projects list` before any PR read.
    const repos = (await readRegistry()).find((x) => x.name === p.name)?.repos ?? [];
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
      if (!p.linearId) throw new Error(`${p.name} has no Linear project. Pick one from the project menu, or link it: agents projects link ${p.name} --linear`);
      const { stdout } = await runLinear(['tasks', '--project', p.linearId, '--json'], p.linearProfile, 60_000);
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
    if (id === 'tickets') {
      return this.drawTickets(p, await this.ticketGroups(p, force));
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
    const model = parsePrs(stdout);
    this.reviewSeen = { slugs: model.repos.map((r) => r.slug), done: new Map(model.repos.map((r) => [r.slug, r])) };
    return renderPrs(model, Date.now(), this.reviewOptions());
  }

  private drawTickets(p: ProjectRef, all: TicketGroup[]): string {
    const chosen = this.chosenMilestone(p.name);
    const groups = all.map((g) => ({ ...g, tickets: chosen ? g.tickets.filter((t) => t.milestone === chosen) : g.tickets })).filter((g) => g.tickets.length);
    const where = resolveLaunchTarget(vscode.workspace.getConfiguration('agents').get<string>('launch.defaultTarget'));
    return renderTickets(groups, (t) => this.ticketRow(p, t), this.headMilestone, where);
  }

  /** The PRs last read, so a ⇅ change redraws Review without reading GitHub again. */
  private reviewSeen: { slugs: string[]; done: Map<string, PrsModel['repos'][number]> } | undefined;

  private reviewOptions() {
    return { prefs: readReviewPrefs(this.context.workspaceState.get(REVIEW_PREFS_KEY)), mergeWith: getSettings(this.context).mergeMethod ?? 'squash', avatar: (url: string) => this.avatarUri(url), fixAgent: { key: this.defaultAgent().key, name: this.defaultAgent().name } };
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
  /** The milestone the header shows; Issues names a ticket's milestone only when it differs. */
  headMilestone: string | undefined;
  /** The last goals read, so a milestone pick redraws the header without reading again. */
  private goalsSeen: { goals: Goals; project: string; linearName: string | null | undefined } | undefined;

  /** The milestone Issues shows for a project, picked in the header's menu; none is all.
   *  A pick that is no longer open (finished, renamed) is all, as the header then shows. */
  private chosenMilestone(project: string): string | undefined {
    const name = this.context.workspaceState.get<Record<string, string>>(MILESTONE_KEY)?.[project] || undefined;
    const seen = this.goalsSeen;
    if (!name || !seen || seen.project !== project) return name;
    return openMilestones(seen.goals, seen.linearName).some((m) => m.name === name) ? name : undefined;
  }

  async pickMilestone(name: string): Promise<string | undefined> {
    const seen = this.goalsSeen;
    if (!seen) return undefined;
    await this.context.workspaceState.update(MILESTONE_KEY, { ...this.context.workspaceState.get<Record<string, string>>(MILESTONE_KEY), [seen.project]: name });
    return this.goalsLine(seen);
  }

  private goalsLine(seen: NonNullable<ProjectPanelController['goalsSeen']>): string {
    const chosen = this.chosenMilestone(seen.project);
    this.headMilestone = chosen ?? nextMilestone(seen.goals, seen.linearName)?.name;
    return renderGoals(seen.goals, seen.linearName, chosen);
  }

  /** Company and today's goal of the project's Linear workspace: one `linear goals` read. */
  async goals(): Promise<string> {
    const project = await this.project().catch(() => null);
    const { stdout } = await runLinear(['goals', '--json'], project?.linearProfile ?? null, 30_000);
    const goals = parseGoals(stdout);
    this.todayId = goals.today?.id;
    this.goalsSeen = { goals, project: project?.name ?? '', linearName: project?.linearName };
    return this.goalsLine(this.goalsSeen);
  }

  private ticketById(id: string): Ticket | undefined {
    for (const g of this.ticketsSeen) for (const t of g.tickets) if (t.identifier === id) return t;
    return undefined;
  }

  /** A row's ▶ agent and its peek: the description the list read carried, and the live
   *  sessions on the ticket. */
  private ticketRow(p: ProjectRef, t: Ticket): TicketRowExtras {
    const agent = this.ticketAgent(t);
    const rows = this.projectRows(p).filter((r) => sessionStateOf(r) !== 'ended' && (r.ticket === t.identifier || onTicket(r, t.identifier)));
    const onIt = rows.map((r) => ({
      sessionId: r.sessionId, host: r.host, title: sessionTitle(r), state: SESSION_STATE_WORD[sessionStateOf(r)], where: r.host === LOCAL_LABEL || !r.host ? 'this machine' : r.host,
    }));
    return {
      agentKey: agent.key,
      agentName: agent.name,
      peek: renderTicketPeek(t.identifier, t.description, onIt),
      avatar: t.assigneeAvatar ? this.avatarUri(t.assigneeAvatar) : null,
      onIt: rows.map((r) => ({ agentType: r.agentType, state: sessionStateOf(r), title: sessionTitle(r), sessionId: r.sessionId, host: r.host })),
    };
  }

  /** Open a ticket's Linear page as a tab: the URL the Issues read carried (waiting for
   *  that read when it is still running), else one `linear tasks <ID>` read for a
   *  ticket not in it (a closed one). */
  async openTicketPage(id: string): Promise<void> {
    let url = this.ticketById(id)?.url;
    try {
      if (!url) {
        const project = await this.project();
        if (!project) throw new Error('No project found for this folder; pick one from the project menu to read its tickets.');
        await this.ticketGroups(project, false).catch(() => undefined);
        url = this.ticketById(id)?.url;
        if (!url) {
          const { stdout } = await runLinear(['tasks', id, '--json'], project.linearProfile, 60_000);
          const t = parseTicketView(stdout);
          if (rememberTicket(t)) { void this.view.redrawSessions(); notifyAgentPanelSessionUpdate(); }
          url = t.url;
        }
      }
      if (!url) throw new Error('Linear gave no page for it.');
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not open ${id}: ${errorText(e)}`);
      return;
    }
    await openLink(url);
  }

  /** Start runs the agent Linear delegates the ticket to when this version launches it
   *  ("Claude", "codex1" → Codex), else your default agent. */
  private ticketAgent(t: Pick<Ticket, 'delegate'>): (typeof PICKABLE_AGENTS)[number] & { delegated: boolean } {
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
    if (!p) { void this.view.notice(`#${number} is not in the PR list just read; Review is reading it again.`); void this.view.load('prs', true); return; }
    try {
      const project = await this.project().catch(() => null);
      const checkout = project ? (await readRegistry()).find((x) => x.name === project.name)?.repos?.find((r) => r.slug === slug)?.path || null : null;
      await vscode.commands.executeCommand('agents.spawnWithPrompt', { agent: this.defaultAgent().key, prompt: prFixPrompt(p, slug, checkout) });
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not start an agent on #${number}: ${errorText(e)}`);
      void this.view.load('prs', true);
    }
  }

  /** Start on a ticket from its row: the agent in a new tab here, running where ▾ says
   *  (else the Launch target setting), through the same launch as Agents: Spawn With Prompt. */
  async startOnTicket(id: string, agent?: string, where?: LaunchTarget): Promise<void> {
    const t = this.ticketById(id);
    if (!t) { void this.view.notice(`${id} is not in the ticket list just read; Issues is reading it again.`); void this.view.load('tickets', true); return; }
    const key = agent && PICKABLE_AGENTS.some((a) => a.key === agent) ? agent : this.ticketAgent(t).key;
    try {
      await vscode.commands.executeCommand('agents.spawnWithPrompt', { agent: key, prompt: ticketPrompt(t), where: where ?? resolveLaunchTarget(vscode.workspace.getConfiguration('agents').get<string>('launch.defaultTarget')) });
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
      leadSpeak: vscode.workspace.getConfiguration('agents').get<boolean>('lead.speak', false),
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
    if (key === 'lead.speak' && typeof value === 'boolean') {
      await vscode.workspace.getConfiguration('agents').update('lead.speak', value, vscode.ConfigurationTarget.Global);
      return;
    }
    const previous = getSettings(this.context);
    const next = applyPanelSetting(previous, key, value);
    if (!next) return;
    await saveSettings(this.context, next);
    if (key.startsWith('display.')) await maybeUpdateTerminalTitles(previous, next);
    if (key.startsWith('pages.')) await vscode.commands.executeCommand('agents.pages.refresh');
  }

  /** The project's sessions: the CLI's own project, plus (until agents-cli maps a
   *  project's old names) a session whose checkout is one of its repositories, plus
   *  every session with a tab in this window, whatever its project. */
  private projectRows(p: ProjectRef): SessionLike[] {
    const registry = registrySnapshot();
    // The registry answers once; the list redraws then. Until it has, only rows the CLI filed under no project fall back.
    if (!registry) void readRegistry().then(() => this.view.redrawSessions(), () => undefined);
    return projectSessions(preferLive(this.presented()) as unknown as SessionLike[], p.name, projectFallback(p, registry), (r) => !!terminals.getBySessionId(r.sessionId));
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

  /** Sessions the viewer starred, by session id, in every window (globalState). */
  favorites(): Set<string> {
    const v = this.context.globalState.get<unknown>(FAVORITES_KEY);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  }

  async setFavorite(sessionId: string, on: boolean): Promise<void> {
    const favs = this.favorites();
    if (on) favs.add(sessionId); else favs.delete(sessionId);
    await this.context.globalState.update(FAVORITES_KEY, [...favs]);
    void this.view.redrawSessions();
  }

  /** The pinned card's title: Claude's own /rename, typed into that session's tab here.
   *  The card and the tab change when the stream reports the new title. */
  rename(sessionId: string, name: string): void {
    const entry = terminals.getBySessionId(sessionId);
    const row = this.presented().find((r) => r.sessionId === sessionId);
    if (!entry || row?.agentType !== 'claude') { void this.view.notice('Rename needs this Claude session’s tab here.'); return; }
    const typed = renameSession(entry.terminal, name);
    if (typed) void this.view.notice(`Typed /rename ${typed} into its tab; the title changes when the session reports it.`);
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

  private here(webview?: vscode.Webview): SessionHere {
    const app = vscode.env.appName;
    const editor: SessionHere['editor'] = /codium/i.test(app) ? 'vscodium' : /cursor/i.test(app) ? 'cursor' : 'vscode';
    const asset = (...p: string[]) => webview ? webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', ...p)).toString() : '';
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

  /** The project's rows with this window's tabs on them, and what the list reads beside them. */
  private sessionFacts(p: ProjectRef) {
    const tabNumbers = terminalTabNumbers();
    const rows = this.projectRows(p)
      .map((r) => {
        const tab = terminals.getBySessionId(r.sessionId);
        const who = sessionPresentationStore.liveSession(r.sessionId);
        return { ...r, tabHere: !!tab, tabIndex: tab ? tabNumbers.get(tab.terminal) : undefined, account: who?.account ?? who?.accountLabel ?? undefined };
      });
    const byId = new Map(this.presented().map((r) => [r.sessionId, r]));
    const lastUserAt = (id: string) => { const live = byId.get(id) ?? byId.get('session_' + id); const turns = live?.userTurns ?? []; return turns.length ? turns[turns.length - 1]!.atMs : undefined; };
    const blockedIds = new Set(blockedSessions(sessionPresentationStore.activityEvents(), lastUserAt).keys());
    const front = frontTerminal();
    const frontId = front ? terminals.getByTerminal(front)?.sessionId || null : null;
    // A tab whose session the stream bound after it came forward enters the history here.
    this.history.front(frontId || undefined, Date.now());
    return { rows, byId, blockedIds, frontId, prefs: this.prefs() };
  }

  sessions(p: ProjectRef, webview: vscode.Webview): { html: string; count: { shown: number; asks: number } } {
    if (!sessionPresentationStore.hasSeenReset()) return { html: '<div class="empty">Waiting for the session stream…</div>', count: { shown: 0, asks: 0 } };
    const { rows, byId, blockedIds, frontId, prefs } = this.sessionFacts(p);
    const previewUri = (f: string) => webview.asWebviewUri(vscode.Uri.file(f)).toString();
    const thumbsFor = (s: SessionLike) => {
      const live = byId.get(s.sessionId);
      return live ? requestImageThumbs(live, { home: os.homedir(), remoteDevice: remoteDeviceArg(live.host), exists: (f) => fs.existsSync(f), previewUri }) : [];
    };
    const fieldsFor = (s: SessionLike) => {
      const live = byId.get(s.sessionId);
      if (!live) return null;
      const remoteDevice = remoteDeviceArg(live.host);
      return { live, card: sessionCardFields(live, { sessionId: live.sessionId, home: os.homedir(), remoteDevice, previewUri: remoteDevice ? undefined : previewUri }) };
    };
    const madeFor = (s: SessionLike) => { const f = fieldsFor(s); return f ? sessionMade(f.card) : null; };
    const cards = cardSettings(getSettings(this.context).cards);
    // The pinned card's Made shelf is the Active Session sidebar's, with no Share (that lives
    // there), drawn as one row of chips unless Settings asks for previews.
    const shelfFor = (s: SessionLike) => { const f = fieldsFor(s); return f ? { ...madeShelf(f.live, f.card), sessionLocal: false, chips: cards.made === 'chips' } : null; };
    const here = this.here(webview);
    const subject = currentAgentPanelSubject();
    const count = sessionCount(rows, here, prefs, frontId);
    return { html: renderSessions(rows, Date.now(), { selectedId: subject?.sessionId ?? null, frontId, here, prefs, thumbsFor, madeFor, shelfFor, todayId: this.todayId, blockedIds, project: p.name, linearName: p.linearName ?? undefined, cards, memory: this.history, favorites: this.favorites() }), count: { shown: count.shown, asks: count.asks } };
  }

  /** Agents: Next Agent That Needs You: fronts the session tab › fronts in
   *  Next-that-needs-you (an ask, then a turn that finished since you looked, then the
   *  other idle tabs), from any tab or editor in front. */
  async nextNeedsYou(): Promise<void> {
    const p = await this.project().catch(() => null);
    const next = p && sessionPresentationStore.hasSeenReset() ? (() => {
      const { rows, blockedIds, frontId, prefs } = this.sessionFacts(p);
      return nextThatNeedsYou(rows, { selectedId: null, frontId, here: this.here(), prefs, todayId: this.todayId, blockedIds, memory: this.history });
    })() : undefined;
    if (!next) { vscode.window.setStatusBarMessage(p ? 'Nothing needs you: every other agent is working' : 'No project in this window', 4000); return; }
    this.select(next.row.sessionId, next.row.host, 'always');
  }

  /** ‹ in Next-that-needs-you: back to the session tab in front before, like Back in a browser. */
  back(sessionId: string, host: string | undefined): void {
    this.history.goBack(sessionId);
    this.select(sessionId, host, 'always');
  }

  /** Show the session in the sidebar; its tab in this window comes forward, wherever its
   *  agent runs (s1, m1…). A card asks through Settings > Card click; ⌘K and an answer
   *  always front it. Nothing is resumed or spawned. */
  select(sessionId: string, host: string | undefined, front: 'card' | 'always' | 'no' = 'no'): void {
    setAgentPanelSubjectFromProject(sessionId, host);
    void this.view.redrawSessions();
    if (front === 'no' || (front === 'card' && cardSettings(getSettings(this.context).cards).click !== 'front')) return;
    terminals.getBySessionId(sessionId)?.terminal.show(false);
  }

  /** ⌘K's rows: every session the store holds (live and ended, any project), with its
   *  tab here, what it made and the images you attached (`renderPalette`). Nothing is read. */
  palette(webview: vscode.Webview): string {
    const tabNumbers = terminalTabNumbers();
    const previewUri = (f: string) => webview.asWebviewUri(vscode.Uri.file(f)).toString();
    const entries = preferLive(this.presented()).map((r) => {
      const tab = terminals.getBySessionId(r.sessionId);
      const row = { ...(r as unknown as SessionLike), tabHere: !!tab, tabIndex: tab ? tabNumbers.get(tab.terminal) : undefined };
      const remoteDevice = remoteDeviceArg(r.host);
      const card = sessionCardFields(r, { sessionId: r.sessionId, home: os.homedir(), remoteDevice, previewUri: remoteDevice ? undefined : previewUri });
      return { row, made: sessionMade(card), images: requestImageThumbs(r, { home: os.homedir(), remoteDevice, exists: (f) => fs.existsSync(f), previewUri }) };
    });
    return renderPalette(entries, Date.now(), this.favorites(), { device: normalizeHost(os.hostname()), localHost: LOCAL_LABEL });
  }

  /** Enter in ⌘K (the approved prototype's kpick): a tab here comes forward as a card click
   *  does; a live session elsewhere shows in the sidebar and comes forward where it runs, as
   *  its ↗ does; an ended one resumes, as its ▶ does, unless the CLI says it cannot. */
  paletteGo(sessionId: string, host: string | undefined, here: boolean): Promise<void> | void {
    if (here) { this.select(sessionId, host, 'always'); this.view.reveal(sessionId); return; }
    const row = preferLive(this.presented().filter((r) => r.sessionId === sessionId))[0];
    this.select(sessionId, host, 'no');
    this.view.reveal(sessionId);
    if (row && sessionStateOf(row as unknown as SessionLike) === 'ended' && row.resumable === false) return;
    return this.goToSession(sessionId, host);
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

  /** The command palette's project menu: the same rows as the panel's. */
  async pick(): Promise<void> {
    const { rows, picked, linearError } = await this.menu();
    const items = rows.map((r) => ({ label: `${r.current ? '$(check) ' : ''}${r.label}`, description: r.found ? `${r.detail} · found from this folder` : r.detail, pick: r.pick }));
    if (picked) items.push({ label: 'Use detection again', description: 'the project found from this folder', pick: '' });
    const choice = await vscode.window.showQuickPick(items, { placeHolder: linearError ? `Linear projects could not be read: ${linearError}` : 'Show which project in the Project sidebar?' });
    if (choice) await this.pickByName(choice.pick);
  }

  refresh(projectChanged = false): void {
    this.tickets = undefined;
    this.detected = undefined;
    // Tickets and pull requests read are the shown project's; a switch must not keep the last one's.
    if (projectChanged) { this.ticketsSeen = []; this.reviewSeen = undefined; }
    this.view.refresh(projectChanged);
  }
}

let activeController: ProjectPanelController | undefined;

/** Called by extension.ts when a session-stream fact changed the store; the
 *  Sessions tab redraws from memory (no subprocess).
 *  @public loaded with require('./projectPanel.vscode') in extension.ts, which knip cannot see */
export function notifyProjectPanelSessionUpdate(): void {
  const controller = activeController;
  if (!controller) return;
  void controller.redrawSessions();
}

/** @public loaded with require('./projectPanel.vscode') in extension.ts, which knip cannot see */
export function registerProjectPanel(context: vscode.ExtensionContext): void {
  const controller = new ProjectPanelController(context);
  activeController = controller;
  context.subscriptions.push({ dispose: () => { if (activeController === controller) activeController = undefined; } });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, controller.view, {
    webviewOptions: { retainContextWhenHidden: true },
  }));
  controller.view.dock.register(context);
  const atStart = frontTerminal();
  controller.history.front(atStart ? terminals.getByTerminal(atStart)?.sessionId || undefined : undefined, Date.now());
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.project.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('agents.project.settings', () => controller.view.open('settings')),
    vscode.commands.registerCommand('agents.project.tab', (tab: unknown) => (TABS as readonly unknown[]).includes(tab) ? controller.view.open(tab as TabId) : undefined),
    vscode.commands.registerCommand('agents.project.pick', () => controller.pick().catch((e) => {
      void vscode.window.showErrorMessage(`Could not list projects: ${errorText(e)}`);
    })),
    // Internal: the session panel's ticket tile opens the ticket here.
    vscode.commands.registerCommand('agents.searchSessions', () => controller.view.openPalette()),
    vscode.commands.registerCommand('agents.nextNeedsYou', () => controller.nextNeedsYou()),
    // The list follows the tab in front: switching tabs moves its selection (owner video,
    // 2026-10-12), on either tab event, never with a flash (PHNX-4387).
    // A tab with no session yet (a new agent, a shell) still moves THIS TAB and the sidebar.
    onDidChangeFrontTab((t) => {
      const id = t ? terminals.getByTerminal(t)?.sessionId : undefined;
      controller.history.front(id || undefined, Date.now());
      followFrontTerminal();
      void controller.redrawSessions().then(() => { if (id) controller.view.reveal(id, false); });
    }),
    vscode.commands.registerCommand('agents.project.openTicket', (id: unknown) => typeof id === 'string' && id ? controller.view.openTicketTab(id) : undefined),
    // Internal: the Lead talks to the project this panel shows (src/vscode/lead.vscode.ts).
    vscode.commands.registerCommand('agents.project.current', async () => (await controller.project())?.name),
  );
}

/** The panel's webview document; exported for the script syntax test. */
export function shell(cspSource: string, logoCss = ''): string {
  const n = getNonce();
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${cspSource} data:; connect-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';" />
<style>
${RUSH_THEME_CSS}  body { margin: 0; font-family: var(--vscode-font-family); font-size: 12px; color: var(--r-text);
    background: var(--vscode-sideBar-background); background-image: radial-gradient(130% 55% at 72% 0%, var(--r-sky), transparent 70%); }
  body.loading main { opacity: 0.55; }
  section { padding: 8px 0; border-bottom: 1px solid var(--r-edge); }
  section:last-child { border-bottom: none; }
  ul { list-style: none; margin: 0; padding: 0; }
  a { color: inherit; text-decoration: none; }
  .head { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .title { font-weight: 600; font-size: 15px; flex: 1; }
  .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--r-caption); flex: 1; }
  .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--r-text); }
  .n { color: var(--r-faint); font-variant-numeric: tabular-nums; font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .sub { color: var(--r-caption); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ms { margin-top: 8px; } .ms .t { flex: 1; }
  .ic { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .srow { display: grid; grid-template-columns: minmax(0,1fr) 18px; gap: 2px 8px; width: 100%; text-align: left; padding: 7px 6px; margin: 1px 0; border: none; border-radius: 8px; background: none; color: inherit; font: inherit; cursor: pointer; }
  .srow:hover { background: var(--r-glass-hover); } .srow.sel { background: var(--r-glass-hover); box-shadow: inset 2px 0 0 var(--r-gold-line); }
  .srow:focus-visible, a:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .mark { grid-column: 2; grid-row: 1 / span 2; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid currentColor; display: grid; place-items: center; font-size: 10px; font-weight: 700; margin-top: 1px; color: var(--r-faint); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .quiet summary, details summary { cursor: pointer; padding: 6px 2px 2px; color: var(--r-caption); font-size: 11.5px; }
  details > summary { list-style: revert; }
  .pri { display: inline-flex; align-items: flex-end; gap: 1.5px; width: 12px; height: 11px; flex: none; margin-top: 3px; }
  .pri i { display: block; width: 2.5px; border-radius: 1px; background: var(--r-edge); }
  .pri i.on { background: var(--r-faint); }
  .pri.p1 i.on { background: var(--r-bad); } .pri.p2 i.on { background: var(--r-warn); } .pri.p3 i.on { background: var(--r-caption); }
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
  .pro:hover { background: var(--r-glass-hover); color: var(--r-text); }
  .pro svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  /* A PR row ends in one ring, as in the AGI Menu (owner, 2026-10-27 12:07 PM): the verdict is a mark,
     its word sits on the meta line, and only a ready PR's ring is a button. */
  .pring { flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%; background: none; display: inline-flex; align-items: center; justify-content: center; font: inherit; }
  .pring svg { width: 20px; height: 20px; display: block; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; overflow: visible; }
  .pring .trk { stroke: var(--r-edge); } .pring .arc { stroke: currentColor; stroke-dasharray: 53.4 53.4; transform: rotate(-90deg); transform-origin: 10px 10px; }
  .pring .mk { stroke: currentColor; } .pring .dot { fill: currentColor; stroke: none; } .pring .mrg, .pring .und { display: none; } .pring .mrg circle { fill: none; }
  button.pring:not(.v-bad) :is(.bang, .dot) { display: none; } button.pring.v-bad .chk { display: none; }
  .v-ok { color: var(--r-ok); } .v-bad { color: var(--r-bad); } .v-run { color: var(--r-warn); } .v-quiet { color: var(--r-faint); } .v-merged { color: var(--r-merged); }
  .pring.v-run .arc { stroke-dasharray: 14 40; animation: spin 1s linear infinite; } .pring.v-quiet .arc { stroke: none; }
  button.pring { cursor: pointer; } button.pring:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button.pring.v-ok:is(:hover, :focus-visible):not(.armed):not(.merging) { background: var(--r-ok); color: var(--r-on-av); }
  button.pring.v-ok:is(:hover, :focus-visible):not(.armed):not(.merging) .chk { display: none; } button.pring.v-ok:is(:hover, :focus-visible):not(.armed):not(.merging) .mrg { display: inline; }
  button.pring:is(:hover, :focus-visible):not(.armed):not(.merging) .trk, button.pring:is(:hover, :focus-visible):not(.armed):not(.merging) .arc { stroke: none; }
  /* Undo: the ring drains for 5 s; under the pointer its center is ✕, and a click stops the merge. */
  .pring.armed:is(:hover, :focus-visible) .chk { display: none; } .pring.armed:is(:hover, :focus-visible) .und { display: inline; }
  .pring.merging { pointer-events: none; } .pring.merging .chk { display: none; } .pring.merging .arc { stroke-dasharray: 14 40; animation: spin .7s linear infinite; }
  .pring.v-merged { background: var(--r-merged); color: var(--r-on-av); animation: pop .35s ease-out; } .pring.v-merged .trk, .pring.v-merged .arc { stroke: none; }
  @keyframes pop { 0% { transform: scale(.7); } 60% { transform: scale(1.15); } 100% { transform: scale(1); } }
  .vw { font-family: var(--vscode-font-family); } .sub .vw.v-quiet { color: var(--r-faint); }
  /* Fix: the agent's logo beside a red ring, on the row's hover; one click starts it on the PR. */
  .prfix { flex: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: none; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; }
  .prli:hover .prfix, .prfix:focus-visible, .prfix[disabled] { opacity: 1; } .prfix:hover { background: var(--r-glass-hover); } .prfix .hx { width: 15px; height: 15px; } .prfix[disabled] { animation: breathe 1.2s ease-in-out infinite; cursor: default; }
  .rgrp .head { margin-bottom: 2px; } .rgrp.g-ready .label { color: var(--r-ok); } .rgrp.g-fail .label { color: var(--r-bad); }
  .trow:hover, .prow:hover { background: var(--r-glass-hover); }
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
  .err { color: var(--r-bad); white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px 0; }
  .empty { color: var(--r-caption); padding: 8px 0; }
  .empty a { color: var(--vscode-textLink-foreground); }
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; padding: 0; }
  .tabs { display: flex; align-items: center; gap: 2px; padding: 4px 8px 4px 10px; border-bottom: 1px solid var(--r-edge); flex: none; min-width: 0; }
  .tab[hidden] { display: none; }
  .shead .today { margin-left: 6px; flex: none; font: 500 10.5px var(--r-sans); color: var(--r-text-2); border: 1px solid var(--r-edge); border-radius: 999px; padding: 0 7px; background: transparent; cursor: pointer; }
  .shead .today.on { border-color: var(--r-selected-edge); background: var(--r-selected); color: var(--r-text); }
  .tday { margin-left: 4px; font-size: 10.5px; flex: none; }
  .card .span { font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-caption); margin: 2px 0 4px; }
  .reading, .quiet { font-size: 11.5px; color: var(--r-caption); padding: 6px 2px; }
  /* One header row: the goal, then the tabs as icons and their controls (owner video,
     2026-10-18 8:59 PM); the project's name is the view's title. */
  .goals { flex: 1; min-width: 0; margin-right: 4px; overflow: hidden; }
  .goals[hidden] { display: none; }
  .goals .gl1 { width: 100%; border: 0; background: none; padding: 2px 4px; margin-left: -4px; border-radius: 6px; font: inherit; cursor: pointer; text-align: left; }
  .goals .gl1:hover, .goals .gl1[aria-expanded="true"] { background: var(--r-glass-hover); } .goals .gl1:hover .gtx { color: var(--r-text); }
  .goals .gcar { font-size: 9px; color: var(--r-faint); flex: none; }
  .gmenu-pop { position: fixed; left: 8px; right: auto; top: 34px; min-width: 250px; max-width: calc(100vw - 16px); }
  .menu .mn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .menu .mm { flex: none; font-family: var(--r-mono); font-size: 10px; color: var(--r-faint); } .menu .hx { width: 14px; height: 14px; flex: none; }
  .tpick { position: relative; display: inline-flex; } .tcar { opacity: 0; width: 14px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--r-caption); font-size: 9px; cursor: pointer; margin: 0 2px 0 -2px; }
  .tli:hover .tcar, .tcar[aria-expanded="true"] { opacity: 1; } .tcar:hover { background: var(--r-glass-hover); color: var(--r-text); }
  .goals .gl1, .goals a { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 11.5px; line-height: 1.55; color: var(--r-caption); text-decoration: none; }
  .goals a:hover .gtx { color: var(--r-text); }
  .goals .gl2 { color: var(--r-text-2); }
  .goals .gl2 b { font-weight: 600; margin-right: 3px; }
  .goals .gk { width: 13px; text-align: center; flex: none; }
  .goals .gtx { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .goals .gm { flex: none; font-family: var(--r-mono); font-size: 10px; color: var(--r-faint); }
  .goals .gerr { font-size: 11px; color: var(--r-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tab { height: 26px; padding: 0 6px; border: none; border-radius: 6px; background: none; color: var(--r-caption); font: inherit; display: inline-flex; gap: 5px; align-items: center; position: relative; cursor: pointer; }
  .tab .lbl { display: none; font-size: 12px; white-space: nowrap; }
  .tab:hover { background: var(--r-glass-hover); }
  .tab[aria-selected="true"] { background: var(--r-glass-hover); color: var(--r-text); font-weight: 600; }
  .tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .tab .ti { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .tab .cnt { font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); font-weight: 400; }
  .tab .dot { position: absolute; top: -1px; right: -2px; min-width: 14px; height: 14px; line-height: 14px; border-radius: 7px; background: var(--r-warn-tint); color: var(--r-warn); font-size: 9.5px; font-weight: 700; text-align: center; padding: 0 3px; box-sizing: border-box; transform: scale(.85); }
  .tab .dot:empty { display: none; }
  main { padding: 2px 8px 12px; overflow: auto; flex: 1; min-height: 0; }
  /* Sessions: outlined cards, compact until hovered or selected (AGENTS.md Design). */
  .shead { display: flex; align-items: center; gap: 8px; margin: 8px 2px 4px; position: relative; }
  .sfind { position: sticky; top: 0; z-index: 3; margin: 2px 0 6px; padding: 4px 0; background: var(--vscode-sideBar-background); }
  .sfind input { width: 100%; box-sizing: border-box; height: 26px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--r-edge); background: var(--r-glass); color: var(--r-text); font: inherit; font-size: 12px; outline: none; }
  .sfind input:focus { border-color: var(--vscode-focusBorder); }
  .nofind { margin: 10px 6px; color: var(--r-faint); font-size: 11.5px; }
  .more-drafts { display: block; margin: 6px 4px; padding: 2px 6px; border: 0; border-radius: 5px; background: none; color: var(--r-faint); font: inherit; font-size: 11.5px; cursor: pointer; } .more-drafts:hover { color: var(--r-text); background: var(--r-glass-hover); }
  .icon { width: 24px; height: 22px; display: grid; place-items: center; border-radius: 5px; border: 1px solid transparent; background: none; color: var(--r-caption); cursor: pointer; padding: 0; flex: none; }
  .icon:hover, .icon[aria-expanded="true"] { background: var(--r-glass-hover); border-color: var(--r-edge); color: var(--r-text); }
  .icon .ic { width: 14px; height: 14px; }
  .menu { position: absolute; right: 0; top: 26px; z-index: 5; min-width: 176px; padding: 5px; border-radius: 9px; border: 1px solid var(--r-edge); background: var(--vscode-menu-background, var(--vscode-sideBar-background)); box-shadow: 0 10px 28px rgba(0,0,0,.28); }
  .menu .sec { font-size: 11px; color: var(--r-faint); padding: 6px 8px 2px; }
  .menu button { display: flex; gap: 8px; align-items: center; width: 100%; border: 0; background: none; color: var(--r-text); font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 5px; cursor: pointer; text-align: left; }
  .menu button:hover { background: var(--r-glass-hover); }
  .menu .ck { width: 12px; } .menu .mi { width: 13px; height: 13px; fill: none; stroke: var(--r-caption); stroke-width: 1.4; }
  .menu hr { border: 0; border-top: 1px solid var(--r-edge); margin: 4px 2px; }
  .pinned { margin: 6px 0 10px; padding: 2px 5px 6px; border-radius: 9px; background: var(--r-warn-tint); }
  .pinned .ph { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--r-warn); padding: 5px 4px 4px; }
  .pinned.now { background: var(--r-bad-tint); } .pinned.now .ph { color: var(--r-bad); }
  .grp { margin-top: 8px; }
  .gh { display: flex; align-items: center; gap: 7px; padding: 4px; border-radius: 6px; cursor: pointer; user-select: none; position: relative; }
  .gh .gmenu { width: 22px; height: 20px; margin-left: 2px; } .gh .menu { top: 24px; cursor: default; }
  .gh:hover { background: var(--r-glass-hover); }
  .gh .car { width: 10px; color: var(--r-faint); font-size: 10px; transition: transform .15s; } .grp.closed .car { transform: rotate(-90deg); }
  .gi-box { width: 20px; height: 20px; display: grid; place-items: center; flex: none; }
  .appic { width: 20px; height: 20px; display: block; }
  .gi { width: 14px; height: 14px; fill: none; stroke: var(--r-caption); stroke-width: 1.4; }
  .gname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; } .gname b { font-weight: 600; } .gs { color: var(--r-faint); font-size: 11px; }
  .gh .gmenu { margin-left: auto; } .gact ~ .gmenu { margin-left: 6px; }
  .gact { margin-left: auto; font: inherit; font-size: 10.5px; border: 1px solid var(--r-edge); background: none; color: var(--r-caption); border-radius: 5px; padding: 0 7px; cursor: pointer; }
  .gact:hover { color: var(--r-text); border-color: var(--r-faint); }
  .items, .flat { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; margin-top: 4px; } .pinned .card + .card { margin-top: 6px; }
  .card { display: block; min-width: 0; color: inherit; cursor: pointer; transition: background .12s, border-color .12s; }
  .card:hover, .card:focus-visible { background: var(--r-glass-hover); border-color: var(--r-faint); outline: none; }
  /* Selected is its own look, not hover's: a gold rail inside the left edge. */
  .card.sel { background: var(--r-glass-hover); border-color: var(--r-faint); box-shadow: inset 2px 0 0 var(--r-gold-line); }
  /* The front tab's card, pinned above the list (owner, 2026-10-18). */
  .front-pin { margin: 2px 0 8px; }
  .fc-nav { display: flex; align-items: center; gap: 4px; margin: -2px -2px 2px; }
  .fc-step { width: 22px; height: 20px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--r-text-2); font: inherit; font-size: 16px; line-height: 1; cursor: pointer; }
  .fc-step:hover:not([disabled]) { background: var(--r-well); color: var(--r-text); }
  .fc-step:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .fc-step[disabled] { opacity: .3; cursor: default; }
  .card.front { cursor: default; }
  .card.front.st-asks:hover, .card.front.st-stuck:hover, .card.front.st-blocked:hover, .card.front.st-working:hover, .card.front.st-waiting:hover, .card.front.st-idle:hover, .card.front.st-review:hover { filter: none; }
  .card.front .top { height: auto; min-height: 20px; align-items: flex-start; }
  .card.front .top .hx { margin-top: 2px; }
  .card.front .top .vchip { margin-top: 1px; }
  /* ⇤ ‹ the title, up to three lines, and its state › ⇥; under it the machine, the tab's place, the age, Copy and ⋯ (owner video, 2026-10-27 9:24 AM). */
  .card.front .fc-nav .top { flex: 1; min-width: 0; }
  .card.front .fc-nav .ttl { line-height: 17px; white-space: normal; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
  .card.front .fc-nav { align-items: flex-start; } .card.front .fc-nav .fc-step { margin-top: 1px; }
  .fc-meta { display: flex; align-items: center; gap: 6px; min-width: 0; margin: 0 0 2px 26px; height: 22px; } .fc-nav.bare + .fc-meta { margin-left: 0; }
  .fc-where { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); font-variant-numeric: tabular-nums; }
  .fc-acts { display: flex; gap: 2px; flex: none; margin-left: auto; }
  .fc-k { display: flex; align-items: baseline; gap: 6px; margin-bottom: 3px; font-size: 9.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--r-caption); }
  .fc-recap { margin-top: 6px; padding: 6px 8px 7px; border-radius: 6px; background: var(--r-glass); border: 1px solid var(--r-edge); }
  .fc-recap .fc-k { color: var(--r-gold-line); }
  .fc-old { margin-left: auto; font-size: 10.5px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--r-faint); }
  .fc-rt { font-size: 12px; line-height: 1.4; color: var(--r-text); }
  .fc-recap.stale .fc-k { color: var(--r-caption); } .fc-recap.stale .fc-rt { color: var(--r-text-2); }
  .card.front .ask, .card.front .line.said { margin-top: 6px; }
  .fc-made, .fc-act { margin-top: 7px; }
  .card .fc-made .cstrip, .card .fc-made .thumbs { margin-top: 0; } .fc-made .thumbs { margin-top: 4px; }
  .fc-more { margin-left: auto; font-size: 10.5px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--vscode-textLink-foreground); }
  .fc-more:hover { text-decoration: underline; }
  .fc-act ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
  .fc-act li { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 6px; font-size: 11.5px; line-height: 1.35; color: var(--r-text-2); }
  .fc-act li time { padding-top: 1px; font-family: var(--vscode-editor-font-family); font-size: 10px; color: var(--r-faint); white-space: nowrap; }
  .fc-act li .fc-at { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .fc-act li.user .fc-at { font-style: italic; color: var(--r-caption); }
  .fc-act li .fc-you { font-style: normal; font-weight: 600; color: var(--r-text); }
  .fc-act li.live .fc-at { display: block; color: var(--r-text); }
  .fc-now { display: block; margin-top: 1px; font-size: 11px; color: var(--r-ok); }
  .fc-reply { margin-top: 8px; cursor: auto; }
  .fc-reply .reply-box textarea { resize: none; min-height: 32px; border-radius: 8px; }
  .fc-reply .reply-box .reply-mic { top: 4px; right: 4px; }
${REPLY_BOX_CSS}
${LEAD_TAB_CSS}
${MADE_CSS}
  .fc-made .made { margin: 7px -11px 0; }
  .fc-made .made.chips { margin: 0; }
  .fc-made button.mk, .fc-made button.mk-open { color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .fc-made button.mk-open { background: transparent; border: 0; }
  .fc-act ol { max-height: 96px; overflow-y: auto; scrollbar-width: thin; }
  /* About a quarter shorter than it was, so more of the list shows under it (owner video, 2026-10-22 8:50 AM); the recap's full text is its tooltip. */
  .fc-rt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .fc-act ol[hidden] { display: none; }
  .fc-act ol:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .fc-act li.fc-earlier { display: block; font-size: 10.5px; color: var(--r-faint); }
  .card .started { margin-top: 2px; font-size: 10.5px; color: var(--r-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card.multi { border-color: var(--r-gold-line); }
  .card .top { display: flex; align-items: center; gap: 6px; min-width: 0; height: 20px; }
  .card .ttl { flex: 1; min-width: 0; font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .age { font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); flex: none; }
  .acts { display: none; gap: 2px; flex: none; }
  .card:hover .acts, .card.sel .acts, .card:focus-within .acts { display: flex; } .card:hover .age, .card.sel .age, .card:focus-within .age { display: none; }
  .act { width: 22px; height: 20px; display: grid; place-items: center; border: 1px solid transparent; background: none; border-radius: 5px; color: var(--r-caption); cursor: pointer; padding: 0; }
  .act:hover { background: var(--r-glass-hover); border-color: var(--r-edge); color: var(--r-text); }
  .act .ic { width: 13px; height: 13px; stroke-width: 1.6; }
  .pill { display: inline-flex; align-items: center; gap: 4px; flex: none; border: 1px solid var(--r-edge); border-radius: 999px; padding: 0 7px 0 6px; font-size: 10.5px; line-height: 16px; color: var(--r-text-2); }
  .pill i { background: var(--r-faint); } .pill i { width: 6px; height: 6px; border-radius: 50%; display: block; }
  .pill.solo { padding: 0 4px; border: 0; }
  .st-asks.pill { color: var(--r-warn); border-color: var(--r-warn); } .pill.st-asks i { background: var(--r-warn) !important; }
  .st-working.pill { color: var(--r-ok); } .pill.st-working i { background: var(--r-ok) !important; } .st-working.pill i { animation: breathe 1.6s ease-in-out infinite; }
  .st-stuck.pill { color: var(--r-bad); border-color: var(--r-bad); } .pill.st-stuck i { background: var(--r-bad) !important; }
  .pill.st-review i { background: var(--r-info) !important; }
  /* Waiting on its own work reads Running: green and breathing. */
  .st-waiting.pill { color: var(--r-ok); } .pill.st-waiting i { background: var(--r-ok) !important; }
  .st-waiting.pill i { animation: breathe 1.6s ease-in-out infinite; }
  .fx { display: inline-flex; gap: 2px; flex: none; } .fx span { font-size: 10.5px; line-height: 1; padding: 2px 3px; border-radius: 4px; background: var(--r-well); }
  .fx .fast { color: var(--r-warn); } .fx .hi { color: var(--r-info); }
  .cbot { display: flex; align-items: flex-end; gap: 6px; margin-top: 6px; min-width: 0; } .card .cbot .cstrip { margin-top: 0; flex: 1; min-width: 0; }
  .cbot .hst { margin-left: auto; flex: none; font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); opacity: .8; }
  .cbot .hst .repo { margin-right: 6px; } .cbot .hst .repo::after { content: '·'; margin-left: 6px; }
  .cmore { position: relative; } .cmore > summary { list-style: none; font-size: 13px; line-height: 18px; text-align: center; } .cmore > summary::-webkit-details-marker { display: none; }
  .card:has(.cmore[open]) .acts { display: flex; } .card:has(.cmore[open]) .age { display: none; }
  .cmenu { position: absolute; right: 0; top: 22px; z-index: 6; width: 230px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--r-edge); background: var(--vscode-menu-background, var(--vscode-sideBar-background)); box-shadow: 0 8px 22px rgba(0,0,0,.3); cursor: default; }
  .cmenu dl { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 3px 8px; margin: 0; font-size: 11px; } .cmenu dt { color: var(--r-faint); } .cmenu dd { margin: 0; overflow-wrap: anywhere; }
  .cmenu button { display: block; width: 100%; margin-top: 6px; padding: 3px 4px; text-align: left; font: inherit; font-size: 11.5px; border: 0; border-top: 1px solid var(--r-edge); background: none; color: var(--r-text); cursor: pointer; } .cmenu button:hover { background: var(--r-glass-hover); }
  .cmenu .cpv { display: inline; width: auto; margin: 0; padding: 0; border: 0; border-radius: 3px; font-size: 11px; text-align: left; overflow-wrap: anywhere; }
  .cmenu .cpv.copied::after { content: ' copied'; color: var(--r-faint); }
  .pill.st-blocked { color: var(--r-bad); border-color: var(--r-bad); } .pill.st-blocked i { background: var(--r-bad) !important; }
  .st-ended.pill { opacity: .8; }
  @keyframes breathe { 50% { opacity: .25; } }
  /* A card always shows the same preview; hover only reveals its icons, so nothing moves. */
  .card .ask, .card .line.said { margin-top: 5px; }
  .card .cstrip, .card .thumbs { margin-top: 6px; }
  /* One row of chips that scrolls sideways, never a second row (owner video, 2026-10-17). */
  .cstrip { display: flex; gap: 4px; align-items: center; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
  .cstrip::-webkit-scrollbar { display: none; } .cstrip > * { flex: none; }
  .cbot .cstrip { flex: 1; min-width: 0; }
  /* The card's tint is its state: red asks or blocked, green working, yellow idle. */
  .card.st-stuck, .card.st-blocked { background: color-mix(in srgb, var(--r-bad) 14%, transparent); border-color: color-mix(in srgb, var(--r-bad) 45%, transparent); }
  .card.st-asks { background: color-mix(in srgb, var(--r-warn) 12%, transparent); border-color: color-mix(in srgb, var(--r-warn) 45%, transparent); }
  .card.st-working, .card.st-waiting { background: color-mix(in srgb, var(--r-ok) 9%, transparent); border-color: color-mix(in srgb, var(--r-ok) 32%, transparent); }
  /* Amber is only for an ask now, so a finished turn is the plain card (owner video, 2026-10-22 8:50 AM). */
  .card.st-idle, .card.st-review { background: var(--r-glass); border-color: var(--r-edge); }
  .card.st-asks:hover, .card.st-stuck:hover, .card.st-blocked:hover, .card.st-working:hover, .card.st-waiting:hover, .card.st-idle:hover, .card.st-review:hover { filter: brightness(1.15); }
  .card .age.wait { color: var(--r-bad); font-variant-numeric: tabular-nums; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .pill .wait { font-variant-numeric: tabular-nums; font-weight: 600; }
  .pill.st-asks i, .pill.st-stuck i, .pill.st-blocked i { position: relative; overflow: visible; }
  .pill.st-stuck i::after, .pill.st-blocked i::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--r-bad); opacity: 0; animation: askring 2.4s ease-out infinite; }
  .pill.st-asks i::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--r-warn); opacity: 0; animation: askring 2.4s ease-out infinite; }
  @keyframes askring { 0% { transform: scale(.4); opacity: .7; } 70%, 100% { transform: scale(1.5); opacity: 0; } }
  /* A question that just arrived: the card glows three times, then rests. */
  .card.fresh { animation: askglow 1.1s ease-in-out 3; }
  @keyframes askglow { 0%, 100% { box-shadow: 0 0 0 0 transparent; } 45% { background: var(--r-warn-tint); box-shadow: 0 0 0 2px var(--r-warn); } }
  .card.flash { animation: flashsel .9s ease-out; }
  @keyframes flashsel { 0% { box-shadow: 0 0 0 2px var(--r-gold-line); } 100% { box-shadow: 0 0 0 0 transparent; } }
  .ic.mark { width: 11px; height: 11px; }
  .card .line { color: var(--r-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .card .line.said { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .card.compact .line.said { -webkit-line-clamp: 1; } .card.compact .ask, .card.compact .line.said { margin-top: 3px; }
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
  .card .opt:hover, .card .opt:focus-visible { background: var(--r-glass-hover); border-color: var(--r-warn); outline: none; }
  .card .opt .k { flex: none; font-size: 10.5px; color: var(--r-faint); font-variant-numeric: tabular-nums; }
  .card .opt .ol { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .opt small { flex-basis: 100%; padding-left: 13px; color: var(--r-caption); font-size: 11px; }
  .card .alt { display: flex; gap: 12px; margin-top: 4px; }
  .card .draft { display: flex; align-items: flex-start; gap: 6px; margin-top: 5px; padding: 4px 7px; border: 1px solid var(--r-edge); border-radius: 5px; background: var(--r-glass); font-size: 11.5px; }
  .card .draft .dl { flex: none; padding-top: 1px; font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--r-caption); }
  .card .draft .dt { flex: 1; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .card .draft .da { flex: none; display: flex; gap: 10px; }
  .card .lnk { background: none; border: 0; padding: 0; font: inherit; font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; } .card .lnk:hover { text-decoration: underline; }
  .card .aother input { width: 100%; box-sizing: border-box; margin-top: 5px; font: inherit; font-size: 11.5px; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--r-edge)); border-radius: 4px; }
  .card .asend { margin-top: 5px; font-size: 11.5px; color: var(--r-text-2); } .card .asend.err { color: var(--r-bad); }
  .chip { display: inline-flex; align-items: center; gap: 3px; max-width: 170px; padding: 1px 6px 1px 4px; border-radius: 5px; border: 1px solid var(--r-edge); color: var(--r-caption); font-family: var(--vscode-editor-font-family); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a.chip { text-decoration: none; cursor: pointer; } a.chip:hover { border-color: var(--r-caption); color: var(--r-text); }
  .chip.pr-ok { color: var(--r-ok); } .chip.pr-bad { color: var(--r-bad); } .chip.pr-warn { color: var(--r-warn); }
  .thumbs { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; margin-top: 3px; }
  .th { position: relative; height: 40px; border-radius: 4px; overflow: hidden; border: 1px solid var(--r-edge); display: block; flex: none; }
  .th { width: 64px; } .card .th { width: 54px; height: 34px; aspect-ratio: 54 / 34; contain: strict; background: var(--r-well); } .th.in { outline: 1.5px dashed var(--r-faint); outline-offset: 1px; } .th img { width: 100%; height: 100%; object-fit: cover; display: block; } .th:hover { border-color: var(--r-gold-line); }
  .th i { position: absolute; left: 3px; bottom: 3px; font-style: normal; font-size: 9px; background: rgba(0,0,0,.62); color: #fff; border-radius: 3px; padding: 0 3px; }
  .th b { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.45); color: #fff; font-size: 11px; }
  .confirm { margin-top: 8px; padding: 8px; border-radius: 7px; background: var(--r-warn-tint); color: var(--r-text-2); font-size: 11.5px; display: grid; gap: 6px; cursor: default; }
  .confirm .cb { display: flex; gap: 6px; } .confirm button, .bulk button, .toast button { font: inherit; font-size: 11px; border: 1px solid var(--r-edge); background: none; color: var(--r-text); border-radius: 5px; padding: 2px 9px; cursor: pointer; }
  .confirm .danger { color: var(--r-warn); border-color: var(--r-warn); }
  .bulk, .toast { position: sticky; bottom: 6px; display: flex; gap: 8px; align-items: center; margin-top: 8px; padding: 6px 8px; border-radius: 9px; font-size: 11.5px; }
  .bulk { background: var(--vscode-menu-background, var(--vscode-sideBar-background)); border: 1px solid var(--r-faint); box-shadow: 0 8px 22px rgba(0,0,0,.3); }
  .bulk span, .toast span { flex: 1; } .toast { background: var(--r-text); color: var(--vscode-sideBar-background); } .toast button { color: inherit; border-color: transparent; font-weight: 700; text-decoration: underline; }
  .bulk[hidden], .toast[hidden], .menu[hidden] { display: none; }
  .reveal { position: fixed; z-index: 20; pointer-events: none; border-radius: 8px; border: 1px solid var(--r-faint); background: var(--vscode-sideBar-background); padding: 3px; display: none; }
  .reveal img { display: block; max-width: 260px; max-height: 180px; border-radius: 5px; } .reveal span { display: block; font-size: 10.5px; color: var(--r-caption); padding: 3px 2px 0; }
  .card .top .hx { width: 14px; height: 14px; border-radius: 3px; }
  .card .top .fork { flex: none; font-size: 12px; color: var(--r-caption); }
  /* ☆ on hover, ★ kept on a favorite; it always holds its place, so the row never moves. */
  .star { flex: none; font-size: 13px; line-height: 1; color: var(--r-gold-line); }
  .fav-ic { color: var(--r-gold-line); font-size: 13px; }
  .card .line.said.you b { font-weight: 600; color: var(--r-caption); margin-right: 2px; }
  /* The pinned card's title renames a Claude session on a click. */
  .card.front .ttl.rn { cursor: text; border-radius: 4px; } .card.front .ttl.rn:hover { background: var(--r-glass-hover); }
  .ttl-edit { width: 100%; box-sizing: border-box; font: inherit; font-weight: 600; font-size: 12.5px; padding: 0 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder); border-radius: 4px; outline: none; }
  ${logoCss}
  /* A tab's own controls (☀, search, ⇅) ride the tab row instead of a heading row of their own. */
  .tabs .sctl { margin-left: auto; position: relative; display: flex; align-items: center; min-width: 0; }
  .tabs .sctl .shead { margin: 0; gap: 4px; }
  /* Ticket detail and Settings (PHNX-4329). */
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 5px 9px; cursor: pointer; font: inherit; font-weight: 600; align-self: flex-start; }
  button.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  /* A ticket row: ▶ shows on hover; its peek unfolds under it, inside the same hover tone. */
  .tli { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; border-radius: 6px; }
  .tli .trow { flex: 1; min-width: 0; grid-template-columns: auto minmax(0,1fr); align-items: center; }
  .tli .sub .pri { display: inline-flex; width: 10px; height: 9px; gap: 1px; margin: 0 5px 0 0; vertical-align: -1px; } .tli .sub .pri i { width: 2px; }
  .iav.nobody { border: 1px dashed var(--r-edge); background: none; }
  /* A title longer than its row scrolls to its end and back while the pointer is on it. */
  .tli.mq .t { text-overflow: clip; } .tli.mq .t > span { display: inline-block; animation: tmq var(--mqs) ease-in-out .5s infinite alternate; }
  @keyframes tmq { to { transform: translateX(var(--mq)); } }
  .tli .who { margin-left: 0; }
  .tag { display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 4px; border: 1px solid transparent; border-radius: 6px; background: none; color: var(--r-caption); cursor: pointer; }
  .tag:hover { border-color: var(--r-edge); background: var(--r-glass-hover); } .tag .hx { width: 14px; height: 14px; }
  .tag i[class^="d-"] { width: 6px; height: 6px; border-radius: 50%; display: block; background: var(--r-faint); } .tag .n { font-size: 10px; color: var(--r-faint); }
  .tag i.d-move { background: var(--r-warn); } .tag i.d-running { background: var(--r-ok); } .tag i.d-review { background: var(--r-info); }
  .tli:hover .pro, .tli.peek .pro { opacity: 1; }
  .tli:hover, .tli.peek { background: var(--r-glass-hover); } .tli .trow:hover { background: none; }
  .tpeek { flex-basis: 100%; padding: 0 8px 8px 24px; display: flex; flex-direction: column; gap: 6px; }
  .tpeek[hidden] { display: none; }
  .tpeek .tbody { font-size: 12px; line-height: 1.45; color: var(--r-text-2); overflow-wrap: anywhere; }
  .tpeek .tbody p { margin: 3px 0; } .tpeek h4 { margin: 6px 0 2px; font-size: 12px; }
  .tpeek ul { list-style: disc; padding-left: 18px; margin: 3px 0; }
  .tpeek code, .tpeek pre { font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .tpeek pre { white-space: pre-wrap; background: var(--r-well); border-radius: 6px; padding: 6px; }
  .tpeek a { color: var(--vscode-textLink-foreground); }
  .tpeek .none { color: var(--r-caption); font-size: 11px; }
  .tpeek .onit { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .tpeek .ons { display: grid; min-width: 0; text-align: left; font: inherit; color: var(--r-text); background: none; border: 1px solid var(--r-edge); border-radius: 7px; padding: 5px 7px; cursor: pointer; }
  .tpeek .ons:hover { background: var(--r-glass-hover); }
  .tpeek .ons b { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .tpeek .ons small { color: var(--r-caption); font-size: 10.5px; }
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
  .settings .dstar[aria-pressed="true"] { color: var(--r-gold-line); } .settings .dstar:hover { background: var(--r-glass-hover); }
  .settings .doff { color: var(--r-faint); font-size: 11px; padding: 6px 0; border-bottom: 1px solid var(--r-edge); }
  .settings .err { color: var(--r-bad); }
  .settings .rbtn { flex: none; font: inherit; font-size: 11.5px; padding: 2px 10px; border-radius: 5px; border: 1px solid var(--r-edge); background: var(--r-glass); color: var(--r-text); cursor: pointer; } .settings .rbtn:hover { background: var(--r-glass-hover); }
  /* ⌘K: the session palette, drawn over the list (owner video, 2026-10-19 1:42 AM). */
  .kscrim { position: fixed; inset: 0; z-index: 30; background: color-mix(in srgb, var(--vscode-sideBar-background) 55%, transparent); display: flex; justify-content: center; align-items: flex-start; padding: 36px 8px 8px; }
  .kscrim[hidden], .kql[hidden] { display: none; }
  .kpal { width: 100%; max-width: 640px; max-height: calc(100vh - 52px); display: flex; flex-direction: column; border: 1px solid var(--r-edge); border-radius: 10px; background: var(--vscode-menu-background, var(--vscode-sideBar-background)); box-shadow: 0 16px 44px rgba(0,0,0,.35); overflow: hidden; }
  .kpal input { flex: none; border: 0; border-bottom: 1px solid var(--r-edge); padding: 10px 12px; font: inherit; font-size: 13px; color: var(--vscode-input-foreground); background: transparent; outline: none; }
  .klist { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; padding: 4px; }
  .krow { display: grid; grid-template-columns: 16px minmax(min(45%, 9em), 1fr) minmax(0, max-content); column-gap: 7px; min-width: 0; row-gap: 3px; align-items: center; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
  .krow[hidden] { display: none; }
  .krow:hover { background: var(--r-glass-hover); } .krow[aria-selected="true"] { background: var(--r-selected, var(--r-glass-hover)); box-shadow: inset 2px 0 0 var(--r-gold-line); }
  .krow .hx { width: 14px; height: 14px; border-radius: 3px; grid-row: 1; }
  .krow .kt { grid-column: 2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12.5px; }
  .krow .kfav { color: var(--r-gold-line); margin-right: 4px; }
  .krow .kmeta { grid-column: 3; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; justify-self: end; max-width: 100%; white-space: nowrap; font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--r-faint); }
  .krow .ksub { grid-column: 2 / 4; display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; white-space: nowrap; font-size: 11.5px; color: var(--r-caption); }
  .krow .ksub > * { flex: none; } .krow .knote { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .krow .knote mark { background: none; color: var(--r-gold); font-weight: 600; }
  .krow .kmeta .pill { flex: none; } .krow .kmeta .kw { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  /* ⌘K palette rows. */
  .krow.ended { opacity: .55; }
  .kth { display: block; width: 46px; height: 28px; border-radius: 4px; overflow: hidden; border: 1px solid var(--r-edge); outline: 1.5px dashed var(--r-faint); outline-offset: 1px; background: var(--r-well); cursor: zoom-in; }
  .kth img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .kfoot { flex: none; padding: 5px 12px; font-size: 10.5px; color: var(--r-faint); border-top: 1px solid var(--r-edge); }
  .kempty { padding: 10px 8px; color: var(--r-caption); }
  .kql { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; }
  .kql figure { margin: 0; text-align: center; max-width: 94vw; } .kql img { max-width: 94vw; max-height: 82vh; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
  .kql figcaption { color: #fff; font-size: 11.5px; margin-top: 6px; }
  @media (prefers-reduced-motion: reduce) { .pring.v-run .arc, .pring.merging .arc, .pring.v-merged, .prfix[disabled], .st-waiting.pill i, .st-working.pill i, .ring .arc, .pill.st-asks i::after, .pill.st-stuck i::after, .pill.st-blocked i::after, .card.fresh, .card.flash, .tli.mq .t > span { animation: none; } .gh .car { transition: none; } }
</style>
</head>
<body>
<div class="tabs" role="tablist" aria-label="Project">
  <div class="goals" hidden></div>
  <button class="tab" role="tab" data-tab="lead" aria-selected="false" title="Lead: ask or tell this project's Lead, by voice (⌥Space) or text"><svg class="ti" viewBox="0 0 16 16"><path d="M8 2v12M2.8 5l10.4 6M2.8 11l10.4-6"/></svg><span class="lbl">Lead</span></button>
  <button class="tab" role="tab" data-tab="sessions" aria-selected="true" title="Sessions"><svg class="ti" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/></svg><span class="lbl">Sessions <span class="cnt" data-cnt="sessions"></span></span><span class="dot" data-asks title="Sessions that need you"></span></button>
  <button class="tab" role="tab" data-tab="prs" aria-selected="false" title="Review — pull requests"><svg class="ti" viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V7a2 2 0 0 0-2-2H7"/></svg><span class="lbl">Review</span></button>
  <button class="tab" role="tab" data-tab="tickets" aria-selected="false" title="Issues"><svg class="ti" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg><span class="lbl">Issues</span></button>
  <div class="sctl"></div>
</div>
<main role="tabpanel"><div class="empty">Loading…</div></main>
<div class="kscrim" hidden><div class="kpal" role="dialog" aria-label="Search sessions"><input id="kq" placeholder="Search sessions" autocomplete="off" spellcheck="false" aria-controls="klist"><div class="klist" id="klist" role="listbox"></div><div class="kfoot">Favorites, then asks, running, idle; ended last · ↑↓ ↵ · esc</div></div></div>
<div class="kql" hidden><figure><img alt=""><figcaption></figcaption></figure></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const main = document.querySelector('main');
  const ctl = document.querySelector('.tabs .sctl');
${PATCH_SCRIPT}
${THUMB_SCRIPT}
${REPLY_SCRIPT}
  ${relTime}
${MADE_SCRIPT}
  // The pinned card's Made shelf: drawn from its data-made when that changes; the
  // patch keeps it otherwise (data-keep), so a scrolled shelf stays put.
  function drawFrontMade() {
    const slot = main.querySelector('.front-pin .fc-made[data-made]');
    if (!slot || slot.__made === slot.dataset.made) return;
    slot.__made = slot.dataset.made;
    slot.innerHTML = renderMadeShelf(JSON.parse(slot.dataset.made), null);
    observeThumbs(slot);
  }
  // The pinned card's activity box stays at its newest step unless you scrolled up in it.
  // A card click keeps the clicked card where it was on screen: the pinned card above
  // it changes height when its tab comes forward, so each redraw for the next 2 s moves
  // the scroll by as much as the card moved, until the pinned card is the clicked one
  // (owner video, 2026-10-19 1:32 AM: "it just goes to the top").
  let anchor = null;
  // The filter bar over the Sessions list: every word typed must appear in a listed card's
  // title or words; groups with none left fold away. The pinned card always stays.
  function applyFind() {
    const box = main.querySelector('[data-find]');
    const words = (box ? box.value : '').toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const grp of main.querySelectorAll('.grp')) {
      let left = 0;
      for (const c of grp.querySelectorAll('.items .card')) {
        const hay = ((c.dataset.title || '') + ' ' + c.textContent).toLowerCase();
        const hit = words.every((w) => hay.includes(w));
        c.style.display = hit ? '' : 'none';
        if (hit) left++;
      }
      grp.style.display = words.length && !left && !grp.classList.contains('closed') ? 'none' : '';
      shown += left;
    }
    const none = main.querySelector('.nofind');
    if (none) none.hidden = !words.length || shown > 0;
  }
  main.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('[data-find]')) applyFind(); });
  main.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target.matches && e.target.matches('[data-find]')) { e.target.value = ''; applyFind(); e.stopPropagation(); } });
  // The ⇅ menu sits in the tab row (Review) or on the list's first group header (Sessions).
  function anyMenu() { return ctl.querySelector('.menu') || main.querySelector('.menu'); }
  function openMenu() { return document.querySelector('.menu:not([hidden])'); }
  function cardsOf(attr, value) { return [...main.querySelectorAll('.card[data-' + attr + '="' + CSS.escape(value) + '"]')]; }
  // A session can show three times: pinned, in Favorites and in its own group.
  function placeOf(c) { return c.closest('.front-pin') ? 'pin' : c.closest('.grp[data-group="favorites"]') ? 'fav' : 'list'; }
  // On screen: at least a title row's height of it shows.
  function onScreen(el) { const r = el.getBoundingClientRect(), v = main.getBoundingClientRect(); return Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top) >= 24; }
  // Scrolling yourself ends it: a later redraw never undoes your scroll.
  for (const ev of ['wheel', 'touchmove', 'keydown']) main.addEventListener(ev, () => { anchor = null; }, { passive: true });
  function holdAnchor() {
    if (!anchor) return;
    if (Date.now() - anchor.at > 2000) { anchor = null; return; }
    const c = cardsOf('key', anchor.key).find((x) => placeOf(x) === anchor.place);
    if (c) main.scrollTop += c.getBoundingClientRect().top - anchor.top;
    if (main.querySelector('.front-pin .card')?.dataset.key === anchor.key) anchor = null;
  }
  function activityBox() { return main.querySelector('.front-pin .fc-act ol'); }
  function activityAtEnd(box) { return !box || box.scrollHeight - box.scrollTop - box.clientHeight < 6; }
  // The front card's reply box: its session's draft, bound once per node, the mic as
  // it stands (a new box asks the host), and the caret back where it was if a move
  // between groups rebuilt the box of the session you were typing to, while this page
  // has the focus.
  function syncFrontReply(typing) {
    const box = main.querySelector('.card.front .reply-box');
    if (!box) return;
    const id = box.closest('.card').dataset.session;
    if (showReplyDraft(box, id)) showReplyError(box, '');
    drawDictation(box);
    if (!box.__asked) { box.__asked = true; vscode.postMessage({ type: 'dictationState' }); }
    bindReplyBox(box, (text) => vscode.postMessage({ type: 'reply', sessionId: box.closest('.card').dataset.session, text }));
    const input = box.querySelector('textarea');
    if (typing && typing.id === id && document.hasFocus() && document.activeElement !== input) { input.focus(); input.setSelectionRange(typing.at[0], typing.at[1]); }
  }
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
  ${waitFor}
  // The wait on a question ticks every second; only these numbers change.
  function tickWaits() { main.querySelectorAll('[data-since]').forEach((el) => { const t = Number(el.dataset.since); if (t) el.textContent = waitFor(Date.now() - t); }); }
  setInterval(tickWaits, 1000);
  // The one ticket whose peek is open in Issues; it survives redraws of the list.
  let peeked = null;
  // A tile's peek scrolls into view once its row is drawn, which may be after the message.
  let scrollToPeek = false;
  // When ▶ last started each ticket: a redraw replaces the button, so the guard lives here.
  const startedAt = new Map();
  // A ticket title wider than its row scrolls to its end under the pointer, at a reading pace.
  main.addEventListener('mouseover', (e) => {
    const li = e.target.closest && e.target.closest('.tli');
    if (!li || li.classList.contains('mq')) return;
    const t = li.querySelector('.t');
    const over = t ? t.scrollWidth - t.clientWidth : 0;
    if (over <= 4) return;
    li.style.setProperty('--mq', -over + 'px'); li.style.setProperty('--mqs', Math.max(1.5, over / 40) + 's');
    li.classList.add('mq');
  });
  main.addEventListener('mouseout', (e) => {
    const li = e.target.closest && e.target.closest('.tli');
    if (li && !li.contains(e.relatedTarget)) li.classList.remove('mq');
  });
  function drawPeek() {
    main.querySelectorAll('.tli').forEach((li) => {
      const on = li.querySelector('.trow').dataset.ticket === peeked;
      li.classList.toggle('peek', on);
      li.querySelector('.trow').setAttribute('aria-expanded', String(on));
      const box = li.querySelector('.tpeek'); if (box) box.hidden = !on;
    });
    const row = scrollToPeek && main.querySelector('.tli.peek');
    if (row) { row.scrollIntoView({ block: 'nearest' }); scrollToPeek = false; }
  }
  function restoreLocal() {
    drawPeek();
    main.querySelectorAll('.card[data-session] .ask').forEach((a) => a.classList.toggle('open', opened.has(a.closest('.card').dataset.session)));
    for (const [key, left] of pendingMerge) drawUndo(key, left);
    for (const key of mergingNow) drawMerging(key);
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
    el.querySelectorAll('.opts, .alt, .draft').forEach((x) => { x.hidden = busy; });
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
  // One answer per ask: a click (or key 1-9) posts once, at once or after the 5 s Undo
  // Settings asks for, and brings that agent's tab forward through the card's own select.
  function answerAsk(key, label, payload) {
    const held = pendingAnswer.get(key);
    if (held && held.state !== 'error') return;
    otherOpen.delete(key);
    const el = askEl(key);
    const card = el && el.closest('.card[data-session]');
    if (card) vscode.postMessage({ type: 'select', sessionId: card.dataset.session, host: card.dataset.host, focus: card.dataset.here === '1', answer: true });
    const wait = Number(el && el.dataset.undo) || 0;
    const p = Object.assign({ left: wait, label, state: wait ? 'wait' : 'sending' }, payload);
    pendingAnswer.set(key, p); drawAsk(key);
    if (!wait) { vscode.postMessage({ type: 'answer', key, choice: p.choice, text: p.text }); return; }
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
  // Undo: the ready ring drains one fifth a second (in steps under reduced motion); under the pointer its center is ✕.
  function drawUndo(key, left) {
    const b = mergeBtn(key); if (!b) return;
    b.classList.remove('v-bad'); b.classList.add('v-ok', 'armed'); b.title = 'Merging in ' + left + ' s. Click to stop'; b.setAttribute('aria-label', b.title);
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const arc = b.querySelector('.arc'); if (arc) { arc.style.transition = still ? '' : 'stroke-dashoffset 1s linear'; arc.style.strokeDashoffset = String(53.4 * (6 - left) / 5); }
  }
  // Back to a ready ring: a stopped Undo, or a countdown the tab left behind.
  function disarm(b) {
    if (!b) return;
    b.classList.remove('armed'); const arc = b.querySelector('.arc'); if (arc) { arc.style.transition = ''; arc.style.strokeDashoffset = ''; }
    b.title = 'Ready to merge. Click to merge #' + b.dataset.mergeNumber; b.setAttribute('aria-label', 'Merge #' + b.dataset.mergeNumber);
  }
  // Rings sent to the host and not answered yet: a redraw keeps them spinning.
  const mergingNow = new Set();
  function drawMerging(key) {
    const b = mergeBtn(key); if (!b) return;
    b.classList.remove('armed'); b.classList.add('merging'); b.title = 'Merging…';
    const w = b.closest('.prli') && b.closest('.prli').querySelector('.vw'); if (w) w.textContent = 'Merging…';
  }
  // What the host says when a merge finished: violet and Merged, or red with the reason.
  function drawMerged(key, error, merged) {
    mergingNow.delete(key);
    const b = mergeBtn(key); if (!b) return;
    // Turned down here with its own warning: back to a ready ring until Review rereads.
    if (!merged && !error) { b.classList.remove('merging'); disarm(b); const w = b.closest('.prli') && b.closest('.prli').querySelector('.vw'); if (w) w.textContent = 'Ready to merge'; return; }
    const row = b.closest('.prli'); const word = row && row.querySelector('.vw');
    b.classList.remove('armed', 'merging', 'v-ok'); b.classList.add(error ? 'v-bad' : 'v-merged'); b.disabled = !error;
    b.title = error ? 'Not merged: ' + error + '. Click to try again' : 'Merged'; b.setAttribute('aria-label', b.title);
    const arc = b.querySelector('.arc'); if (arc) { arc.style.transition = ''; arc.style.strokeDashoffset = ''; }
    if (word) { word.className = 'vw ' + (error ? 'v-bad' : 'v-merged'); word.textContent = error ? 'Not merged: ' + error : 'Merged'; }
  }
  // The Lead tab's box is data-keep (what you type survives a redraw); its mic and busy
  // state arrive as attributes on .lead-ask and are copied onto the box here.
  function syncLeadBox() {
    const ask = main.querySelector('.lead-ask'); if (!ask) return;
    const box = ask.querySelector('.reply-box'); const mic = ask.dataset.mic || 'idle';
    box.classList.toggle('listening', mic === 'listening'); box.classList.toggle('transcribing', mic === 'transcribing');
    const d = box.querySelector('.dictation'); if (d) d.hidden = mic === 'idle';
    const t = box.querySelector('.dict-t'); if (t) t.textContent = mic === 'transcribing' ? 'transcribing…' : '';
    const b = box.querySelector('#lead-mic'); if (b) b.setAttribute('aria-pressed', String(mic === 'listening'));
    const input = box.querySelector('#lead-input'); if (input) input.placeholder = ask.dataset.busy === 'true' ? 'The Lead is working…' : 'Ask the Lead… (Enter asks)';
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
    for (const key of pendingMerge.keys()) disarm(mergeBtn(key));
    const n = pendingMerge.size; mergeTimers.clear(); pendingMerge.clear();
    return n;
  }
  // Settings > Tabs: Review and Issues can go. Sessions always stays: the Lead tab and
  // Settings need a way back.
  let tabsShown = { prs: true, tickets: true, lead: true };
  function syncTabs() {
    for (const t of document.querySelectorAll('.tabs .tab')) {
      t.hidden = t.dataset.tab !== 'sessions' && !tabsShown[t.dataset.tab];
    }
  }
  function choose(tab) {
    // ⌃2/⌃3 to a tab Settings turned off land on Sessions.
    if ((tab === 'prs' || tab === 'tickets') && !tabsShown[tab]) tab = 'sessions';
    if (tab === current) return;
    if (current === 'prs' && cancelMerges()) toast('Merge cancelled: you left Review before it started.');
    if (current === 'sessions' && cancelAnswers()) toast('Answer not sent: you left Sessions before it went.');
    scroll[current] = main.scrollTop;
    current = tab;
    select(tab);
    syncTabs();
    vscode.postMessage({ type: 'tab', tab });
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'tab') { current = m.tab; select(m.tab); syncTabs(); }
    else if (m.type === 'choose') choose(m.tab);
    else if (m.type === 'merged' && typeof m.repo === 'string') drawMerged(m.repo + '#' + m.number, typeof m.error === 'string' ? m.error : '', m.merged !== false);
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
      // Focus comes back to the same card in the same place (pinned or listed), without scrolling to it.
      const focusEl = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.key ? document.activeElement : null;
      const focused = focusEl ? { key: focusEl.dataset.key, place: placeOf(focusEl) } : null;
      const typingIn = same && document.hasFocus() && document.activeElement && document.activeElement.id === 'reply-input' ? document.activeElement : null;
      const typing = typingIn ? { id: typingIn.closest('.card').dataset.session, at: [typingIn.selectionStart, typingIn.selectionEnd] } : null;
      const actBox = activityBox();
      const actEnd = activityAtEnd(actBox);
      // Measured before the patch: a new turn makes the page taller, so after it the viewer no longer looks at the end.
      const leadEnd = m.tab === 'lead' && same && main.scrollHeight - main.scrollTop - main.clientHeight < 80;
      // A stream tick must not take away an Undo, a pending "close anyway?" or the open menu.
      // The patch would draw the toast hidden and empty again, so its words are put back after it.
      const keepToast = same ? main.querySelector('.toast:not([hidden])')?.innerHTML ?? null : null;
      const keepConfirm = same ? [...main.querySelectorAll('.confirm')].map((c) => { const card = c.closest('.card'); return [card.dataset.key, placeOf(card), c]; }) : [];
      const menuOpen = same && openMenu();
      // The tab's heading row (☀, search, ⇅ and its menu) goes into the tab row; the rest into main.
      const page = document.createElement('template'); page.innerHTML = m.html;
      const head = [...page.content.children].find((c) => c.classList.contains('shead')); if (head) head.remove();
      patchChildren(ctl, head ? head.outerHTML : '');
      if (same) patchChildren(main, page.innerHTML); else main.innerHTML = page.innerHTML;
      if (keepToast !== null) { const t = main.querySelector('.toast'); if (t) { t.innerHTML = keepToast; t.hidden = false; } }
      for (const [key, place, box] of keepConfirm) cardsOf('key', key).find((c) => placeOf(c) === place)?.appendChild(box);
      if (menuOpen) { const mm = anyMenu(); if (mm) { mm.hidden = false; mm.parentElement.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'true'); } }
      main.dataset.tab = m.tab;
      if (same) folds().forEach((d, i) => { const k = d.querySelector('summary')?.textContent || i; if (open.has(k)) d.open = true; });
      observeThumbs(main);
      applyFind();
      main.scrollTop = y;
      holdAnchor();
      if (focused) { const el = cardsOf('key', focused.key).find((c) => placeOf(c) === focused.place); if (el) el.focus({ preventScroll: true }); }
      if (m.tab === 'lead') { syncLeadBox(); if (!same || leadEnd) main.scrollTop = main.scrollHeight; }
      if (m.tab === 'sessions') {
        syncBulk(); syncFrontReply(typing); drawFrontMade(); syncTitles();
        const box = activityBox();
        if (box && (box !== actBox || actEnd)) box.scrollTop = box.scrollHeight;
      }
      restoreLocal();
      document.body.classList.remove('loading');
    }
    else if (m.type === 'project') {
      // Only a different project cancels a merge still counting down; every load re-sends the name.
      if (shownProject !== undefined && m.name !== shownProject && cancelMerges()) toast('Merge cancelled: the project changed before it started.');
      if (shownProject !== undefined && m.name !== shownProject) peeked = null;
      shownProject = m.name;
    }
    else if (m.type === 'tabs') {
      tabsShown = { prs: m.prs, tickets: m.tickets, lead: true };
      if (!tabsShown[current] && current !== 'sessions' && current !== 'settings') choose('sessions');
      syncTabs();
    }
    else if (m.type === 'goals') { const g = document.querySelector('.goals'); g.innerHTML = m.html || ''; g.hidden = !m.html; }
    else if (m.type === 'loading') document.body.classList.add('loading');
    else if (m.type === 'idle') document.body.classList.remove('loading');
    else if (m.type === 'peek') { peeked = m.id; scrollToPeek = true; drawPeek(); }
    else if (m.type === 'notice') toast(m.text);
    // The status stays long enough to read, then goes once the host has acted.
    else if (m.type === 'opened') { if (busyShown) { busyShown = false; clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, Math.max(0, 700 - (Date.now() - busySince))); } }
    else if (m.type === 'replyResult') showReplyError(main.querySelector('.card.front .reply-box'), m.ok ? '' : (m.error || 'Reply failed'));
    else if (m.type === 'dictation') {
      const box = main.querySelector('.card.front .reply-box');
      setDictation(box, m.state, m.text);
      if (m.error) showReplyError(box, m.error);
    }
    else if (m.type === 'answered') {
      const p = pendingAnswer.get(m.key); if (!p) return;
      if (m.error) { p.state = 'error'; p.error = m.error; } else p.state = 'sent';
      drawAsk(m.key);
    }
    else if (m.type === 'reveal') {
      // The list stays where it is while any card of the session shows (the pinned one
      // included); only one off screen scrolls its listed card to the nearest edge.
      const all = cardsOf('session', m.sessionId);
      if (!all.length) return;
      const c = all.find((x) => placeOf(x) === 'list') || all[0];
      if (!all.some(onScreen)) c.scrollIntoView({ block: 'nearest' });
      if (m.flash) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
    }
  });
  // Sessions: a click selects; icons focus, resume, close or hide. Closing a tab
  // whose agent is working or waiting asks first; everything else offers Undo.
  const multi = new Set();
  let bulkSure = false;
  let toastTimer = 0;
  let undo = null;
  const target = (card) => ({ sessionId: card.dataset.session, host: card.dataset.host });
  let busyShown = false, busySince = 0;
  function toast(text, onUndo, hold) {
    const el = main.querySelector('.toast'); if (!el) return;
    el.innerHTML = '<span></span>' + (onUndo ? '<button data-undo>Undo</button>' : '');
    el.firstChild.textContent = text; el.hidden = false; undo = onUndo || null; busyShown = !!hold; busySince = Date.now();
    clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, hold ? 30000 : 6000);
  }
  // A redraw may have replaced the toast's node, so it is looked up when it goes.
  function hideToast() { const el = main.querySelector('.toast'); if (el) el.hidden = true; undo = null; busyShown = false; }
  // A click that opens something rings the thing clicked and says so at once; the host's
  // 'opened' ends it, so nothing silently waits (owner video, 2026-10-19 12:58 AM).
  // The ring is a Web Animation, not a class: the redraw a click causes rewrites the card's
  // classes, and an animation on the node outlives that.
  function opening(el, words) {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && el.animate) el.animate([
      { boxShadow: '0 0 0 0 color-mix(in srgb, var(--r-gold-line) 70%, transparent)' },
      { boxShadow: '0 0 0 4px color-mix(in srgb, var(--r-gold-line) 30%, transparent)', offset: 0.4 },
      { boxShadow: '0 0 0 0 transparent' },
    ], { duration: 900, easing: 'ease-out' });
    toast(words, null, true);
  }
  function named(el, fallback) { return (el.textContent || '').trim() || fallback; }
  // The pinned card's title renames a Claude session: Enter types /rename into its tab, Esc
  // or leaving the box cancels. The title is data-keep, so a stream update never takes the
  // box away; otherwise it always draws the stream's title (data-ttl), so a new name shows
  // only once the session reports it.
  function syncTitles() {
    const t = main.querySelector('.front-pin .ttl[data-ttl]');
    if (!t || t.querySelector('input')) return;
    if (t.textContent !== t.dataset.ttl) t.textContent = t.dataset.ttl;
  }
  function editTitle(t) {
    if (t.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'ttl-edit'; input.value = t.textContent; input.setAttribute('aria-label', 'Rename this session');
    t.replaceChildren(input); input.focus(); input.select();
    let done = false;
    const end = (save) => {
      if (done) return; done = true;
      const card = t.closest('.card'); const name = input.value.trim();
      if (save && card && name && name !== t.dataset.ttl) vscode.postMessage({ type: 'rename', sessionId: card.dataset.session, name });
      t.replaceChildren(); syncTitles();
    };
    input.addEventListener('keydown', (k) => { if (k.metaKey || k.ctrlKey) return; k.stopPropagation(); if (k.key === 'Enter' && !k.isComposing) { k.preventDefault(); end(true); } else if (k.key === 'Escape') { k.preventDefault(); end(false); } });
    input.addEventListener('blur', () => end(false));
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
    if (current === 'lead' && e.target.closest) {
      const ref = e.target.closest('[data-lead-ref]');
      if (ref) { e.preventDefault(); vscode.postMessage({ type: 'leadRef', ref: JSON.parse(ref.dataset.leadRef), external: e.metaKey || e.ctrlKey || e.altKey }); return; }
      const one = e.target.closest('[data-lead-confirm]');
      if (one && !one.disabled) { one.disabled = true; vscode.postMessage({ type: 'leadConfirm', key: one.dataset.leadConfirm }); return; }
      const all = e.target.closest('[data-lead-confirm-all]');
      if (all && !all.disabled) { all.disabled = true; vscode.postMessage({ type: 'leadConfirmAll', tokens: all.dataset.leadConfirmAll }); return; }
      if (e.target.closest('#lead-mic')) { vscode.postMessage({ type: 'leadTalk' }); return; }
    }
    // A card's ⋯ menu: its summary toggles it; a click anywhere else closes it.
    main.querySelectorAll('.cmore[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
    // ☆/★: a favorite is this viewer's own; every copy of the card turns at once.
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.preventDefault(); e.stopPropagation();
      const on = fav.getAttribute('aria-pressed') !== 'true';
      main.querySelectorAll('[data-fav="' + CSS.escape(fav.dataset.fav) + '"]').forEach((b) => { b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Remove from Favorites' : 'Add to Favorites'; });
      fav.closest('.cmore').open = false;
      vscode.postMessage({ type: 'favorite', sessionId: fav.dataset.fav, value: on });
      toast(on ? 'Added to Favorites' : 'Removed from Favorites');
      return;
    }
    if (e.target.closest('.ttl-edit')) return;
    const rn = e.target.closest('.front-pin .ttl[data-rename="1"]');
    if (rn) { e.preventDefault(); editTitle(rn); return; }
    // Copy, on a card or in its ⋯ menu: the text goes to the clipboard through the host.
    const copy = e.target.closest('[data-copy]');
    // A value in ⋯ copies quietly: a faint "copied" beside it for a moment, the menu stays open.
    if (copy && copy.hasAttribute('data-quiet')) { e.stopPropagation(); vscode.postMessage({ type: 'copy', text: copy.dataset.copy }); copy.classList.add('copied'); setTimeout(() => copy.classList.remove('copied'), 1200); return; }
    if (copy) { e.stopPropagation(); vscode.postMessage({ type: 'copy', text: copy.dataset.copy }); toast('Copied'); }
    const more = e.target.closest('.cmore');
    if (copy && !more) return;
    if (more) {
      if (copy) more.open = false;
      // Close and Hide live in ⋯; they run below, as the card's own [data-act].
      if (!e.target.closest('.cmenu [data-act]')) return;
      more.open = false;
    }
    // ‹ › on the pinned card front the tab before or after this one, as a card click would.
    const step = e.target.closest('[data-front-step]');
    if (step) { if (!step.disabled && step.dataset.session) vscode.postMessage({ type: 'select', sessionId: step.dataset.session, host: step.dataset.host, focus: true, step: true, back: step.hasAttribute('data-back') }); return; }
    // The pinned card's Made shelf: a PR opens on GitHub, a ticket in Issues; files open below.
    const shelfLink = e.target.closest('.fc-made [data-url], .fc-made [data-ticket]');
    if (shelfLink) { e.preventDefault(); e.stopPropagation(); opening(shelfLink, 'Opening ' + named(shelfLink, shelfLink.dataset.url || shelfLink.dataset.ticket) + '…'); if (shelfLink.dataset.url) vscode.postMessage({ type: 'open', url: shelfLink.dataset.url, external: e.metaKey || e.ctrlKey || e.altKey }); else vscode.postMessage({ type: 'ticketTab', id: shelfLink.dataset.ticket }); return; }
    if (e.target.closest('[data-open-sidebar]')) { e.preventDefault(); vscode.postMessage({ type: 'openSidebar' }); return; }
    const tab = e.target.closest('.tab');
    if (tab) { choose(tab.dataset.tab); return; }
    // The project button: its menu lists every Linear project (read when it opens).
    // A ticket tile or chip peeks at its row in Issues and opens its Linear page.
    const tk = e.target.closest('[data-open-ticket]');
    if (tk) { e.preventDefault(); e.stopPropagation(); opening(tk, 'Opening ' + tk.dataset.openTicket + '…'); vscode.postMessage({ type: 'ticketTab', id: tk.dataset.openTicket }); return; }
    const merge = e.target.closest('[data-merge-repo]');
    if (merge) {
      e.preventDefault(); e.stopPropagation();
      const key = merge.dataset.mergeRepo + '#' + merge.dataset.mergeNumber;
      // A second click inside the window is Undo: nothing was sent yet.
      if (pendingMerge.has(key)) { clearInterval(mergeTimers.get(key)); mergeTimers.delete(key); pendingMerge.delete(key); disarm(merge); toast('Stopped. #' + merge.dataset.mergeNumber + ' was not merged.'); return; }
      let left = 5; pendingMerge.set(key, left); drawUndo(key, left);
      const timer = setInterval(() => {
        left -= 1;
        if (!pendingMerge.has(key)) { clearInterval(timer); return; }
        if (left > 0) { pendingMerge.set(key, left); drawUndo(key, left); return; }
        clearInterval(timer); pendingMerge.delete(key); mergeTimers.delete(key);
        mergingNow.add(key); drawMerging(key);
        vscode.postMessage({ type: 'merge', repo: merge.dataset.mergeRepo, number: Number(merge.dataset.mergeNumber), sha: merge.dataset.mergeSha });
      }, 1000);
      mergeTimers.set(key, timer);
      return;
    }
    const fix = e.target.closest('[data-fix-repo]');
    // One agent per click: the button stays off until Review redraws.
    if (fix) { e.preventDefault(); e.stopPropagation(); if (fix.disabled) return; fix.disabled = true; fix.title = 'Starting…'; vscode.postMessage({ type: 'fixPr', repo: fix.dataset.fixRepo, number: Number(fix.dataset.fixNumber) }); return; }
    const rpref = e.target.closest('[data-rpref]');
    if (rpref) { vscode.postMessage({ type: 'reviewPrefs', key: rpref.dataset.rpref, value: rpref.dataset.value }); return; }
    if (e.target.closest('[data-search]')) { vscode.postMessage({ type: 'search' }); return; }
    if (e.target.closest('[data-refresh]')) { vscode.postMessage({ type: 'refresh' }); return; }
    const os = e.target.closest('[data-open-session]');
    if (os) { vscode.postMessage({ type: 'openSession', sessionId: os.dataset.openSession, host: os.dataset.host }); return; }
    // An ask on a card: each answer button carries what it sends (a choice id or words).
    const askBox = e.target.closest('.card .ask[data-ask]');
    if (askBox) {
      const key = askBox.dataset.ask;
      const opt = e.target.closest('[data-choice], [data-ask-text]');
      if (opt) { e.stopPropagation(); answerAsk(key, opt.dataset.label, opt.dataset.choice ? { choice: opt.dataset.choice } : { text: opt.dataset.askText }); return; }
      if (e.target.closest('[data-ask-other]')) { otherOpen.add(key); drawAsk(key); askBox.querySelector('[data-ask-input]').focus(); return; }
      const draftEdit = e.target.closest('[data-ask-edit]');
      if (draftEdit) { e.stopPropagation(); otherOpen.add(key); drawAsk(key); const input = askBox.querySelector('[data-ask-input]'); input.value = draftEdit.dataset.askEdit; input.focus(); return; }
      if (e.target.closest('[data-ask-undo]')) { const p = pendingAnswer.get(key); if (p) clearInterval(p.timer); pendingAnswer.delete(key); drawAsk(key); return; }
      if (e.target.closest('.aother, .asend')) return;
    }
    const ask = e.target.closest('.card .ask [data-expand]');
    if (ask) { const id = ask.closest('.card').dataset.session; if (opened.has(id)) opened.delete(id); else opened.add(id); restoreLocal(); return; }
    const goal = e.target.closest('.goals [data-url]');
    if (goal) { e.preventDefault(); const gm = goal.closest('.menu'); if (gm) gm.hidden = true; vscode.postMessage({ type: 'open', url: goal.dataset.url, external: e.metaKey || e.ctrlKey || e.altKey }); return; }
    const menuBtn = e.target.closest('[data-menu]');
    const menu = menuBtn ? menuBtn.parentElement.querySelector(':scope > .menu') : openMenu();
    if (menuBtn && menu) { const open = menu.hidden; menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); return; }
    const pref = e.target.closest('[data-pref]');
    if (pref) { vscode.postMessage({ type: 'prefs', key: pref.dataset.pref, value: pref.dataset.value }); return; }
    const closeMenu = (m) => { m.hidden = true; m.parentElement.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'false'); };
    // The header's milestone menu: the pick is the host's to remember and draw.
    const ms = e.target.closest('.menu [data-milestone]');
    if (ms) { closeMenu(ms.closest('.menu')); vscode.postMessage({ type: 'milestone', name: ms.dataset.milestone }); return; }
    // A ticket's ▾: Where is a choice inside the menu; an agent starts with it.
    const where = e.target.closest('.menu [data-where]');
    if (where) {
      where.closest('.menu').querySelectorAll('[data-where]').forEach((b) => { const on = b === where; b.setAttribute('aria-checked', String(on)); b.querySelector('.ck').textContent = on ? '✓' : ''; });
      return;
    }
    const pickAgent = e.target.closest('.menu [data-start-ticket][data-agent]');
    if (pickAgent) {
      const m = pickAgent.closest('.menu'); closeMenu(m);
      const id = pickAgent.dataset.startTicket;
      if (Date.now() - (startedAt.get(id) || 0) < 5000) return;
      startedAt.set(id, Date.now());
      vscode.postMessage({ type: 'startTicket', id, agent: pickAgent.dataset.agent, where: m.querySelector('[data-where][aria-checked="true"]')?.dataset.where });
      return;
    }
    if (menu && !menu.hidden && !e.target.closest('.menu')) { menu.hidden = true; menu.parentElement.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'false'); }
    if (e.target.closest('.menu')) return;
    // The front card's reply box handles its own keys and mic; a click there selects nothing.
    if (e.target.closest('.fc-reply')) return;
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
      if (kind === 'focus' || kind === 'resume') { opening(card, (kind === 'resume' ? 'Resuming ' : 'Opening ') + card.dataset.title + '…'); vscode.postMessage({ type: kind, sessionId: card.dataset.session, host: card.dataset.host }); }
      else if (kind === 'close') { if (card.dataset.busy === '1') askClose(card); else closeCards([card]); }
      else if (kind === 'hide') closeCards([card]);
      return;
    }
    const th = e.target.closest('.th[data-path]');
    if (th) { e.preventDefault(); opening(th, 'Opening the image…'); vscode.postMessage({ type: 'image', path: th.dataset.path }); return; }
    // Tickets: a row unfolds its peek and a second click folds it; ↗ opens its Linear page.
    // The agent's logo starts that agent on it, once per click.
    const trow = e.target.closest('.trow[data-ticket]');
    if (trow) {
      e.preventDefault();
      const id = trow.dataset.ticket;
      peeked = peeked === id ? null : id;
      drawPeek();
      return;
    }
    const go = e.target.closest('[data-start-ticket]');
    if (go) {
      e.preventDefault(); e.stopPropagation();
      // One agent per click: a second click on the ticket within 5 s starts nothing.
      const id = go.dataset.startTicket;
      if (Date.now() - (startedAt.get(id) || 0) < 5000) return;
      startedAt.set(id, Date.now());
      vscode.postMessage({ type: 'startTicket', id });
      return;
    }
    const art = e.target.closest('[data-artifact]');
    if (art && card) { e.preventDefault(); opening(art, 'Opening ' + art.dataset.artifact.split('/').pop() + '…'); vscode.postMessage({ type: 'artifact', sessionId: card.dataset.session, host: card.dataset.host, path: art.dataset.artifact }); return; }
    const a = e.target.closest('a');
    if (a && a.dataset.url) { e.preventDefault(); opening(a, 'Opening ' + named(a, a.dataset.url) + '…'); vscode.postMessage({ type: 'open', url: a.dataset.url, external: e.metaKey || e.ctrlKey || e.altKey }); return; }
    if (card) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) { const id = card.dataset.session; if (multi.has(id)) multi.delete(id); else multi.add(id); syncBulk(); return; }
      if (!card.closest('.front-pin')) anchor = { key: card.dataset.key, place: placeOf(card), top: card.getBoundingClientRect().top, at: Date.now() };
      if (!card.closest('.front-pin')) opening(card, 'Opening ' + card.dataset.title + '…');
      // The rail moves on the click. A card changed here loses its hash, so the host's next draw always patches it back to what the host holds.
      // The pinned copy loses it too, so 1-9 never answers the session clicked away from.
      const rail = (c, on) => { if (c.classList.contains('sel') === on) return; c.classList.toggle('sel', on); c.removeAttribute('data-h'); };
      for (const c of main.querySelectorAll('.card.sel')) rail(c, false);
      for (const c of cardsOf('session', card.dataset.session)) rail(c, true);
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
    // While ⌘K is open no key reaches the list behind it; Esc closes it.
    if (!kscrim.hidden) { if (e.key === 'Escape') kclose(); return; }
    if (e.target && e.target.id === 'lead-input') {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const text = e.target.value.trim();
        if (text && main.querySelector('.lead-ask')?.dataset.busy !== 'true') { e.target.value = ''; vscode.postMessage({ type: 'leadAsk', text }); }
      }
      return;
    }
    // The reply box and the filter bar take their own keys; the activity box scrolls with the arrow keys.
    if (e.target.closest && e.target.closest('.fc-reply, .fc-act ol, .sfind')) return;
    // Other…: Enter sends what was typed (with the same Undo setting), Escape closes the box.
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
      // A focused or selected card answers its session's ask through whichever of its cards
      // carries the answers: the pinned one, or its own when a Favorites copy shows the question.
      const opts = (c) => c && c.querySelector('.ask[data-ask] .opts:not([hidden])');
      const answers = (c) => opts(c) || (c ? cardsOf('key', c.dataset.key).map(opts).find(Boolean) : null);
      const ask = held ? answers(held) : [...main.querySelectorAll('.card.sel')].map(answers).find(Boolean);
      const opt = ask ? ask.querySelectorAll('.opt')[Number(e.key) - 1] : null;
      if (opt) { e.preventDefault(); opt.click(); return; }
    }
    const tab = e.target.closest && e.target.closest('.tab');
    if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus(); choose(next.dataset.tab); return;
    }
    if (e.key === 'Escape') { const m = openMenu(); if (m) m.hidden = true; multi.clear(); syncBulk(); return; }
    if (e.target.closest && e.target.closest('a, button, summary')) return;
    const gh = e.target.closest && e.target.closest('.gh');
    if (gh && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); gh.click(); return; }
    const card = e.target.closest && e.target.closest('.card[data-session]');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.click(); }
  });
  // ⌘K: the host sends the rows (\`renderPalette\`) when it opens and as the stream moves;
  // the page filters them as you type and keeps what you typed and selected.
  ${paletteMatch}
  ${saidSnippet}
  const kscrim = document.querySelector('.kscrim'), kq = document.getElementById('kq'), klist = document.getElementById('klist'), kql = document.querySelector('.kql');
  let kpicked = null;
  function krows() { return [...klist.querySelectorAll('.krow:not([hidden])')].sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0)); }
  function kmark() {
    const rows = krows();
    if (!rows.some((r) => r.dataset.session === kpicked)) kpicked = rows[0] ? rows[0].dataset.session : null;
    for (const r of klist.querySelectorAll('.krow')) r.setAttribute('aria-selected', String(r.dataset.session === kpicked));
  }
  // Rows rank by how well they match (paletteMatch), then keep the host's order; the best
  // 60 show, and the footer says how many more the words would need to narrow.
  function kfilter() {
    const ranked = [...klist.querySelectorAll('.krow')].map((r, i) => ({ r, i, t: paletteMatch({ ids: r.dataset.ids, title: r.dataset.title, text: r.dataset.text, said: r.dataset.said }, kq.value) }));
    const hits = ranked.filter((x) => x.t !== null).sort((a, b) => a.t - b.t || a.i - b.i);
    const shownSet = new Set(hits.slice(0, 60).map((x) => x.r));
    for (const x of ranked) { x.r.hidden = !shownSet.has(x.r); x.r.style.order = String(x.t ?? 0); ksaid(x.r, x.t === 4 && !x.r.hidden ? kq.value : ''); }
    for (const el of klist.querySelectorAll('.kempty:not(.kwait), .kmore')) el.remove();
    if (!hits.length && !klist.dataset.waiting) { const d = document.createElement('div'); d.className = 'kempty'; d.textContent = kq.value.trim() ? 'Nothing matches \u201c' + kq.value.trim() + '\u201d' : 'No sessions yet'; klist.append(d); }
    if (hits.length > 60) { const d = document.createElement('div'); d.className = 'kempty kmore'; d.style.order = '99'; d.textContent = (hits.length - 60) + ' more \u00b7 type to narrow'; klist.append(d); }
    kmark();
  }
  // A row matched only by what was said in it shows those words, the match marked, where
  // its recap line sits; it gets its own line back when the words change.
  function ksaid(r, q) {
    const cut = q ? saidSnippet(r.dataset.said || '', q) : null;
    let n = r.querySelector('.knote');
    if (!cut) {
      if (n && n.dataset.was !== undefined) { n.textContent = n.dataset.was; delete n.dataset.was; if (!n.textContent) n.remove(); }
      return;
    }
    if (!n) { n = document.createElement('span'); n.className = 'knote'; r.querySelector('.ksub').append(n); }
    if (n.dataset.was === undefined) n.dataset.was = n.textContent;
    const m = document.createElement('mark');
    m.textContent = cut.hit;
    n.replaceChildren(cut.before, m, cut.after);
  }
  function kclose() { if (kscrim.hidden) return; kscrim.hidden = true; kql.hidden = true; vscode.postMessage({ type: 'paletteClosed' }); }
  function kpick(row) {
    if (!row) return;
    opening(row, 'Opening ' + row.dataset.title + '\u2026');
    kclose();
    vscode.postMessage({ type: 'paletteGo', sessionId: row.dataset.session, host: row.dataset.host, here: row.dataset.here === '1' });
  }
  function kshow(html, waiting) {
    const was = kscrim.hidden;
    klist.dataset.waiting = waiting ? '1' : '';
    klist.innerHTML = waiting ? '<div class="kempty kwait">Waiting for the session stream\u2026</div>' : html;
    observeThumbs(klist);
    if (was) { kscrim.hidden = false; kq.value = ''; kpicked = null; }
    kfilter();
    if (was) kq.focus();
    const sel = klist.querySelector('.krow[aria-selected="true"]');
    if (sel && was) sel.scrollIntoView({ block: 'nearest' });
  }
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'palette') kshow(e.data.html, e.data.waiting); });
  // ⌘K (Ctrl+K) inside the panel opens it here: the editor's own binding did not reach a
  // focused webview (it waited for a chord instead), so the page takes the key first.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault(); e.stopPropagation();
      // Open already: back to the box with its words selected; nothing is sent again.
      if (!kscrim.hidden) { kq.focus(); kq.select(); return; }
      vscode.postMessage({ type: 'search' });
    }
  }, true);
  kq.addEventListener('input', () => { kpicked = null; kfilter(); klist.scrollTop = 0; });
  kq.addEventListener('keydown', (e) => {
    // ⌘/Ctrl keys go on to the webview host, which runs copy, paste and cut for the page.
    if (e.metaKey || e.ctrlKey) return;
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = krows(); const i = rows.findIndex((r) => r.dataset.session === kpicked);
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { kpicked = next.dataset.session; kmark(); next.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); kpick(klist.querySelector('.krow[aria-selected="true"]')); }
    else if (e.key === 'Escape') { e.preventDefault(); kclose(); }
  });
  // A thumbnail opens a quick look; space or esc (or a click) closes it.
  document.addEventListener('keydown', (e) => {
    if (!kql.hidden && (e.key === 'Escape' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); kql.hidden = true; kq.focus(); }
  }, true);
  kql.addEventListener('click', () => { kql.hidden = true; kq.focus(); });
  kscrim.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === kscrim) { kclose(); return; }
    const row = e.target.closest('.krow');
    const ql = e.target.closest('[data-ql]');
    if (ql) { e.preventDefault(); kql.querySelector('img').src = ql.dataset.ql; kql.querySelector('figcaption').textContent = ql.dataset.name + ' \u00b7 attached by you \u00b7 space or esc closes'; kql.hidden = false; return; }
    const url = e.target.closest('[data-url]');
    if (url) { e.preventDefault(); opening(url, 'Opening ' + named(url, url.dataset.url) + '\u2026'); kclose(); vscode.postMessage({ type: 'open', url: url.dataset.url, external: e.metaKey || e.ctrlKey || e.altKey }); return; }
    const art = e.target.closest('[data-artifact]');
    if (art && row) { e.preventDefault(); opening(art, 'Opening ' + art.dataset.artifact.split('/').pop() + '\u2026'); kclose(); vscode.postMessage({ type: 'artifact', sessionId: row.dataset.session, host: row.dataset.host, path: art.dataset.artifact }); return; }
    if (row) kpick(row);
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
