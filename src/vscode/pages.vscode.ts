// Pages (⌘⇧B): the owner's everyday pages as two rows of icons in an editor tab.
// A click opens the page in VSCodium's own browser, in the same tab or a new one.
import * as path from 'path';
import * as vscode from 'vscode';
import {
  browserOpenArgs, findIconHref, movePin, normalizePageUrl, PAGES_CLICK_DEFAULT, parseBrowserHistory, pinPage, readPins, renamePin,
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
  | { type: 'rename'; url: string; name: string }
  | { type: 'move'; url: string; before: string | null };

/**
 * The built-in browser's history lives in VSCodium's own storage, beside this extension's
 * global storage folder. Read-only, with the runtime's own SQLite; nothing else reads it.
 */
export function readBrowserHistory(globalStorage: Pick<vscode.Uri, 'fsPath'>, remoteName?: string): { recent: RecentPage[]; reason?: string } {
  // A remote window's extension host runs where the code is; the browser's history stays on this machine.
  if (remoteName) return { recent: [], reason: `Recent shows the built-in browser's history in a local window; this window runs on ${remoteName}.` };
  let sqlite: { DatabaseSync: new (file: string, o: { readOnly: boolean }) => { prepare(sql: string): { get(key: string): { value?: string } | undefined }; close(): void } };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqlite = require('node:sqlite');
  } catch {
    return { recent: [], reason: "Recent needs an editor whose runtime has SQLite (VSCodium or VS Code 1.117 and later)." };
  }
  try {
    const conn = new sqlite.DatabaseSync(path.join(path.dirname(globalStorage.fsPath), 'state.vscdb'), { readOnly: true });
    try {
      const read = (key: string) => conn.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key)?.value ?? null;
      return { recent: parseBrowserHistory(read('browser.history.entries.global'), read('browser.history.favicons.global')) };
    } finally {
      conn.close();
    }
  } catch (err) {
    return { recent: [], reason: `The built-in browser's history could not be read (${(err as Error).message}).` };
  }
}

/**
 * A GET whose headers and body both arrive within `ms` and whose body stays under `maxBytes`;
 * null otherwise. Redirects are followed one hop at a time, and a hop `allow` refuses ends it.
 */
async function fetchCapped(url: string, ms: number, maxBytes: number, allow: (url: string) => boolean): Promise<{ res: Response; url: string; body: Buffer } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    let at = url;
    for (let hop = 0; hop <= 5; hop++) {
      if (!/^https?:/i.test(at) || !allow(at)) return null;
      const res = await fetch(at, { signal: ctl.signal, redirect: 'manual' });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (next) { at = new URL(next, at).toString(); continue; }
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes || !res.body) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) { ctl.abort(); return null; }
        chunks.push(chunk);
      }
      return { res, url: at, body: Buffer.concat(chunks) };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Loopback, link-local and private addresses: an icon fetched from a public page never goes there. */
function isPrivateHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^fe80:|^f[cd]/.test(h)
      || /^(127|10|0)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch {
    return true;
  }
}

async function iconAt(url: string, allow: (url: string) => boolean): Promise<string | undefined> {
  const got = await fetchCapped(url, 5000, ICON_MAX_BYTES, allow);
  if (!got) return undefined;
  const type = (got.res.headers.get('content-type') ?? '').split(';')[0].trim();
  return got.res.ok && type.startsWith('image/') && got.body.length ? `data:${type};base64,${got.body.toString('base64')}` : undefined;
}

/** The icon the page declares, then the site's /favicon.ico; undefined draws a letter. */
export async function resolvePageIcon(pageUrl: string): Promise<string | undefined> {
  if (!/^https?:/i.test(pageUrl)) return undefined;
  // A page you pinned on your own machine may use its own; a public page's icon may not point inward.
  const allowed = (href: string) => isPrivateHost(pageUrl) || !isPrivateHost(href);
  const tries: string[] = [];
  const page = await fetchCapped(pageUrl, 5000, 512 * 1024, allowed);
  if (page?.res.ok) {
    const declared = findIconHref(page.body.toString('utf8'), page.url);
    if (declared && allowed(declared)) tries.push(declared);
  }
  const fallback = findIconHref('', pageUrl);
  if (fallback && !tries.includes(fallback)) tries.push(fallback);
  for (const href of tries) {
    const icon = await iconAt(href, allowed);
    if (icon) return icon;
  }
  return undefined;
}

export class PagesPanel {
  private panel: vscode.WebviewPanel | undefined;
  /** The URL Pages last opened; "same tab" navigates the browser tab still showing it. */
  private lastUrl: string | null = null;
  /** Read when the tab shows or on Refresh; a pin, rename or open reuses it. */
  private history: { recent: RecentPage[]; reason?: string } = { recent: [] };

  constructor(private readonly context: vscode.ExtensionContext, private readonly modifier: string) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Pages', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'pages-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'pages-dark.svg'),
    };
    panel.webview.html = pagesShell(panel.webview.cspSource);
    panel.onDidDispose(() => { this.panel = undefined; });
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible) this.post(true); });
    panel.webview.onDidReceiveMessage((m: Inbound) => { void this.handle(m); });
  }

  /** Settings > Pages changed; an open Pages tab redraws its hint. */
  refresh(): void {
    if (this.panel) this.post(true);
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

  private post(reread = false): void {
    if (reread) this.history = readBrowserHistory(this.context.globalStorageUri, vscode.env.remoteName);
    const { recent, reason } = this.history;
    void this.panel?.webview.postMessage({ type: 'state', pins: this.pins(), recent, reason, click: this.click(), shortcut: `${this.modifier}B` });
  }

  private async handle(m: Inbound): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        this.post(true);
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
      case 'move':
        await this.savePins(movePin(this.pins(), m.url, m.before));
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
  .hint { color: var(--r-faint); font-size: 11.5px; white-space: nowrap; } .hint.fail { color: var(--r-text-2); }
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
  .tile.dragging { opacity: .4; }
  .tile.drop-before::before, .tile.drop-after::after { content: ''; position: absolute; top: 2px; height: 60px; width: 2px; border-radius: 1px; background: var(--r-gold-line); }
  .tile.drop-before::before { left: -8px; } .tile.drop-after::after { right: -8px; }
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
  .pinq { flex: none; width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--r-edge); background: none; color: var(--r-text-2); cursor: pointer; padding: 0; }
  .pinq:hover { background: var(--r-glass-hover); color: var(--r-text); } .pinq[hidden] { display: none; }
  .pinq:focus-visible, .more:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .more { display: block; width: 100%; padding: 8px 12px; border: 0; border-top: 1px solid var(--r-edge); background: none; color: var(--r-text-2); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
  .more:hover { background: var(--r-glass-hover); color: var(--r-text); }
  .empty { color: var(--r-faint); font-size: 12.5px; padding: 10px 2px; }
  .tiles .empty { grid-column: 1 / -1; }
  /* A short last page keeps both rows' height, so Recent never moves when the page turns. */
  .tiles.paged { min-height: 192px; align-content: start; }
  .pager { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 14px; }
  .pager[hidden] { display: none; }
  .pg { width: 24px; height: 24px; border-radius: 7px; border: 1px solid transparent; background: none; color: var(--r-text-2); cursor: pointer; padding: 0; font-size: 14px; }
  .pg:hover:not(:disabled) { border-color: var(--r-edge); background: var(--r-glass-hover); }
  .pg:disabled { opacity: .3; cursor: default; }
  .dot { width: 24px; height: 24px; border: 0; padding: 0; background: none; cursor: pointer; display: grid; place-items: center; }
  .dot::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--r-edge-hi); }
  .dot.on::before { background: var(--r-gold-line); }
  .pg:focus-visible, .dot:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .ring { animation: ring .9s ease; }
  @keyframes ring { from { box-shadow: 0 0 0 0 rgba(168,136,74,.55); } to { box-shadow: 0 0 0 10px rgba(168,136,74,0); } }
  @media (prefers-reduced-motion: reduce) { .ring { animation: none; } }
</style>
</head>
<body>
<main>
  <label class="search"><input id="q" placeholder="Filter Recent, or type a URL and press Enter" autocomplete="off" aria-label="Filter Recent or enter a URL"><span class="hint" id="hint"></span><button class="pinq" id="pinq" hidden>☆</button></label>
  <h2>Your pages<span class="n" id="npin"></span></h2>
  <div class="tiles" id="tiles"></div>
  <nav class="pager" id="pager" hidden aria-label="Pages of pinned pages"></nav>
  <h2 id="recentH">Recent<span class="n">from the built-in browser's history</span></h2>
  <div id="recent"></div>
</main>
<script nonce="${n}">${PAGES_SCRIPT}</script>
</body>
</html>`;
}

const ESCAPE = escapeHtml.toString();
const MOVE_PIN = movePin.toString();
const NORMALIZE_URL = normalizePageUrl.toString();

/** The Pages webview's behavior: state in, one message per gesture out. */
const PAGES_SCRIPT = `(() => {
  const vscode = acquireVsCodeApi();
  const escapeHtml = ${ESCAPE};
  const movePin = ${MOVE_PIN};
  const normalizePageUrl = ${NORMALIZE_URL};
  // Recent shows 30 pages, and Show more the next 30.
  const RECENT_STEP = 30;
  let shown = RECENT_STEP;
  let state = { pins: [], recent: [], click: 'same', shortcut: '' };
  let editing = null;
  // Your pages fill two rows; more go on further pages, ‹ › and the dots between them.
  let page = 0;
  const TILE_W = 104, TILE_GAP = 14, ROWS = 2;
  const perPage = () => ROWS * Math.max(1, Math.floor(($('tiles').clientWidth + TILE_GAP) / (TILE_W + TILE_GAP)));
  const pageCount = () => Math.max(1, Math.ceil(state.pins.length / perPage()));
  const pageOf = (url) => Math.floor(Math.max(0, state.pins.findIndex((x) => x.url === url)) / perPage());
  // The pager is redrawn with the page, so the button pressed gets focus back (‹ › again where it is now disabled, the dot otherwise).
  function turnTo(to, from) {
    const focused = !!from && document.activeElement === from;
    page = to; draw();
    if (!focused) return;
    const same = from.classList.contains('dot') ? $('pager').querySelector('.dot[data-page="' + page + '"]') : $('pager').querySelector('.pg[title="' + from.title + '"]');
    const back = same && !same.disabled ? same : $('pager').querySelector('.dot.on'); if (back) back.focus();
  }
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
  // No toast (owner, 2026-11-04 9:42 PM): a refusal takes the hint's place for 4 s.
  let failUntil = 0, failTimer = 0;
  function fail(text) {
    const hint = $('hint'); clearTimeout(failTimer);
    failUntil = Date.now() + 4000; hint.textContent = text; hint.classList.add('fail');
    failTimer = setTimeout(() => { failUntil = 0; hint.classList.remove('fail'); draw(); }, 4000);
  }
  function draw() {
    const q = $('q').value.trim().toLowerCase();
    const mod = state.shortcut.startsWith('Ctrl') ? 'Ctrl+' : '⌘';
    if (Date.now() >= failUntil) $('hint').textContent = state.click === 'same' ? 'Enter opens here · ' + mod + 'Enter in a new tab' : 'Enter opens a new tab · ' + mod + 'Enter here';
    $('npin').textContent = state.pins.length ? String(state.pins.length) : '';
    // A typed address you have not pinned gets ☆ beside it, so it pins without opening first.
    const typed = normalizePageUrl($('q').value);
    const pinq = $('pinq'); pinq.hidden = !typed || state.pins.some((p) => p.url === typed);
    if (typed) { pinq.dataset.url = typed; pinq.title = 'Pin ' + typed; pinq.setAttribute('aria-label', 'Pin ' + typed); }
    // The filter is for Recent: your pages always show (owner, 2026-11-26 5:58 PM).
    const per = perPage(), pages = pageCount();
    page = Math.min(Math.max(page, 0), pages - 1);
    const pins = state.pins.slice(page * per, page * per + per);
    $('pager').hidden = pages < 2;
    $('tiles').classList.toggle('paged', pages > 1);
    $('pager').innerHTML = pages < 2 ? '' : '<button class="pg" data-page="' + (page - 1) + '"' + (page ? '' : ' disabled') + ' title="Previous" aria-label="Previous">‹</button>'
      + Array.from({ length: pages }, (_, i) => '<button class="dot' + (i === page ? ' on' : '') + '" data-page="' + i + '" aria-label="Page ' + (i + 1) + ' of ' + pages + '"' + (i === page ? ' aria-current="page"' : '') + '></button>').join('')
      + '<button class="pg" data-page="' + (page + 1) + '"' + (page < pages - 1 ? '' : ' disabled') + ' title="Next" aria-label="Next">›</button>';
    $('tiles').innerHTML = pins.map((p) => '<div class="tile" draggable="' + (editing ? 'false' : 'true') + '" data-tile="' + escapeHtml(p.url) + '">'
      + '<button class="face" data-open="' + escapeHtml(p.url) + '" title="' + escapeHtml(p.url) + '" aria-label="Open ' + escapeHtml(p.name) + '">' + icon(p, p.name) + '</button>'
      + (editing === p.url
        ? '<input class="rename" data-rename="' + escapeHtml(p.url) + '" value="' + escapeHtml(p.name) + '" aria-label="Name"><div class="was">' + escapeHtml(p.title) + '</div>'
        : '<div class="tname" data-edit="' + escapeHtml(p.url) + '" title="Click to rename" role="button" tabindex="0">' + escapeHtml(p.name) + '</div>')
      + '<button class="unpin" data-unpin="' + escapeHtml(p.url) + '" title="Unpin" aria-label="Unpin ' + escapeHtml(p.name) + '">✕</button></div>').join('')
      || '<div class="empty">Pin a page from Recent with ☆, or type its address above and press ☆ there.</div>';
    const pinned = new Set(state.pins.map((p) => p.url));
    const matched = state.recent.filter((p) => !pinned.has(p.url) && match(q, p.title, p.url));
    const recent = matched.slice(0, shown), more = Math.min(RECENT_STEP, matched.length - recent.length);
    $('recent').innerHTML = state.reason ? '<div class="empty">' + escapeHtml(state.reason) + '</div>'
      : recent.length ? '<div class="rows">' + recent.map((p) => '<div class="row" tabindex="0" data-open="' + escapeHtml(p.url) + '" title="' + escapeHtml(p.url) + '">'
        + icon(p, p.title) + '<div class="t">' + escapeHtml(p.title) + '<span>' + escapeHtml(host(p.url)) + '</span></div><div class="age">' + ago(p.time) + '</div>'
        + '<button class="act" data-pin="' + escapeHtml(p.url) + '" title="Pin" aria-label="Pin ' + escapeHtml(p.title) + '">☆</button></div>').join('')
        + (more > 0 ? '<button class="more" id="more">Show ' + more + ' more</button>' : '') + '</div>'
      : '<div class="empty">' + (q ? 'Nothing recent matches. Enter opens it as a URL.' : 'Pages you open in the built-in browser show here.') + '</div>';
    for (const img of document.querySelectorAll('img[data-ic]')) { if (img.complete) darken(img); else img.addEventListener('load', () => darken(img), { once: true }); }
    const r = document.querySelector('.rename'); if (r) { r.focus(); r.select(); }
  }
  function open(url, flip, el) {
    if (el && el.animate) { el.classList.remove('ring'); void el.offsetWidth; el.classList.add('ring'); }
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
    if (t.closest('#pinq')) { pinTyped(); return; }
    if (t.closest('#more')) { showMore(); return; }
    const pg = t.closest('[data-page]'); if (pg) { if (!pg.disabled) turnTo(Number(pg.dataset.page), pg); return; }
    const ed = t.closest('[data-edit]'); if (ed) { editing = ed.dataset.edit; draw(); return; }
    const un = t.closest('[data-unpin]'); if (un) { vscode.postMessage({ type: 'unpin', url: un.dataset.unpin }); return; }
    const pn = t.closest('[data-pin]'); if (pn) { const p = state.recent.find((x) => x.url === pn.dataset.pin); if (p) vscode.postMessage({ type: 'pin', url: p.url, title: p.title, icon: p.icon }); return; }
    const op = t.closest('[data-open]'); if (op) open(op.dataset.open, e.metaKey || e.ctrlKey, op.closest('.face') || op);
  });
  function pinTyped() {
    const url = $('pinq').dataset.url; if (!url || $('pinq').hidden) return;
    const seen = state.recent.find((x) => x.url === url);
    vscode.postMessage({ type: 'pin', url, title: seen ? seen.title : '', icon: seen ? seen.icon : undefined });
    $('pinq').hidden = true; $('q').focus();
  }
  // The first page Show more added takes focus, so the keyboard carries on where it was.
  function showMore() {
    const at = document.querySelectorAll('.row[data-open]').length;
    shown += RECENT_STEP; draw();
    const row = document.querySelectorAll('.row[data-open]')[at]; if (row) row.focus();
  }
  // Arrow keys walk focus: ← → through your pages in order (turning the page at its edge), ↑ ↓ between
  // the two rows, on into Recent and back up to the search box.
  function focusPin(i) {
    const p = state.pins[i]; if (!p) return;
    const to = Math.floor(i / perPage()); if (to !== page) { page = to; draw(); }
    const f = [...document.querySelectorAll('.face')].find((x) => x.dataset.open === p.url); if (f) f.focus();
  }
  function walk(e) {
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k) || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return false;
    const t = e.target, rows = [...document.querySelectorAll('.row[data-open]')];
    const firstRow = () => { if (rows[0]) rows[0].focus(); };
    if (t === $('q')) { if (k !== 'ArrowDown') return false; if (state.pins.length) focusPin(page * perPage()); else firstRow(); return true; }
    const face = t.closest && t.closest('.face');
    if (face) {
      const i = state.pins.findIndex((x) => x.url === face.dataset.open), per = perPage(), cols = per / ROWS;
      const j = i - page * per, onPage = Math.min(per, state.pins.length - page * per);
      if (k === 'ArrowLeft') focusPin(i - 1);
      else if (k === 'ArrowRight') focusPin(i + 1);
      else if (k === 'ArrowUp') { if (j >= cols) focusPin(i - cols); else $('q').focus(); }
      else if (j < cols && onPage > cols) focusPin(page * per + Math.min(j + cols, onPage - 1));
      else firstRow();
      return true;
    }
    const row = t.closest && t.closest('.row[data-open]');
    if (row && (k === 'ArrowUp' || k === 'ArrowDown')) {
      const n = rows.indexOf(row) + (k === 'ArrowDown' ? 1 : -1);
      if (rows[n]) rows[n].focus();
      else if (n < 0) { if (state.pins.length) focusPin(Math.min(state.pins.length, page * perPage() + perPage()) - 1); else $('q').focus(); }
      else { const m = $('more'); if (m) m.focus(); }
      return true;
    }
    if (t === $('more') && k === 'ArrowUp') { if (rows.length) rows[rows.length - 1].focus(); return true; }
    return false;
  }
  // Drag a tile onto another to put it there; ⌥← ⌥→ on a focused tile moves it past the tile beside it.
  function move(url, before) {
    const pins = movePin(state.pins, url, before); if (pins === state.pins) return;
    state.pins = pins;
    page = pageOf(url);
    vscode.postMessage({ type: 'move', url, before });
    draw();
  }
  // Puts a pin before or after the tile it was dropped on.
  function placeBy(url, target, after) {
    const i = state.pins.findIndex((x) => x.url === target);
    const next = after ? state.pins.slice(i + 1).find((x) => x.url !== url) : state.pins[i];
    move(url, next ? next.url : null);
  }
  // Turning the page detaches the dragged tile, so its dragend can be lost: a drag counts only while it carries a pin.
  const PIN_DRAG = 'application/x-agents-pin';
  let dragged = null;
  const ours = (e) => !!(dragged && e.dataTransfer && [...(e.dataTransfer.types || [])].includes(PIN_DRAG));
  const clearDrop = () => document.querySelectorAll('.drop-before, .drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
  const dropAt = (e) => {
    const t = e.target.closest && e.target.closest('.tile[data-tile]');
    if (!ours(e) || !t || t.dataset.tile === dragged) return null;
    const box = t.getBoundingClientRect();
    return { tile: t, after: e.clientX > box.left + box.width / 2 };
  };
  $('tiles').addEventListener('dragstart', (e) => {
    const t = e.target.closest && e.target.closest('.tile[draggable="true"]'); if (!t) return;
    dragged = t.dataset.tile; t.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(PIN_DRAG, dragged); e.dataTransfer.setData('text/plain', dragged);
  });
  $('tiles').addEventListener('dragover', (e) => {
    const d = dropAt(e); if (!d) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const cls = d.after ? 'drop-after' : 'drop-before';
    if (!d.tile.classList.contains(cls)) { clearDrop(); d.tile.classList.add(cls); }
  });
  $('tiles').addEventListener('dragleave', (e) => { const t = e.target.closest && e.target.closest('.tile'); if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-before', 'drop-after'); });
  $('tiles').addEventListener('drop', (e) => {
    const d = dropAt(e); if (!d) return;
    e.preventDefault(); clearDrop();
    // The redraw replaces the dragged tile, so its dragend never reaches #tiles: the drag ends here.
    const url = dragged; dragged = null;
    placeBy(url, d.tile.dataset.tile, d.after);
  });
  // A tile held over ‹ or › turns the page, so it can be dropped on another one.
  let holdAt = 0, holdOn = '';
  $('pager').addEventListener('dragover', (e) => {
    const pg = ours(e) && e.target.closest && e.target.closest('.pg:not(:disabled)');
    if (!pg) { holdOn = ''; return; }
    e.preventDefault();
    if (holdOn !== pg.title) { holdOn = pg.title; holdAt = Date.now(); return; }
    if (Date.now() - holdAt < 500) return;
    holdAt = Date.now(); turnTo(Number(pg.dataset.page), null);
  });
  $('pager').addEventListener('dragleave', (e) => { if (!$('pager').contains(e.relatedTarget)) holdOn = ''; });
  // A sideways two-finger swipe over your pages turns the page.
  // One gesture turns one page: its momentum is spent until the wheel rests for 200 ms, and drift that pauses starts over.
  let swipe = 0, lastWheel = 0, spent = false;
  $('tiles').addEventListener('wheel', (e) => {
    if (pageCount() < 2 || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const now = Date.now(), gap = now - lastWheel; lastWheel = now;
    if (gap > 200) { spent = false; swipe = 0; }
    if (spent) return;
    if (swipe && Math.sign(swipe) !== Math.sign(e.deltaX)) swipe = 0;
    swipe += e.deltaX;
    if (Math.abs(swipe) < 60) return;
    const to = page + (swipe > 0 ? 1 : -1); spent = true; swipe = 0;
    if (to >= 0 && to < pageCount()) { page = to; draw(); }
  }, { passive: false });
  // A width change (the window, or a scrollbar appearing) re-pages around the first page you were looking at.
  let lastPer = perPage();
  new ResizeObserver(() => {
    const per = perPage(); if (per === lastPer) return;
    const first = state.pins[page * lastPer]; lastPer = per;
    if (first) page = pageOf(first.url);
    draw();
  }).observe($('tiles'));
  $('tiles').addEventListener('dragend', () => { dragged = null; clearDrop(); document.querySelectorAll('.tile.dragging').forEach((t) => t.classList.remove('dragging')); });
  document.addEventListener('keydown', (e) => {
    if (walk(e)) { e.preventDefault(); return; }
    const face = e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.closest && e.target.closest('.face');
    if (face) {
      e.preventDefault();
      const url = face.dataset.open, left = e.key === 'ArrowLeft';
      const beside = (state.pins[state.pins.findIndex((x) => x.url === url) + (left ? -1 : 1)] || {}).url;
      if (!beside) return;
      placeBy(url, beside, !left);
      const back = [...document.querySelectorAll('.face')].find((f) => f.dataset.open === url); if (back) back.focus();
      return;
    }
    const r = e.target.closest && e.target.closest('.rename');
    if (r) { if (e.key === 'Enter') commit(r); else if (e.key === 'Escape') { editing = null; draw(); } return; }
    const ed = e.target.closest && e.target.closest('[data-edit]');
    if (ed && e.key === 'Enter') { editing = ed.dataset.edit; draw(); return; }
    const row = e.target.closest && e.target.closest('.row[data-open]');
    if (row && e.key === 'Enter') open(row.dataset.open, e.metaKey || e.ctrlKey, row);
  });
  document.addEventListener('focusout', (e) => { const r = e.target.closest && e.target.closest('.rename'); if (r && editing) commit(r); });
  // A new filter starts Recent at 30 again.
  $('q').addEventListener('input', () => { shown = RECENT_STEP; draw(); });
  $('q').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = $('q').value.trim(); if (!v) return;
    const first = document.querySelector('.row[data-open]');
    const looksLikeUrl = /^[a-z][\\w+.-]*:|^[\\w-]+(\\.[\\w-]+)+|^localhost/i.test(v);
    if (looksLikeUrl || !first) open(v, e.metaKey || e.ctrlKey, null); else open(first.dataset.open, e.metaKey || e.ctrlKey, first);
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') { state = m; draw(); }
    if (m.type === 'opened' && m.error) fail(m.error);
  });
  vscode.postMessage({ type: 'ready' });
})();`;
