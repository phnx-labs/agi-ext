import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addProposedApiOptIn,
  argvJsonPath,
  editorEndpointsDir,
  editorWindowId,
  newBridgeToken,
  removeEditorEndpoint,
  tokensMatch,
  writeEditorEndpoint,
  type EditorEndpoint,
} from './editorBrowser';

const testdata = path.join(import.meta.dir, 'testdata', 'editor-browser');

function parseJsonc(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*/g, (_m, s) => s ?? ''));
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-browser-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function endpoint(over: Partial<EditorEndpoint> = {}): EditorEndpoint {
  return {
    v: 1,
    id: editorWindowId('VSCodium', 'file:///home/u/agi-ext'),
    app: 'VSCodium',
    appVersion: '1.135.0',
    workspace: 'agi-ext',
    pid: process.pid,
    port: 49321,
    token: newBridgeToken(),
    startedAt: '2026-11-12T12:00:00.000Z',
    ...over,
  };
}

describe('endpoint file (read by browser-cli editor-discovery)', () => {
  test('lives under $AGENTS_HOME/browser/run/editors', () => {
    expect(editorEndpointsDir({ AGENTS_HOME: '/x/.agents' })).toBe('/x/.agents/browser/run/editors');
    expect(editorEndpointsDir({ HOME: '/home/u' })).toBe('/home/u/.agents/browser/run/editors');
  });

  test('the window id is stable per editor and folder, so a saved alias survives a restart', () => {
    const a = editorWindowId('VSCodium', 'file:///home/u/agi-ext');
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(editorWindowId('VSCodium', 'file:///home/u/agi-ext')).toBe(a);
    expect(editorWindowId('Visual Studio Code', 'file:///home/u/agi-ext')).not.toBe(a);
    expect(editorWindowId('VSCodium', undefined)).not.toBe(editorWindowId('VSCodium', undefined));
  });

  test('is written 0600 under a 0700 directory, readable as the contract', () => {
    const e = endpoint();
    const file = writeEditorEndpoint(e, path.join(dir, 'editors'));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(e);
    expect(e.token).toMatch(/^[a-f0-9]{64}$/);
  });

  test('is removed on shutdown only while it still carries this window\'s token', () => {
    const mine = endpoint();
    const file = writeEditorEndpoint(mine, dir);
    writeEditorEndpoint({ ...mine, token: newBridgeToken(), port: 50000 }, dir);
    removeEditorEndpoint(file, mine.token);
    expect(fs.existsSync(file)).toBe(true);
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as EditorEndpoint;
    removeEditorEndpoint(file, current.token);
    expect(fs.existsSync(file)).toBe(false);
    removeEditorEndpoint(file, current.token);
  });

  test('the token comparison accepts only the exact token', () => {
    const t = newBridgeToken();
    expect(tokensMatch(t, t)).toBe(true);
    expect(tokensMatch(t, t.slice(1))).toBe(false);
    expect(tokensMatch(t, newBridgeToken())).toBe(false);
  });
});

describe('argv.json opt-in', () => {
  test('argv.json is in the editor\'s data folder, or the portable folder', () => {
    expect(argvJsonPath(path.join(testdata, 'app'), {})).toBe(path.join(os.homedir(), '.vscode-oss', 'argv.json'));
    expect(argvJsonPath(path.join(testdata, 'app'), { VSCODE_PORTABLE: '/p/data' })).toBe('/p/data/argv.json');
  });

  test('adds the extension to VSCodium\'s stock argv.json and keeps every comment', () => {
    const before = fs.readFileSync(path.join(testdata, 'argv-vscodium.json'), 'utf8');
    const after = addProposedApiOptIn(before)!;
    expect(parseJsonc(after)).toEqual({
      'enable-proposed-api': ['swarmify.swarm-ext'],
      'enable-crash-reporter': false,
      'crash-reporter-id': '00000000-0000-4000-8000-000000000000',
    });
    for (const line of before.split('\n').filter((l) => l.trim().startsWith('//'))) expect(after).toContain(line);
    expect(addProposedApiOptIn(after)).toBeNull();
  });

  test('joins an existing enable-proposed-api list', () => {
    const after = addProposedApiOptIn('{\n\t"enable-proposed-api": ["someone.else"]\n}\n')!;
    expect(parseJsonc(after)['enable-proposed-api']).toEqual(['swarmify.swarm-ext', 'someone.else']);
    expect(parseJsonc(addProposedApiOptIn('{ "enable-proposed-api": [] }')!)['enable-proposed-api']).toEqual(['swarmify.swarm-ext']);
  });

  test('an object holding only comments gets no dangling comma, and a missing file a fresh one', () => {
    expect(parseJsonc(addProposedApiOptIn('{\n\t// "disable-hardware-acceleration": true,\n}\n')!)).toEqual({
      'enable-proposed-api': ['swarmify.swarm-ext'],
    });
    expect(parseJsonc(addProposedApiOptIn('')!)).toEqual({ 'enable-proposed-api': ['swarmify.swarm-ext'] });
  });
});
