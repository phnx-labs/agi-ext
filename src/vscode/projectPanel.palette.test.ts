// ⌘K through the REAL registered panel: Agents: Search Sessions brings the panel up on
// Sessions and sends it every session the store holds, any project, live or ended;
// Enter on a session with a tab here fronts that tab; nothing is read or spawned.

import { expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

let provider: { resolveWebviewView(view: unknown): void } | undefined;
const noop = { dispose() { /* noop */ } };
const commands = new Map<string, (...a: unknown[]) => unknown>();
const ran: string[] = [];
const openTerminals: unknown[] = [];
mock.module('vscode', () => vscodeDouble({
  window: {
    registerWebviewViewProvider: (_id: string, p: typeof provider) => { provider = p; return noop; },
    registerWebviewPanelSerializer: () => noop,
    onDidChangeActiveTerminal: () => noop,
    terminals: openTerminals,
    showErrorMessage: () => Promise.resolve(undefined),
    tabGroups: { all: [], onDidChangeTabs: () => noop, onDidChangeTabGroups: () => noop },
  },
  workspace: { workspaceFolders: undefined },
  commands: { registerCommand: (id: string, cb: (...a: unknown[]) => unknown) => { commands.set(id, cb); return noop; }, executeCommand: (id: string) => { ran.push(id); return Promise.resolve(undefined); } },
  env: { appName: 'VSCodium' },
  Uri: { joinPath: () => ({ toString: () => '' }), file: (p: string) => ({ fsPath: p, toString: () => p }) },
}));

const { registerProjectPanel } = await import('./projectPanel.vscode');
const terminals = await import('./terminals.vscode');
const { sessionPresentationStore } = await import('../core/sessionPresentationStore');
const { getDefaultSettings } = await import('../core/settings');

const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); } }; };
const globalState = memento();
globalState.update('agentSettings', getDefaultSettings());
globalState.update('agents.projectPanel.favorites', ['other-project']);
registerProjectPanel({ subscriptions: [], globalState, workspaceState: memento(), extensionUri: { fsPath: '/ext' }, extensionPath: '/ext' } as never);

let send: (msg: unknown) => void = () => undefined;
const posted: { type: string; html?: string; tab?: string; waiting?: boolean }[] = [];
let shownView = 0;
provider!.resolveWebviewView({
  visible: false,
  show: () => { shownView++; },
  webview: {
    options: {}, html: '', cspSource: 'vscode-webview:',
    asWebviewUri: (u: unknown) => u,
    onDidReceiveMessage: (cb: (m: unknown) => void) => { send = cb; return noop; },
    postMessage: (m: { type: string }) => { posted.push(m); return Promise.resolve(true); },
  },
  onDidChangeVisibility: () => noop,
  onDidDispose: () => noop,
});

sessionPresentationStore.apply({
  v: 1, type: 'reset', streamId: 'palette', sequence: 1, capturedAt: 100, scope: 'zion',
  agents: [
    { rowKey: 'a', sourceDevice: 'zion', machine: 'zion', sessionId: 'here-1', kind: 'claude', title: 'Tab here', startedAtMs: 100, status: 'idle', confirmedProject: 'agi' },
    { rowKey: 'b', sourceDevice: 'zion', machine: 'zion', sessionId: 'other-project', kind: 'codex', title: 'Another project', startedAtMs: 100, status: 'idle', confirmedProject: 'rush' },
  ],
  attention: [],
} as never);

let fronted = 0;
const tab = { name: 'CC - here', processId: Promise.resolve(931), exitStatus: undefined, creationOptions: {}, show() { fronted++; }, sendText() { /* noop */ } };
openTerminals.push(tab);
terminals.register(tab as never, 'CC-here', { title: 'Claude', prefix: 'CC', icon: 'claude.png', commandId: 'agents.newClaude' } as never, 931);
terminals.getById('CC-here')!.sessionId = 'here-1';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Search Sessions shows the panel on Sessions and sends every session the store holds, favorites first', async () => {
  await commands.get('agents.searchSessions')!();
  await settle(10);
  expect(shownView).toBe(1);
  expect(posted.find((m) => m.type === 'choose')).toEqual({ type: 'choose', tab: 'sessions' });
  const palette = posted.find((m) => m.type === 'palette')!;
  expect(palette.waiting).toBe(false);
  const titles = [...palette.html!.matchAll(/data-title="([^"]+)"/g)].map((m) => m[1]);
  // The store is the process's one store, so other files' rows may be there too.
  expect(titles[0]).toBe('Another project');
  expect(titles).toContain('Tab here');
  expect(palette.html).toContain('data-session="here-1" data-host="zion" data-here="1"');
  // Nothing was read: no command but the view's own.
  expect(ran).toEqual([]);
});

test('Enter on a session with a tab here fronts that tab; closing stops the updates', async () => {
  fronted = 0;
  posted.length = 0;
  send({ type: 'paletteGo', sessionId: 'here-1', host: 'zion', here: true });
  await settle(10);
  expect(fronted).toBe(1);
  expect(posted.some((m) => m.type === 'opened')).toBe(true);
  send({ type: 'paletteClosed' });
  send({ type: 'ready' });
  await settle(10);
  expect(posted.some((m) => m.type === 'palette')).toBe(false);
});
