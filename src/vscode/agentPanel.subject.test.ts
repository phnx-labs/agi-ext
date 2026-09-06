// The sidebar's subject model (PHNX-3939 follow-up).
//
// One preview, two triggers, LAST WINS:
//   an agent terminal takes focus   -> onDidChangeActiveTerminal
//   a Fleet row is clicked          -> 'session.select' -> setAgentPanelSubjectFromFleet
//
// Driven through the REAL registration path: `registerAgentPanel` subscribes the
// terminal listener, and the test invokes the listener VS Code would have called.
// The subject is presentation state only, so the assertions are about which
// session the panel resolves to — never about anything persisted.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

const win: {
  activeTerminal: unknown;
  terminals: unknown[];
  onDidChangeActiveTerminal: (cb: () => void) => { dispose(): void };
  onDidCloseTerminal: (cb: () => void) => { dispose(): void };
  onDidOpenTerminal: (cb: () => void) => { dispose(): void };
  registerWebviewViewProvider: (id: string, provider: unknown, opts?: unknown) => { dispose(): void };
  createOutputChannel: (name: string) => unknown;
} = {
  activeTerminal: undefined,
  terminals: [],
  onDidChangeActiveTerminal: () => ({ dispose() { /* noop */ } }),
  onDidCloseTerminal: () => ({ dispose() { /* noop */ } }),
  onDidOpenTerminal: () => ({ dispose() { /* noop */ } }),
  registerWebviewViewProvider: () => ({ dispose() { /* noop */ } }),
  createOutputChannel: () => ({ appendLine() { /* noop */ }, dispose() { /* noop */ } }),
};

/** The one terminal-focus listener registerAgentPanel subscribes. */
let onActiveTerminal: (() => void) | undefined;
win.onDidChangeActiveTerminal = (cb) => { onActiveTerminal = cb; return { dispose() { /* noop */ } }; };

mock.module('vscode', () => vscodeDouble({
  window: win,
  workspace: { workspaceFolders: undefined, createFileSystemWatcher: () => ({
    onDidChange() { /* noop */ }, onDidCreate() { /* noop */ }, onDidDelete() { /* noop */ }, dispose() { /* noop */ },
  }) },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  Uri: { joinPath: () => ({ toString: () => '' }), file: (p: string) => ({ fsPath: p }), parse: (p: string) => ({ toString: () => p }) },
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
  EventEmitter: class { fire() { /* noop */ } event = () => ({ dispose() { /* noop */ } }); },
}));

const terminals = await import('./terminals.vscode');
const panel = await import('./agentPanel.vscode');

const CLAUDE_CONFIG = { title: 'Claude', prefix: 'CC', icon: 'claude.png', commandId: 'agents.newClaude' };

let pidSeq = 500;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function agentTab(id: string, sessionId: string, host?: string): any {
  const terminal = { name: id, processId: Promise.resolve(++pidSeq), exitStatus: undefined, creationOptions: {}, show() { /* noop */ } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  terminals.register(terminal as any, id, CLAUDE_CONFIG as any, pidSeq);
  const entry = terminals.getById(id);
  if (entry) {
    entry.sessionId = sessionId;
    entry.agentType = 'claude';
    if (host) entry.host = host;
  }
  return terminal;
}

const context = {
  subscriptions: [] as { dispose(): void }[],
  extensionUri: { toString: () => '' },
  globalState: { get: () => undefined, update: () => Promise.resolve() },
  workspaceState: { get: () => undefined, update: () => Promise.resolve() },
};

describe('sidebar subject — last of { focused terminal, clicked Fleet row }', () => {
  beforeEach(() => {
    panel.clearAgentPanelSubject();
    win.activeTerminal = undefined;
  });

  test('focusing an agent terminal makes it the subject', () => {
    const a = agentTab('CC-subject-a', 'session-a');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.registerAgentPanel(context as any);
    expect(onActiveTerminal).toBeDefined();

    win.activeTerminal = a;
    onActiveTerminal!();

    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: 'session-a', source: 'terminal', hasTerminal: true,
    });
  });

  test('a Fleet row click wins over the focused terminal', () => {
    const a = agentTab('CC-subject-b', 'session-b');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.registerAgentPanel(context as any);
    win.activeTerminal = a;
    onActiveTerminal!();
    expect(panel.currentAgentPanelSubject()?.sessionId).toBe('session-b');

    // The user clicks a DIFFERENT session in the Fleet list — one with no tab here.
    panel.setAgentPanelSubjectFromFleet('session-remote', 'yosemite-m2');

    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: 'session-remote', host: 'yosemite-m2', source: 'fleet', hasTerminal: false,
    });
    // The terminal is still the focused one; the subject just isn't it any more.
    expect(win.activeTerminal).toBe(a);
  });

  test('focusing a terminal again wins back over the Fleet selection', () => {
    const a = agentTab('CC-subject-c', 'session-c');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.registerAgentPanel(context as any);
    panel.setAgentPanelSubjectFromFleet('session-remote', 'yosemite-m2');
    expect(panel.currentAgentPanelSubject()?.source).toBe('fleet');

    win.activeTerminal = a;
    onActiveTerminal!();

    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: 'session-c', source: 'terminal', hasTerminal: true,
    });
  });

  test('a Fleet subject that DOES have a local tab binds to it, so Focus and reply work', () => {
    agentTab('CC-subject-d', 'session-d');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.registerAgentPanel(context as any);

    panel.setAgentPanelSubjectFromFleet('session-d');

    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: 'session-d', source: 'fleet', hasTerminal: true,
    });
  });

  test('a terminal subject whose tab is gone falls back to whatever is focused', () => {
    const a = agentTab('CC-subject-e', 'session-e');
    const b = agentTab('CC-subject-f', 'session-f');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.registerAgentPanel(context as any);
    win.activeTerminal = a;
    onActiveTerminal!();
    expect(panel.currentAgentPanelSubject()?.sessionId).toBe('session-e');

    // The subject's tab closes and focus moves to the other tab. The panel must
    // NOT pin a dead tab.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    terminals.unregister(a as any);
    win.activeTerminal = b;

    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: 'session-f', source: 'terminal', hasTerminal: true,
    });
  });

  test('a Fleet subject SURVIVES its device going quiet — it is not a terminal lookup', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.registerAgentPanel(context as any);
    panel.setAgentPanelSubjectFromFleet('session-ghost', 'mac-mini');
    // No terminal anywhere matches it, and nothing is focused: the panel still
    // renders that session from the stream row rather than falling back to empty.
    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: 'session-ghost', host: 'mac-mini', source: 'fleet', hasTerminal: false,
    });
  });

  test('an empty session id is ignored rather than blanking the subject', () => {
    const a = agentTab('CC-subject-g', 'session-g');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.registerAgentPanel(context as any);
    win.activeTerminal = a;
    onActiveTerminal!();

    panel.setAgentPanelSubjectFromFleet('   ');

    expect(panel.currentAgentPanelSubject()?.sessionId).toBe('session-g');
  });

  test('no focus and no click means no subject at all', () => {
    expect(panel.currentAgentPanelSubject()).toBeUndefined();
  });
});
