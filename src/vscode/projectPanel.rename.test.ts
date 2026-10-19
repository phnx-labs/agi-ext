// The pinned card's title and ★ through the REAL registered panel (owner videos,
// 2026-10-19 12:58 and 1:42 AM). Rename types Claude's own /rename into that session's
// tab through submitToTui (typed, then \r as its own keystroke), never for another
// harness; a favorite is a per-user preference kept in globalState by session id.

import { expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

let provider: { resolveWebviewView(view: unknown): void } | undefined;
const noop = { dispose() { /* noop */ } };
mock.module('vscode', () => vscodeDouble({
  window: {
    registerWebviewViewProvider: (_id: string, p: typeof provider) => { provider = p; return noop; },
    registerWebviewPanelSerializer: () => noop,
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
const { sessionPresentationStore } = await import('../core/sessionPresentationStore');
const { getDefaultSettings } = await import('../core/settings');

const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); } }; };
const globalState = memento();
globalState.update('agentSettings', getDefaultSettings());
registerProjectPanel({ subscriptions: [], globalState, workspaceState: memento(), extensionUri: { fsPath: '/ext' }, extensionPath: '/ext' } as never);

let send: (msg: unknown) => void = () => undefined;
const posted: { type: string; text?: string }[] = [];
provider!.resolveWebviewView({
  visible: false,
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
  v: 1, type: 'reset', streamId: 'rename', sequence: 1, capturedAt: 100, scope: 'zion',
  agents: [
    { rowKey: 'c', sourceDevice: 'zion', machine: 'zion', sessionId: 'claude-1', kind: 'claude', startedAtMs: 100, status: 'idle' },
    { rowKey: 'x', sourceDevice: 'zion', machine: 'zion', sessionId: 'codex-1', kind: 'codex', startedAtMs: 100, status: 'idle' },
  ],
  attention: [],
} as never);

const typed: [string, boolean | undefined][] = [];
const tab = (name: string, pid: number) => ({ name, processId: Promise.resolve(pid), exitStatus: undefined, creationOptions: {}, show() { /* noop */ }, sendText: (t: string, nl?: boolean) => { typed.push([t, nl]); } });
terminals.register(tab('CC - one', 911) as never, 'CC-one', { title: 'Claude', prefix: 'CC', icon: 'claude.png', commandId: 'agents.newClaude' } as never, 911);
terminals.getById('CC-one')!.sessionId = 'claude-1';
terminals.register(tab('CX - two', 912) as never, 'CX-two', { title: 'Codex', prefix: 'CX', icon: 'codex.png', commandId: 'agents.newCodex' } as never, 912);
terminals.getById('CX-two')!.sessionId = 'codex-1';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('renaming a Claude session types its own /rename into its tab, then Enter as its own keystroke', async () => {
  send({ type: 'rename', sessionId: 'claude-1', name: '  Body alignment  ' });
  await settle(450);
  expect(typed).toEqual([['/rename Body alignment', false], ['\r', false]]);
  expect(posted.at(-1)).toMatchObject({ type: 'notice', text: 'Typed /rename Body alignment into its tab; the title changes when the session reports it.' });
});

test('another harness has no /rename: nothing is typed and the panel says why', async () => {
  typed.length = 0;
  send({ type: 'rename', sessionId: 'codex-1', name: 'New name' });
  await settle(450);
  expect(typed).toEqual([]);
  expect(posted.at(-1)).toMatchObject({ type: 'notice', text: 'Rename needs this Claude session’s tab here.' });
});

test('★ keeps the session id in globalState, so it survives a reload; ☆ takes it out', async () => {
  send({ type: 'favorite', sessionId: 'claude-1', value: true });
  send({ type: 'favorite', sessionId: 'codex-1', value: true });
  await settle(10);
  expect(globalState.get('agents.projectPanel.favorites')).toEqual(['claude-1', 'codex-1']);
  send({ type: 'favorite', sessionId: 'claude-1', value: false });
  await settle(10);
  expect(globalState.get('agents.projectPanel.favorites')).toEqual(['codex-1']);
});

test('a click that opens something hears back once the host has acted', async () => {
  posted.length = 0;
  send({ type: 'select', sessionId: 'claude-1', host: 'zion', focus: true });
  await settle(10);
  expect(posted.some((m) => m.type === 'opened')).toBe(true);
});
