import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { browserOpenArgs, findIconHref, normalizePageUrl, parseBrowserHistory, pinPage, readPins, renamePin, unpinPage } from './pages';

const fixture = (name: string) => readFileSync(join(__dirname, 'testdata', 'pages', name), 'utf8');

describe('normalizePageUrl', () => {
  test('a bare host becomes https; web and file URLs pass; anything else is not a page', () => {
    expect(normalizePageUrl('github.com/acme')).toBe('https://github.com/acme');
    expect(normalizePageUrl('  localhost:3000/x ')).toBe('https://localhost:3000/x');
    expect(normalizePageUrl('http://example.com')).toBe('http://example.com/');
    expect(normalizePageUrl('file:///Users/me/plan.html')).toBe('file:///Users/me/plan.html');
    expect(normalizePageUrl('vscode://settings')).toBeNull();
    expect(normalizePageUrl('pull requests')).toBeNull();
    expect(normalizePageUrl('')).toBeNull();
  });
});

describe('pins', () => {
  const pins = pinPage([], { url: 'https://github.com/acme/app', title: 'acme/app', icon: 'data:image/png;base64,AA' });
  test('a pin starts named by the page title, and pinning twice keeps one', () => {
    expect(pins).toEqual([{ url: 'https://github.com/acme/app', name: 'acme/app', title: 'acme/app', icon: 'data:image/png;base64,AA' }]);
    expect(pinPage(pins, { url: 'https://github.com/acme/app', title: 'again' })).toBe(pins);
  });
  test("the owner's name replaces the title; an empty name brings the title back", () => {
    const renamed = renamePin(pins, 'https://github.com/acme/app', ' RUSH ');
    expect(renamed[0].name).toBe('RUSH');
    expect(renamePin(renamed, 'https://github.com/acme/app', '   ')[0].name).toBe('acme/app');
  });
  test('unpin removes only that page', () => {
    const two = pinPage(pins, { url: 'https://x.com/', title: '' });
    expect(two[1].name).toBe('x.com');
    expect(unpinPage(two, 'https://github.com/acme/app').map((p) => p.url)).toEqual(['https://x.com/']);
  });
  test('stored pins drop malformed entries and icons that are not data URIs', () => {
    expect(readPins([{ url: 'https://a.com/', name: 'A', icon: 'https://a.com/i.png' }, { name: 'no url' }, 'x'])).toEqual([{ url: 'https://a.com/', name: 'A', title: 'A' }]);
    expect(readPins(undefined)).toEqual([]);
  });
});

describe('parseBrowserHistory', () => {
  const recent = parseBrowserHistory(fixture('history-entries.json'), fixture('history-favicons.json'));
  test('newest visit of each page first; sign-in pages and non-web URLs are left out', () => {
    expect(recent.map((r) => r.url)).toEqual(['https://github.com/acme/app/pulls', 'https://console.example.com/', 'file:///Users/me/plan.html']);
    expect(recent[0].time).toBe(1792500000000);
  });
  test('an icon comes from the stored favicons by id; a missing one or a non-data URI is left out', () => {
    expect(recent[0].icon?.startsWith('data:image/png;base64,')).toBe(true);
    expect(recent[1].icon).toBeUndefined();
    expect(recent[1].title).toBe('console.example.com');
  });
  test('missing or broken storage reads as no history', () => {
    expect(parseBrowserHistory(null, null)).toEqual([]);
    expect(parseBrowserHistory('{not json', null)).toEqual([]);
  });
});

test('browserOpenArgs: same tab reuses the last URL Pages opened; a new tab or a first open passes only the URL', () => {
  expect(browserOpenArgs('https://b.com/', false, 'https://a.com/')).toEqual({ url: 'https://b.com/', reuseUrlFilter: 'https://a.com/' });
  expect(browserOpenArgs('https://b.com/', true, 'https://a.com/')).toEqual({ url: 'https://b.com/' });
  expect(browserOpenArgs('https://b.com/', false, null)).toEqual({ url: 'https://b.com/' });
});

test('findIconHref: the declared icon resolved against the page, else /favicon.ico; none for a local file', () => {
  const html = '<head><link rel="apple-touch-icon" href="/apple.png"><link rel="stylesheet" href="/a.css"><link href="img/fav.svg" rel="icon"></head>';
  expect(findIconHref(html, 'https://site.com/app/page')).toBe('https://site.com/app/img/fav.svg');
  expect(findIconHref('<link rel="apple-touch-icon" href="/apple.png">', 'https://site.com/')).toBe('https://site.com/apple.png');
  expect(findIconHref('', 'https://site.com/deep/x')).toBe('https://site.com/favicon.ico');
  expect(findIconHref('<link rel="icon" href="/i.png">', 'file:///Users/me/plan.html')).toBeNull();
});
