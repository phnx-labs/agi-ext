// Pages (⌘⇧V): the owner's everyday pages as one row of icons in an editor tab.
// A click opens the page in VSCodium's own browser, in the same tab or a new one.
import * as path from 'path';
import * as vscode from 'vscode';
import {
  browserOpenArgs, findIconHref, normalizePageUrl, PAGES_CLICK_DEFAULT, parseBrowserHistory, pinPage, readPins, renamePin,
  setPinIcon, unpinPage, type PagePin, type PagesClick, type RecentPage,
} from '../core/pages';
import { escapeHtml, RUSH_THEME_CSS } from '../shared/sessionCards';
import { getSettings } from './agentSettings.vscode';
import { getNonce } from './htmlReader';

const PINS_KEY = 'pages.pins';
const VIEW_TYPE = 'agents.pages';
const ICON_MAX_BYTES = 256 * 1024;

type Inbound =
  | { type: 'ready' } | { type: 'refresh' }
  | { type: 'open'; url: string; newTab: boolean }
  | { type: 'pin'; url: string; title: string; icon?: string }
  | { type: 'unpin'; url: string }
  | { type: 'rename'; url: string; name: string };

/**
 * The built-in browser's history lives in VSCodium's own storage, beside this extension's
 * global storage folder. Read-only, with the runtime's own SQLite; nothing else reads it.
 */
export function readBrowserHistory(globalStorage: Pick<vscode.Uri, 'fsPath'>): { recent: RecentPage[]; reason?: string } {
  const db = path.join(path.dirname(globalStorage.fsPath), 'state.vscdb');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string, o: { readOnly: boolean }) => { prepare(sql: string): { get(key: string): { value?: string } | undefined }; close(): void } };
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const read = (key: string) => conn.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)?.value ?? null;
      return { recent: parseBrowserHistory(read('browser.history.entries.global'), read('browser.history.favicons.global')) };
    } finally {
      conn.close();
    }
  } catch (err) {
    return { recent: [], reason: `The browser's history could not be read: ${(err as Error).message}` };
  }
}

async function fetchWithin(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

async function iconAt(url: string): Promise<string | undefined> {
  const res = await fetchWithin(url, 5000);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!res.ok || !type.startsWith('image/')) return undefined;
  const body = Buffer.from(await res.arrayBuffer());
  return body.length && body.length <= ICON_MAX_BYTES ? `data:${type};base64,${body.toString('base64')}` : undefined;
}

/** The icon the page declares, then the site's /favicon.ico; undefined draws a letter. */
export async function resolvePageIcon(pageUrl: string): Promise<string | undefined> {
  if (!/^https?:/i.test(pageUrl)) return undefined;
  const tries: string[] = [];
  try {
    const res = await fetchWithin(pageUrl, 5000);
    const html = res.ok ? (await res.text()).slice(0, 512 * 1024) : '';
    const declared = findIconHref(html, res.url || pageUrl);
    if (declared) tries.push(declared);
  } catch { /* the page did not answer; the site's favicon may */ }
  const fallback = findIconHref('', pageUrl);
  if (fallback && !tries.includes(fallback)) tries.push(fallback);
  for (const href of tries) {
    try {
      const icon = await iconAt(href);
      if (icon) return icon;
    } catch { /* try the next one */ }
  }
  return undefined;
}

export class PagesPanel {
  private panel: vscode.WebviewPanel | undefined;
  /** The URL Pages last opened; "same tab" navigates the browser tab still showing it. */
  private lastUrl: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext, private readonly modifier: string) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Pages', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    panel.webview.html = pagesShell(panel.webview.cspSource);
    panel.onDidDispose(() => { this.panel = undefined; });
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible) this.post(); });
    panel.webview.onDidReceiveMessage((m: Inbound) => { void this.handle(m); });
  }

  /** Settings > Pages changed; an open Pages tab redraws its hint. */
  refresh(): void {
    if (this.panel) this.post();
  }

  private pins(): PagePin[] {
    return readPins(this.context.globalState.get(PINS_KEY));
  }

  private async savePins(pins: PagePin[]): Promise<void> {
    await this.context.globalState.update(PINS_KEY, pins);
  }

  private click(): PagesClick {
    return getSettings(this.context).pages?.click ?? PAGES_CLICK_DEFAULT;
  }

  private post(): void {
    const { recent, reason } = readBrowserHistory(this.context.globalStorageUri);
    void this.panel?.webview.postMessage({ type: 'state', pins: this.pins(), recent, reason, click: this.click(), shortcut: `${this.modifier}V` });
  }

  private async handle(m: Inbound): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        this.post();
        return;
      case 'open': {
        const url = normalizePageUrl(m.url);
        if (!url) {
          void this.panel?.webview.postMessage({ type: 'opened', error: `${m.url} is not a web address` });
          return;
        }
        try {
          await vscode.commands.executeCommand('workbench.action.browser.open', browserOpenArgs(url, m.newTab, this.lastUrl));
          this.lastUrl = url;
          void this.panel?.webview.postMessage({ type: 'opened' });
        } catch (err) {
          void this.panel?.webview.postMessage({ type: 'opened', error: `This editor has no built-in browser: ${(err as Error).message}` });
        }
        return;
      }
      case 'pin': {
        const url = normalizePageUrl(m.url);
        if (!url) return;
        await this.savePins(pinPage(this.pins(), { url, title: m.title, icon: m.icon }));
        this.post();
        if (m.icon) return;
        const icon = await resolvePageIcon(url);
        if (!icon) return;
        await this.savePins(setPinIcon(this.pins(), url, icon));
        this.post();
        return;
      }
      case 'unpin':
        await this.savePins(unpinPage(this.pins(), m.url));
        this.post();
        return;
      case 'rename':
        await this.savePins(renamePin(this.pins(), m.url, m.name));
        this.post();
        return;
    }
  }
}

/** The Pages document; exported for the webview script test. */
export function pagesShell(cspSource: string): string {
  const n = getNonce();
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';" />
<title>Pages</title>
<style>
${RUSH_THEME_CSS}  body { margin: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--r-text); background: var(--vscode-editor-background); }
  main { max-width: 1100px; margin: 0 auto; padding: 22px 28px 40px; }
  .search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border: 1px solid var(--r-edge); border-radius: 10px; background: var(--r-glass); }
  .search:focus-within { border-color: var(--r-gold-line); }
  .search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--r-text); font: inherit; font-size: 13.5px; }
  .hint { color: var(--r-faint); font-size: 11.5px; white-space: nowrap; }
  h2 { margin: 22px 0 12px; font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--r-caption); }
  h2 .n { font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--r-faint); margin-left: 6px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, 104px); gap: 18px 14px; }
  .tile { display: flex; flex-direction: column; align-items: center; gap: 7px; position: relative; }
  .face { width: 72px; height: 64px; border-radius: 16px; border: 1px solid var(--r-edge); background: var(--r-glass); display: grid; place-items: center; cursor: pointer; padding: 0; color: inherit; }
  .face:hover { background: var(--r-glass-hover); border-color: var(--r-edge-hi); }
  .face:focus-visible, .row:focus-visible, .act:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .face img, .face .lt { width: 26px; height: 26px; border-radius: 6px; }
  .tname { max-width: 104px; font-size: 12px; color: var(--r-text-2); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 5px; padding: 1px 5px; cursor: text; }
  .tname:hover { background: var(--r-selected); color: var(--r-text); }
  .rename { width: 104px; text-align: center; font: inherit; font-size: 12px; color: var(--r-text); background: var(--vscode-input-background); border: 1px solid var(--r-gold-line); border-radius: 5px; padding: 1px 5px; outline: none; }
  .was { max-width: 124px; font-size: 10.5px; color: var(--r-faint); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .unpin { position: absolute; top: -6px; right: 10px; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--r-edge); background: var(--r-glass-strong); color: var(--r-text-2); font-size: 11px; display: grid; place-items: center; cursor: pointer; opacity: 0; padding: 0; }
  .tile:hover .unpin, .tile:focus-within .unpin { opacity: 1; }
  .lt { display: inline-grid; place-items: center; color: #fff; font-weight: 700; font-size: 11px; }
  img.ondark { background: #141829; padding: 3px; }
  .rows { border: 1px solid var(--r-edge); border-radius: 12px; background: var(--r-glass); overflow: hidden; }
  .row { display: grid; grid-template-columns: 16px minmax(0,1fr) auto 26px; gap: 10px; align-items: center; padding: 7px 12px; border-top: 1px solid var(--r-edge); cursor: pointer; }
  .row:first-child { border-top: 0; }
  .row:hover { background: var(--r-glass-hover); }
  .row img, .row .lt { width: 16px; height: 16px; border-radius: 3px; font-size: 9px; }
  .row .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .t span { color: var(--r-caption); margin-left: 8px; font-size: 11.5px; }
  .row .age { color: var(--r-faint); font-size: 11.5px; white-space: nowrap; }
  .act { width: 26px; height: 26px; border-radius: 7px; border: 1px solid transparent; background: none; color: var(--r-faint); cursor: pointer; opacity: 0; padding: 0; }
  .row:hover .act, .row:focus-within .act { opacity: 1; border-color: var(--r-edge); }
  .empty { color: var(--r-faint); font-size: 12.5px; padding: 10px 2px; }
  .tiles .empty { grid-column: 1 / -1; }
  .ring { animation: ring .9s ease; }
  @keyframes ring { from { box-shadow: 0 0 0 0 rgba(168,136,74,.55); } to { box-shadow: 0 0 0 10px rgba(168,136,74,0); } }
  .toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: var(--r-glass-strong); color: var(--r-text); border: 1px solid var(--r-edge); box-shadow: var(--r-float); padding: 7px 14px; border-radius: 9px; font-size: 12.5px; }
  .toast[hidden] { display: none; }
  @media (prefers-reduced-motion: reduce) { .ring { animation: none; } }
</style>
</head>
<body>
<main>
  <label class="search"><input id="q" placeholder="Filter your pages, or type a URL and press Enter" autocomplete="off" aria-label="Filter pages or enter a URL"><span class="hint" id="hint"></span></label>
  <h2>Your pages<span class="n" id="npin"></span></h2>
  <div class="tiles" id="tiles"></div>
  <h2 id="recentH">Recent<span class="n">from the built-in browser's history</span></h2>
  <div id="recent"></div>
</main>
<div class="toast" id="toast" role="status" hidden></div>
<script nonce="${n}">${PAGES_SCRIPT}</script>
</body>
</html>`;
}

const ESCAPE = escapeHtml.toString();

/** The Pages webview's behavior: state in, one message per gesture out. */
const PAGES_SCRIPT = `(() => {
  const vscode = acquireVsCodeApi();
  const escapeHtml = ${ESCAPE};
  let state = { pins: [], recent: [], click: 'same', shortcut: '' };
  let editing = null;
  const $ = (id) => document.getElementById(id);
  const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const host = (u) => { try { const x = new URL(u); return x.protocol === 'file:' ? 'local file' : x.host.replace(/^www\\./, ''); } catch { return u; } };
  const ago = (t) => { const s = (Date.now() - t) / 1000; for (const [n, u] of [[86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return Math.floor(s / n) + u + ' ago'; return 'now'; };
  const icon = (p, name) => p.icon
    ? '<img src="' + escapeHtml(p.icon) + '" alt="" data-ic>'
    : '<span class="lt" style="background:hsl(' + hue(name) + ' 42% 44%)">' + escapeHtml((name.trim()[0] || '?').toUpperCase()) + '</span>';
  // An icon drawn for a dark theme (white on transparent) vanishes on a light card: give it a dark chip.
  const darken = (img) => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 16;
      const g = c.getContext('2d'); if (!g) return;
      g.drawImage(img, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data; let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 64 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 200) ink++;
      if (ink < 12) img.classList.add('ondark');
    } catch { /* an image the canvas cannot read keeps its own background */ }
  };
  const match = (q, ...xs) => !q || xs.join(' ').toLowerCase().includes(q);
  function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = !text; }
  function draw() {
    const q = $('q').value.trim().toLowerCase();
    const mod = state.shortcut.startsWith('Ctrl') ? 'Ctrl+' : '⌘';
    $('hint').textContent = state.click === 'same' ? 'Enter opens here · ' + mod + 'Enter in a new tab' : 'Enter opens a new tab · ' + mod + 'Enter here';
    $('npin').textContent = state.pins.length ? String(state.pins.length) : '';
    const pins = state.pins.filter((p) => match(q, p.name, p.title, p.url));
    $('tiles').innerHTML = pins.map((p) => '<div class="tile">'
      + '<button class="face" data-open="' + escapeHtml(p.url) + '" title="' + escapeHtml(p.url) + '" aria-label="Open ' + escapeHtml(p.name) + '">' + icon(p, p.name) + '</button>'
      + (editing === p.url
        ? '<input class="rename" data-rename="' + escapeHtml(p.url) + '" value="' + escapeHtml(p.name) + '" aria-label="Name"><div class="was">' + escapeHtml(p.title) + '</div>'
        : '<div class="tname" data-edit="' + escapeHtml(p.url) + '" title="Click to rename" role="button" tabindex="0">' + escapeHtml(p.name) + '</div>')
      + '<button class="unpin" data-unpin="' + escapeHtml(p.url) + '" title="Unpin" aria-label="Unpin ' + escapeHtml(p.name) + '">✕</button></div>').join('')
      || '<div class="empty">' + (state.pins.length ? 'No pinned page matches.' : 'Pin a page from Recent with ☆, or type a URL above and pin it from Recent once it opens.') + '</div>';
    const pinned = new Set(state.pins.map((p) => p.url));
    const recent = state.recent.filter((p) => !pinned.has(p.url) && match(q, p.title, p.url));
    $('recent').innerHTML = state.reason ? '<div class="empty">' + escapeHtml(state.reason) + '</div>'
      : recent.length ? '<div class="rows">' + recent.map((p) => '<div class="row" tabindex="0" data-open="' + escapeHtml(p.url) + '" title="' + escapeHtml(p.url) + '">'
        + icon(p, p.title) + '<div class="t">' + escapeHtml(p.title) + '<span>' + escapeHtml(host(p.url)) + '</span></div><div class="age">' + ago(p.time) + '</div>'
        + '<button class="act" data-pin="' + escapeHtml(p.url) + '" title="Pin" aria-label="Pin ' + escapeHtml(p.title) + '">☆</button></div>').join('') + '</div>'
      : '<div class="empty">' + (q ? 'Nothing recent matches. Enter opens it as a URL.' : 'Pages you open in the built-in browser show here.') + '</div>';
    for (const img of document.querySelectorAll('img[data-ic]')) { if (img.complete) darken(img); else img.addEventListener('load', () => darken(img), { once: true }); }
    const r = document.querySelector('.rename'); if (r) { r.focus(); r.select(); }
  }
  function open(url, flip, el) {
    if (el && el.animate) { el.classList.remove('ring'); void el.offsetWidth; el.classList.add('ring'); }
    toast('Opening …');
    vscode.postMessage({ type: 'open', url, newTab: (state.click === 'new') !== !!flip });
  }
  function commit(input) {
    const url = input.dataset.rename; editing = null;
    vscode.postMessage({ type: 'rename', url, name: input.value });
    const p = state.pins.find((x) => x.url === url); if (p) p.name = input.value.trim() || p.title;
    draw();
  }
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('.rename')) return;
    const ed = t.closest('[data-edit]'); if (ed) { editing = ed.dataset.edit; draw(); return; }
    const un = t.closest('[data-unpin]'); if (un) { vscode.postMessage({ type: 'unpin', url: un.dataset.unpin }); return; }
    const pn = t.closest('[data-pin]'); if (pn) { const p = state.recent.find((x) => x.url === pn.dataset.pin); if (p) vscode.postMessage({ type: 'pin', url: p.url, title: p.title, icon: p.icon }); return; }
    const op = t.closest('[data-open]'); if (op) open(op.dataset.open, e.metaKey || e.ctrlKey, op.closest('.face') || op);
  });
  document.addEventListener('keydown', (e) => {
    const r = e.target.closest && e.target.closest('.rename');
    if (r) { if (e.key === 'Enter') commit(r); else if (e.key === 'Escape') { editing = null; draw(); } return; }
    const ed = e.target.closest && e.target.closest('[data-edit]');
    if (ed && e.key === 'Enter') { editing = ed.dataset.edit; draw(); return; }
    const row = e.target.closest && e.target.closest('.row[data-open]');
    if (row && e.key === 'Enter') open(row.dataset.open, e.metaKey || e.ctrlKey, row);
  });
  document.addEventListener('focusout', (e) => { const r = e.target.closest && e.target.closest('.rename'); if (r && editing) commit(r); });
  $('q').addEventListener('input', draw);
  $('q').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = $('q').value.trim(); if (!v) return;
    const first = document.querySelector('[data-open]');
    const looksLikeUrl = /^[a-z][\\w+.-]*:|^[\\w-]+(\\.[\\w-]+)+|^localhost/i.test(v);
    if (looksLikeUrl || !first) open(v, e.metaKey || e.ctrlKey, null); else open(first.dataset.open, e.metaKey || e.ctrlKey, first);
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') { state = m; draw(); }
    if (m.type === 'opened') { toast(m.error || ''); if (m.error) setTimeout(() => toast(''), 4000); }
  });
  vscode.postMessage({ type: 'ready' });
})();`;
