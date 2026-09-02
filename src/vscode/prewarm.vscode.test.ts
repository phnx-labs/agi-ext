import { describe, expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

// `restoreTerminals` takes the workspace path as an injected argument (not read
// from the module-global `vscode.workspace`, whose mock another test file would
// win), so these tests control scoping directly.
mock.module('vscode', () => vscodeDouble({ window: {} }));

const { restoreTerminals } = await import('./prewarm.vscode');

// A Memento double backed by a Map. Real ExtensionContext always carries both
// globalState and workspaceState; the migration path reads globalState, so tests
// must supply it (empty by default = nothing to migrate).
const memento = (initial: Array<[string, unknown]> = [], sink?: Array<[string, unknown]>) => {
  const values = new Map<string, unknown>(initial);
  return {
    values,
    store: {
      get<T>(key: string, fallback?: T): T {
        return (values.has(key) ? values.get(key) : fallback) as T;
      },
      async update(key: string, value: unknown): Promise<void> {
        values.set(key, value);
        sink?.push([key, value]);
      },
    },
  };
};

describe('restoreTerminals', () => {
  test('reopens only the residual crash mappings — skips reaped and already-restored sessions', async () => {
    const updates: Array<[string, unknown]> = [];
    const ws = memento([
      ['prewarm.cleanShutdown', false],
      ['prewarm.mappings', [
        // Residual: in the CLI list, and NOT already reopened by restoreAgentTerminals.
        { terminalId: 'CL42', sessionId: 'session-live', agentType: 'claude', createdAt: 100, workingDirectory: '/workspace/project' },
        // Reaped: no longer in the CLI session list -> must not be resurrected.
        { terminalId: 'CD17', sessionId: 'session-reaped', agentType: 'codex', createdAt: 1, workingDirectory: '/workspace/old' },
        // Already restored by restoreAgentTerminals (its terminalId is tracked)
        // -> must be skipped so we don't double-open + double-resume it.
        { terminalId: 'CL08', sessionId: 'session-doubled-by-tid', agentType: 'claude', createdAt: 50, workingDirectory: '/workspace/a' },
        // Already restored under a different terminalId, same session id
        // -> the sessionId guard must still skip it.
        { terminalId: 'CL99', sessionId: 'session-doubled-by-sid', agentType: 'claude', createdAt: 60, workingDirectory: '/workspace/b' },
      ]],
    ], updates);
    const opened: Array<{ id: string; terminalId?: string; agent: string }> = [];
    const context = {
      // PHNX-3768: crash-recovery state is keyed to workspaceState, not the
      // machine-global globalState, so a window can only touch its own workspace.
      workspaceState: ws.store,
      globalState: memento().store, // no pre-upgrade data to migrate
    } as any;

    const restored = await restoreTerminals(context, {
      async listRestorableSessionIds() {
        // Every candidate except the reaped one is still a real session.
        return new Set(['session-live', 'session-doubled-by-tid', 'session-doubled-by-sid']);
      },
      trackedKeys() {
        return { terminalIds: new Set(['CL08']), sessionIds: new Set(['session-doubled-by-sid']) };
      },
      async openAgentSessionTerminal(_context, session) {
        opened.push(session);
        return true;
      },
    }, '/workspace/project');

    // Only the residual session opens; reaped + both already-tracked are skipped.
    expect(restored).toBe(1);
    expect(opened).toEqual([{
      id: 'session-live',
      shortId: 'session-',
      agent: 'claude',
      cwd: '/workspace/project',
      terminalId: 'CL42',
    }]);
    expect(updates).toContainEqual(['prewarm.mappings', []]);
  });

  test('no-op when no workspace folder is open (mirrors restoreAgentTerminals bail)', async () => {
    let listCalled = false;
    const context = { workspaceState: memento().store, globalState: memento().store } as any;
    const restored = await restoreTerminals(context, {
      async listRestorableSessionIds() { listCalled = true; return new Set(); },
      trackedKeys: () => ({ terminalIds: new Set<string>(), sessionIds: new Set<string>() }),
      async openAgentSessionTerminal() { return true; },
    }, undefined);
    // Bails before doing any work — no restorable lookup, nothing reopened.
    expect(restored).toBe(0);
    expect(listCalled).toBe(false);
  });

  // PHNX-3768 regression: the crash-recovery store is per-workspace, so a window
  // activating for workspace A must NEVER read, reopen, or clear workspace B's
  // mappings. Under the old machine-global globalState, A's activation resurrected
  // every one of B's sessions into A's window and wiped B's state in the same pass
  // — the N-window resume-storm that crashed the host. Two independent contexts
  // (as workspaceState gives each window) must stay fully isolated.
  test('a window only restores + clears its OWN workspace — no cross-workspace bleed', async () => {
    const workspaceB = memento([
      ['prewarm.cleanShutdown', false],
      ['prewarm.mappings', [
        { terminalId: 'B-CL1', sessionId: 'b-session-1', agentType: 'claude', createdAt: 10, workingDirectory: '/workspace/b' },
        { terminalId: 'B-CL2', sessionId: 'b-session-2', agentType: 'codex', createdAt: 11, workingDirectory: '/workspace/b' },
      ]],
    ]);
    const workspaceA = memento([
      ['prewarm.cleanShutdown', false],
      ['prewarm.mappings', [
        { terminalId: 'A-CL1', sessionId: 'a-session-1', agentType: 'claude', createdAt: 20, workingDirectory: '/workspace/a' },
      ]],
    ]);

    const opened: string[] = [];
    const restored = await restoreTerminals(
      { workspaceState: workspaceA.store, globalState: memento().store } as any,
      {
        // The machine-wide CLI list contains BOTH workspaces' live sessions.
        async listRestorableSessionIds() {
          return new Set(['a-session-1', 'b-session-1', 'b-session-2']);
        },
        trackedKeys: () => ({ terminalIds: new Set<string>(), sessionIds: new Set<string>() }),
        async openAgentSessionTerminal(_context, session) {
          opened.push(session.id);
          return true;
        },
      },
      '/workspace/a',
    );

    // Only workspace A's session reopens — B's live sessions are never touched.
    expect(restored).toBe(1);
    expect(opened).toEqual(['a-session-1']);
    // Workspace B's crash-recovery state is left completely intact.
    expect(workspaceB.values.get('prewarm.mappings')).toHaveLength(2);
    expect(workspaceB.values.get('prewarm.cleanShutdown')).toBe(false);
  });

  // PHNX-3768 upgrade path: a user mid-crash when the extension auto-updated has
  // pending mappings in the OLD machine-global globalState. On first post-upgrade
  // activation, restoreTerminals must fold THIS workspace's slice into workspaceState
  // and honor the old crash flag so the pending restore still happens — while never
  // pulling in another workspace's global mappings.
  test('migrates this workspace\'s slice of pre-upgrade globalState, ignoring other workspaces', async () => {
    const ws = memento(); // fresh: workspaceState has never held these keys
    const global = memento([
      ['prewarm.cleanShutdown', false], // a real pre-upgrade crash
      ['prewarm.mappings', [
        { terminalId: 'A-OLD', sessionId: 'a-old-session', agentType: 'claude', createdAt: 5, workingDirectory: '/workspace/a' },
        // Another workspace's mapping sitting in the shared global store — must NOT migrate.
        { terminalId: 'B-OLD', sessionId: 'b-old-session', agentType: 'codex', createdAt: 6, workingDirectory: '/workspace/b' },
      ]],
    ]);

    const opened: string[] = [];
    const restored = await restoreTerminals(
      { workspaceState: ws.store, globalState: global.store } as any,
      {
        async listRestorableSessionIds() { return new Set(['a-old-session', 'b-old-session']); },
        trackedKeys: () => ({ terminalIds: new Set<string>(), sessionIds: new Set<string>() }),
        async openAgentSessionTerminal(_context, session) { opened.push(session.id); return true; },
      },
      '/workspace/a',
    );

    // The migrated pending session is restored; the other workspace's is untouched.
    expect(restored).toBe(1);
    expect(opened).toEqual(['a-old-session']);
    // Migration is marked done and the old global store is left intact (not cleared).
    expect(ws.values.get('prewarm.migratedFromGlobal')).toBe(true);
    expect(global.values.get('prewarm.mappings')).toHaveLength(2);
  });
});
