// The project list never holds up a draw (owner video, 2026-10-19 1:27 PM): once a
// read has answered, a list older than a minute is answered at once while one
// reread replaces it. Runs against a fake `agents` on PATH (testdata/projects-bin).
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearAgentsBinCache } from '../core/agentsBin';
import { readRegistry } from './projectRegistry.vscode';

const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
let dir = '';
let log = '';
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'projects-registry-'));
  log = join(dir, 'argv.log');
  process.env.PATH = `${join(import.meta.dir, 'testdata', 'projects-bin')}:${saved.PATH ?? ''}`;
  process.env.SHELL = '/bin/sh';
  process.env.PROJECTS_STUB_LOG = log;
  clearAgentsBinCache();
});
afterAll(() => {
  setSystemTime();
  process.env.PATH = saved.PATH;
  if (saved.SHELL === undefined) delete process.env.SHELL; else process.env.SHELL = saved.SHELL;
  for (const k of ['PROJECTS_STUB_LOG', 'PROJECTS_STUB_NAME', 'PROJECTS_STUB_DELAY_MS']) delete process.env[k];
  clearAgentsBinCache();
  rmSync(dir, { recursive: true, force: true });
});

test('a stale list answers at once while one reread replaces it; force waits for the reread', async () => {
  const t0 = Date.parse('2026-10-19T13:30:00Z');
  setSystemTime(new Date(t0));
  // Nothing held yet: the first read is the only one that waits.
  expect((await readRegistry()).map((p) => p.name)).toEqual(['agi-ui']);
  expect(calls()).toBe(1);
  // Within the minute: no CLI call.
  expect((await readRegistry()).map((p) => p.name)).toEqual(['agi-ui']);
  expect(calls()).toBe(1);

  // A minute on, on a slow machine: the held list comes back before the CLI answers.
  setSystemTime(new Date(t0 + 61_000));
  process.env.PROJECTS_STUB_NAME = 'agi';
  process.env.PROJECTS_STUB_DELAY_MS = '1500';
  const started = performance.now();
  const stale = await readRegistry();
  expect(performance.now() - started).toBeLessThan(200);
  expect(stale.map((p) => p.name)).toEqual(['agi-ui']);
  // A second caller during the reread joins it rather than starting another.
  expect((await readRegistry()).map((p) => p.name)).toEqual(['agi-ui']);
  // force (the project menu) waits for the reread in flight, which now answers.
  expect((await readRegistry(true)).map((p) => p.name)).toEqual(['agi']);
  expect(calls()).toBe(2);
  expect(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([['projects', 'list', '--json'], ['projects', 'list', '--json']]);
});
