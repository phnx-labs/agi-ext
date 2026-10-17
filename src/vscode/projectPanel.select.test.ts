// A card click through the REAL registered panel: the sidebar takes the session and
// the tab this window binds to it comes forward, also when its agent runs on another
// machine (owner video, 2026-10-17: Cloud - Projects on s1 stayed behind CC - Linear).
// Settings > Card click "Only show it" leaves the tab where it is.

import { expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

let provider: { resolveWebviewView(view: unknown): void } | undefined;
const noop = { dispose() { /* noop */ } };
mock.module('vscode', () => vscodeDouble({
  window: {
    registerWebviewViewProvider: (_id: string, p: typeof provider) => { provider = p; return noop; },
    onDidChangeActiveTerminal: () => noop,
    showErrorMessage: () => Promise.resolve(undefined),
    tabGroups: { all: [], onDidChangeTabs: () => noop, onDidChangeTabGroups: () => noop },
  },
  workspace: { workspaceFolders: undefined },
  commands: { registerCommand: () => noop, executeCommand: () => Promise.resolve(undefined) },
  env: { appName: 'VSCodium' },
  Uri: { joinPath: () => ({ toString: () => '' }), file: (p: string) => ({ fsPath: p, toString: () => p }) },
}));

const { registerProjectPanel } = await import('./projectPanel.vscode');
const terminals = await import('./terminals.vscode');
const { getDefaultSettings, DEFAULT_CARD_SETTINGS } = await import('../core/settings');

const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); } }; };
const globalState = memento();
registerProjectPanel({ subscriptions: [], globalState, workspaceState: memento(), extensionUri: { fsPath: '/ext' }, extensionPath: '/ext' } as never);

let send: (msg: unknown) => void = () => undefined;
provider!.resolveWebviewView({
  visible: false,
  webview: {
    options: {}, html: '', cspSource: 'vscode-webview:',
    asWebviewUri: (u: unknown) => u,
    onDidReceiveMessage: (cb: (m: unknown) => void) => { send = cb; return noop; },
    postMessage: () => Promise.resolve(true),
  },
  onDidChangeVisibility: () => noop,
  onDidDispose: () => noop,
});

globalState.update('agentSettings', getDefaultSettings());
let shown = 0;
const tab = { name: 'CC - Cloud - Projects', processId: Promise.resolve(901), exitStatus: undefined, creationOptions: {}, show() { shown++; } };
terminals.register(tab as never, 'CC-cloud', { title: 'Claude', prefix: 'CC', icon: 'claude.png', commandId: 'agents.newClaude' } as never, 901);
const entry = terminals.getById('CC-cloud')!;
entry.sessionId = 'cloud-projects';
entry.host = 'yosemite-s1';

test('a card click fronts the tab of a session whose agent runs on another machine', () => {
  shown = 0;
  send({ type: 'select', sessionId: 'cloud-projects', host: 'yosemite-s1', focus: true });
  expect(shown).toBe(1);
  // A click that only selects (no tab here) fronts nothing.
  send({ type: 'select', sessionId: 'cloud-projects', host: 'yosemite-s1', focus: false });
  expect(shown).toBe(1);
});

test('Card click "Only show it" keeps the tab where it is', () => {
  globalState.update('agentSettings', { ...getDefaultSettings(), cards: { ...DEFAULT_CARD_SETTINGS, click: 'show' } });
  shown = 0;
  send({ type: 'select', sessionId: 'cloud-projects', host: 'yosemite-s1', focus: true });
  expect(shown).toBe(0);
});
