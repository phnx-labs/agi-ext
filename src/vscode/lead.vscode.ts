// The Lead in docked mode: ⌥Space opens VS Code's own quick input at the top
// center for one turn, the last summary sits in the status bar, and the whole
// conversation is an editor tab (src/vscode/leadTab.vscode.ts). Every gesture is
// one `agents lead …` verb through src/core/lead.ts; agents-cli owns the Lead's
// process, so closing the overlay (Esc) never stops a turn.
//
// When ~/.agents/lead/surface.json says "bubble", FastWispr owns ⌥Space: the
// keybinding's `agents.lead.bubble` clause lets the key through, and only the
// status-bar item and the tab stay here.

import * as vscode from 'vscode';
import {
  LeadClient, ageText, isWebUrl, answerLines, readSurface, refDescription, refLabel, uniqueRefs, watchSurface, writeSurface,
  type LeadRef, type LeadSnapshot, type LeadSurface, type LeadTurn,
} from '../core/lead';
import { MIC_IDLE, PressGate, nextMic, type MicEvent, type MicMachine, type MicOrigin, type MicUpdate } from '../core/leadInput';
import { dictation } from './dictation.vscode';
import { LeadTab } from './leadTab.vscode';
import { openLink } from './webviewSecurity';

type Row = vscode.QuickPickItem & { act?: () => unknown; confirm?: string; ref?: LeadRef };

const MIC: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('mic'), tooltip: 'Talk: click (or ⌥Space) to start, again to send' };
const MIC_ON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('mic-filled'), tooltip: 'Listening: click (or ⌥Space) to stop and send' };
const OPEN_TAB: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open the whole conversation as a tab' };
const CONFIRM: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check'), tooltip: 'Confirm: run it' };
const IN_LINEAR: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open in Linear' };

/** A PR's page: its url from the Lead, else github.com/<repo>/pull/<n>. */
function prUrl(r: Extract<LeadRef, { kind: 'pr' }>): string {
  return r.url && isWebUrl(r.url) ? r.url : `https://github.com/${r.repo}/pull/${r.number}`;
}

/** Open a ref: a ticket in Issues (its Linear page as a tab from the row's button), a PR's
 *  GitHub page as a tab, a session in its tab (or resumed). */
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

function refIcon(ext: vscode.Uri, r: LeadRef): vscode.Uri {
  return vscode.Uri.joinPath(ext, 'assets', r.kind === 'ticket' ? 'linear.svg' : r.kind === 'pr' ? 'github.png' : 'claude.png');
}

/** A row's identity: what it shows and whether it has a button. */
const rowKey = (r: Row): string => [r.kind ?? 0, r.label, r.description ?? '', r.buttons?.length ?? 0, r.confirm ?? ''].join('\u0001');

const toolRow = (t: LeadTurn['tools'][number]): Row => ({
  label: `${t.state === 'run' ? '$(sync~spin)' : t.state === 'ok' ? '$(check)' : '$(error)'} ${t.label}`,
  description: t.state === 'run' ? (t.cmd ?? '') : t.secs !== undefined ? `${t.secs < 0.05 ? '<0.05' : t.secs.toFixed(2)} s` : t.state === 'fail' ? 'failed' : '',
  alwaysShow: true,
});

class LeadController {
  readonly client = new LeadClient();
  private readonly status: vscode.StatusBarItem;
  private qp: vscode.QuickPick<Row> | undefined;
  private overlaySig = '';
  private surface: LeadSurface = readSurface();
  /** ⌥Space arrives as a stream of repeats while held; one press is one gesture. */
  private readonly keys = new PressGate();
  /** The Lead's mic as a pure machine (`nextMic`); `dispatch` performs its effects on the shared dictation. */
  private mic: MicMachine = MIC_IDLE;
  private readonly posts = new Map<number, (u: MicUpdate) => void>();
  private project: string | undefined;
  private tab: LeadTab;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem('agents.lead', vscode.StatusBarAlignment.Left, 99);
    this.status.name = 'Lead';
    this.status.command = 'agents.lead.open';
    this.tab = new LeadTab(context, this.client, {
      project: () => this.resolveProject(),
      openRef: (r, external) => openLeadRef(r, external),
      ask: (text) => this.send(text),
      talk: () => this.toggleMic('tab'),
      mic: () => this.mic.phase,
      confirm: (token) => this.confirm(token),
      setSurface: (s) => this.setSurface(s),
      surface: () => this.surface,
    });
    context.subscriptions.push(this.status, this.client.onChange((s) => this.render(s)), { dispose: () => this.client.dispose() });
    // The age in the status bar reads "5m", "1h"; redraw it, nothing else, twice a minute.
    const ageTimer = setInterval(() => this.renderStatus(this.client.snapshot()), 30_000);
    context.subscriptions.push({ dispose: () => clearInterval(ageTimer) });
    void vscode.commands.executeCommand('setContext', 'agents.lead.bubble', this.surface === 'bubble');
    try {
      context.subscriptions.push(watchSurface((s) => {
        this.surface = s;
        void vscode.commands.executeCommand('setContext', 'agents.lead.bubble', s === 'bubble');
        if (s === 'bubble') this.qp?.hide();
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

  /** `agents.lead.ask [text]`: open the overlay, and send `text` when given (for a caller such as a search row). */
  async ask(text?: unknown): Promise<void> {
    const sending = typeof text === 'string' && text.trim();
    // Without text this is the key (or the palette): a held ⌥Space opens the overlay once.
    if (!sending && !this.keys.press(Date.now())) return;
    const project = await this.resolveProject();
    if (!project) {
      void vscode.window.showWarningMessage('The Lead works per project. Pick one in the Project panel first.', 'Switch Project')
        .then((c) => c && vscode.commands.executeCommand('agents.project.pick'));
      return;
    }
    this.openOverlay(project);
    if (typeof text === 'string' && text.trim()) await this.send(text.trim());
  }

  /** `agents.lead.talk`: ⌥Space while the overlay is open. A held key is one press. */
  async talk(): Promise<void> {
    if (!this.keys.press(Date.now())) return;
    await this.toggleMic('overlay');
  }

  async toggleMic(origin: MicOrigin): Promise<void> {
    if (this.mic.phase === 'idle' && this.client.busy) { void vscode.window.showInformationMessage('The Lead is still working on the last turn.'); return; }
    // Busy with someone else's recording: the reply box's (ours is `active`).
    await this.dispatch({ kind: 'toggle', origin, now: Date.now(), recorderBusy: this.mic.active === undefined && dictation.state() !== 'idle' });
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
      else if (fx.kind === 'send') void this.send(fx.text, fx.secs);
      else if (fx.kind === 'error') void vscode.window.showErrorMessage(fx.message);
    }
    // A finished or dropped recording's post is no longer needed.
    for (const id of [...this.posts.keys()]) if (id !== this.mic.active) this.posts.delete(id);
    this.render(this.client.snapshot());
  }

  async openTab(): Promise<void> {
    await this.tab.show();
  }

  setSurface(s: LeadSurface): void {
    try { writeSurface(s); } catch (e) {
      void vscode.window.showErrorMessage(`Could not write ~/.agents/lead/surface.json: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // The watcher sees it too; apply now so the key clause flips at once.
    this.surface = s;
    void vscode.commands.executeCommand('setContext', 'agents.lead.bubble', s === 'bubble');
    if (s === 'bubble') this.qp?.hide();
    this.render(this.client.snapshot());
    void vscode.window.showInformationMessage(s === 'bubble'
      ? 'The Lead floats as a bubble: ⌥Space now belongs to FastWispr. The status bar and the Lead tab stay here.'
      : 'The Lead is docked: ⌥Space opens it at the top of this window.');
  }

  async send(text: string, voiceSecs?: number): Promise<void> {
    const project = this.project ?? await this.resolveProject();
    if (!project) return;
    if (this.client.busy) { void vscode.window.showInformationMessage('The Lead is still working on the last turn.'); return; }
    await this.client.ask(project, text, voiceSecs);
  }

  async confirm(token: string): Promise<void> {
    if (this.client.busy) { void vscode.window.showInformationMessage('The Lead is still working; confirm once it finishes.'); return; }
    await this.client.confirm(token);
  }

  // ── The overlay ──

  private openOverlay(project: string): void {
    if (this.qp) { this.qp.show(); return; }
    const qp = vscode.window.createQuickPick<Row>();
    this.qp = qp;
    qp.ignoreFocusOut = false;
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    qp.placeholder = 'Ask or tell the Lead… (⌥Space again to talk)';
    qp.onDidChangeValue(() => this.renderOverlay(this.client.snapshot()));
    qp.onDidTriggerButton((b) => {
      if (b === OPEN_TAB) { qp.hide(); void this.openTab(); } else void this.toggleMic('overlay');
    });
    qp.onDidTriggerItemButton(({ item, button }) => {
      if (button === CONFIRM && item.confirm) void this.confirm(item.confirm);
      else if (button === IN_LINEAR && item.ref) void openLeadRef(item.ref, true);
    });
    qp.onDidAccept(() => {
      const row = qp.activeItems[0];
      if (row?.act) void row.act();
      else if (qp.value.trim() && !this.client.busy) { const v = qp.value.trim(); qp.value = ''; void this.send(v); }
    });
    // Esc closes the overlay; the turn runs on and lands in the status bar.
    qp.onDidHide(() => {
      // Esc while talking drops the recording: nothing is sent.
      void this.dispatch({ kind: 'cancel', origin: 'overlay' });
      void vscode.commands.executeCommand('setContext', 'agents.lead.overlayOpen', false);
      qp.dispose();
      if (this.qp === qp) { this.qp = undefined; this.overlaySig = ''; }
    });
    this.project = project;
    this.renderOverlay(this.client.snapshot());
    void vscode.commands.executeCommand('setContext', 'agents.lead.overlayOpen', true);
    qp.show();
  }

  private stateWord(s: LeadSnapshot): string {
    return this.mic.phase === 'listening' ? 'listening' : this.mic.phase === 'transcribing' ? 'transcribing' : s.busy ? 'busy' : s.engine ?? 'ready';
  }

  private renderOverlay(s: LeadSnapshot): void {
    const qp = this.qp;
    if (!qp) return;
    qp.title = `Lead · ${this.project ?? s.project ?? 'no project'} · ${this.stateWord(s)}`;
    qp.busy = s.busy || this.mic.phase === 'transcribing';
    qp.buttons = [this.mic.phase === 'listening' ? MIC_ON : MIC, OPEN_TAB];
    qp.enabled = true;
    const rows: Row[] = [];
    const typed = qp.value.trim();
    if (typed) {
      rows.push(s.busy
        ? { label: '$(watch) The Lead is still working', description: 'send once this turn finishes', alwaysShow: true }
        : { label: `$(send) Ask the Lead: “${typed}”`, alwaysShow: true, act: () => { qp.value = ''; return this.send(typed); } });
    }
    const t = s.current;
    if (t) rows.push(...this.turnRows(t));
    // A stream event that changes nothing visible must not move the selection; one that
    // does keeps the row you were on when it is still there.
    const sig = rows.map(rowKey).join('\u0002');
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;
    const active = qp.activeItems[0] ? rowKey(qp.activeItems[0]) : undefined;
    qp.items = rows;
    const keep = active !== undefined ? rows.find((r) => rowKey(r) === active) : undefined;
    if (keep) qp.activeItems = [keep];
  }

  private turnRows(t: LeadTurn): Row[] {
    const ext = this.context.extensionUri;
    const rows: Row[] = [];
    if (t.ask) rows.push({ kind: vscode.QuickPickItemKind.Separator, label: `${t.voiceSecs !== undefined ? '🎙' : '⌨'} ${t.ask}` });
    else rows.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Confirmed' });
    rows.push(...t.tools.map(toolRow));
    if (!t.finished && !t.text) {
      const word = t.phase === 'booting' ? 'starting the Lead…' : t.phase === 'tool' ? 'running a tool…' : 'thinking…';
      rows.push({ label: `$(loading~spin) ${word}`, alwaysShow: true });
    }
    const answer = answerLines(t.text);
    answer.forEach((line, i) => rows.push({
      label: i === 0 ? `$(comment) ${line}` : `      ${line}`,
      alwaysShow: true,
      act: () => { this.qp?.hide(); return this.openTab(); },
    }));
    if (t.error) rows.push({ label: `$(error) ${t.error}`, alwaysShow: true });
    for (const c of t.confirms) {
      rows.push({
        label: `$(warning) ${c.label}`,
        description: c.state === 'open' ? 'press ✓ to run it' : c.state === 'running' ? 'running…' : c.state === 'done' ? 'done' : `failed${c.message ? ': ' + c.message : ''}`,
        alwaysShow: true,
        ...(c.state === 'open' ? { buttons: [CONFIRM], confirm: c.token, act: () => this.confirm(c.token) } : {}),
      });
    }
    const refs = uniqueRefs(t.refs);
    if (refs.length) rows.push({ kind: vscode.QuickPickItemKind.Separator, label: 'Open' });
    for (const r of refs) {
      rows.push({
        label: refLabel(r), description: refDescription(r), iconPath: refIcon(ext, r), alwaysShow: true, ref: r,
        ...(r.kind === 'ticket' && r.url ? { buttons: [IN_LINEAR] } : {}),
        act: () => { this.qp?.hide(); return openLeadRef(r); },
      });
    }
    if (t.timing && t.finished) {
      const parts = Object.entries(t.timing).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => `${k} ${(v as number).toFixed(2)}`);
      if (parts.length) rows.push({ label: `$(clock) ${parts.join(' · ')} s`, alwaysShow: true });
    }
    return rows;
  }

  // ── The status bar ──

  private render(s: LeadSnapshot): void {
    this.renderStatus(s);
    this.renderOverlay(s);
    this.tab.update();
  }

  private renderStatus(s: LeadSnapshot): void {
    const bubble = this.surface === 'bubble';
    const listening = this.mic.phase === 'listening';
    this.status.text = listening ? '$(mic-filled) Lead · listening…'
      : s.busy ? '$(sync~spin) Lead · working…'
        : s.last ? `✳ Lead · ${s.last.summary} · ${ageText(Date.now() - s.last.at)}`
          : bubble ? '✳ Lead · floating' : '✳ Lead · ⌥Space';
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['agents.lead.open', 'agents.lead.ask', 'agents.lead.float', 'agents.lead.dock'] };
    md.appendMarkdown(s.last ? 'Last update from the Lead. Click for the whole conversation.\n\n' : 'The Lead: one long-lived agent for this project.\n\n');
    md.appendMarkdown(bubble
      ? '[Open the conversation](command:agents.lead.open) · [Dock into VSCodium](command:agents.lead.dock)'
      : '[Ask](command:agents.lead.ask) (⌥Space) · [Open the conversation](command:agents.lead.open) · [Float as a bubble](command:agents.lead.float)');
    this.status.tooltip = md;
  }
}

/** @public loaded with require('./lead.vscode') in extension.ts, which knip cannot see */
export function registerLead(context: vscode.ExtensionContext): void {
  const lead = new LeadController(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.lead.ask', (text?: unknown) => lead.ask(text)),
    vscode.commands.registerCommand('agents.lead.talk', () => lead.talk()),
    vscode.commands.registerCommand('agents.lead.open', () => lead.openTab()),
    vscode.commands.registerCommand('agents.lead.float', () => lead.setSurface('bubble')),
    vscode.commands.registerCommand('agents.lead.dock', () => lead.setSurface('docked')),
  );
}
