// The one `vscode` module double every test registers with `mock.module`.
//
// bun's module-mock registry is process-global and the LAST file to register a
// specifier wins for every module that already imported it — the registration
// is not scoped to the file that made it. Each test file used to hand-roll its
// own partial `vscode` object, so which parts of the API existed during a suite
// run was decided by whichever mocking file happened to load last. That is how
// `terminalReadiness.close.test.ts` passed on its own and failed all six of its
// assertions in the suite: a file that sorted last registered a double with
// no `TerminalExitReason`, so `shouldTearDownAgentOnClose`'s
// `vscode.TerminalExitReason.User` read threw.
//
// API *constants* are the part that must not vary — they are fixed by the VS
// Code API, not by what a given test is exercising. They live here once and are
// merged into every double, so the winning registration always carries the full
// set. Per-file spies (a `window` that records the messages it was shown, a
// `workspace` backed by a temp dir) stay in the test that asserts on them.

/**
 * Enum values fixed by the VS Code extension API, mirrored for tests that run
 * without an extension host. `TerminalExitReason` has been stable since API
 * 1.77, `ConfigurationTarget` since 1.0.
 */
export const VSCODE_API_CONSTANTS = {
  TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  // Plain value classes (an icon id, a theme color id): a module that builds
  // QuickPick rows creates them at load, so every double must carry them.
  ThemeIcon: class ThemeIcon { constructor(readonly id: string, readonly color?: unknown) {} },
  ThemeColor: class ThemeColor { constructor(readonly id: string) {} },
} as const;

const commands = {
  executeCommand: async (..._args: unknown[]): Promise<unknown> => {
    throw new Error('Configure commands.executeCommand in the vscode test double before invoking it');
  },
};

const namespaceSurface = {
  commands,
  window: {},
  workspace: {},
  TabInputTerminal: class {},
  // A webview provider builds localResourceRoots from Uri at resolve time, so
  // the export must exist in whichever double a suite run imports first.
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
    joinPath: (base: { fsPath?: string }, ...parts: string[]) => {
      const p = [base?.fsPath ?? '', ...parts].join('/');
      return { fsPath: p, path: p, toString: () => p };
    },
  },
};

/**
 * Build a `vscode` double: the shared API constants plus whatever surface this
 * test drives. Pass the result to `mock.module('vscode', () => vscodeDouble({…}))`.
 */
export function vscodeDouble<T extends Record<string, unknown>>(
  surface: T = {} as T,
): T & typeof VSCODE_API_CONSTANTS & typeof namespaceSurface {
  // Bun fixes namespace export names on the first import. Later registrations
  // can replace these surfaces, but cannot add an already-imported export.
  return { ...VSCODE_API_CONSTANTS, ...namespaceSurface, ...surface };
}
