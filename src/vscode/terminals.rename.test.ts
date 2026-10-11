// #3019: the extension must NEVER steal focus to rename a tab. Renaming a VS Code
// terminal tab requires focusing it (no rename-without-focus API,
// microsoft/vscode#171175), and the title code ran on every focus change — so a
// rename stole focus and triggered another rename, cycling the active tab with no
// user input. These tests pin the fix: renameTerminal touches ONLY the already-
// focused tab; a background tab defers its title and applies it on next focus.

import { describe, expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

// Mutable focus + a spy for the one command that actually renames a tab.
const win: { activeTerminal: unknown } = { activeTerminal: undefined };
const execCalls: Array<{ cmd: string; arg: unknown }> = [];

mock.module('vscode', () => vscodeDouble({
  window: win,
  commands: {
    executeCommand: (cmd: string, arg: unknown) => {
      execCalls.push({ cmd, arg });
      return Promise.resolve(undefined);
    },
  },
}));

const terminals = await import('./terminals.vscode');

let pidSeq = 100;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeTerminal(): any {
  return { name: 'CC', processId: Promise.resolve(++pidSeq), exitStatus: undefined };
}

const RENAME = 'workbench.action.terminal.renameWithArg';

describe('renameTerminal never steals focus (#3019)', () => {
  test('a background tab is deferred, not renamed — no focus-stealing command fires', async () => {
    const focused = fakeTerminal();
    const background = fakeTerminal();
    terminals.register(focused, 'cc-f1', null, 1);
    terminals.register(background, 'cc-b1', null, 2);
    win.activeTerminal = focused; // `background` is NOT the active terminal
    execCalls.length = 0;

    await terminals.renameTerminal(background, 'Bee Task');

    expect(execCalls.length).toBe(0); // never showed/renamed a non-focused tab
    expect(terminals.getByTerminal(background)?.pendingTitle).toBe('Bee Task');
    expect(terminals.getByTerminal(background)?.appliedTitle).toBe('CC'); // its creation name, unchanged
  });

  test('the focused tab is renamed, then an identical rename is a no-op', async () => {
    const focused = fakeTerminal();
    terminals.register(focused, 'cc-f2', null, 3);
    win.activeTerminal = focused;
    execCalls.length = 0;

    await terminals.renameTerminal(focused, 'Ay Task');
    expect(execCalls).toEqual([{ cmd: RENAME, arg: { name: 'Ay Task' } }]);
    expect(terminals.getByTerminal(focused)?.appliedTitle).toBe('Ay Task');

    execCalls.length = 0;
    await terminals.renameTerminal(focused, 'Ay Task'); // same title again
    expect(execCalls.length).toBe(0); // dedupe: no redundant command
  });

  test('a deferred title applies the moment the tab gains focus', async () => {
    const focused = fakeTerminal();
    const background = fakeTerminal();
    terminals.register(focused, 'cc-f3', null, 4);
    terminals.register(background, 'cc-b3', null, 5);
    win.activeTerminal = focused;
    await terminals.renameTerminal(background, 'Bee Later'); // deferred
    expect(terminals.getByTerminal(background)?.pendingTitle).toBe('Bee Later');

    win.activeTerminal = background; // user selects the tab
    execCalls.length = 0;
    await terminals.applyPendingTitle(background);

    expect(execCalls).toEqual([{ cmd: RENAME, arg: { name: 'Bee Later' } }]);
    expect(terminals.getByTerminal(background)?.appliedTitle).toBe('Bee Later');
    expect(terminals.getByTerminal(background)?.pendingTitle).toBeUndefined();
  });
});
