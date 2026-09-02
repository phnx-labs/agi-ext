import { describe, expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble({ window: {} }));

const { restoreTerminals } = await import('./prewarm.vscode');

describe('restoreTerminals', () => {
  test('reopens only the residual crash mappings — skips reaped and already-restored sessions', async () => {
    const updates: Array<[string, unknown]> = [];
    const opened: Array<{ id: string; terminalId?: string; agent: string }> = [];
    const values = new Map<string, unknown>([
      ['prewarm.cleanShutdown', false],
      ['prewarm.mappings', [
        // Residual: in the CLI list, and NOT already reopened by restoreAgentTerminals.
        {
          terminalId: 'CL42',
          sessionId: 'session-live',
          agentType: 'claude',
          createdAt: 100,
          workingDirectory: '/workspace/project',
        },
        // Reaped: no longer in the CLI session list -> must not be resurrected.
        {
          terminalId: 'CD17',
          sessionId: 'session-reaped',
          agentType: 'codex',
          createdAt: 1,
          workingDirectory: '/workspace/old',
        },
        // Already restored by restoreAgentTerminals (its terminalId is tracked)
        // -> must be skipped so we don't double-open + double-resume it.
        {
          terminalId: 'CL08',
          sessionId: 'session-doubled-by-tid',
          agentType: 'claude',
          createdAt: 50,
          workingDirectory: '/workspace/a',
        },
        // Already restored under a different terminalId, same session id
        // -> the sessionId guard must still skip it.
        {
          terminalId: 'CL99',
          sessionId: 'session-doubled-by-sid',
          agentType: 'claude',
          createdAt: 60,
          workingDirectory: '/workspace/b',
        },
      ]],
    ]);
    const context = {
      // PHNX-3768: crash-recovery state is keyed to workspaceState, not the
      // machine-global globalState, so a window can only touch its own workspace.
      workspaceState: {
        get<T>(key: string, fallback?: T): T {
          return (values.has(key) ? values.get(key) : fallback) as T;
        },
        async update(key: string, value: unknown): Promise<void> {
          values.set(key, value);
          updates.push([key, value]);
        },
      },
    } as any;

    const restored = await restoreTerminals(context, {
      async listRestorableSessionIds() {
        // Every candidate except the reaped one is still a real session.
        return new Set(['session-live', 'session-doubled-by-tid', 'session-doubled-by-sid']);
      },
      trackedKeys() {
        return {
          terminalIds: new Set(['CL08']),
          sessionIds: new Set(['session-doubled-by-sid']),
        };
      },
      async openAgentSessionTerminal(_context, session) {
        opened.push(session);
        return true;
      },
    });

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

  // PHNX-3768 regression: the crash-recovery store is per-workspace, so a window
  // activating for workspace A must NEVER read, reopen, or clear workspace B's
  // mappings. Under the old machine-global globalState, A's activation resurrected
  // every one of B's sessions into A's window and wiped B's state in the same pass
  // — the N-window resume-storm that crashed the host. Two independent contexts
  // (as workspaceState gives each window) must stay fully isolated.
  test('a window only restores + clears its OWN workspace — no cross-workspace bleed', async () => {
    const makeContext = (initial: Array<[string, unknown]>) => {
      const values = new Map<string, unknown>(initial);
      return {
        values,
        ctx: {
          workspaceState: {
            get<T>(key: string, fallback?: T): T {
              return (values.has(key) ? values.get(key) : fallback) as T;
            },
            async update(key: string, value: unknown): Promise<void> {
              values.set(key, value);
            },
          },
        } as any,
      };
    };

    const workspaceB = makeContext([
      ['prewarm.cleanShutdown', false],
      ['prewarm.mappings', [
        { terminalId: 'B-CL1', sessionId: 'b-session-1', agentType: 'claude', createdAt: 10, workingDirectory: '/workspace/b' },
        { terminalId: 'B-CL2', sessionId: 'b-session-2', agentType: 'codex', createdAt: 11, workingDirectory: '/workspace/b' },
      ]],
    ]);

    const workspaceA = makeContext([
      ['prewarm.cleanShutdown', false],
      ['prewarm.mappings', [
        { terminalId: 'A-CL1', sessionId: 'a-session-1', agentType: 'claude', createdAt: 20, workingDirectory: '/workspace/a' },
      ]],
    ]);

    const opened: string[] = [];
    const restored = await restoreTerminals(workspaceA.ctx, {
      // The machine-wide CLI list contains BOTH workspaces' live sessions.
      async listRestorableSessionIds() {
        return new Set(['a-session-1', 'b-session-1', 'b-session-2']);
      },
      trackedKeys: () => ({ terminalIds: new Set<string>(), sessionIds: new Set<string>() }),
      async openAgentSessionTerminal(_context, session) {
        opened.push(session.id);
        return true;
      },
    });

    // Only workspace A's session reopens — B's live sessions are never touched.
    expect(restored).toBe(1);
    expect(opened).toEqual(['a-session-1']);
    // Workspace B's crash-recovery state is left completely intact.
    expect(workspaceB.values.get('prewarm.mappings')).toHaveLength(2);
    expect(workspaceB.values.get('prewarm.cleanShutdown')).toBe(false);
  });
});
