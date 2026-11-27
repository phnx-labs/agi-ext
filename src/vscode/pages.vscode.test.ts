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
  // The page's timers are its window's, so closing the window ends them (a refusal's 4 s
  // timer otherwise fires into whichever test runs next).
  new Function('window', 'document', 'acquireVsCodeApi', 'setTimeout', 'clearTimeout', 'ResizeObserver', script)(
    window, document, () => ({ postMessage: (m: Record<string, unknown>) => sent.push(m) }), window.setTimeout.bind(window), window.clearTimeout.bind(window), window.ResizeObserver);
  // happy-dom lays nothing out; a wide box keeps every test's pins on one page.
  Object.defineProperty(document.getElementById('tiles'), 'clientWidth', { configurable: true, value: 1000 });
  const CONSOLE_ICON = 'data:image/png;base64,Q09OU09MRQ==';
  const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const $ = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  const click = (el: HTMLElement, meta = false) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: meta }) as unknown as Event);
  const key = (el: HTMLElement, k: string, meta = false) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, metaKey: meta }) as unknown as Event);
  const last = () => sent[sent.length - 1];
  const state = (click: 'same' | 'new') => deliver({
    type: 'state', click, shortcut: '⌘⇧B',
    pins: [{ url: 'https://github.com/acme/app', name: 'RUSH', title: 'acme/app', icon: `data:image/png;base64,${PNG.toString('base64')}` }, { url: 'file:///Users/me/plan.html', name: 'Plan', title: 'Plan' }],
    // The host sends each icon once (shareIcons); a page names its place.
    recent: [{ url: 'https://console.example.com/', title: 'Console', time: Date.now() - 3_600_000, icon: 0 }, { url: 'https://github.com/acme/app', title: 'acme/app', time: Date.now() }],
    icons: [CONSOLE_ICON],
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
    expect($('#toast')).toBeNull();
    deliver({ type: 'opened' });
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
    expect(last()).toEqual({ type: 'pin', url: 'https://console.example.com/', title: 'Console', icon: CONSOLE_ICON });
    click($('.unpin'));
    expect(last()).toEqual({ type: 'unpin', url: 'https://github.com/acme/app' });
  });
  test('a tile dragged onto another goes before or after it by which half it lands on; ⌥← ⌥→ move a focused tile', () => {
    state('same');
    const names = () => [...document.querySelectorAll('.tname')].map((e) => e.textContent);
    const tile = (i: number) => document.querySelectorAll('.tile')[i] as unknown as HTMLElement;
    // Aims at a half of the tile's box, whatever geometry this window's elements report.
    const drag = (type: string, el: HTMLElement, half: 'left' | 'right' = 'left') => {
      const e = new window.Event(type, { bubbles: true, cancelable: true }) as unknown as DragEvent;
      const box = el.getBoundingClientRect();
      Object.assign(e, { clientX: box.left + (half === 'right' ? box.width * 0.75 + 1 : box.width * 0.25 - 1), dataTransfer: carrying });
      el.dispatchEvent(e as unknown as Event);
      return e;
    };
    // One drag's data, as the browser keeps it from dragstart to drop.
    const carrying = { types: [] as string[], setData(t: string) { if (!this.types.includes(t)) this.types.push(t); }, effectAllowed: '', dropEffect: '' };
    drag('dragstart', tile(0));
    expect(tile(0).classList.contains('dragging')).toBe(true);
    expect(drag('dragover', tile(1), 'right').defaultPrevented).toBe(true);
    expect(tile(1).classList.contains('drop-after')).toBe(true);
    drag('drop', tile(1), 'right');
    drag('dragend', tile(1));
    expect(last()).toEqual({ type: 'move', url: 'https://github.com/acme/app', before: null });
    expect(names()).toEqual(['Plan', 'RUSH']);
    drag('dragstart', tile(1));
    expect(drag('dragover', tile(1), 'left').defaultPrevented).toBe(false);
    drag('drop', tile(0), 'left');
    expect(last()).toEqual({ type: 'move', url: 'https://github.com/acme/app', before: 'file:///Users/me/plan.html' });
    expect(names()).toEqual(['RUSH', 'Plan']);
    const face = $('.face');
    face.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }) as unknown as Event);
    expect(last()).toEqual({ type: 'move', url: 'https://github.com/acme/app', before: null });
    expect(names()).toEqual(['Plan', 'RUSH']);
    expect((document.activeElement as unknown as HTMLElement).dataset.open).toBe('https://github.com/acme/app');
    const sentBefore = sent.length;
    $('.tile:last-child .face').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }) as unknown as Event);
    expect(sent.length).toBe(sentBefore);
    // After a drop the drag is over, and a drag from outside the page carries no pin: neither moves anything.
    expect(drag('dragover', tile(0), 'right').defaultPrevented).toBe(false);
    carrying.types = ['text/plain'];
    expect(drag('dragover', tile(0), 'right').defaultPrevented).toBe(false);
    state('same');
  });
  test('typing filters Recent only: your pages always show, and Enter on a word opens the first recent match', () => {
    state('same');
    const q = $('#q') as unknown as HTMLInputElement;
    q.value = 'console'; q.dispatchEvent(new window.Event('input') as unknown as Event);
    expect([...document.querySelectorAll('.tname')].map((e) => e.textContent)).toEqual(['RUSH', 'Plan']);
    expect([...document.querySelectorAll('.row')].map((e) => (e as unknown as HTMLElement).dataset.open)).toEqual(['https://console.example.com/']);
    q.value = 'zzz'; q.dispatchEvent(new window.Event('input') as unknown as Event);
    expect([...document.querySelectorAll('.tname')].map((e) => e.textContent)).toEqual(['RUSH', 'Plan']);
    q.value = 'console'; q.dispatchEvent(new window.Event('input') as unknown as Event);
    key(q as unknown as HTMLElement, 'Enter');
    expect(last()).toEqual({ type: 'open', url: 'https://console.example.com/', newTab: false });
    q.value = ''; q.dispatchEvent(new window.Event('input') as unknown as Event);
  });
  test('your pages fill two rows, then turn pages with ‹ › and the dots; a tile moved past the edge takes the page with it', () => {
    // Two 104 px columns fit in 222 px, so a page holds four.
    Object.defineProperty($('#tiles'), 'clientWidth', { configurable: true, value: 222 });
    deliver({ type: 'state', click: 'same', shortcut: '⌘⇧B', recent: [], pins: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ url: `https://${n}.com/`, name: n, title: n })) });
    const names = () => [...document.querySelectorAll('.tname')].map((e) => e.textContent);
    expect(names()).toEqual(['a', 'b', 'c', 'd']);
    expect(document.querySelectorAll('.dot').length).toBe(2);
    expect(($('.pg') as unknown as HTMLButtonElement).disabled).toBe(true);
    click($('.pg[title="Next"]'));
    expect(names()).toEqual(['e', 'f']);
    expect($('.dot.on').getAttribute('aria-label')).toBe('Page 2 of 2');
    click($('.dot'));
    expect(names()).toEqual(['a', 'b', 'c', 'd']);
    $('.tile:last-child .face').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }) as unknown as Event);
    expect(last()).toEqual({ type: 'move', url: 'https://d.com/', before: 'https://f.com/' });
    expect(names()).toEqual(['d', 'f']);
    expect((document.activeElement as unknown as HTMLElement).dataset.open).toBe('https://d.com/');
    // ‹ keeps focus where it is after turning the page.
    const prev = $('.pg') as unknown as HTMLButtonElement; prev.focus(); click(prev);
    expect(names()).toEqual(['a', 'b', 'c', 'e']);
    expect((document.activeElement as unknown as HTMLElement).classList.contains('dot')).toBe(true);
    // One sideways swipe turns one page however long its momentum runs; a vertical scroll turns none.
    const wheel = (dx: number, dy = 0) => $('#tiles').dispatchEvent(new window.WheelEvent('wheel', { deltaX: dx, deltaY: dy, bubbles: true, cancelable: true }) as unknown as Event);
    wheel(0, 120);
    expect(names()).toEqual(['a', 'b', 'c', 'e']);
    wheel(40); wheel(40);
    expect(names()).toEqual(['d', 'f']);
    wheel(80); wheel(80);
    expect($('.dot.on').getAttribute('aria-label')).toBe('Page 2 of 2');
    // A dragged tile held over ‹ turns the page only once it has rested there.
    const carrying = { types: ['application/x-agents-pin'], setData() {}, effectAllowed: '', dropEffect: '' };
    const over = (el: HTMLElement) => { const e = new window.Event('dragover', { bubbles: true, cancelable: true }); Object.assign(e, { dataTransfer: carrying }); el.dispatchEvent(e as unknown as Event); };
    const start = new window.Event('dragstart', { bubbles: true }); Object.assign(start, { dataTransfer: carrying });
    $('.tile').dispatchEvent(start as unknown as Event);
    over($('.pg'));
    over($('.pg'));
    expect(names()).toEqual(['d', 'f']);
    const realNow = Date.now; Date.now = () => realNow() + 600;
    over($('.pg'));
    Date.now = realNow;
    expect(names()).toEqual(['a', 'b', 'c', 'e']);
    $('#tiles').dispatchEvent(new window.Event('dragend', { bubbles: true }) as unknown as Event);
    deliver({ type: 'state', click: 'same', shortcut: '⌘⇧B', recent: [], pins: ['a', 'b'].map((n) => ({ url: `https://${n}.com/`, name: n, title: n })) });
    expect(names()).toEqual(['a', 'b']);
    expect(($('#pager') as unknown as HTMLElement).hidden).toBe(true);
    Object.defineProperty($('#tiles'), 'clientWidth', { configurable: true, value: 1000 });
    state('same');
  });
  test('☆ beside a typed address pins it without opening it; a word or a pinned address gets none', () => {
    state('same');
    const q = $('#q') as unknown as HTMLInputElement;
    const type = (v: string) => { q.value = v; q.dispatchEvent(new window.Event('input') as unknown as Event); };
    const pinq = $('#pinq') as unknown as HTMLButtonElement;
    type('example.org/docs');
    expect(pinq.hidden).toBe(false);
    expect(pinq.title).toBe('Pin https://example.org/docs');
    click(pinq);
    expect(last()).toEqual({ type: 'pin', url: 'https://example.org/docs', title: '', icon: undefined });
    type('console.example.com');
    click(pinq);
    expect(last()).toEqual({ type: 'pin', url: 'https://console.example.com/', title: 'Console', icon: CONSOLE_ICON });
    type('console');
    expect(pinq.hidden).toBe(true);
    type('github.com/acme/app');
    expect(pinq.hidden).toBe(true);
    type('');
  });
  test('Recent shows 30 pages and Show more the next 30, focus on the first one it added', () => {
    const recent = Array.from({ length: 75 }, (_, i) => ({ url: `https://r${i}.example/`, title: `Page ${i}`, time: Date.now() - i * 1000 }));
    deliver({ type: 'state', click: 'same', shortcut: '⌘⇧B', pins: [], recent });
    const rows = () => document.querySelectorAll('.row').length;
    expect(rows()).toBe(30);
    expect($('#more').textContent).toBe('Show 30 more');
    click($('#more'));
    expect(rows()).toBe(60);
    expect((document.activeElement as unknown as HTMLElement).dataset.open).toBe('https://r30.example/');
    expect($('#more').textContent).toBe('Show 15 more');
    click($('#more'));
    expect(rows()).toBe(75);
    expect($('#more')).toBeNull();
    // A new filter starts at 30 again; ↓ off the last row reaches Show more and ↑ comes back.
    const q = $('#q') as unknown as HTMLInputElement;
    q.value = 'page'; q.dispatchEvent(new window.Event('input') as unknown as Event);
    expect(rows()).toBe(30);
    (document.querySelectorAll('.row')[29] as unknown as HTMLElement).focus();
    key(document.activeElement as unknown as HTMLElement, 'ArrowDown');
    expect((document.activeElement as unknown as HTMLElement).id).toBe('more');
    key(document.activeElement as unknown as HTMLElement, 'ArrowUp');
    expect((document.activeElement as unknown as HTMLElement).dataset.open).toBe('https://r29.example/');
    q.value = ''; q.dispatchEvent(new window.Event('input') as unknown as Event);
    state('same');
  });
  test('arrow keys walk focus through your pages, across the page edge, into Recent and back to the search box', () => {
    Object.defineProperty($('#tiles'), 'clientWidth', { configurable: true, value: 222 });
    deliver({ type: 'state', click: 'same', shortcut: '⌘⇧B', recent: [{ url: 'https://console.example.com/', title: 'Console', time: Date.now() }],
      pins: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ url: `https://${n}.com/`, name: n, title: n })) });
    const at = () => (document.activeElement as unknown as HTMLElement);
    const press = (k: string) => key(at(), k);
    const focusFace = (url: string) => ([...document.querySelectorAll('.face')].find((f) => (f as unknown as HTMLElement).dataset.open === url) as unknown as HTMLElement).focus();
    ($('#q') as unknown as HTMLInputElement).focus();
    press('ArrowDown'); expect(at().dataset.open).toBe('https://a.com/');
    press('ArrowRight'); expect(at().dataset.open).toBe('https://b.com/');
    press('ArrowDown'); expect(at().dataset.open).toBe('https://d.com/');
    press('ArrowLeft'); expect(at().dataset.open).toBe('https://c.com/');
    press('ArrowRight'); press('ArrowRight');
    expect(at().dataset.open).toBe('https://e.com/');
    expect($('.dot.on').getAttribute('aria-label')).toBe('Page 2 of 2');
    press('ArrowDown'); expect(at().dataset.open).toBe('https://console.example.com/');
    press('ArrowUp'); expect(at().dataset.open).toBe('https://f.com/');
    press('ArrowUp'); expect(at().id).toBe('q');
    // ⌥→ still moves the tile, not the focus.
    click($('.dot')); focusFace('https://a.com/'); key(at(), 'ArrowLeft'); expect(at().dataset.open).toBe('https://a.com/');
    at().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }) as unknown as Event);
    expect(last()).toEqual({ type: 'move', url: 'https://a.com/', before: 'https://c.com/' });
    expect(at().dataset.open).toBe('https://a.com/');
    Object.defineProperty($('#tiles'), 'clientWidth', { configurable: true, value: 1000 });
    state('same');
  });
  test('a hostile title or URL from the history is text, never markup', () => {
    deliver({ type: 'state', click: 'same', shortcut: '⌘⇧B', pins: [],
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
  test('no toast (owner, 2026-11-04 9:42 PM): a refusal takes the hint\'s place', () => {
    deliver({ type: 'opened', error: 'Could not open it' });
    expect($('#toast')).toBeNull();
    expect($('#hint').textContent).toBe('Could not open it');
  });
});
