// Pages: the pages the owner opens every day, as one row of icons in an editor tab (⌘⇧V).
// A click opens the page in VSCodium's own browser. Pure: no vscode import.

/** A page the owner pinned: their own name for it, and the icon saved when it was pinned. */
export interface PagePin {
  url: string;
  /** The owner's name; the page's title until they rename it. */
  name: string;
  /** The page's own title, which comes back when the name is cleared. */
  title: string;
  /** A data: URI, saved with the pin so it never goes blank; the view draws a letter without one. */
  icon?: string;
}

/** A page from the built-in browser's history. */
export interface RecentPage {
  url: string;
  title: string;
  icon?: string;
  time: number;
}

/** What a plain click does; ⌘-click does the other. */
export type PagesClick = 'same' | 'new';

export const PAGES_CLICK_DEFAULT: PagesClick = 'same';

/** A URL the owner typed: a bare host gets https://; anything that is not a web or file URL is not a page. */
export function normalizePageUrl(input: string): string | null {
  const v = input.trim();
  if (!v || /\s/.test(v)) return null;
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(v) ? v : /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)|^localhost(:\d+)?(\/|$)/i.test(v) ? `https://${v}` : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    return ['http:', 'https:', 'file:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

export function pinPage(pins: PagePin[], page: { url: string; title: string; icon?: string }): PagePin[] {
  if (pins.some((p) => p.url === page.url)) return pins;
  const title = page.title.trim() || hostOf(page.url);
  return [...pins, { url: page.url, name: title, title, ...(page.icon ? { icon: page.icon } : {}) }];
}

export function unpinPage(pins: PagePin[], url: string): PagePin[] {
  return pins.filter((p) => p.url !== url);
}

/** An empty name gives the page its own title back. */
export function renamePin(pins: PagePin[], url: string, name: string): PagePin[] {
  return pins.map((p) => (p.url === url ? { ...p, name: name.trim() || p.title } : p));
}

export function setPinIcon(pins: PagePin[], url: string, icon: string): PagePin[] {
  return pins.map((p) => (p.url === url ? { ...p, icon } : p));
}

/** Pins as stored in globalState; anything malformed is dropped rather than drawn. */
export function readPins(stored: unknown): PagePin[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((p) => {
    if (!p || typeof p !== 'object' || typeof p.url !== 'string' || typeof p.name !== 'string') return [];
    const title = typeof p.title === 'string' && p.title ? p.title : p.name;
    return [{ url: p.url, name: p.name, title, ...(typeof p.icon === 'string' && p.icon.startsWith('data:') ? { icon: p.icon } : {}) }];
  });
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? 'local file' : u.host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * The built-in browser's history, from VSCodium's own storage: `browser.history.entries.global`
 * holds `{ <scope>: [{ url, title, time, icon }] }` and `browser.history.favicons.global` holds
 * `{ map: { <icon id>: data URI } }` (VSCodium 1.117). Newest visit of each page first; sign-in
 * pages and anything that is not http(s) or file are left out.
 */
export function parseBrowserHistory(entriesJson: string | null, faviconsJson: string | null, limit = 30): RecentPage[] {
  let entries: unknown;
  let icons: Record<string, string> = {};
  try {
    entries = entriesJson ? JSON.parse(entriesJson) : null;
    const map = faviconsJson ? JSON.parse(faviconsJson)?.map : null;
    if (map && typeof map === 'object') icons = map as Record<string, string>;
  } catch {
    return [];
  }
  const lists = Array.isArray(entries) ? [entries] : entries && typeof entries === 'object' ? Object.values(entries) : [];
  const newest = new Map<string, RecentPage>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e.url !== 'string' || typeof e.time !== 'number') continue;
      if (!/^(https?|file):/i.test(e.url) || /^https:\/\/accounts\.google\.com\//.test(e.url)) continue;
      const url = e.url.split('#')[0];
      const prev = newest.get(url);
      if (prev && prev.time >= e.time) continue;
      const icon = typeof e.icon === 'string' && typeof icons[e.icon] === 'string' && icons[e.icon].startsWith('data:') ? icons[e.icon] : undefined;
      newest.set(url, { url, title: typeof e.title === 'string' && e.title.trim() ? e.title.trim() : hostOf(url), time: e.time, ...(icon ? { icon } : {}) });
    }
  }
  return [...newest.values()].sort((a, b) => b.time - a.time).slice(0, limit);
}

/**
 * Arguments for `workbench.action.browser.open` (VSCodium 1.117). "Same tab" passes the URL
 * Pages last opened as `reuseUrlFilter`, which navigates the browser tab still showing it;
 * when no tab shows it any more the browser opens a new one.
 */
export function browserOpenArgs(url: string, newTab: boolean, lastUrl: string | null): { url: string; reuseUrlFilter?: string } {
  return !newTab && lastUrl ? { url, reuseUrlFilter: lastUrl } : { url };
}

/** The icon a page's HTML declares, as an absolute URL; the site's /favicon.ico when it declares none. */
export function findIconHref(html: string, pageUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(base.protocol)) return null;
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  const rank = (rel: string) => (/(^|\s)icon(\s|$)/i.test(rel) ? 0 : /shortcut icon/i.test(rel) ? 1 : /apple-touch-icon/i.test(rel) ? 2 : -1);
  const found = links
    .map((tag) => ({ rel: /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] ?? '', href: /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '' }))
    .filter((l) => l.href && rank(l.rel) >= 0)
    .sort((a, b) => rank(a.rel) - rank(b.rel));
  try {
    return new URL(found[0]?.href ?? '/favicon.ico', base).toString();
  } catch {
    return null;
  }
}
