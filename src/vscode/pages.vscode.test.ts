// Pages' host side against real things: VSCodium's own storage as a real SQLite file, and
// favicons from a real local HTTP server. The webview script runs in happy-dom.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { Window } from 'happy-dom';
import { tmpdir } from 'os';
import { join } from 'path';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { pagesShell, readBrowserHistory, resolvePageIcon } = await import('./pages.vscode');
const { Database } = await import('bun:sqlite');
// The editor's runtime reads with node:sqlite; an older bun has none and gets the reason instead.
const hasNodeSqlite = await import('node:sqlite').then(() => true, () => false);

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'core', 'testdata', 'pages', name), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe("the built-in browser's history", () => {
  const dir = mkdtempSync(join(tmpdir(), 'pages-history-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  test('is read from state.vscdb beside the extension folder, or says the runtime has no SQLite', () => {
    const db = new Database(join(dir, 'state.vscdb'));
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const put = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    put.run('browser.history.entries.global', fixture('history-entries.json'));
    put.run('browser.history.favicons.global', fixture('history-favicons.json'));
    db.close();
    mkdirSync(join(dir, 'swarmify.swarm-ext'));
    const { recent, reason } = readBrowserHistory({ fsPath: join(dir, 'swarmify.swarm-ext') });
    if (!hasNodeSqlite) {
      expect(recent).toEqual([]);
      expect(reason).toContain('Recent needs an editor whose runtime has SQLite');
      return;
    }
    expect(reason).toBeUndefined();
    expect(recent.map((r) => r.url)).toEqual(['https://github.com/acme/app/pulls', 'https://console.example.com/', 'file:///Users/me/plan.html']);
  });
  test('says why when the storage is not there, and lists nothing', () => {
    const { recent, reason } = readBrowserHistory({ fsPath: join(dir, 'nowhere', 'ext') });
    expect(recent).toEqual([]);
    expect(reason).toContain(hasNodeSqlite ? "The built-in browser's history could not be read" : 'Recent needs an editor whose runtime has SQLite');
  });
  test('a remote window says where it runs instead of reading the remote machine', () => {
    const { recent, reason } = readBrowserHistory({ fsPath: join(dir, 'swarmify.swarm-ext') }, 'ssh-remote');
    expect(recent).toEqual([]);
    expect(reason).toBe("Recent shows the built-in browser's history in a local window; this window runs on ssh-remote.");
  });
});

describe('a pinned page gets its icon', () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = '';
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === '/declares') return new Response('<html><head><link rel="icon" href="/assets/mark.png"></head></html>', { headers: { 'content-type': 'text/html' } });
        if (pathname === '/assets/mark.png' || pathname === '/favicon.ico') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
        if (pathname === '/moved') return new Response(null, { status: 302, headers: { location: '/declares' } });
        if (pathname === '/huge') {
          // Headers at once, then far more body than a page may take: never buffered whole.
          const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
          let sent = 0;
          return new Response(new ReadableStream({ pull(c) { if (sent++ < 64) c.enqueue(chunk); else c.close(); } }), { headers: { 'content-type': 'text/html' } });
        }
        if (pathname === '/plain') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
        return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
      },
    });
    base = `http://localhost:${server.port}`;
  });
  afterAll(() => server.stop(true));
  test('from the icon the page declares', async () => {
    expect(await resolvePageIcon(`${base}/declares`)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });
  test("from the site's /favicon.ico when the page declares none", async () => {
    expect(await resolvePageIcon(`${base}/plain`)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });
  test('a redirect is followed hop by hop to the page and its declared icon', async () => {
    expect(await resolvePageIcon(`${base}/moved`)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });
  test('a page whose body runs past the cap falls back to /favicon.ico', async () => {
    expect(await resolvePageIcon(`${base}/huge`)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });
  test('none for a local file, which the view draws as a letter', async () => {
    expect(await resolvePageIcon('file:///Users/me/plan.html')).toBeUndefined();
  });
});

describe('the Pages webview', () => {
  const window = new Window();
  afterAll(() => window.happyDOM.close());
  const { document } = window;
  const page = pagesShell('vscode-webview:');
  document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
  const sent: Record<string, unknown>[] = [];
  const script = page.match(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/i)![1];
  new Function('window', 'document', 'acquireVsCodeApi', script)(window, document, () => ({ postMessage: (m: Record<string, unknown>) => sent.push(m) }));
  const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  const click = (el: HTMLElement, meta = false) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: meta }) as unknown as Event);
  const key = (el: HTMLElement, k: string, meta = false) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, metaKey: meta }) as unknown as Event);
  const last = () => sent[sent.length - 1];
  const state = (click: 'same' | 'new') => deliver({
    type: 'state', click, shortcut: '⌘⇧V',
    pins: [{ url: 'https://github.com/acme/app', name: 'RUSH', title: 'acme/app', icon: `data:image/png;base64,${PNG.toString('base64')}` }, { url: 'file:///Users/me/plan.html', name: 'Plan', title: 'Plan' }],
    recent: [{ url: 'https://console.example.com/', title: 'Console', time: Date.now() - 3_600_000 }, { url: 'https://github.com/acme/app', title: 'acme/app', time: Date.now() }],
  });

  test('asks for its state once it runs', () => {
    expect(sent[0]).toEqual({ type: 'ready' });
  });
  test('draws one tile per pin with its own name, a letter where there is no icon, and leaves pinned pages out of Recent', () => {
    state('same');
    expect([...document.querySelectorAll('.tname')].map((e) => e.textContent)).toEqual(['RUSH', 'Plan']);
    expect($('.tile:nth-child(2) .lt').textContent).toBe('P');
    expect([...document.querySelectorAll('.row')].map((e) => (e as unknown as HTMLElement).dataset.open)).toEqual(['https://console.example.com/']);
  });
  test('a click opens in the same tab and ⌘-click in a new one; the setting flips both', () => {
    click($('.face'));
    expect(last()).toEqual({ type: 'open', url: 'https://github.com/acme/app', newTab: false });
    expect($('#toast').textContent).toBe('Opening …');
    deliver({ type: 'opened' });
    expect(($('#toast') as unknown as { hidden: boolean }).hidden).toBe(true);
    click($('.face'), true);
    expect(last()).toEqual({ type: 'open', url: 'https://github.com/acme/app', newTab: true });
    state('new');
    click($('.face'));
    expect(last()).toEqual({ type: 'open', url: 'https://github.com/acme/app', newTab: true });
    expect($('#hint').textContent).toBe('Enter opens a new tab · ⌘Enter here');
    state('same');
  });
  test('a click on a name renames it in place; Enter saves', () => {
    click($('.tname'));
    const input = $('.rename') as unknown as HTMLInputElement;
    expect(input.value).toBe('RUSH');
    expect($('.was').textContent).toBe('acme/app');
    input.value = 'Agents repo';
    key(input as unknown as HTMLElement, 'Enter');
    expect(last()).toEqual({ type: 'rename', url: 'https://github.com/acme/app', name: 'Agents repo' });
    expect($('.tname').textContent).toBe('Agents repo');
  });
  test('☆ pins a recent page with its icon and title; ✕ unpins a tile', () => {
    click($('.row [data-pin]'));
    expect(last()).toEqual({ type: 'pin', url: 'https://console.example.com/', title: 'Console', icon: undefined });
    click($('.unpin'));
    expect(last()).toEqual({ type: 'unpin', url: 'https://github.com/acme/app' });
  });
  test('a hostile title or URL from the history is text, never markup', () => {
    deliver({ type: 'state', click: 'same', shortcut: '⌘⇧V', pins: [],
      recent: [{ url: 'https://evil.example/"><img src=x onerror=alert(1)>', title: '<img src=x onerror=alert(1)>', time: Date.now() }] });
    expect(document.querySelectorAll('#recent img:not([data-ic])').length).toBe(0);
    expect($('.row .t').textContent).toContain('<img src=x onerror=alert(1)>');
    state('same');
  });
  test('Enter on a typed URL opens it; ⌘Enter opens it in a new tab', () => {
    const q = $('#q') as unknown as HTMLInputElement;
    q.value = 'news.ycombinator.com';
    key(q as unknown as HTMLElement, 'Enter', true);
    expect(last()).toEqual({ type: 'open', url: 'news.ycombinator.com', newTab: true });
  });
});
