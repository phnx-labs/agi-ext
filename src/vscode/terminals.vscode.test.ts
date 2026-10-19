import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type * as vscode from 'vscode';
import { vscodeDouble } from '../testing/vscodeDouble';

// Only the vscode surface these terminals paths touch; API constants come from
// the shared double so a suite run does not depend on file load order.
mock.module('vscode', () => vscodeDouble({
  window: {
    terminals: [],
    onDidCloseTerminal: () => ({ dispose: () => {} }),
    onDidOpenTerminal: () => ({ dispose: () => {} }),
    onDidChangeActiveTerminal: () => ({ dispose: () => {} }),
    onDidChangeTabs: () => ({ dispose: () => {} }),
  },
  workspace: { workspaceFolders: undefined },
  TabInputTerminal: class {},
}));




const t = await import('./terminals.vscode');

function fakeTerm(name: string): vscode.Terminal {
  return { name, processId: Promise.resolve(undefined) } as unknown as vscode.Terminal;
}

function scannedTerm(name: string, processId: Promise<number | undefined>): vscode.Terminal {
  return {
    name,
    processId,
    disposed: 0,
    dispose() { (this as { disposed: number }).disposed++; },
    exitStatus: undefined,
    creationOptions: { env: { AGENT_TERMINAL_ID: 'CC-restored-1' } },
  } as unknown as vscode.Terminal;
}

function fakeAgentConfig() {
  return {
    title: 'Claude',
    command: 'claude',
    icon: undefined,
    prefix: 'CC',
    iconPath: undefined,
  } as any;
}

beforeEach(() => {
  t.clear();
});

afterEach(() => {
  // Terminals tests mock vscode and sibling modules globally; restore so later
  // test files (htmlReader, session-read, etc.) load the real modules.
  mock.restore();
});

// ─── Bug proofs ───────────────────────────────────────────────────────────────

describe('BUG C: setSessionId clears autoLabel on session change', () => {
  test('autoLabel is cleared by setSessionId when an existing session changes', () => {
    const term = fakeTerm('CC-bug-c');
    t.register(term, 'CC-001', fakeAgentConfig(), undefined);
    t.setSessionId(term, 'old-session-id-aaaa');

    // Simulate a label being set after first session adoption
    t.setAutoLabel(term, 'fix the auth bug');

    const before = t.getByTerminal(term);
    expect(before?.autoLabel).toBe('fix the auth bug');

    // Session changes (e.g. /continue creates a new session)
    t.setSessionId(term, 'new-session-id-aaaa');

    const after = t.getByTerminal(term);
    expect(after?.autoLabel).toBeUndefined();
    expect(after?.sessionId).toBe('new-session-id-aaaa');
  });
});

describe('automatic-label persistence', () => {
  test('buildPersistedSessions keeps the automatic label provenance', () => {
    const term = fakeTerm('CC-auto-label');
    t.register(term, 'CC-auto', fakeAgentConfig(), undefined);
    t.setSessionId(term, 'session-auto');
    t.setAutoLabel(term, 'Release the project');

    expect(t.buildPersistedSessions()).toEqual([
      expect.objectContaining({
        terminalId: 'CC-auto',
        label: undefined,
        autoLabel: 'Release the project',
      }),
    ]);
  });

  test('buildPersistedSessions keeps an opaque recovery harness separate from built-in identity', () => {
    const term = fakeTerm('Muse recovery');
    t.register(term, 'RX-opaque', { ...fakeAgentConfig(), title: 'muse', prefix: 'rx' }, undefined);
    t.setSessionId(term, 'session-muse');
    t.setHost(term, 'yosemite-m3');
    t.setRecoveryAgent(term, 'muse');

    expect(t.buildPersistedSessions()).toEqual([
      expect.objectContaining({
        terminalId: 'RX-opaque',
        prefix: 'rx',
        sessionId: 'session-muse',
        host: 'yosemite-m3',
        agentType: undefined,
        recoveryAgent: 'muse',
      }),
    ]);
  });
});

describe('reload scan ignores terminal editor ghosts', () => {
  test('an agent terminal without a backing process is closed and left for persisted restore', async () => {
    const vscode = await import('vscode');
    const ghost = scannedTerm('CC — stale restored editor', Promise.resolve(undefined));
    (vscode.window.terminals as vscode.Terminal[]) = [ghost];

    const count = await t.scanExisting(() => fakeAgentConfig());

    expect(count).toBe(0);
    expect(t.getByTerminal(ghost)).toBeUndefined();
    expect((ghost as unknown as { disposed: number }).disposed).toBe(1);
  });

  test('a terminal still starting (processId never settles) neither holds the restore nor is closed', async () => {
    const vscode = await import('vscode');
    const slow = scannedTerm('CC — slow to start', new Promise<number | undefined>(() => {}));
    (vscode.window.terminals as vscode.Terminal[]) = [slow];

    expect(await t.scanExisting(() => fakeAgentConfig())).toBe(0);
    expect(t.getByTerminal(slow)).toBeUndefined();
    expect((slow as unknown as { disposed: number }).disposed).toBe(0);
  }, 20_000);
});

describe('adopting a tab the editor opens after activation', () => {
  function openedTerm(env: Record<string, string>): vscode.Terminal {
    return {
      name: 'CC',
      processId: Promise.resolve(4321),
      exitStatus: undefined,
      creationOptions: { env },
    } as unknown as vscode.Terminal;
  }

  test('the session id and version it was launched with come back from its env', async () => {
    const term = openedTerm({ AGENT_TERMINAL_ID: 'CC-late-1', AGENT_SESSION_ID: 'session-from-env', AGENT_VERSION: '2.1.113' });

    expect(await t.adopt(term, () => fakeAgentConfig(), { persistedSessions: [] })).toBe(true);

    const entry = t.getByTerminal(term);
    expect(entry?.id).toBe('CC-late-1');
    expect(entry?.sessionId).toBe('session-from-env');
    expect(entry?.version).toBe('2.1.113');
    expect(entry?.agentType).toBe('claude');
  });

  test('a persisted rebinding is newer than the env and wins, with its host', async () => {
    const term = openedTerm({ AGENT_TERMINAL_ID: 'CC-late-2', AGENT_SESSION_ID: 'session-from-env' });

    await t.adopt(term, () => fakeAgentConfig(), {
      persistedSessions: [{ terminalId: 'CC-late-2', prefix: 'cc', sessionId: 'session-rebound', host: 'yosemite-s0' }],
    });

    expect(t.getByTerminal(term)?.sessionId).toBe('session-rebound');
    expect(t.getByTerminal(term)?.host).toBe('yosemite-s0');
  });

  // A window reload revives a tab with its name and its process only: creationOptions
  // comes back with no env and no icon (measured in VSCodium 1.135, 2026-10-19), and
  // a tab named by its session carries no harness text.
  function revivedTerm(name: string, pid: number): vscode.Terminal {
    return { name, processId: Promise.resolve(pid), exitStatus: undefined, creationOptions: {} } as unknown as vscode.Terminal;
  }

  test('a revived tab is found by the shell pid its persisted entry recorded', async () => {
    const term = revivedTerm('Fix the auth bug', 4321);
    const adopted = await t.adopt(term, () => fakeAgentConfig(), {
      persistedSessions: [{ terminalId: 'cl-1760900000000-3', prefix: 'cl', sessionId: 'session-7', host: 'yosemite-s0', autoLabel: 'Fix the auth bug', agentPid: 4321, createdAt: 1 }],
    });

    expect(adopted).toBe(true);
    const entry = t.getByTerminal(term);
    expect(entry?.id).toBe('cl-1760900000000-3');
    expect(entry?.sessionId).toBe('session-7');
    expect(entry?.host).toBe('yosemite-s0');
    expect(entry?.agentType).toBe('claude');
    expect(entry?.label).toBeUndefined();
    expect(entry?.autoLabel).toBe('Fix the auth bug');
  });

  test('a revived tab showing a launch stage does not keep the stage as its name', async () => {
    const term = revivedTerm('New session', 4322);
    await t.adopt(term, () => fakeAgentConfig(), {
      persistedSessions: [{ terminalId: 'cx-1760900000000-4', prefix: 'cx', agentPid: 4322, createdAt: 1 }],
    });

    expect(t.getByTerminal(term)?.label).toBeUndefined();
  });

  test('a revived plain terminal no persisted entry recorded is not an agent tab', async () => {
    const term = revivedTerm('zsh', 999);
    expect(await t.adopt(term, () => fakeAgentConfig(), {
      persistedSessions: [{ terminalId: 'cl-1760900000000-3', prefix: 'cl', agentPid: 4321, createdAt: 1 }],
    })).toBe(false);
  });
});

describe('BUG A: startAutoLabelPoller guard blocks restart once autoLabel is set', () => {
  test('pollFn is never called when autoLabel is already set', async () => {
    const term = fakeTerm('CC-bug-a');
    t.register(term, 'CC-002', fakeAgentConfig(), undefined);

    // Label was set from a previous session
    t.setAutoLabel(term, 'old label from session 1');

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => { pollCount++; });

    // Give the poller time to fire if it were running
    await new Promise(r => setTimeout(r, 50));

    // BUG: pollFn never called — guard `if (entry.autoLabel || entry.label) return` fires
    expect(pollCount).toBe(0);
  });

  test('pollFn IS called when autoLabel is not set', async () => {
    const term = fakeTerm('CC-no-bug');
    t.register(term, 'CC-003', fakeAgentConfig(), undefined);

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => { pollCount++; });

    await new Promise(r => setTimeout(r, 50));

    // Without a label, the poller starts and fires immediately
    expect(pollCount).toBeGreaterThan(0);

    t.stopAutoLabelPoller(term);
  });
});

describe('BUG I: setLabel immediately stops autoLabelPoller', () => {
  test('poller interval is cleared after manual label is set via setLabel', async () => {
    const term = fakeTerm('CC-bug-i');
    t.register(term, 'CC-005', fakeAgentConfig(), undefined);

    let pollCount = 0;
    t.startAutoLabelPoller(term, async () => {
      pollCount++;
      // Simulate the poller setting the autoLabel on first run
      t.setAutoLabel(term, 'auto-generated');
    }, 50);

    await new Promise(r => setTimeout(r, 30));
    expect(pollCount).toBe(1); // immediate fire on start

    // User sets a manual label (Cmd+L), which stops the interval immediately
    const fakeContext = undefined as any;
    await t.setLabel(term, 'manual label', fakeContext);

    const entry = t.getByTerminal(term);
    expect(entry?.autoLabelPollerId).toBeUndefined();

    t.stopAutoLabelPoller(term);
  });
});

// Half of the status-bar identity fix (Defect 2): a harness the CLI records no
// version for (Kimi) must not keep a version left over from a prior binding in the
// same terminal. setVersion(null) has to CLEAR, not be ignored.
describe('setVersion clears the cached version on null or blank', () => {
  test('a null version wipes both version and statusVersion', () => {
    const term = fakeTerm('CC-setver');
    t.register(term, 'CC-ver-1', fakeAgentConfig(), undefined);

    t.setVersion(term, '2.1.218');
    const set = t.getByTerminal(term);
    expect(set?.version).toBe('2.1.218');
    expect(set?.statusVersion).toBe('2.1.218');

    // Re-hydration for a session the CLI has no version for must clear it.
    t.setVersion(term, null);
    const cleared = t.getByTerminal(term);
    expect(cleared?.version).toBeUndefined();
    expect(cleared?.statusVersion).toBeUndefined();
    // Whitespace is a clear too, not a literal value.
    t.setVersion(term, '2.1.218');
    t.setVersion(term, '   ');
    expect(t.getByTerminal(term)?.version).toBeUndefined();
  });
});
