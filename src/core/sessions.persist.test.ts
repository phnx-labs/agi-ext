import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { restorePlan, type PersistedSession } from './sessions.persist';

// A reload, and every other editor window, is a separate process reading the
// on-disk store, so these run the REAL module in child `bun` processes with HOME
// pointed at a throwaway dir. STORE_MODULE swaps in another implementation to
// show the same scenario against it.
const MODULE = process.env.STORE_MODULE || path.join(import.meta.dir, 'sessions.persist.ts');
const LEGACY = path.join(import.meta.dir, 'testdata/restore/legacy-sessions.yaml');
const homes: string[] = [];

afterAll(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-persist-'));
  homes.push(home);
  return home;
}

function runInChild(home: string, snippet: string): unknown {
  const res = spawnSync('bun', ['-e', `const persist = await import(${JSON.stringify(MODULE)});\n${snippet}`], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  if (res.status !== 0) throw new Error(`child bun failed (status ${res.status}):\n${res.stderr}\n${res.stdout}`);
  const lines = res.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function runConcurrently(home: string, snippet: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['-e', `const persist = await import(${JSON.stringify(MODULE)});\n${snippet}`], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
  });
}

const tab = (terminalId: string, sessionId: string, extra: Partial<PersistedSession> = {}): PersistedSession =>
  ({ terminalId, prefix: 'cl', sessionId, agentType: 'claude', createdAt: 1, ...extra });

describe('restore store', () => {
  test('session fields round-trip across a reload', () => {
    const home = freshHome();
    const session = tab('CL-123-1', 'sess-abc', { label: 'refactor auth', version: '2.1.170', host: 'yosemite-m3', agentPid: 4242 });
    runInChild(home, `persist.saveWorkspaceSessions('/work/repo', [${JSON.stringify(session)}]); console.log('1');`);
    expect(runInChild(home, `console.log(JSON.stringify(persist.getWorkspaceSessions('/work/repo')))`)).toEqual([session]);
  });

  test('an opaque recovery harness round-trips without borrowing a built-in agent type', () => {
    const home = freshHome();
    const recovered = { terminalId: 'RX-1', prefix: 'rx', sessionId: 'sess-muse', host: 'yosemite-m3', recoveryAgent: 'muse', createdAt: 222 };
    runInChild(home, `persist.saveWorkspaceSessions('/work/opaque', [${JSON.stringify(recovered)}]); console.log('1');`);
    const loaded = runInChild(home, `console.log(JSON.stringify(persist.getWorkspaceSessions('/work/opaque')))`) as Array<Record<string, unknown>>;
    expect(loaded).toEqual([recovered]);
    expect(loaded[0].agentType).toBeUndefined();
  });

  test('two windows writing at once never lose or resurrect each other\'s tabs', async () => {
    const home = freshHome();
    // Window A keeps closing and reopening its "Dev API" tab while window B keeps
    // persisting its own tabs. A third process reads A's tabs throughout, as a
    // restoring window would.
    const writer = (ws: string, label: string) => `
      for (let i = 0; i < 400; i++) {
        const tabs = [{ terminalId: '${label}-keep', prefix: 'cl', sessionId: '${label}-keep', createdAt: i }];
        if (i % 2 === 0) tabs.push({ terminalId: '${label}-devapi', prefix: 'cl', sessionId: '${label}-devapi', createdAt: i });
        persist.saveWorkspaceSessions('${ws}', tabs, true);
      }
      console.log('done');`;
    const reader = `
      let missing = 0;
      for (let i = 0; i < 400; i++) {
        if (!persist.getWorkspaceSessions('/work/projA').some((s) => s.terminalId === 'A-keep')) missing++;
      }
      console.log(missing);`;
    runInChild(home, `persist.saveWorkspaceSessions('/work/projA', [{ terminalId: 'A-keep', prefix: 'cl', createdAt: 0 }], true); console.log('1');`);
    const [, , missing] = await Promise.all([
      runConcurrently(home, writer('/work/projA', 'A')),
      runConcurrently(home, writer('/work/projB', 'B')),
      runConcurrently(home, reader),
    ]);
    // A's last write (i = 399) closed Dev API; B's last write (i = 399) did too.
    const a = runInChild(home, `console.log(JSON.stringify(persist.getWorkspaceSessions('/work/projA')))`) as PersistedSession[];
    const b = runInChild(home, `console.log(JSON.stringify(persist.getWorkspaceSessions('/work/projB')))`) as PersistedSession[];
    expect({ missing: Number(missing), a: a.map((s) => s.terminalId), b: b.map((s) => s.terminalId) })
      .toEqual({ missing: 0, a: ['A-keep'], b: ['B-keep'] });
  }, 60_000);

  test('a window that never wrote its own file restores its slice of the pre-upgrade shared file, and never writes that file', () => {
    const home = freshHome();
    const legacyPath = path.join(home, '.swarmify/agents/sessions.yaml');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.copyFileSync(LEGACY, legacyPath);
    const before = fs.readFileSync(legacyPath, 'utf8');
    const multiRootKey = 'file:///Users/dev/Library/VSCodium/Workspaces/1791/workspace.json';
    const migrated = runInChild(home, `console.log(JSON.stringify(persist.getWorkspaceSessions(${JSON.stringify(multiRootKey)}, '/work/projB')))`) as PersistedSession[];
    expect(migrated.map((s) => s.sessionId)).toEqual(['9ff4d220-cce7-4ca1-a42d-01c16f2a40d7']);
    const after = runInChild(home, `
      persist.saveWorkspaceSessions(${JSON.stringify(multiRootKey)}, []);
      console.log(JSON.stringify(persist.getWorkspaceSessions(${JSON.stringify(multiRootKey)}, '/work/projB')));`);
    expect(after).toEqual([]);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(before);
  });
});

describe('restorePlan', () => {
  const legacy = YAML.parse(fs.readFileSync(LEGACY, 'utf8')).workspaces['/work/projA'].sessions as PersistedSession[];
  const none = { terminalIds: new Set<string>(), sessionIds: new Set<string>() };

  test('one tab per session; the restored tab keeps the device a later copy lost', () => {
    const plan = restorePlan(legacy, none);
    expect(plan.map((s) => s.terminalId)).toEqual(['cl-1791351021462-9', 'cl-1791114788329-17', 'sh-1791693300000-21']);
    expect(plan[0]).toMatchObject({ host: 'yosemite-m2', label: 'Finalize - Dev API', version: '2.1.289', autoLabel: 'Finalize - Dev API' });
  });

  test('a host only a later copy recorded is carried onto the first', () => {
    const plan = restorePlan([tab('t1', 's1'), tab('t2', 's1', { host: 'yosemite-m5' })], none);
    expect(plan).toEqual([tab('t1', 's1', { host: 'yosemite-m5' })]);
  });

  test('nothing reopens for a terminal or session this window already shows', () => {
    const plan = restorePlan(legacy, {
      terminalIds: new Set(['sh-1791693300000-21']),
      sessionIds: new Set(['e5ae558d-5f3c-4315-90f6-c0d78c7c607d']),
    });
    expect(plan.map((s) => s.terminalId)).toEqual(['cl-1791114788329-17']);
  });

  test('the input is not mutated', () => {
    const input = [tab('t1', 's1'), tab('t2', 's1', { host: 'h' })];
    restorePlan(input, none);
    expect(input[0].host).toBeUndefined();
  });
});
