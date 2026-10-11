import { expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());

// The panel's script lives inside a template literal; one mis-escaped character
// is a SyntaxError that leaves every tab on "Loading…". Parse what actually ships.
test('the Project panel webview script parses', async () => {
  const { shell } = await import('./projectPanel.vscode');
  const scripts = [...shell('vscode-webview:').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length).toBe(1);
  for (const js of scripts) expect(() => new Function(js)).not.toThrow();
});
