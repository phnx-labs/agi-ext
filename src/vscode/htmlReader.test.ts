import { describe, expect, mock, test } from 'bun:test';
import * as path from 'path';
import { vscodeDouble } from '../testing/vscodeDouble';

const opened: string[] = [];

mock.module('vscode', () => vscodeDouble({
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` }),
    parse: (value: string) => ({ toString: () => value }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
  env: {
    openExternal: async (uri: { toString(): string }) => { opened.push(uri.toString()); return true; },
  },
  window: {
    registerCustomEditorProvider: () => ({ dispose: () => {} }),
  },
  workspace: {
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
  },
}));

const { rewriteRelativeResources, escapeForTemplateLiteral, isExternalLink, AgentsHtmlReaderProvider } = await import('./htmlReader');

describe('escapeForTemplateLiteral', () => {
  test('escapes </script> so host script block is not broken', () => {
    const html = '<script>alert(1)</script><p>hello</p>';
    const out = escapeForTemplateLiteral(html);
    expect(out).not.toContain('</script');
    expect(out).toContain('<\\/script');
  });

  test('escapes case-insensitively', () => {
    const out = escapeForTemplateLiteral('</Script></SCRIPT>');
    expect(out).not.toContain('</Script');
    expect(out).not.toContain('</SCRIPT');
  });

  test('escapes backticks and template expressions', () => {
    const out = escapeForTemplateLiteral('`${x}`');
    expect(out).toBe('\\`\\${x}\\`');
  });
});

describe('rewriteRelativeResources', () => {
  const docDir = '/tmp/artifacts/plans';
  const webview = {
    asWebviewUri: (uri: { fsPath: string }) => ({
      toString: () => `webview-uri://${uri.fsPath}`,
    }),
  };

  test('rewrites relative src and href to webview URIs', () => {
    const html = `<img src="./cover.png"><link href="style.css" rel="stylesheet">`;
    const fileUri = (fsPath: string) => ({ fsPath } as unknown as ReturnType<typeof import('vscode')['Uri']['file']>);
    const out = rewriteRelativeResources(html, docDir, webview as any, fileUri);
    expect(out).toContain(`src="webview-uri://${path.resolve(docDir, './cover.png')}"`);
    expect(out).toContain(`href="webview-uri://${path.resolve(docDir, 'style.css')}"`);
  });

  test('leaves a custom-scheme link alone, so an agents:// session link is not turned into a missing file', () => {
    const html = `<a href="agents://session/0495e152-4d7c-4620-920b-efc0f2de069c?host=mac-mini">Open session</a><a href="vscode://swarmify.swarm-ext/focus">x</a>`;
    expect(rewriteRelativeResources(html, docDir, webview as any)).toBe(html);
  });

  test('leaves absolute and data URLs alone', () => {
    const html = `<img src="https://example.com/a.png"><img src="data:image/png;base64,aa"><a href="#toc">`;
    const out = rewriteRelativeResources(html, docDir, webview as any);
    expect(out).toBe(html);
  });
});

describe('isExternalLink', () => {
  test('hands session links, web links and mail to the OS', () => {
    for (const href of ['agents://session/0495e152?host=mac-mini', 'https://github.com/phnx-labs/agi-ext/pull/106', 'http://localhost:3000', 'mailto:a@b.c', '  AGENTS://session/x']) {
      expect(isExternalLink(href)).toBe(true);
    }
  });

  test('keeps in-page anchors, relative files and every other scheme inside the reader', () => {
    for (const href of ['#toc', './plan.md', 'javascript:alert(1)', 'file:///etc/passwd', 'vscode://settings', 'data:text/html,x']) {
      expect(isExternalLink(href)).toBe(false);
    }
  });
});

describe('reader link messages', () => {
  test('a clicked agents:// or web link opens outside the editor; other schemes and stray messages do not', async () => {
    opened.length = 0;
    let onMessage: ((m: unknown) => void) | undefined;
    let html = '';
    const webview = {
      options: {},
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `webview-uri://${uri.fsPath}` }),
      onDidReceiveMessage: (listener: (m: unknown) => void) => { onMessage = listener; return { dispose: () => {} }; },
      set html(value: string) { html = value; },
      get html() { return html; },
    };
    const panel = { webview, onDidDispose: () => ({ dispose: () => {} }) };
    const document = { uri: { fsPath: '/tmp/a/demo.html', toString: () => 'file:///tmp/a/demo.html' }, getText: () => '<a href="agents://session/abc">Open session</a>' };
    const provider = new AgentsHtmlReaderProvider({ extensionUri: { fsPath: '/ext' } } as any);
    await provider.resolveCustomTextEditor(document as any, panel as any, {} as any);

    expect(html).toContain("postMessage({ type: 'open-external', href })");
    for (const message of [
      { type: 'open-external', href: 'agents://session/abc?host=mac-mini' },
      { type: 'open-external', href: 'https://github.com/phnx-labs/agi-ext/pull/107' },
      { type: 'open-external', href: 'javascript:alert(1)' },
      { type: 'open-external', href: 'file:///etc/passwd' },
      { type: 'navigate', href: 'https://example.com' },
      { type: 'open-external' },
    ]) onMessage?.(message);
    await Promise.resolve();
    expect(opened).toEqual(['agents://session/abc?host=mac-mini', 'https://github.com/phnx-labs/agi-ext/pull/107']);
  });
});
