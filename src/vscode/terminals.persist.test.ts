import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each case is its own extension host (child process) against the real store,
// so Bun's process-global module doubles stay out of it.
function window(home: string, workspace: string, body: string) {
  const script = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import { vscodeDouble } from ${JSON.stringify(join(import.meta.dir, '../testing/vscodeDouble.ts'))};
    mock.module('vscode', () => vscodeDouble({ window: { terminals: [], activeTerminal: undefined, tabGroups: { all: [] } },
      workspace: ${workspace} }));
    const t = await import(${JSON.stringify(join(import.meta.dir, 'terminals.vscode.ts'))});
    const config = { prefix: 'cl', title: 'Claude', command: 'claude' };
    const term = (id) => ({ name: id, processId: Promise.resolve(1), creationOptions: { env: { AGENT_TERMINAL_ID: id } } });
    const ids = () => t.loadPersistedSessions().map((s) => s.terminalId);
    const vscode = await import('vscode');
    const live = (id) => ({ name: 'CC', exitStatus: undefined, processId: Promise.resolve(4242),
      creationOptions: { env: { AGENT_TERMINAL_ID: id } } });
    const row = (id, extra = {}) => ({ terminalId: id, prefix: 'CC', sessionId: 'sess-' + id, agentType: 'claude', createdAt: 1, ...extra });
    const seed = async (rows) => (await import(${JSON.stringify(join(import.meta.dir, '../core/sessions.persist.ts'))}))
      .saveWorkspaceSessions('/work/projA', rows);
    ${body}
    t.clear();
  `;
  const result = spawnSync('bun', ['-e', script], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(result.status, result.stderr + result.stdout).toBe(0);
}

const folder = (p: string) => `{ workspaceFolders: [{ uri: { fsPath: '${p}' } }] }`;

describe('restore store per window', () => {
  test('a closed tab is off disk at once, so a crash right after cannot bring it back', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminals-persist-'));
    try {
      window(home, folder('/work/projA'), `
        const devApi = term('cl-devapi'), keep = term('cl-keep');
        t.register(devApi, 'cl-devapi', config, 1);
        t.register(keep, 'cl-keep', config, 2);
        t.setHost(devApi, 'yosemite-m2');
        t.persistNow();
        t.unregister(devApi);
        assert.deepEqual(ids(), ['cl-keep']);
      `);
      // The next launch (crash restart) sees only the tab that was still open.
      window(home, folder('/work/projA'), `assert.deepEqual(ids(), ['cl-keep']);`);
    } finally { rmSync(home, { recursive: true }); }
  });

  test('a crash in the middle of a restore keeps the tabs not reopened yet', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminals-persist-'));
    try {
      window(home, folder('/work/projA'), `
        const pending = (id) => ({ terminalId: id, prefix: 'cl', sessionId: id, host: 'yosemite-m2', createdAt: 1 });
        t.setRestoring([pending('cl-1'), pending('cl-2')]);
        const restored = term('cl-1');
        t.register(restored, 'cl-1', config, 1);
        t.register(term('cl-3'), 'cl-3', config, 3);
        t.persistNow();
        assert.deepEqual(ids(), ['cl-1', 'cl-3', 'cl-2']);
        // Closing a tab the restore already reopened removes it, even mid-restore.
        t.unregister(restored);
        assert.deepEqual(ids(), ['cl-3', 'cl-2']);
        t.unregister(t.getById('cl-3').terminal);
      `);
      window(home, folder('/work/projA'), `
        assert.deepEqual(ids(), ['cl-2']);
        assert.equal(t.loadPersistedSessions()[0].host, 'yosemite-m2');
      `);
    } finally { rmSync(home, { recursive: true }); }
  });

  test('a scan that registers one tab while the store holds five keeps all five on disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminals-persist-'));
    try {
      window(home, folder('/work/projA'), `
        await seed(['cc-1', 'cc-2', 'cc-3', 'cc-4', 'cc-5'].map((id) => row(id, { host: 'yosemite-m2' })));
        vscode.window.terminals = [live('cc-1')];
        await t.scanExisting(() => config);
        t.persistNow();
        assert.deepEqual(ids(), ['cc-1', 'cc-2', 'cc-3', 'cc-4', 'cc-5']);
        assert.deepEqual(t.pendingRestore().map((s) => s.terminalId), ['cc-2', 'cc-3', 'cc-4', 'cc-5']);
        assert.equal(t.loadPersistedSessions()[4].host, 'yosemite-m2');
      `);
    } finally { rmSync(home, { recursive: true }); }
  });

  test('on the first launch after the upgrade, an early write keeps the pre-upgrade tabs', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminals-persist-'));
    try {
      mkdirSync(join(home, '.swarmify/agents'), { recursive: true });
      writeFileSync(join(home, '.swarmify/agents/sessions.yaml'), YAML.stringify({ workspaces: { '/work/projA': { cleanShutdown: true,
        sessions: ['cc-1', 'cc-2', 'cc-3', 'cc-4', 'cc-5'].map((id) => ({ terminalId: id, prefix: 'CC', sessionId: 'sess-' + id, createdAt: 1 })) } } }));
      window(home, folder('/work/projA'), `
        vscode.window.terminals = [live('cc-1')];
        await t.scanExisting(() => config);
        t.persistNow();
      `);
      window(home, folder('/work/projA'), `assert.deepEqual(ids(), ['cc-1', 'cc-2', 'cc-3', 'cc-4', 'cc-5']);`);
    } finally { rmSync(home, { recursive: true }); }
  });

  test('a rename never lands on another tab when the active tab changes before the workbench runs it', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminals-persist-'));
    try {
      window(home, folder('/work/projA'), `
        const a1 = { name: 'Claude 8d05c00f - real a1', processId: Promise.resolve(1), creationOptions: { env: {} } };
        const shell = { name: 'Shell - cleartest', processId: Promise.resolve(2), creationOptions: { env: {} } };
        vscode.window.terminals = [a1, shell];
        t.register(a1, 'cl-a1', config, 1);
        t.register(shell, 'sh-1', config, 2);
        // The workbench renames whatever is active when it runs the command; the
        // user focuses the shell tab in between the extension's check and that run.
        let switchBeforeRun = true;
        vscode.commands.executeCommand = async (cmd, arg) => {
          if (cmd !== 'workbench.action.terminal.renameWithArg') return;
          if (switchBeforeRun) { vscode.window.activeTerminal = shell; switchBeforeRun = false; }
          vscode.window.activeTerminal.name = arg.name;
        };
        vscode.window.activeTerminal = a1;
        await t.renameTerminal(a1, 'CC - a1 new title');
        assert.equal(shell.name, 'Shell - cleartest');
        assert.equal(a1.name, 'Claude 8d05c00f - real a1');
        assert.equal(t.getByTerminal(a1).pendingTitle, 'CC - a1 new title');
        // Next time a1 is really active, the title lands on a1.
        vscode.window.activeTerminal = a1;
        await t.renameTerminal(a1, 'CC - a1 new title');
        assert.equal(a1.name, 'CC - a1 new title');
        assert.equal(shell.name, 'Shell - cleartest');
      `);
    } finally { rmSync(home, { recursive: true }); }
  });

  test('a tab created with its title is not renamed to the same title', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminals-persist-'));
    try {
      window(home, folder('/work/projA'), `
        const a1 = { name: 'Claude 8d05c00f - real a1', processId: Promise.resolve(1), creationOptions: { env: {} } };
        vscode.window.terminals = [a1];
        vscode.window.activeTerminal = a1;
        let renames = 0;
        vscode.commands.executeCommand = async () => { renames++; };
        t.register(a1, 'cl-a1', config, 1);
        await t.renameTerminal(a1, 'Claude 8d05c00f - real a1');
        assert.equal(renames, 0);
      `);
    } finally { rmSync(home, { recursive: true }); }
  });

  test('a session is open only while its tab runs or is starting its agent; finding tabs closes nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminals-persist-'));
    try {
      window(home, folder('/work/projA'), `
        const { spawn } = await import('node:child_process');
        const shellRunningAgent = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore', detached: true });
        const shellAtPrompt = spawn('sleep', ['30'], { stdio: 'ignore' });
        shellRunningAgent.unref(); shellAtPrompt.unref();
        await new Promise((r) => setTimeout(r, 300));
        const old = Date.now() - 60_000;
        const make = (id, pid, opts = {}) => {
          const disposed = { n: 0 };
          const terminal = { name: id, processId: Promise.resolve(pid), exitStatus: opts.exited ? { code: 0 } : undefined,
            creationOptions: { env: { AGENT_TERMINAL_ID: id }, shellArgs: opts.shellArgs }, dispose() { disposed.n++; } };
          t.register(terminal, id, config, pid, undefined, undefined, opts.createdAt ?? old);
          t.setSessionId(terminal, 's-' + id);
          return disposed;
        };
        const counts = [
          make('cl-run', shellRunningAgent.pid),
          make('cl-proc', shellAtPrompt.pid, { shellArgs: ['-l', '-i', '-c', "agents sessions resume 'x' -q"] }),
          make('cl-starting', shellAtPrompt.pid, { createdAt: Date.now() }),
          make('cl-idle', shellAtPrompt.pid),
          make('cl-exit', shellRunningAgent.pid, { exited: true }),
        ];
        const state = async (id) => { const r = await t.sessionTabs('s-' + id); return [r.live?.id, r.dead.map((e) => e.id)]; };
        assert.deepEqual(await state('cl-run'), ['cl-run', []]);
        assert.deepEqual(await state('cl-proc'), ['cl-proc', []]);
        assert.deepEqual(await state('cl-starting'), ['cl-starting', []]);
        assert.deepEqual(await state('cl-idle'), [undefined, ['cl-idle']]);
        assert.deepEqual(await state('cl-exit'), [undefined, ['cl-exit']]);
        assert.deepEqual(counts.map((c) => c.n), [0, 0, 0, 0, 0]);
        t.closeTabs((await t.sessionTabs('s-cl-idle')).dead);
        assert.deepEqual(counts.map((c) => c.n), [0, 0, 0, 1, 0]);
        assert.equal(t.getById('cl-idle'), undefined);
        process.kill(-shellRunningAgent.pid, 'SIGKILL'); shellAtPrompt.kill('SIGKILL');
      `);
    } finally { rmSync(home, { recursive: true }); }
  }, 20_000);

  test('reload waits for the old agent to exit, and reports one that will not', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminals-persist-'));
    try {
      window(home, folder('/work/projA'), `
        const { spawn } = await import('node:child_process');
        const shell = spawn('sh', ['-c', 'sleep 1 & wait; sleep 30'], { stdio: 'ignore', detached: true });
        const stuck = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore', detached: true });
        shell.unref(); stuck.unref();
        await new Promise((r) => setTimeout(r, 300));
        const make = (id, pid) => {
          const terminal = { name: id, processId: Promise.resolve(pid), creationOptions: { env: {} }, dispose() {} };
          t.register(terminal, id, config, pid);
          return t.getById(id);
        };
        const exiting = make('cl-exiting', shell.pid);
        const running = make('cl-stuck', stuck.pid);
        const t0 = Date.now();
        assert.equal(await t.waitForAgentExit(exiting, 5000), true);
        assert.ok(Date.now() - t0 < 4000);
        assert.equal(await t.waitForAgentExit(running, 1000), false);
        process.kill(-shell.pid, 'SIGKILL'); process.kill(-stuck.pid, 'SIGKILL');
      `);
    } finally { rmSync(home, { recursive: true }); }
  }, 20_000);

  test('a multi-root window and a folder window on its first folder keep separate tabs', () => {
    const home = mkdtempSync(join(tmpdir(), 'terminals-persist-'));
    try {
      const multiRoot = `{ workspaceFile: { toString: () => 'file:///ws/untitled-1/workspace.json' },
        workspaceFolders: [{ uri: { fsPath: '/work/agents-cli' } }, { uri: { fsPath: '/work/agi-menu' } }] }`;
      window(home, multiRoot, `t.register(term('cl-multi'), 'cl-multi', config, 1); t.persistNow();`);
      window(home, folder('/work/agents-cli'), `t.register(term('cl-folder'), 'cl-folder', config, 1); t.persistNow();`);
      window(home, multiRoot, `assert.deepEqual(ids(), ['cl-multi']);`);
      window(home, folder('/work/agents-cli'), `assert.deepEqual(ids(), ['cl-folder']);`);
    } finally { rmSync(home, { recursive: true }); }
  });
});
