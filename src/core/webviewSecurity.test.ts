import { describe, expect, it } from 'bun:test';
import { browserTabArgs, isAllowedExternalUrl, isAllowedWebviewCommand } from './webviewSecurity';
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
    const url = 'https://linear.app/getrush/issue/PHNX-4367/voice-dictation';
    expect(browserTabArgs(url, 'editor')).toEqual({ url, reuseUrlFilter: url });
    expect(browserTabArgs('http://localhost:5173/', 'editor')).toEqual({ url: 'http://localhost:5173/', reuseUrlFilter: 'http://localhost:5173/' });
  });

  it('leaves the editor for other schemes and when the link should open in the browser', () => {
    expect(browserTabArgs('mailto:muqsit@trp.so', 'editor')).toBeNull();
    expect(browserTabArgs('agents://session/abc', 'editor')).toBeNull();
    expect(browserTabArgs('not a url', 'editor')).toBeNull();
    expect(browserTabArgs('https://github.com/phnx-labs/agents/pull/3979', 'browser')).toBeNull();
  });
});
