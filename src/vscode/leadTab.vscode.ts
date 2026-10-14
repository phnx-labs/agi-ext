// The Lead tab: "✳ Lead · <project>", an editor webview with the whole
// conversation. `agents lead history --json` is read when the tab opens and on
// Refresh; the turns this window runs stream in live. Beside the thread: the
// Lead's session, engine, brief, memory and allowed tools, from one
// `agents lead status --json` read at the same moments. Never on a timer.

import * as vscode from 'vscode';
import {
  linkify, parseLeadRef, refKey, uniqueRefs,
  type LeadClient, type LeadHistoryTurn, type LeadRef, type LeadSegment, type LeadStatus, type LeadSurface, type LeadTurn,
} from '../core/lead';
import { getNonce } from './htmlReader';

export interface LeadTabDeps {
  project(): Promise<string | undefined>;
  openRef(r: LeadRef, external: boolean): Promise<void>;
  ask(text: string): Promise<void>;
  talk(): Promise<void>;
  mic(): 'idle' | 'listening' | 'transcribing';
  confirm(token: string): Promise<void>;
  setSurface(s: LeadSurface): void;
  surface(): LeadSurface;
}

/** One turn as the webview draws it; text is pre-split into text and links. */
export interface TabTurn {
  key: string;
  ask: string;
  voiceSecs?: number;
  at?: number;
  tools: { label: string; state: 'run' | 'ok' | 'fail'; secs?: number }[];
  segments: LeadSegment[];
  confirms: { token: string; label: string; state: string; message?: string }[];
  refs: LeadRef[];
  error?: string;
  live: boolean;
  phase?: string;
}

const fromHistory = (h: LeadHistoryTurn, i: number): TabTurn => ({
  key: h.turn || `h${i}`, ask: h.ask, ...(h.voiceSecs !== undefined ? { voiceSecs: h.voiceSecs } : {}), ...(h.at !== undefined ? { at: h.at } : {}),
  tools: h.tools.map((t) => ({ label: t.label, state: t.state, ...(t.secs !== undefined ? { secs: t.secs } : {}) })),
  segments: linkify(h.text, h.refs), confirms: [], refs: uniqueRefs(h.refs), live: false,
});

const fromLive = (t: LeadTurn, i: number): TabTurn => ({
  key: t.turn || `l${i}-${t.startedAt}`, ask: t.ask, ...(t.voiceSecs !== undefined ? { voiceSecs: t.voiceSecs } : {}), at: t.endedAt ?? t.startedAt,
  tools: t.tools.map((x) => ({ label: x.label, state: x.state, ...(x.secs !== undefined ? { secs: x.secs } : {}) })),
  segments: linkify(t.text, t.refs), confirms: t.confirms.map((c) => ({ token: c.token, label: c.label, state: c.state, ...(c.message ? { message: c.message } : {}) })),
  refs: uniqueRefs(t.refs), ...(t.error ? { error: t.error } : {}), live: !t.finished, ...(t.phase ? { phase: t.phase } : {}),
});

/** History first, then this window's turns that history does not already hold. */
export function mergeTurns(history: LeadHistoryTurn[], live: LeadTurn[]): TabTurn[] {
  const out = history.map(fromHistory);
  const seen = new Set(history.map((h) => h.turn).filter(Boolean));
  live.forEach((t, i) => { if (!t.turn || !seen.has(t.turn)) out.push(fromLive(t, i)); });
  return out;
}

export class LeadTab {
  private panel: vscode.WebviewPanel | undefined;
  private history: LeadHistoryTurn[] = [];
  private status: LeadStatus | null = null;
  private loadError: string | undefined;
  private loading = false;
  private project: string | undefined;
  /** Every ref the page was given, by identity; the only refs a click may open. */
  private shownRefs = new Map<string, LeadRef>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly client: LeadClient, private readonly deps: LeadTabDeps) {}

  /** Open or bring forward the tab. The panel exists before anything is awaited, so two quick opens make one tab. */
  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      const project = await this.deps.project();
      if (project !== this.project) { this.project = project; void this.load(); }
      return;
    }
    const panel = vscode.window.createWebviewPanel('agents.lead', '✳ Lead', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'assets')],
    });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'claude.png');
    const assets = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', f)).toString();
    panel.webview.html = leadTabHtml(panel.webview.cspSource, getNonce(), { linear: assets('linear.svg'), github: assets('github.png'), session: assets('claude.png') });
    const disposables: vscode.Disposable[] = [];
    panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m), null, disposables);
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      for (const d of disposables.splice(0)) d.dispose();
    }, null, disposables);
    this.project = await this.deps.project();
    if (this.panel !== panel) return;
    void this.load();
  }

  private onMessage(m: unknown): void {
    if (!m || typeof m !== 'object') return;
    const msg = m as Record<string, unknown>;
    if (msg.type === 'ready') this.update();
    else if (msg.type === 'ask' && typeof msg.text === 'string' && msg.text.trim()) void this.deps.ask(msg.text.trim());
    // A token or ref from the page is honored only if the Lead gave it to us.
    else if (msg.type === 'confirm' && typeof msg.token === 'string' && this.client.hasOpenConfirm(msg.token)) void this.deps.confirm(msg.token);
    else if (msg.type === 'ref') {
      const r = parseLeadRef(msg.ref);
      if (r && this.shownRefs.has(refKey(r))) void this.deps.openRef(this.shownRefs.get(refKey(r))!, msg.external === true);
    }
    else if (msg.type === 'talk') void this.deps.talk();
    else if (msg.type === 'refresh') void this.load();
    else if (msg.type === 'surface' && (msg.surface === 'bubble' || msg.surface === 'docked')) this.deps.setSurface(msg.surface);
  }

  /** Read history and status: on open and on Refresh only. */
  private async load(): Promise<void> {
    const project = this.project;
    if (!project) { this.loadError = 'Pick a project in the Project panel; the Lead works per project.'; this.update(); return; }
    this.loading = true;
    this.update();
    const [h, s] = await Promise.allSettled([this.client.history(project, 100), this.client.status(project)]);
    if (project !== this.project) return;
    this.loading = false;
    this.history = h.status === 'fulfilled' ? h.value : [];
    this.status = s.status === 'fulfilled' ? s.value : null;
    const errs = [h, s].filter((x): x is PromiseRejectedResult => x.status === 'rejected').map((x) => x.reason instanceof Error ? x.reason.message : String(x.reason));
    this.loadError = errs.length ? errs[0] : undefined;
    const last = this.history[this.history.length - 1];
    if (last?.summary && last.at) this.client.noteSummary(last.summary, last.at);
    this.update();
  }

  /** Post the whole state; the webview redraws the thread and the side panel, never the input. */
  update(): void {
    const panel = this.panel;
    if (!panel) return;
    const snap = this.client.snapshot();
    const live = [...snap.turns, ...(snap.current ? [snap.current] : [])];
    const turns = mergeTurns(this.history, live);
    this.shownRefs = new Map(turns.flatMap((t) => [...t.refs, ...t.segments.flatMap((x) => x.kind === 'ref' ? [x.ref] : [])]).map((r) => [refKey(r), r]));
    panel.title = `✳ Lead · ${this.project ?? 'no project'}`;
    void panel.webview.postMessage({
      type: 'state',
      project: this.project ?? '',
      turns,
      busy: snap.busy,
      mic: this.deps.mic(),
      surface: this.deps.surface(),
      loading: this.loading,
      error: this.loadError ?? '',
      status: {
        session: snap.session ?? this.status?.session ?? '',
        engine: snap.engine ?? this.status?.engine ?? '',
        state: snap.busy ? 'busy' : this.status?.state ?? '',
        model: this.status?.model ?? '',
        host: this.status?.host ?? '',
        brief: this.status?.brief ?? [],
        memory: this.status?.memory ?? [],
        tools: this.status?.tools ?? [],
      },
    });
  }
}

/** The tab's document; exported for the script syntax test. Every string from the Lead goes in as text, never HTML. */
export function leadTabHtml(cspSource: string, n: string, logos: { linear: string; github: string; session: string }): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';" />
<style>
  :root { --gap: 16px; }
  body { margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground);
    font: 13px/1.5 var(--vscode-font-family); }
  .wrap { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: var(--gap); max-width: 1100px; margin: 0 auto; padding: 20px var(--gap); }
  @media (max-width: 760px) { .wrap { grid-template-columns: minmax(0, 1fr); } }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 2px; display: flex; gap: 8px; align-items: center; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 12px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .sub button { font: inherit; color: var(--vscode-textLink-foreground); background: none; border: 0; padding: 0; cursor: pointer; }
  .thread { display: flex; flex-direction: column; gap: 12px; }
  .turn { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
  .you { color: var(--vscode-descriptionForeground); }
  .you small { margin-right: 6px; }
  .tx { white-space: pre-wrap; }
  .tools { display: flex; flex-wrap: wrap; gap: 6px; }
  .tool { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); color: var(--vscode-descriptionForeground); }
  .tool.fail { color: var(--vscode-errorForeground); }
  .tool.run::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--vscode-progressBar-background); animation: breathe 1.2s ease-in-out infinite; vertical-align: middle; }
  @keyframes breathe { 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) { .tool.run::before { animation: none; } }
  a.ref { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; white-space: nowrap; }
  a.ref:hover { text-decoration: underline; }
  a.ref img { width: 12px; height: 12px; vertical-align: -1px; margin-right: 3px; }
  .cf { align-self: flex-start; font: inherit; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
  .cf[disabled] { opacity: .6; cursor: default; }
  .err { color: var(--vscode-errorForeground); }
  .think { color: var(--vscode-descriptionForeground); font-style: italic; }
  .ask { position: sticky; bottom: 0; display: flex; gap: 6px; padding: 10px 0; background: var(--vscode-editor-background); }
  .ask input { flex: 1; font: inherit; padding: 6px 8px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .ask button { font: inherit; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--vscode-widget-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  .ask button[aria-pressed="true"] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  aside { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; padding: 10px 12px; align-self: start; position: sticky; top: 20px; }
  aside h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 10px 0 4px; font-weight: 600; }
  aside h2:first-child { margin-top: 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
  dt { color: var(--vscode-descriptionForeground); }
  dd { margin: 0; overflow-wrap: anywhere; }
  ul { margin: 0; padding-left: 16px; }
  .empty { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div class="wrap">
  <main>
    <h1>✳ <span id="title">Lead</span></h1>
    <div class="sub"><span id="sub"></span><button id="refresh" title="Read the history and status again">Refresh</button><button id="surface"></button></div>
    <div class="thread" id="thread" aria-live="polite"></div>
    <form class="ask" id="ask">
      <input id="ask-in" placeholder="Ask or tell the Lead…" autocomplete="off" />
      <button type="button" id="mic" aria-pressed="false" title="Talk: click to start, again to send">🎙</button>
      <button type="submit">Send</button>
    </form>
  </main>
  <aside id="side"></aside>
</div>
<script nonce="${n}">
(() => {
  const vscode = acquireVsCodeApi();
  const LOGO = { ticket: ${JSON.stringify(logos.linear)}, pr: ${JSON.stringify(logos.github)}, session: ${JSON.stringify(logos.session)} };
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  let state = null;

  function refLink(text, ref) {
    const a = el('a', 'ref');
    const img = el('img'); img.src = LOGO[ref.kind] || LOGO.session; img.alt = '';
    a.append(img, document.createTextNode(text));
    a.title = ref.kind === 'ticket' ? 'Open ' + ref.id + ' in Issues (Alt-click: Linear)' : ref.kind === 'pr' ? 'Open ' + ref.repo + '#' + ref.number + ' on GitHub' : 'Go to this session';
    a.dataset.ref = JSON.stringify(ref);
    return a;
  }

  function turnEl(t) {
    const d = el('div', 'turn');
    if (t.ask) { const y = el('div', 'you'); y.append(el('small', '', t.voiceSecs !== undefined ? '🎙 ' + t.voiceSecs.toFixed(0) + 's' : '⌨'), document.createTextNode(t.ask)); d.append(y); }
    if (t.tools.length) {
      const tl = el('div', 'tools');
      t.tools.forEach((x) => tl.append(el('span', 'tool ' + x.state, x.label + (x.state === 'ok' ? ' ✓' : x.state === 'fail' ? ' ✕' : ' …') + (x.secs !== undefined ? ' ' + x.secs.toFixed(2) + ' s' : ''))));
      d.append(tl);
    }
    if (t.segments.length) {
      const tx = el('div', 'tx');
      t.segments.forEach((s) => tx.append(s.kind === 'ref' ? refLink(s.text, s.ref) : document.createTextNode(s.text)));
      d.append(tx);
    } else if (t.live) d.append(el('div', 'think', t.phase === 'booting' ? 'starting the Lead…' : t.phase === 'tool' ? 'running a tool…' : 'thinking…'));
    const linked = new Set(t.segments.filter((s) => s.kind === 'ref').map((s) => JSON.stringify(s.ref)));
    const extra = t.refs.filter((r) => !linked.has(JSON.stringify(r)));
    if (extra.length) {
      const tl = el('div', 'tools');
      extra.forEach((r) => tl.append(refLink(r.kind === 'ticket' ? r.id : r.kind === 'pr' ? '#' + r.number : (r.title || r.id.slice(0, 8)), r)));
      d.append(tl);
    }
    t.confirms.forEach((c) => {
      const b = el('button', 'cf', c.state === 'open' ? c.label + ' · Confirm' : c.state === 'running' ? 'Running…' : c.state === 'done' ? c.label + ' ✓' : 'Failed: ' + (c.message || c.label));
      b.dataset.token = c.token;
      if (c.state !== 'open' || (state && state.busy)) b.disabled = true;
      d.append(b);
    });
    if (t.error) d.append(el('div', 'err', t.error));
    return d;
  }

  function side(s) {
    const a = $('side'); a.textContent = '';
    a.append(el('h2', '', 'Lead'));
    const dl = el('dl');
    const kv = (k, v) => { if (!v) return; dl.append(el('dt', '', k), el('dd', '', v)); };
    kv('Session', s.session); kv('Engine', s.engine === 'warm' ? 'one warm process' : s.engine === 'cold' ? 'a new process per sentence' : s.engine);
    kv('State', s.state); kv('Model', s.model); kv('Runs on', s.host);
    if (!dl.children.length) dl.append(el('dd', 'empty', 'Not started yet.'));
    a.append(dl);
    const list = (title, items, none) => { a.append(el('h2', '', title)); if (!items.length) { a.append(el('div', 'empty', none)); return; } const ul = el('ul'); items.forEach((x) => ul.append(el('li', '', x))); a.append(ul); };
    list('Brief it started with', s.brief, 'agents lead status gave none.');
    list('Memory · memory.md', s.memory, 'Nothing remembered yet.');
    list('May run', s.tools, 'agents lead status gave none.');
  }

  function render() {
    if (!state) return;
    $('title').textContent = 'Lead · ' + (state.project || 'no project');
    $('sub').textContent = [state.status.session ? 'session ' + state.status.session : '', state.busy ? 'working…' : '', state.loading ? 'reading history…' : '', state.error].filter(Boolean).join(' · ');
    $('surface').textContent = state.surface === 'bubble' ? 'Dock into VSCodium' : 'Float as a bubble';
    const th = $('thread'); th.textContent = '';
    if (!state.turns.length && !state.loading) th.append(el('div', 'empty', state.error ? '' : 'No turns yet. Ask below, or hold ⌥Space anywhere in the editor.'));
    state.turns.forEach((t) => th.append(turnEl(t)));
    side(state.status);
    $('mic').setAttribute('aria-pressed', String(state.mic === 'listening'));
    $('mic').textContent = state.mic === 'listening' ? '■' : state.mic === 'transcribing' ? '…' : '🎙';
    $('ask-in').placeholder = state.busy ? 'The Lead is working…' : 'Ask or tell the Lead…';
    window.scrollTo(0, document.body.scrollHeight);
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.ref');
    if (a) { e.preventDefault(); vscode.postMessage({ type: 'ref', ref: JSON.parse(a.dataset.ref), external: e.altKey }); return; }
    const cf = e.target.closest('button.cf');
    if (cf && !cf.disabled) { cf.disabled = true; vscode.postMessage({ type: 'confirm', token: cf.dataset.token }); return; }
    if (e.target.closest('#refresh')) vscode.postMessage({ type: 'refresh' });
    else if (e.target.closest('#surface')) vscode.postMessage({ type: 'surface', surface: state && state.surface === 'bubble' ? 'docked' : 'bubble' });
    else if (e.target.closest('#mic')) vscode.postMessage({ type: 'talk' });
  });
  $('ask').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('ask-in'); const v = inp.value.trim();
    if (!v || (state && state.busy)) return;
    inp.value = '';
    vscode.postMessage({ type: 'ask', text: v });
  });
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'state') { state = e.data; render(); } });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
