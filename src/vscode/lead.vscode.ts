// The Lead in the editor: the Project panel's ✳ Lead tab is the conversation
// (src/core/leadView.ts draws it; src/vscode/projectPanel.vscode.ts hosts it), ⌥Space
// opens that tab and talks, and the last summary sits in the status bar. Every gesture
// is one `agents lead …` verb through src/core/lead.ts; agents-cli owns the Lead's
// process, so nothing here ever stops a turn.
//
// When ~/.agents/lead/surface.json says "bubble", FastWispr owns ⌥Space: the
// keybinding's `agents.lead.bubble` clause lets the key through, and only the
// status-bar item and the tab stay here.

import * as vscode from 'vscode';
import {
  LeadClient, ageText, isWebUrl, parseLeadRef, readSurface, refKey, watchSurface, writeSurface,
  type LeadContext, type LeadHistoryTurn, type LeadRef, type LeadSnapshot, type LeadStatus, type LeadSurface,
} from '../core/lead';
import { MIC_IDLE, PressGate, nextMic, type MicEvent, type MicMachine, type MicUpdate } from '../core/leadInput';
import { mergeTurns, type LeadTabModel } from '../core/leadView';
import { dictation } from './dictation.vscode';
import { frontTerminal, terminalTabNumbers } from './frontTab.vscode';
import * as terminals from './terminals.vscode';
import { openLink } from './webviewSecurity';

/** A PR's page: its url from the Lead, else github.com/<repo>/pull/<n>. */
function prUrl(r: Extract<LeadRef, { kind: 'pr' }>): string {
  return r.url && isWebUrl(r.url) ? r.url : `https://github.com/${r.repo}/pull/${r.number}`;
}

/** Open a ref: a ticket in Issues (its Linear page with Alt), a PR's GitHub page as a tab,
 *  a session in its tab (or resumed). */
async function openLeadRef(r: LeadRef, external = false): Promise<void> {
  if (r.kind === 'ticket') {
    if (external && r.url && isWebUrl(r.url)) { await openLink(r.url); return; }
    await vscode.commands.executeCommand('agents.project.openTicket', r.id);
    return;
  }
  if (r.kind === 'pr') { await openLink(prUrl(r)); return; }
  const { resumeAndNotify } = await import('./resumeSession.vscode');
  await resumeAndNotify({ sessionId: r.id, host: r.host ?? '', title: r.title ?? '' });
}

/** What the editor shows right now: the tab in front and every agent tab with its number. */
function editorContext(): LeadContext {
  const numbers = terminalTabNumbers();
  const front = frontTerminal();
  const tabs: LeadContext['tabs'] = [];
  for (const [t, tab] of numbers) {
    const sessionId = terminals.getByTerminal(t)?.sessionId;
    if (sessionId) tabs.push({ sessionId, title: t.name, tab });
  }
  tabs.sort((a, b) => (a.tab ?? 0) - (b.tab ?? 0));
  const frontId = front ? terminals.getByTerminal(front)?.sessionId : undefined;
  const frontTab = frontId ? tabs.find((t) => t.sessionId === frontId) : undefined;
  return { ...(frontTab ? { front: frontTab } : {}), tabs };
}

/** What the Project panel's Lead tab needs from the Lead, and the gestures it sends back. */
export interface LeadPanelBridge {
  model(project: string | undefined): LeadTabModel;
  /** Read history and status: when the tab shows and on Refresh, never on a timer. */
  load(project: string, force: boolean): Promise<void>;
  onChange(fn: () => void): vscode.Disposable;
  ask(text: string): Promise<void>;
  talk(): Promise<void>;
  confirm(token: string): Promise<void>;
  confirmAll(tokens: string[]): Promise<void>;
  /** Only a ref the tab was given opens; page text never becomes a target. */
  openRef(ref: unknown, external: boolean): Promise<void>;
}

let bridge: LeadPanelBridge | undefined;

/** The Lead tab's bridge, once the Lead is registered. */
export function leadPanel(): LeadPanelBridge | undefined {
  return bridge;
}

class LeadController implements LeadPanelBridge {
  readonly client = new LeadClient();
  private readonly status: vscode.StatusBarItem;
  private surface: LeadSurface = readSurface();
  /** ⌥Space arrives as a stream of repeats while held; one press is one gesture. */
  private readonly keys = new PressGate();
  /** The Lead's mic as a pure machine (`nextMic`); `dispatch` performs its effects on the shared dictation. */
  private mic: MicMachine = MIC_IDLE;
  private readonly posts = new Map<number, (u: MicUpdate) => void>();
  private project: string | undefined;
  private history: LeadHistoryTurn[] = [];
  private historyFor: string | undefined;
  private leadStatus: LeadStatus | null = null;
  private loading = false;
  private loadError: string | undefined;
  private shownRefs = new Map<string, LeadRef>();
  private readonly changed = new vscode.EventEmitter<void>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem('agents.lead', vscode.StatusBarAlignment.Left, 99);
    this.status.name = 'Lead';
    this.status.command = 'agents.lead.open';
    context.subscriptions.push(this.status, this.changed, this.client.onChange((s) => this.render(s)), { dispose: () => this.client.dispose() });
    // The age in the status bar reads "5m", "1h"; redraw it, nothing else, twice a minute.
    const ageTimer = setInterval(() => this.renderStatus(this.client.snapshot()), 30_000);
    context.subscriptions.push({ dispose: () => clearInterval(ageTimer) });
    void vscode.commands.executeCommand('setContext', 'agents.lead.bubble', this.surface === 'bubble');
    try {
      context.subscriptions.push(watchSurface((s) => {
        this.surface = s;
        void vscode.commands.executeCommand('setContext', 'agents.lead.bubble', s === 'bubble');
        this.render(this.client.snapshot());
      }));
    } catch (e) {
      console.warn('[lead] cannot watch ~/.agents/lead/surface.json:', e);
    }
    this.renderStatus(this.client.snapshot());
    this.status.show();
  }

  async resolveProject(): Promise<string | undefined> {
    const name = await vscode.commands.executeCommand<string | undefined>('agents.project.current').then((p) => p, () => undefined);
    if (name) this.project = name;
    return this.project;
  }

  // ── Commands ──

  /** The Lead tab in the Project panel, brought forward. */
  async openTab(): Promise<void> {
    await vscode.commands.executeCommand('agents.project.tab', 'lead');
  }

  /** `agents.lead.ask [text]`: open the Lead tab, and send `text` when given (for a caller such as a search row). */
  async askCommand(text?: unknown): Promise<void> {
    await this.openTab();
    if (typeof text === 'string' && text.trim()) await this.ask(text.trim());
  }

  /** `agents.lead.talk` (⌥Space): open the Lead tab and start or stop talking. A held key is one press. */
  async talkCommand(): Promise<void> {
    if (!this.keys.press(Date.now())) return;
    await this.openTab();
    await this.talk();
  }

  async talk(): Promise<void> {
    if (this.mic.phase === 'idle' && this.client.busy) { void vscode.window.showInformationMessage('The Lead is still working on the last turn.'); return; }
    if (this.mic.phase === 'idle' && !await this.resolveProject()) { this.needProject(); return; }
    // Busy with someone else's recording: the reply box's (ours is `active`).
    await this.dispatch({ kind: 'toggle', origin: 'tab', now: Date.now(), recorderBusy: this.mic.active === undefined && dictation.state() !== 'idle' });
  }

  private needProject(): void {
    void vscode.window.showWarningMessage('The Lead works per project. Pick one in the Project panel first.', 'Switch Project')
      .then((c) => c && vscode.commands.executeCommand('agents.project.pick'));
  }

  private async dispatch(e: MicEvent): Promise<void> {
    const { state, effects } = nextMic(this.mic, e);
    this.mic = state;
    for (const fx of effects) {
      if (fx.kind === 'start') {
        const id = fx.id;
        const post = (u: MicUpdate) => { void this.dispatch({ kind: 'update', id, update: u, now: Date.now() }); };
        this.posts.set(id, post);
        await dictation.start(post);
      } else if (fx.kind === 'stop') await dictation.stop();
      else if (fx.kind === 'cancel') { const post = this.posts.get(fx.id); if (post) dictation.cancelFor(post); }
      else if (fx.kind === 'send') void this.ask(fx.text, fx.secs);
      else if (fx.kind === 'error') void vscode.window.showErrorMessage(fx.message);
    }
    // A finished or dropped recording's post is no longer needed.
    for (const id of [...this.posts.keys()]) if (id !== this.mic.active) this.posts.delete(id);
    this.render(this.client.snapshot());
  }

  setSurface(s: LeadSurface): void {
    try { writeSurface(s); } catch (e) {
      void vscode.window.showErrorMessage(`Could not write ~/.agents/lead/surface.json: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // The watcher sees it too; apply now so the key clause flips at once.
    this.surface = s;
    void vscode.commands.executeCommand('setContext', 'agents.lead.bubble', s === 'bubble');
    this.render(this.client.snapshot());
    void vscode.window.showInformationMessage(s === 'bubble'
      ? 'The Lead floats as a bubble: ⌥Space now belongs to FastWispr. The status bar and the Lead tab stay here.'
      : 'The Lead is docked: ⌥Space opens the Lead tab in the Project panel and talks.');
  }

  // ── The Lead tab's bridge ──

  async ask(text: string, voiceSecs?: number): Promise<void> {
    const project = this.project ?? await this.resolveProject();
    if (!project) { this.needProject(); return; }
    if (this.client.busy) { void vscode.window.showInformationMessage('The Lead is still working on the last turn.'); return; }
    const speak = vscode.workspace.getConfiguration('agents').get<boolean>('lead.speak', true);
    await this.client.ask(project, text, { ...(voiceSecs !== undefined ? { voiceSecs } : {}), context: editorContext(), speak });
  }

  async confirm(token: string): Promise<void> {
    if (!this.client.hasOpenConfirm(token)) return;
    if (this.client.busy) { void vscode.window.showInformationMessage('The Lead is still working; confirm once it finishes.'); return; }
    await this.client.confirm(token);
  }

  async confirmAll(tokens: string[]): Promise<void> {
    if (this.client.busy) { void vscode.window.showInformationMessage('The Lead is still working; confirm once it finishes.'); return; }
    await this.client.confirmAll(tokens.filter((t) => this.client.hasOpenConfirm(t)));
  }

  async openRef(ref: unknown, external: boolean): Promise<void> {
    const r = parseLeadRef(ref);
    const shown = r ? this.shownRefs.get(refKey(r)) : undefined;
    if (shown) await openLeadRef(shown, external);
  }

  onChange(fn: () => void): vscode.Disposable {
    return this.changed.event(fn);
  }

  async load(project: string, force: boolean): Promise<void> {
    if (!force && this.historyFor === project) return;
    this.project = project;
    this.historyFor = project;
    this.loading = true;
    this.changed.fire();
    const [h, s] = await Promise.allSettled([this.client.history(project, 100), this.client.status(project)]);
    if (project !== this.historyFor) return;
    this.loading = false;
    this.history = h.status === 'fulfilled' ? h.value : [];
    this.leadStatus = s.status === 'fulfilled' ? s.value : null;
    const errs = [h, s].filter((x): x is PromiseRejectedResult => x.status === 'rejected').map((x) => x.reason instanceof Error ? x.reason.message : String(x.reason));
    this.loadError = errs[0];
    const last = this.history[this.history.length - 1];
    if (last?.summary && last.at) this.client.noteSummary(last.summary, last.at);
    this.changed.fire();
  }

  model(project: string | undefined): LeadTabModel {
    const snap = this.client.snapshot();
    const sameProject = !!project && this.historyFor === project;
    const live = (snap.project === undefined || snap.project === project) ? [...snap.turns, ...(snap.current ? [snap.current] : [])] : [];
    const turns = mergeTurns(sameProject ? this.history : [], live);
    this.shownRefs = new Map(turns.flatMap((t) => [...t.refs, ...t.segments.flatMap((x) => x.kind === 'ref' ? [x.ref] : [])]).map((r) => [refKey(r), r]));
    const st = sameProject ? this.leadStatus : null;
    return {
      project: project ?? '',
      turns,
      busy: snap.busy,
      mic: this.mic.phase,
      ...(st?.model ? { model: st.model } : {}),
      ...(snap.engine ?? st?.state ? { state: snap.engine ?? st?.state } : {}),
      ...(st?.host ? { host: st.host } : {}),
      loading: sameProject && this.loading,
      ...(sameProject && this.loadError ? { error: this.loadError } : {}),
      now: Date.now(),
    };
  }

  // ── The status bar ──

  private render(s: LeadSnapshot): void {
    this.renderStatus(s);
    this.changed.fire();
  }

  private renderStatus(s: LeadSnapshot): void {
    const bubble = this.surface === 'bubble';
    const listening = this.mic.phase === 'listening';
    this.status.text = listening ? '$(mic-filled) Lead · listening…'
      : s.busy ? '$(sync~spin) Lead · working…'
        : s.last ? `✳ Lead · ${s.last.summary} · ${ageText(Date.now() - s.last.at)}`
          : bubble ? '✳ Lead · floating' : '✳ Lead · ⌥Space';
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['agents.lead.open', 'agents.lead.talk', 'agents.lead.float', 'agents.lead.dock'] };
    md.appendMarkdown(s.last ? 'Last update from the Lead. Click for the conversation.\n\n' : 'The Lead: one long-lived agent for this project.\n\n');
    md.appendMarkdown(bubble
      ? '[Open the conversation](command:agents.lead.open) · [Dock into VSCodium](command:agents.lead.dock)'
      : '[Talk](command:agents.lead.talk) (⌥Space) · [Open the conversation](command:agents.lead.open) · [Float as a bubble](command:agents.lead.float)');
    this.status.tooltip = md;
  }
}

/** @public loaded with require('./lead.vscode') in extension.ts, which knip cannot see */
export function registerLead(context: vscode.ExtensionContext): void {
  const lead = new LeadController(context);
  bridge = lead;
  context.subscriptions.push(
    { dispose: () => { if (bridge === lead) bridge = undefined; } },
    vscode.commands.registerCommand('agents.lead.ask', (text?: unknown) => lead.askCommand(text)),
    vscode.commands.registerCommand('agents.lead.talk', () => lead.talkCommand()),
    vscode.commands.registerCommand('agents.lead.open', () => lead.openTab()),
    vscode.commands.registerCommand('agents.lead.float', () => lead.setSurface('bubble')),
    vscode.commands.registerCommand('agents.lead.dock', () => lead.setSurface('docked')),
  );
}
