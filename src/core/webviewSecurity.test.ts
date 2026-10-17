import { describe, expect, it } from 'bun:test';
import { browserTabArgs, isAllowedExternalUrl, isAllowedWebviewCommand, openWith, type LinkOpeners } from './webviewSecurity';
import { isDeprecatedAgentKey } from './agents';

describe('isAllowedExternalUrl', () => {
  it('allows the web + mail schemes the UI uses', () => {
    expect(isAllowedExternalUrl('https://github.com/muqsitnawaz/agents-cli/pull/1')).toBe(true);
    expect(isAllowedExternalUrl('http://localhost:5173/')).toBe(true);
    expect(isAllowedExternalUrl('mailto:muqsit@trp.so')).toBe(true);
  });

  it('blocks schemes that turn openExternal into a local-exec / disclosure sink', () => {
    // These are the payloads a hostile webview message would carry.
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('command:workbench.action.terminal.sendSequence')).toBe(false);
    expect(isAllowedExternalUrl('vscode://ms-vscode.js-debug/foo')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects empty / non-string / unparseable input', () => {
    expect(isAllowedExternalUrl('')).toBe(false);
    expect(isAllowedExternalUrl(undefined)).toBe(false);
    expect(isAllowedExternalUrl(null)).toBe(false);
    expect(isAllowedExternalUrl(42)).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
  });
});

describe('browserTabArgs', () => {
  it('opens a web page as an editor tab that a second click reuses', () => {
    const url = 'https://linear.app/acme/issue/ACM-12/fix-login';
    expect(browserTabArgs(url, 'editor')).toEqual({ url, reuseUrlFilter: url });
    expect(browserTabArgs('http://localhost:5173/', 'editor')).toEqual({ url: 'http://localhost:5173/', reuseUrlFilter: 'http://localhost:5173/' });
  });

  it('single shows every page in one tab; new never reuses one', () => {
    const url = 'https://github.com/o/r/pull/7';
    expect(browserTabArgs(url, 'editor', 'single')).toEqual({ url, reuseUrlFilter: '//*/**' });
    expect(browserTabArgs(url, 'editor', 'new')).toEqual({ url });
  });

  it('leaves the editor for other schemes and when the link should open in the browser', () => {
    expect(browserTabArgs('mailto:muqsit@trp.so', 'editor')).toBeNull();
    expect(browserTabArgs('agents://session/abc', 'editor')).toBeNull();
    expect(browserTabArgs('not a url', 'editor')).toBeNull();
    expect(browserTabArgs('https://github.com/o/busy/pull/7', 'browser')).toBeNull();
  });
});

describe('openWith', () => {
  const io = (o: Partial<LinkOpeners> = {}) => {
    const calls: string[] = [];
    const opener: LinkOpeners = {
      hasBrowser: async () => true,
      openTab: async (a) => { calls.push(`tab ${a.url} ${a.reuseUrlFilter}`); },
      openExternal: async (u) => { calls.push(`external ${u}`); },
      ...o,
    };
    return { calls, opener };
  };
  const PR = 'https://github.com/o/busy/pull/7';

  it('opens a web page as a tab, trimmed, with the same URL to reuse', async () => {
    const { calls, opener } = io();
    expect(await openWith(` ${PR} `, 'editor', opener)).toBe('tab');
    expect(calls).toEqual([`tab ${PR} ${PR}`]);
  });

  it('leaves the editor for a modifier click, mailto:, agents: and an editor without the browser', async () => {
    for (const [url, target, o] of [[PR, 'browser', {}], ['mailto:a@b.co', 'editor', {}], ['agents://session/x', 'editor', {}], [PR, 'editor', { hasBrowser: async () => false }]] as const) {
      const { calls, opener } = io(o);
      expect(await openWith(url, target, opener)).toBe('external');
      expect(calls).toEqual([`external ${url}`]);
    }
  });

  it('falls back to the OS browser when the browser lookup or the tab fails', async () => {
    for (const o of [{ hasBrowser: async () => { throw new Error('no commands'); } }, { openTab: async () => { throw new Error('disabled by policy'); } }]) {
      const { calls, opener } = io(o);
      expect(await openWith(PR, 'editor', opener)).toBe('external');
      expect(calls).toEqual([`external ${PR}`]);
    }
  });
});
