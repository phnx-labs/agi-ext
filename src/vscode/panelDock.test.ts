// A panel pops out into an editor tab moved to a new window, draws in one place at a
// time, and comes back to its sidebar when that tab closes (owner, 2026-10-18: keep
// the panels on another monitor).

import { expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

type Listener = (e?: unknown) => void;
function emitter() {
  const ls = new Set<Listener>();
  const event = (l: Listener) => { ls.add(l); return { dispose: () => { ls.delete(l); } }; };
  return { event, fire: (e?: unknown) => { for (const l of [...ls]) l(e); }, count: () => ls.size };
}
function webview() {
  const msg = emitter();
  return { options: {}, html: '', onDidReceiveMessage: msg.event, send: msg.fire, listeners: msg.count };
}
function sidebarView() {
  const dispose = emitter();
  return { webview: webview(), visible: true, show() { /* noop */ }, onDidChangeVisibility: emitter().event, onDidDispose: dispose.event };
}
function tab() {
  const dispose = emitter();
  const state = emitter();
  const t = {
    webview: webview(), visible: true, title: '', revealed: 0,
    reveal() { t.revealed++; },
    onDidChangeViewState: (l: Listener) => state.event(l),
    onDidDispose: dispose.event,
    dispose: () => dispose.fire(),
  };
  return t;
}

const commands = new Map<string, () => unknown>();
const ran: string[] = [];
let serializer: { deserializeWebviewPanel(t: unknown): Promise<void> } | undefined;
const created: ReturnType<typeof tab>[] = [];
mock.module('vscode', () => vscodeDouble({
  window: {
    createWebviewPanel: () => { const t = tab(); created.push(t); return t; },
    registerWebviewPanelSerializer: (_type: string, s: typeof serializer) => { serializer = s; return { dispose() { /* noop */ } }; },
  },
  commands: {
    registerCommand: (id: string, cb: () => unknown) => { commands.set(id, cb); return { dispose() { /* noop */ } }; },
    executeCommand: async (id: string) => { ran.push(id); },
  },
}));

const { PanelDock } = await import('./panelDock.vscode');

function setup() {
  const drawn: { host: { webview: unknown }; stopped: boolean }[] = [];
  const dock = new PanelDock({
    viewType: 'test.panel', command: 'test.popOut', title: 'Project',
    attach: (host) => { const d = { host, stopped: false }; drawn.push(d); return { dispose: () => { d.stopped = true; } }; },
  });
  dock.register({ subscriptions: [] } as never);
  const view = sidebarView();
  dock.resolveSidebar(view as never);
  return { dock, drawn, view };
}

test('Move into New Window draws the panel in a tab moved to its own window, and the sidebar only offers it back', async () => {
  created.length = 0; ran.length = 0;
  const { drawn, view } = setup();
  expect(drawn.map((d) => d.host)).toEqual([view]);

  await commands.get('test.popOut')!();
  const t = created[0]!;
  expect(ran).toEqual(['workbench.action.moveEditorToNewWindow']);
  expect(drawn).toHaveLength(2);
  expect(drawn[0]!.stopped).toBe(true);
  expect(drawn[1]!.host.webview).toBe(t.webview);
  expect(t.title).toBe('Project');
  expect(view.webview.html).toContain('Project is open in its own window');

  // A second press brings the window forward instead of opening another.
  await commands.get('test.popOut')!();
  expect(created).toHaveLength(1);
  expect(t.revealed).toBe(1);
});

test('closing the window, or Bring it back, draws the panel in the sidebar again', async () => {
  created.length = 0;
  const { drawn, view } = setup();
  await commands.get('test.popOut')!();
  view.webview.send({ type: 'dockBack' });
  expect(drawn).toHaveLength(3);
  expect(drawn[1]!.stopped).toBe(true);
  expect(drawn[2]!.host).toBe(view);
  expect(drawn[2]!.stopped).toBe(false);
  // The placeholder's listener went with it: a second click closes nothing.
  expect(view.webview.listeners()).toBe(0);
});

test('a window VS Code restores after a restart is drawn into, not the sidebar', async () => {
  const { drawn, view } = setup();
  const restored = tab();
  await serializer!.deserializeWebviewPanel(restored);
  expect(drawn.at(-1)!.host.webview).toBe(restored.webview);
  expect(drawn[0]!.stopped).toBe(true);
  expect(view.webview.html).toContain('open in its own window');
});

test('a description names the project in the tab title', async () => {
  created.length = 0;
  const { drawn } = setup();
  await commands.get('test.popOut')!();
  (drawn[1]!.host as { description?: string }).description = 'rush';
  expect(created[0]!.title).toBe('Project · rush');
});
