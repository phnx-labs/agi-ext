// Starting on a ticket from Issues: the webview's `startTicket` goes through the REAL
// registered panel, a real `linear` subprocess (testdata/linear-bin) for the ticket, and
// lands as one Spawn With Prompt carrying the agent and where ▾ said to run it.
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { join } from 'path';
import { vscodeDouble } from '../testing/vscodeDouble';

let provider: { resolveWebviewView(view: unknown): void } | undefined;
const noop = { dispose() { /* noop */ } };
const ran: { id: string; args: { agent?: string; prompt?: string; where?: string } }[] = [];
let defaultTarget: string | undefined;
mock.module('vscode', () => vscodeDouble({
  window: {
    registerWebviewViewProvider: (_id: string, p: typeof provider) => { provider = p; return noop; },
    registerWebviewPanelSerializer: () => noop,
    onDidChangeActiveTerminal: () => noop,
    showErrorMessage: () => Promise.resolve(undefined),
    tabGroups: { all: [], onDidChangeTabs: () => noop, onDidChangeTabGroups: () => noop },
  },
  workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: (k: string) => (k === 'launch.defaultTarget' ? defaultTarget : undefined) }) },
  commands: { registerCommand: () => noop, executeCommand: (id: string, args: never) => { ran.push({ id, args }); return Promise.resolve(undefined); } },
  env: { appName: 'VSCodium' },
  Uri: { joinPath: () => ({ toString: () => '' }), file: (p: string) => ({ fsPath: p, toString: () => p }) },
}));

const { registerProjectPanel } = await import('./projectPanel.vscode');
const { clearAgentsBinCache } = await import('../core/agentsBin');
const { forgetRegistry } = await import('./projectRegistry.vscode');

const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
process.env.PATH = `${join(import.meta.dir, 'testdata', 'linear-bin')}:${join(import.meta.dir, 'testdata', 'projects-bin')}:${saved.PATH ?? ''}`;
process.env.SHELL = '/bin/sh';
clearAgentsBinCache();
afterAll(() => {
  forgetRegistry();
  process.env.PATH = saved.PATH;
  if (saved.SHELL === undefined) delete process.env.SHELL; else process.env.SHELL = saved.SHELL;
  clearAgentsBinCache();
});

const workspace = new Map<string, unknown>([['agents.projectPanel.project', { linear: { id: 'lin-rush', name: 'Rush', profile: null } }]]);
const memento = (m = new Map<string, unknown>()) => ({ get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); } });
registerProjectPanel({ subscriptions: [], globalState: memento(), workspaceState: memento(workspace), extensionUri: { fsPath: '/ext' } } as never);

let send: (msg: unknown) => void = () => undefined;
const posted: { type: string; tab?: string; html?: string }[] = [];
provider!.resolveWebviewView({
  visible: true,
  webview: {
    options: {}, html: '', cspSource: 'vscode-webview:',
    asWebviewUri: (u: unknown) => u,
    onDidReceiveMessage: (cb: (m: unknown) => void) => { send = cb; return noop; },
    postMessage: (m: { type: string }) => { posted.push(m); return Promise.resolve(true); },
  },
  onDidChangeVisibility: () => noop,
  onDidDispose: () => noop,
});

const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 25)); expect(cond()).toBe(true); };

beforeAll(async () => {
  send({ type: 'tab', tab: 'tickets' });
  await until(() => posted.some((m) => m.type === 'html' && m.tab === 'tickets' && m.html?.includes('RUSH-1')));
});

test('an agent and a place picked in ▾ reach the launch as they were picked', async () => {
  send({ type: 'startTicket', id: 'RUSH-1', agent: 'codex', where: 'ask' });
  await until(() => ran.length === 1);
  expect(ran[0]!.id).toBe('agents.spawnWithPrompt');
  expect(ran[0]!.args.agent).toBe('codex');
  expect(ran[0]!.args.where).toBe('ask');
  expect(ran[0]!.args.prompt).toContain('RUSH-1');
});

test('the logo alone runs where Settings > Launch target says; an unknown place is auto', async () => {
  ran.length = 0;
  defaultTarget = 'local';
  send({ type: 'startTicket', id: 'RUSH-1' });
  send({ type: 'startTicket', id: 'RUSH-1', where: 'mars' });
  await until(() => ran.length === 2);
  expect(ran.map((r) => r.args.where)).toEqual(['local', 'auto']);
});
