// Agent tabs opened through extension.ts's one opener, with the real terminals
// registry and readiness state machine. Readiness is driven by broadcast facts
// (the monitor-connected path), so no ps/pgrep probe runs.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type * as vscode from 'vscode';
import { vscodeDouble } from '../testing/vscodeDouble';

interface FakeTerminal {
  name: string;
  creationOptions: vscode.TerminalOptions;
  processId: Promise<number>;
  exitStatus: undefined;
  sent: [string, boolean | undefined][];
  shown: number;
  sendText(text: string, addNewLine?: boolean): void;
  show(): void;
  dispose(): void;
}

const created: FakeTerminal[] = [];
let nextPid = 7100;

function fakeTerminal(options: vscode.TerminalOptions): FakeTerminal {
  return {
    name: options.name ?? '',
    creationOptions: options,
    processId: Promise.resolve(nextPid++),
    exitStatus: undefined,
    sent: [],
    shown: 0,
    sendText(text, addNewLine) { this.sent.push([text, addNewLine]); },
    show() { this.shown++; },
    dispose() {},
  };
}

const disposable = () => ({ dispose() {} });

// The vscode double whose registration lands last owns `window` and `workspace`
// for every importer, so this file installs its surface on the live objects
// before each test rather than trusting its own registration.
const windowSurface = {
  terminals: [],
  activeTerminal: undefined,
  activeTextEditor: undefined,
  createTerminal: (options: vscode.TerminalOptions) => {
    const terminal = fakeTerminal(options);
    created.push(terminal);
    return terminal;
  },
  onDidCloseTerminal: disposable,
  onDidOpenTerminal: disposable,
  onDidChangeTerminalShellIntegration: disposable,
  onDidEndTerminalShellExecution: disposable,
  showInformationMessage: () => undefined,
  showErrorMessage: () => undefined,
  setStatusBarMessage: () => undefined,
};
// No folder: the restore store is keyed by folder, so nothing is persisted.
const workspaceSurface = { workspaceFolders: undefined, getConfiguration: () => ({ get: () => undefined }) };

mock.module('vscode', () => vscodeDouble({ window: { ...windowSurface }, workspace: { ...workspaceSurface } }));

const vscodeModule = await import('vscode');
const readiness = await import('./terminalReadiness');
const terminals = await import('./terminals.vscode');
const ext = await import('./extension');
const { AgentsMarkdownEditorProvider } = await import('./customEditor');

const globalState = new Map<string, unknown>();
const context = {
  extensionPath: '/ext',
  extensionUri: { fsPath: '/ext' },
  subscriptions: [] as { dispose(): void }[],
  globalState: {
    get: (key: string) => globalState.get(key),
    update: async (key: string, value: unknown) => { globalState.set(key, value); },
  },
} as unknown as vscode.ExtensionContext;

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function untilCreated(count: number): Promise<FakeTerminal> {
  for (let i = 0; i < 200 && created.length < count; i++) await waitMs(5);
  const terminal = created[count - 1];
  expect(terminal).toBeDefined();
  // The opener registers the tab once its pid resolves.
  for (let i = 0; i < 200 && !terminals.getByTerminal(terminal as unknown as vscode.Terminal); i++) await waitMs(5);
  return terminal;
}

beforeEach(() => {
  Object.assign(vscodeModule.window, windowSurface);
  Object.assign(vscodeModule.workspace, workspaceSurface);
  created.length = 0;
  terminals.clear();
  readiness.__clearRegistryForTests();
  readiness.setMonitorConnectivity(() => true);
  readiness.setMonitorArmSink({ armAgent: () => {}, armShellAdoption: () => {} });
});

afterEach(() => {
  readiness.__clearRegistryForTests();
  readiness.setMonitorConnectivity(() => false);
  readiness.setMonitorArmSink(undefined);
});

describe('Resume a session in a tab', () => {
  test('opens an editor tab whose process is the resume, shown before the agent is ready', async () => {
    const resuming = ext.openAgentSessionTerminal(context, { id: 'session-r', shortId: 'session', agent: 'codex', version: '0.124.0', account: 'me@example.com' });
    const tab = await untilCreated(1);
    // Visible while readiness is still pending: a slow start must not look like a no-op.
    expect(tab.shown).toBe(1);
    readiness.ingestReadinessFact(await tab.processId, 'agentReady');
    expect(await resuming).toBe(true);

    expect(tab.creationOptions.location).toEqual({ viewColumn: -1 });
    expect(tab.creationOptions.shellArgs?.at(-1)).toBe("agents run auto --resume 'session-r' --interactive --quiet");
    expect((tab.creationOptions.iconPath as { dark: { fsPath: string } }).dark.fsPath).toBe('/ext/assets/chatgpt.png');
    expect(tab.creationOptions.env?.AGENT_TERMINAL_KIND).toBe('agent');
    expect(tab.creationOptions.env?.AGENT_VERSION).toBe('0.124.0');
    const entry = terminals.getByTerminal(tab as unknown as vscode.Terminal);
    expect(entry).toEqual(expect.objectContaining({ sessionId: 'session-r', agentType: 'codex', version: '0.124.0', account: 'me@example.com' }));
  });
});

describe('Reopen Last Closed Session', () => {
  test('a session a tab already shows is focused, not opened a second time', async () => {
    const open = fakeTerminal({ name: 'Claude' });
    terminals.register(open as unknown as vscode.Terminal, 'CC-1', { title: 'Claude', command: 'claude', prefix: 'cc' } as never);
    terminals.setSessionId(open as unknown as vscode.Terminal, 'session-open');
    terminals.pushClosedSession({ sessionId: 'session-open', agentType: 'claude' });

    await ext.reopenLastClosedSession(context);

    expect(created).toHaveLength(0);
    expect(open.shown).toBe(1);
  });

  test('a closed session reopens as one tab running its resume, wearing its label', async () => {
    terminals.pushClosedSession({ sessionId: 'session-closed', agentType: 'claude', label: 'fix the build', host: 'yosemite-s0' });

    const reopening = ext.reopenLastClosedSession(context);
    const tab = await untilCreated(1);
    readiness.ingestReadinessFact(await tab.processId, 'agentReady');
    await reopening;

    expect(created).toHaveLength(1);
    expect(tab.creationOptions.shellArgs?.at(-1)).toBe("agents run auto --resume 'session-closed' --interactive --quiet");
    expect(tab.creationOptions.env?.AGENT_SESSION_ID).toBe('session-closed');
    const entry = terminals.getByTerminal(tab as unknown as vscode.Terminal);
    expect(entry?.label).toBe('fix the build');
    expect(entry?.host).toBe('yosemite-s0');
    expect(entry?.agentType).toBe('claude');
  });
});

describe('Reader: Send to Agent', () => {
  test('the selection is typed into the agent and submitted with its own Enter', async () => {
    const provider = new AgentsMarkdownEditorProvider(context);
    const document = { uri: { fsPath: '/notes/plan.md', toString: () => 'file:///notes/plan.md' } };
    const webview = { postMessage: () => Promise.resolve(true) };

    const sending = (provider as unknown as {
      handleMessage(message: unknown, document: unknown, webview: unknown): Promise<void>;
    }).handleMessage({ type: 'sendToAgent', selection: 'Ship the opener' }, document, webview);
    const tab = await untilCreated(1);
    const pid = await tab.processId;
    readiness.ingestReadinessFact(pid, 'promptReady');
    await sending;
    readiness.ingestReadinessFact(pid, 'agentReady');
    await waitMs(400);

    // The launch line, then the prompt typed without a newline, then a bare \r.
    expect(tab.sent).toHaveLength(3);
    expect(tab.sent[0][0]).toContain('agents run claude');
    expect(tab.sent[0][0]).toContain('--local');
    expect(tab.sent[1][0]).toContain('Ship the opener');
    expect(tab.sent[1][1]).toBe(false);
    expect(tab.sent[2]).toEqual(['\r', false]);
    // The Reader's tab is tracked like every other agent tab.
    expect(terminals.getByTerminal(tab as unknown as vscode.Terminal)?.agentType).toBe('claude');
  });
});
