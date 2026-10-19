// Answering an ask from a Sessions card (PHNX-4369): the webview's `answer`
// message goes through the REAL registered panel and the real argv boundary to a
// fake `agents` on PATH (testdata/feed-bin/agents), as `handoff.timeout.test.ts`
// does for `sessions`. The card hears back what the CLI said.

import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
const { sessionPresentationStore } = await import('../core/sessionPresentationStore');
const { clearAgentsBinCache } = await import('../core/agentsBin');

const KEY = 'zion/s-ask/g1';
const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); } }; };
registerProjectPanel({ subscriptions: [], globalState: memento(), workspaceState: memento(), extensionUri: { fsPath: '/ext' } } as never);

let send: (msg: unknown) => void = () => undefined;
const posted: { type: string; key?: string; error?: string | null }[] = [];
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
  v: 1, type: 'reset', streamId: 'answer', sequence: 1, capturedAt: 100, scope: 'zion',
  agents: [{ rowKey: 's-ask', sourceDevice: 'zion', machine: 'zion', sessionId: 's-ask', startedAtMs: 100, status: 'input_required' }],
  attention: [{ key: KEY, sessionId: 's-ask', host: 'zion', kind: 'question', state: 'open', openedAt: '2026-10-14T00:00:00Z', urgency: 'urgent',
    question: { text: 'Publish 1.23.0 to npm?', header: 'Release' }, choices: [{ id: 'yes-publish-from-zion', label: 'Yes, publish from zion' }] }],
} as never);

const answered = async () => {
  for (let i = 0; i < 200 && !posted.some((m) => m.type === 'answered'); i++) await new Promise((r) => setTimeout(r, 25));
  return posted.find((m) => m.type === 'answered');
};

let dir = '';
let log = '';
const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL, mode: process.env.FEED_STUB_MODE };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feed-answer-'));
  log = join(dir, 'argv.log');
  process.env.PATH = `${join(import.meta.dir, 'testdata', 'feed-bin')}:${saved.PATH ?? ''}`;
  process.env.SHELL = '/bin/sh';
  process.env.FEED_STUB_LOG = log;
  delete process.env.FEED_STUB_MODE;
  posted.length = 0;
  clearAgentsBinCache();
});
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.SHELL === undefined) delete process.env.SHELL; else process.env.SHELL = saved.SHELL;
  delete process.env.FEED_STUB_LOG;
  if (saved.mode === undefined) delete process.env.FEED_STUB_MODE; else process.env.FEED_STUB_MODE = saved.mode;
  clearAgentsBinCache();
  rmSync(dir, { recursive: true, force: true });
});
const argvs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('a choice is one `agents feed answer <key> --choice <id> --json`, and the card hears it was delivered', async () => {
  send({ type: 'answer', key: KEY, choice: 'yes-publish-from-zion' });
  expect(await answered()).toEqual({ type: 'answered', key: KEY, error: null });
  expect(argvs()).toEqual([['feed', 'answer', KEY, '--choice', 'yes-publish-from-zion', '--json']]);
});

test('typed words are --text; Try another way sends its canned words the same way', async () => {
  const { TRY_ANOTHER_WAY } = await import('../core/projectPanel');
  send({ type: 'answer', key: KEY, text: TRY_ANOTHER_WAY });
  await answered();
  expect(argvs()).toEqual([['feed', 'answer', KEY, '--text', TRY_ANOTHER_WAY, '--json']]);
});

test('a delivery the CLI could not make shows its reason on the card, whether it exits 0 or 1', async () => {
  process.env.FEED_STUB_MODE = 'failed';
  send({ type: 'answer', key: KEY, choice: 'yes-publish-from-zion' });
  expect((await answered())?.error).toBe('Not delivered: the terminal is gone');
  posted.length = 0;
  process.env.FEED_STUB_MODE = 'error';
  send({ type: 'answer', key: KEY, choice: 'yes-publish-from-zion' });
  expect((await answered())?.error).toBe('Not delivered: unknown attention key');
});

test('a key the stream does not show open runs nothing', async () => {
  send({ type: 'answer', key: 'zion/other/g9', choice: 'x' });
  expect((await answered())?.error).toBe('This ask is no longer open.');
  expect(argvs()).toEqual([]);
});
