// The Resume Session picker's lifecycle: whatever lands after the picker closes
// (a slow project lookup, a stream update) draws nothing and arms no timer.

import { describe, expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

/** A QuickPick double that records what the picker writes to it after it closes. */
function fakeQuickPick() {
  const accept: Array<() => void> = [];
  const hide: Array<() => void> = [];
  let disposed = false;
  const writesAfterDispose: string[] = [];
  const state: Record<string, unknown> = { items: [], activeItems: [], selectedItems: [] };
  const qp = new Proxy(state, {
    set(target, key, value) {
      if (disposed) writesAfterDispose.push(String(key));
      target[key as string] = value;
      return true;
    },
    get(target, key) {
      if (key === 'onDidAccept') return (cb: () => void) => { accept.push(cb); return { dispose() {} }; };
      if (key === 'onDidHide') return (cb: () => void) => { hide.push(cb); return { dispose() {} }; };
      if (key === 'show') return () => {};
      if (key === 'hide') return () => { for (const cb of hide) cb(); };
      if (key === 'dispose') return () => { disposed = true; };
      return target[key as string];
    },
  }) as unknown as { hide(): void };
  return { qp, writesAfterDispose, isDisposed: () => disposed };
}

let current: ReturnType<typeof fakeQuickPick> | undefined;
mock.module('vscode', () => vscodeDouble({
  window: {
    createQuickPick: () => { current = fakeQuickPick(); return current.qp; },
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    terminals: [],
    activeTerminal: undefined,
    onDidChangeActiveTerminal: () => ({ dispose() {} }),
    onDidCloseTerminal: () => ({ dispose() {} }),
    onDidOpenTerminal: () => ({ dispose() {} }),
  },
  workspace: { workspaceFolders: [], name: 'agi-ext', onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
  commands: { executeCommand: () => Promise.resolve(undefined) },
}));

const { showResumePicker, notifyResumePickerUpdate } = await import('./resumeSession.vscode');
const { sessionStreamDemand } = await import('../monitor/sessionDemand');

describe('Resume Session picker lifecycle', () => {
  test('closing before the project lookup resolves leaves no pending timer and no draw', async () => {
    let resolveProjects!: (names: string[]) => void;
    const projects = new Promise<string[]>((r) => { resolveProjects = r; });
    const realSetTimeout = globalThis.setTimeout;
    let timersArmedAfterClose = 0;
    let closed = false;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (closed) timersArmedAfterClose++;
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;
    try {
      const picker = showResumePicker({ projects: () => projects });
      expect(sessionStreamDemand.demand).toBe(true);
      // Escape: the quick pick hides before the lookup comes back.
      current!.qp.hide();
      await picker;
      closed = true;
      expect(current!.isDisposed()).toBe(true);
      expect(sessionStreamDemand.demand).toBe(false);
      // The lookup lands late, and a stream update arrives too.
      resolveProjects(['agi-ui']);
      await projects;
      await new Promise((r) => realSetTimeout(r, 0));
      notifyResumePickerUpdate();
      expect(current!.writesAfterDispose).toEqual([]);
      expect(timersArmedAfterClose).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
