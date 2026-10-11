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

/** Commands the panel ran, and the notifications it showed. */
const commandCalls: unknown[][] = [];
const notices: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(win as any).showInformationMessage = (m: string) => { notices.push(m); return Promise.resolve(undefined); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(win as any).showWarningMessage = (m: string) => { notices.push(m); return Promise.resolve(undefined); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(win as any).showErrorMessage = (m: string) => { notices.push(m); return Promise.resolve(undefined); };

/** The one terminal-focus listener registerAgentPanel subscribes. */
let onActiveTerminal: (() => void) | undefined;
win.onDidChangeActiveTerminal = (cb) => { onActiveTerminal = cb; return { dispose() { /* noop */ } }; };

mock.module('vscode', () => vscodeDouble({
  window: win,
  workspace: { workspaceFolders: undefined, createFileSystemWatcher: () => ({
    onDidChange() { /* noop */ }, onDidCreate() { /* noop */ }, onDidDelete() { /* noop */ }, dispose() { /* noop */ },
  }) },
  commands: {
    executeCommand: (...args: unknown[]) => {
      commandCalls.push(args);
      return Promise.resolve(args[0] === 'agents.resumeSession'
        ? { status: 'opened', terminalId: null, reason: '→ VSCodium window "svatlas", new tab "CC - Merge guard"' }
        : undefined);
    },
  },
  Uri: { joinPath: () => ({ toString: () => '' }), file: (p: string) => ({ fsPath: p }), parse: (p: string) => ({ toString: () => p }) },
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
  EventEmitter: class { fire() { /* noop */ } event = () => ({ dispose() { /* noop */ } }); },
}));

const terminals = await import('./terminals.vscode');
const panel = await import('./agentPanel.vscode');
const { sessionPresentationStore } = await import('../core/sessionPresentationStore');
const { planSessionStreamRebinds } = await import('../core/sessionIdHydrate');
const { formatAgentStatusBarText } = await import('../core/statusIdentity');

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
    sessionPresentationStore.clear();
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

  test('two A tabs keep the focused terminal subject on its exact tab when that tab rebinds to B', () => {
    const sessionA = '11111111-1111-4111-8111-111111111111';
    const sessionB = '22222222-2222-4222-8222-222222222222';
    const tabId = 'CC-subject-reused';
    const terminal = agentTab(tabId, sessionA, 'worker');
    agentTab('CC-subject-other-a', sessionA, 'worker');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.registerAgentPanel(context as any);
    win.activeTerminal = terminal;
    onActiveTerminal!();
    expect(panel.currentAgentPanelSubject()?.sessionId).toBe(sessionA);

    const observerTerminals = [{ device: 'desktop', terminalId: tabId }];
    sessionPresentationStore.apply({
      v: 1,
      type: 'reset',
      streamId: 'rebind', sequence: 1, capturedAt: 100, scope: 'worker', attention: [],
      agents: [{ rowKey: 'a', sourceDevice: 'worker', machine: 'worker', sessionId: sessionA, startedAtMs: 100, observerTerminals }],
    });
    const entry = terminals.getById(tabId)!;
    const tabs = () => terminals.getAllTerminals()
      .filter((candidate) => candidate.id === tabId || candidate.id === 'CC-subject-other-a')
      .map((candidate) => ({ id: candidate.id, host: candidate.host, sessionId: candidate.sessionId }));

    // B appears before A has left the live projection. The stream join is
    // ambiguous, so the registry and both consumers remain on A.
    sessionPresentationStore.apply({
      v: 1, type: 'agent.upsert', streamId: 'rebind', sequence: 2, capturedAt: 200, scope: 'worker', rowKey: 'b',
      agent: { rowKey: 'b', sourceDevice: 'worker', machine: 'worker', sessionId: sessionB, startedAtMs: 200, observerTerminals },
    });
    expect(planSessionStreamRebinds(tabs(), 'desktop', { localHostname: 'desktop' })).toEqual([]);
    expect(panel.currentAgentPanelSubject()?.sessionId).toBe(sessionA);

    // Removing live A makes B the sole owner. Applying that plan to T1 must
    // update the sidebar via T1's identity even though T2 still carries A.
    sessionPresentationStore.apply({
      v: 1, type: 'agent.remove', streamId: 'rebind', sequence: 3, capturedAt: 300, scope: 'worker', rowKey: 'a',
    });
    const plan = planSessionStreamRebinds(
      tabs(),
      'desktop',
      { localHostname: 'desktop' },
    );
    expect(plan).toEqual([{ id: tabId, canonicalId: sessionB }]);
    terminals.setSessionId(terminal, plan[0]!.canonicalId);

    // No second focus event: the same registry entry now drives both consumers.
    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: sessionB, source: 'terminal', hasTerminal: true,
    });
    expect(formatAgentStatusBarText('Claude', undefined, undefined, null, entry.sessionId))
      .toContain(sessionB.slice(0, 8));

    // The historical A row cannot reclaim the terminal.
    sessionPresentationStore.apply({
      v: 1,
      type: 'agent.upsert',
      streamId: 'rebind', sequence: 4, capturedAt: 400, scope: 'worker', rowKey: 'a',
      agent: {
        rowKey: 'a', sourceDevice: 'worker', machine: 'worker', sessionId: sessionA,
        previous: true, startedAtMs: 100, observerTerminals,
      },
    });
    expect(planSessionStreamRebinds(
      tabs(),
      'desktop',
      { localHostname: 'desktop' },
    )).toEqual([]);
    expect(panel.currentAgentPanelSubject()?.sessionId).toBe(sessionB);
    const status = formatAgentStatusBarText('Claude', undefined, undefined, null, entry.sessionId);
    expect(status).toContain(sessionB.slice(0, 8));
    expect(status).not.toContain(sessionA.slice(0, 8));

    // Fleet selection is session-sourced, not terminal-sourced, so selecting A
    // deliberately remains on A and resolves to the other A tab.
    panel.setAgentPanelSubjectFromFleet(sessionA);
    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: sessionA, source: 'fleet', hasTerminal: true,
    });
  });

  test('a Codex tab with no session id yet takes the subject, and a manual id shows through it', () => {
    const claude = agentTab('CC-subject-before-codex', 'session-claude');
    const codex = agentTab('CX-subject-codex', '');
    terminals.getById('CX-subject-codex')!.sessionId = undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.registerAgentPanel(context as any);
    win.activeTerminal = claude;
    onActiveTerminal!();
    expect(panel.currentAgentPanelSubject()?.sessionId).toBe('session-claude');

    // Codex mints its id after launch, so the focused tab has none yet. The
    // sidebar must follow focus to it instead of keeping the Claude session.
    win.activeTerminal = codex;
    onActiveTerminal!();
    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: '', source: 'terminal', hasTerminal: true,
    });

    // agents.setSessionId stamps the id on that tab; the next refresh renders it.
    terminals.setSessionId(codex, 'session-codex', true);
    expect(panel.currentAgentPanelSubject()).toEqual({
      sessionId: 'session-codex', source: 'terminal', hasTerminal: true,
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

// ---------------------------------------------------------------------------
// Focus and ↻ Resume are the one resume action: `agents.resumeSession` with the
// session id (the CLI resolves its device), answered by one notification.
// ---------------------------------------------------------------------------

describe('Focus / ↻ Resume run agents.resumeSession', () => {
  test('both buttons resume the panel\'s session by id and say where it went', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = panel.registerAgentPanel(context as any) as any;
    commandCalls.length = 0;
    notices.length = 0;
    provider.snapshot = { hasTerminal: false, teams: [], fullSessionId: 'session-remote', sessionHost: 'yosemite-m2', sessionTitle: 'Merge guard' };
    await provider.runQuickAction('resumeSubject', undefined, undefined);
    await provider.runQuickAction('focusSubject', undefined, undefined);
    expect(commandCalls).toEqual([
      ['agents.resumeSession', 'session-remote', 'yosemite-m2'],
      ['agents.resumeSession', 'session-remote', 'yosemite-m2'],
    ]);
    expect(notices).toEqual([
      'Opened "Merge guard" (yosemite-m2) in svatlas.',
      'Opened "Merge guard" (yosemite-m2) in svatlas.',
    ]);
  });
});
