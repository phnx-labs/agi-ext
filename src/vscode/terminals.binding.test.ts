import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A separate extension host keeps Bun's process-global module doubles out of
// these checks and proves persistence through the real YAML store.
function run(body: string) {
  const home = mkdtempSync(join(tmpdir(), 'terminal-binding-'));
  try {
    const script = `
      import { mock } from 'bun:test';
      import assert from 'node:assert/strict';
      import { vscodeDouble } from ${JSON.stringify(join(import.meta.dir, '../testing/vscodeDouble.ts'))};
      const surface = vscodeDouble({ window: { terminals: [], activeTerminal: undefined,
        tabGroups: { all: [] }, showInputBox: async () => undefined },
        workspace: { workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }] } });
      mock.module('vscode', () => vscodeDouble(surface));
      const t = await import(${JSON.stringify(join(import.meta.dir, 'terminals.vscode.ts'))});
      const store = (await import(${JSON.stringify(join(import.meta.dir, '../core/sessionPresentationStore.ts'))})).sessionPresentationStore;
      const planner = (await import(${JSON.stringify(join(import.meta.dir, '../core/sessionIdHydrate.ts'))})).planSessionStreamRebinds;
      const persisted = await import(${JSON.stringify(join(import.meta.dir, '../core/sessions.persist.ts'))});
      let term = { name: 'CC', processId: Promise.resolve(process.pid), creationOptions: {
        env: { AGENT_TERMINAL_ID: 'CC-shell', AGENT_SESSION_ID: 'old' } } };
      const config = { prefix: 'CC', title: 'Claude', command: 'claude' };
      const row = (id, previous = false) => ({ rowKey: id, sessionId: id, terminalId: 'CC-shell', machine: 'desktop', previous });
      const reset = (sequence, agents) => store.apply({ v: 1, type: 'reset', streamId: 'test', sequence, scope: 'desktop', agents, attention: [] });
      const rebind = () => { for (const step of planner(t.getAllTerminals(), 'desktop')) t.setSessionId(term, step.canonicalId); };
      ${body}
      t.persistNow();
      t.clear();
    `;
    const result = spawnSync('bun', ['-e', script], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    expect(result.status, result.stderr + result.stdout).toBe(0);
  } finally { rmSync(home, { recursive: true }); }
}

describe('terminal session identity', () => {
  test('restart rebinds the registry and persisted session; Previous cannot reclaim', () => run(`
    t.register(term, 'CC-shell', config, process.pid);
    t.setSessionId(term, 'old');
    reset(1, [row('old')]);
    reset(2, [row('old', true), row('new')]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'new');
    t.persistNow();
    assert.equal(persisted.getWorkspaceSessions('/test/workspace')[0].sessionId, 'new');
    reset(3, [row('old', true)]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'new');
  `));

  test('two live claims leave an unidentified terminal unbound', () => run(`
    t.register(term, 'CC-shell', config, process.pid);
    reset(1, [row('old'), row('new')]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, undefined);
    reset(2, [row('new')]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'new');
  `));

  for (const saved of ['rebound', undefined]) {
    test(`reload scan uses ${saved ? 'persisted session before env' : 'env when no session is persisted'}`, () => run(`
      if (${JSON.stringify(saved)} !== undefined) persisted.saveWorkspaceSessions('/test/workspace', [{ terminalId: 'CC-shell', prefix: 'CC', sessionId: ${JSON.stringify(saved)}, createdAt: 1 }], true);
      surface.window.terminals = [term];
      assert.equal(await t.scanExisting(() => config), 1);
      assert.equal(t.getByTerminal(term).sessionId, ${JSON.stringify(saved ?? 'old')});
    `));
  }

  test('manual command validates canonical ids, persists, and waits for a newer terminal row', () => run(`
    t.register(term, 'CC-shell', config, process.pid);
    t.setSessionId(term, 'old');
    reset(1, [row('old')]);
    surface.window.activeTerminal = term;
    surface.window.showInputBox = async (options) => {
      assert.equal(options.value, 'old');
      assert.equal(options.validateInput(''), 'Enter a session ID.');
      assert.equal(options.validateInput('rollout-broken'), 'Enter a session ID.');
      assert.equal(options.validateInput('ses_native'), undefined);
      return ' ses_manual ';
    };
    assert.equal((await t.promptSessionId()).sessionId, 'ses_manual');
    assert.equal(persisted.getWorkspaceSessions('/test/workspace')[0].sessionId, 'ses_manual');
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'ses_manual');
    store.apply({ v: 1, type: 'agent.upsert', streamId: 'test', sequence: 2, scope: 'desktop', rowKey: 'other', agent: { ...row('other'), terminalId: 'CC-other' } });
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'ses_manual');
    store.apply({ v: 1, type: 'agent.upsert', streamId: 'test', sequence: 3, scope: 'desktop', rowKey: 'old', agent: row('old') });
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'ses_manual');
    reset(4, [row('old')]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'ses_manual');
    t.persistNow();
    t.clear();
    term = { ...term };
    surface.window.terminals = [term];
    await t.scanExisting(() => config);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'ses_manual');
    assert.deepEqual(t.getByTerminal(term).manualSessionOverride, { sessionId: 'ses_manual', replaced: ['old'] });
    store.apply({ v: 1, type: 'agent.upsert', streamId: 'test', sequence: 5, scope: 'desktop', rowKey: 'new', agent: row('new') });
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'new');
    assert.equal(t.getByTerminal(term).manualSessionOverride, undefined);
  `));

  test('a manual binding ignores Previous and foreign rows; newer ambiguous claims remain unresolved', () => run(`
    t.register(term, 'CC-shell', config, process.pid);
    t.setSessionId(term, 'old');
    reset(1, [row('old')]);
    surface.window.showInputBox = async () => 'ses_manual';
    await t.promptSessionId({ terminalId: 'CC-shell' });
    reset(2, [row('old', true), { ...row('foreign'), machine: 'other' }]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'ses_manual');
    reset(3, [row('old'), row('new'), row('another')]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'ses_manual');
    reset(4, [row('old', true), row('new')]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'new');
  `));

  test('non-Claude Clear survives reload and waits for a different session', () => run(`
    term.name = 'CX';
    const codex = { ...config, prefix: 'CX', title: 'Codex', command: 'codex' };
    t.register(term, 'CC-shell', codex, process.pid);
    t.setSessionId(term, 'old');
    reset(1, [row('old')]);
    t.setSessionId(term, '', true);
    t.clear();
    term = { ...term };
    surface.window.terminals = [term];
    await t.scanExisting(() => codex);
    assert.equal(t.getByTerminal(term).sessionId, '');
    assert.deepEqual(t.getByTerminal(term).manualSessionOverride, { sessionId: '', replaced: ['old'] });
    store.apply({ v: 1, type: 'agent.upsert', streamId: 'test', sequence: 2, scope: 'desktop', rowKey: 'old', agent: row('old') });
    const hydration = (await import(${JSON.stringify(join(import.meta.dir, '../core/remoteAutoLabel.ts'))})).planActiveMapHydration;
    assert.deepEqual(hydration(store.terminalSessionMap(undefined, 'desktop'), t.getAllTerminals(), {
      canonical: (id) => id, needsHydrate: () => true,
    }), []);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, '');
    assert.equal(t.getByTerminal(term).id, term.creationOptions.env.AGENT_TERMINAL_ID);
    reset(3, [row('old'), row('new')]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'new');
    assert.equal(t.getByTerminal(term).manualSessionOverride, undefined);
    t.persistNow();
    assert.equal(persisted.getWorkspaceSessions('/test/workspace')[0].terminalId, 'CC-shell');
  `));

  test('repeated manual ids remember every superseded id; the selected id can claim the tab', () => run(`
    t.register(term, 'CC-shell', config, process.pid);
    t.setSessionId(term, 'old');
    t.setSessionId(term, 'middle', true);
    t.setSessionId(term, 'chosen', true);
    reset(1, [row('old'), row('middle')]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'chosen');
    reset(2, [row('old'), row('middle'), row('chosen')]);
    rebind();
    assert.equal(t.getByTerminal(term).sessionId, 'chosen');
  `));

  test('explicit terminal target, invalid input, cancellation, and missing target', () => run(`
    t.register(term, 'CC-shell', config, process.pid);
    t.setSessionId(term, 'old');
    surface.window.showInputBox = async () => 'rollout-invalid';
    assert.equal(await t.promptSessionId({ terminalId: 'CC-shell' }), undefined);
    assert.equal(t.getByTerminal(term).sessionId, 'old');
    surface.window.showInputBox = async () => undefined;
    assert.equal(await t.promptSessionId({ terminalId: 'CC-shell' }), undefined);
    surface.window.showInputBox = async () => 'ses_target';
    assert.equal((await t.promptSessionId({ terminalId: 'CC-shell' })).sessionId, 'ses_target');
    assert.equal(await t.promptSessionId({ terminalId: 'missing' }), undefined);
  `));

  test('the registry snapshot publishes the session the tab is bound to now, not its launch id', () => run(`
    surface.window.terminals = [term];
    const registry = await import(${JSON.stringify(join(import.meta.dir, 'terminalRegistry.vscode.ts'))});
    t.register(term, 'CC-shell', config, process.pid);
    t.setSessionId(term, 'old');
    let entries = await registry.snapshotOwnTerminals();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].terminalId, 'CC-shell');
    assert.equal(entries[0].sessionId, 'old');
    assert.equal(entries[0].pid, process.pid);
    let changes = 0;
    const sub = t.onSessionBindingChanged(() => { changes += 1; });
    t.setSessionId(term, 'rebound', true);
    t.setSessionId(term, 'rebound', true);
    sub.dispose();
    t.setSessionId(term, 'later');
    assert.equal(changes, 1, 'a rebind schedules one registry publish; repeating the same id or a disposed listener does not');
    t.setSessionId(term, 'rebound', true);
    entries = await registry.snapshotOwnTerminals();
    assert.equal(entries[0].sessionId, 'rebound');
  `));

});
