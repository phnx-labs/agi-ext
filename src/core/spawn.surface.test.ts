import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cliResumeOutcome, decideSpawn, resumeSessionTab, spawnNonce, parseSpawnRequest, resolveSpawnSurface, spawnAckPath, type SpawnAck } from './spawn';

// The `…/spawn` URI verb reopens a session as an editor tab. AGI EXT no longer
// spawns tmux-backed terminals at the extension level, so every request lands on
// a plain VS Code terminal surface.
describe('resolveSpawnSurface', () => {
  test('a plain spawn opens a new native tab', () => {
    expect(
      resolveSpawnSurface({ wantsSplit: false, hasParent: false })
    ).toBe('native-tab');
  });

  test('a split beside a live parent uses a native split', () => {
    expect(
      resolveSpawnSurface({ wantsSplit: true, hasParent: true })
    ).toBe('native-split');
  });

  test('a split request with no live parent falls back to a tab', () => {
    expect(
      resolveSpawnSurface({ wantsSplit: true, hasParent: false })
    ).toBe('native-tab');
  });
});

describe('parseSpawnRequest', () => {
  function encode(obj: Record<string, unknown>): string {
    const p = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
    return `p=${p}`;
  }

  test('parses command + cwd + split', () => {
    const req = parseSpawnRequest(encode({
      command: 'claude --resume abc',
      cwd: '/tmp/ws',
      split: 'right',
    }));
    expect(req).toEqual({
      command: 'claude --resume abc',
      cwd: '/tmp/ws',
      split: 'right',
      agent: undefined,
      sessionId: undefined,
      title: undefined,
    });
  });

  test('parses agent + sessionId + title for remote-attach chips (#2478)', () => {
    const req = parseSpawnRequest(encode({
      command: 'ssh -tt host tmux attach',
      cwd: '/Users/me/.agents',
      agent: 'Grok',
      sessionId: '115db661-1079-4e6b-846c-ce9aa05494f8',
      title: 'GK - restore',
    }));
    expect(req?.agent).toBe('grok'); // lowercased
    expect(req?.sessionId).toBe('115db661-1079-4e6b-846c-ce9aa05494f8');
    expect(req?.title).toBe('GK - restore');
    expect(req?.command).toContain('ssh');
  });

  test('returns null without a command', () => {
    expect(parseSpawnRequest(encode({ cwd: '/tmp' }))).toBeNull();
    expect(parseSpawnRequest('')).toBeNull();
  });
});
test('attach titles hide only complete host placeholders, preserving task text', () => {
  const request = (title: string) => parseSpawnRequest('p=' + Buffer.from(JSON.stringify({
    command: 'ssh worker tmux attach', agent: 'claude', title,
  })).toString('base64url'));
  expect(request('CC - [host/yosemite-m3]')?.title).toBeUndefined();
  expect(request('[host/yosemite-m3]')?.title).toBeUndefined();
  expect(request('CC - fix host/config parser')?.title).toBe('CC - fix host/config parser');
  expect(request('CC - investigate [host/yosemite-m3]')?.title).toBe('CC - investigate [host/yosemite-m3]');
});

describe('agents.resumeSession', () => {
  const runCli = (script: string) => async () => {
    const res = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    return { ok: res.status === 0, output: `${res.stdout}\n${res.stderr}` };
  };

  test('a tab already showing the session is focused and the CLI is not run', async () => {
    let focused = 0;
    let ran = 0;
    const result = await resumeSessionTab('s1', {
      liveTab: async (id) => (id === 's1' ? { terminalId: 'cl-1', focus: () => { focused++; } } : undefined),
      runResume: async () => { ran++; return { ok: true, output: '' }; },
    });
    expect({ result, focused, ran }).toEqual({ result: { status: 'focused-existing', terminalId: 'cl-1', reason: null }, focused: 1, ran: 0 });
  });

  test('otherwise the CLI decides the window, and its exit code is the answer', async () => {
    const liveTab = async () => undefined;
    expect(await resumeSessionTab('s2', { liveTab, runResume: runCli('echo "Already open → focused tab \\"CC - x\\" in window \\"projB\\""') }))
      .toEqual({ status: 'focused-existing', terminalId: null, reason: 'Already open → focused tab "CC - x" in window "projB"' });
    expect((await resumeSessionTab('s2', { liveTab, runResume: runCli('echo "no ack" >&2; exit 1') })).status).toBe('failed');
    expect((await resumeSessionTab('', { liveTab, runResume: runCli('exit 0') })).reason).toBe('no session id');
  });

  test("the session's machine reaches the CLI; this machine's sessions name none", async () => {
    const devices: Array<string | undefined> = [];
    const runResume = async (_id: string, device: string | undefined) => { devices.push(device); return { ok: true, output: 'ok' }; };
    await resumeSessionTab('s3', { liveTab: async () => undefined, runResume }, 'yosemite-m2');
    await resumeSessionTab('s4', { liveTab: async () => undefined, runResume });
    expect(devices).toEqual(['yosemite-m2', undefined]);
  });
});

describe('agents.resumeSession outcome from the CLI', () => {
  test('exit 0 is opened or focused-existing, from the line the CLI printed', () => {
    expect(cliResumeOutcome(true, 'Resumed b64b7320 "SV Atlas" (yosemite-m2)\n → VSCodium window "svatlas", new tab "CC - SV Atlas"\n'))
      .toEqual({ status: 'opened', reason: '→ VSCodium window "svatlas", new tab "CC - SV Atlas"' });
    expect(cliResumeOutcome(true, 'Already open → focused tab "CC - SV Atlas" in window "svatlas"').status).toBe('focused-existing');
  });
  test("a non-zero exit is failed with the CLI's own reason", () => {
    expect(cliResumeOutcome(false, "Can't open 0db3f95b: VSCodium didn't confirm a tab within 10s.\n  Resume it in this terminal instead: agents run claude --resume 0db3f95b\n"))
      .toEqual({ status: 'failed', reason: "Can't open 0db3f95b: VSCodium didn't confirm a tab within 10s." });
    expect(cliResumeOutcome(false, '').reason).toBe('resume failed with no output');
  });
  test('a failure with only the type-this-id hint still reports it, and exit 0 never reads as failed', () => {
    expect(cliResumeOutcome(false, 'Resume it in this terminal instead: agents run claude --resume 0db3f95b\n'))
      .toEqual({ status: 'failed', reason: 'Resume it in this terminal instead: agents run claude --resume 0db3f95b' });
    expect(cliResumeOutcome(true, '').status).toBe('opened');
  });
  test("a /spawn that reached the wrong window is wrong-window, with the CLI's words", () => {
    const out = 'Can\'t open 9bef2ef9 "Grafana" (yosemite-m6): the request reached window "agents", which does not hold svatlas; nothing was opened.';
    expect(cliResumeOutcome(false, out)).toEqual({ status: 'wrong-window', reason: out });
  });
});

describe('spawn ack contract', () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'testdata/spawn-ack.json'), 'utf8')) as SpawnAck;
  const encode = (obj: Record<string, unknown>) => 'p=' + Buffer.from(JSON.stringify(obj)).toString('base64url');

  test('the request carries nonce and project; a nonce that could leave the ack folder is dropped', () => {
    const req = parseSpawnRequest(encode({ command: 'claude --resume x', nonce: fixture.nonce, project: '/Users/dev/src/projB' }));
    expect(req?.nonce).toBe(fixture.nonce);
    expect(req?.project).toBe('/Users/dev/src/projB');
    expect(parseSpawnRequest(encode({ command: 'c', nonce: '../../etc/passwd' }))?.nonce).toBeUndefined();
    expect(() => spawnAckPath('../x')).toThrow();
  });

  test('only a window whose folders contain the project opens it, and its own live tab is focused instead of duplicated', () => {
    const folders = ['/Users/dev/src/agents-cli', '/Users/dev/src/agi-menu'];
    expect(decideSpawn({ project: '/Users/dev/src/svatlas', windowFolders: folders })).toBe('wrong-window');
    expect(decideSpawn({ project: '/Users/dev/src/agents-cli-old', windowFolders: folders })).toBe('wrong-window');
    expect(decideSpawn({ project: '/Users/dev/src/agi-menu/sub', windowFolders: folders })).toBe('open');
    expect(decideSpawn({ project: '/Users/dev/src/agents-cli', windowFolders: folders, liveTerminalId: 'cl-1' })).toBe('focus');
    expect(decideSpawn({ project: '/Users/dev/src/svatlas', windowFolders: folders, liveTerminalId: 'cl-1' })).toBe('wrong-window');
    expect(decideSpawn({ windowFolders: folders })).toBe('no-project');
    expect(decideSpawn({ windowFolders: folders, liveTerminalId: 'cl-1' })).toBe('no-project');
  });

  test('the nonce survives a request with no command, so the window can still ack failed', () => {
    expect(parseSpawnRequest(encode({ nonce: 'n-1', project: '/p' }))).toBeNull();
    expect(spawnNonce(encode({ nonce: 'n-1', project: '/p' }))).toBe('n-1');
    expect(spawnNonce(encode({ nonce: '../x' }))).toBeUndefined();
    expect(spawnNonce('p=not-json')).toBeUndefined();
  });

  test('a window on a parent folder leaves a nested project to the live window that holds it', () => {
    expect(decideSpawn({ project: '/Users/dev/src/app/pkg', windowFolders: ['/Users/dev/src'], otherWindows: [['/Users/dev/src/app']] })).toBe('wrong-window');
    expect(decideSpawn({ project: '/Users/dev/src/app/pkg', windowFolders: ['/Users/dev/src/app'], otherWindows: [['/Users/dev/src']] })).toBe('open');
    expect(decideSpawn({ project: '/Users/dev/src/other', windowFolders: ['/Users/dev/src'], otherWindows: [['/Users/dev/src/app']] })).toBe('open');
  });

  test('folders compare through symlinks and, on macOS, without case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-real-'));
    try {
      mkdirSync(join(dir, 'real/proj'), { recursive: true });
      symlinkSync(join(dir, 'real'), join(dir, 'link'));
      expect(decideSpawn({ project: join(dir, 'link/proj'), windowFolders: [join(dir, 'real')] })).toBe('open');
      if (process.platform === 'darwin') {
        expect(decideSpawn({ project: join(dir, 'REAL/proj'), windowFolders: [join(dir, 'real')] })).toBe('open');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('writeSpawnAck lands the fixture shape at spawn-acks/<nonce>.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'spawn-ack-'));
    try {
      const res = spawnSync('bun', ['-e', `
        const m = await import(${JSON.stringify(join(import.meta.dir, 'spawn.ts'))});
        m.writeSpawnAck(${JSON.stringify(fixture)});
        console.log(m.spawnAckPath(${JSON.stringify(fixture.nonce)}));
      `], { encoding: 'utf8', env: { ...process.env, HOME: home } });
      expect(res.status, res.stderr).toBe(0);
      const file = res.stdout.trim();
      expect(file).toBe(join(home, '.swarmify/agents/spawn-acks', `${fixture.nonce}.json`));
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(fixture);
      expect(readdirSync(join(home, '.swarmify/agents/spawn-acks'))).toEqual([`${fixture.nonce}.json`]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
