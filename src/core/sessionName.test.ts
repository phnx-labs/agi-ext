import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readClaudeSessionName, readClaudeSessionNameInfo, resetSessionNameCache } from './sessionName';

let tmpDir: string;

beforeEach(() => {
  resetSessionNameCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionName-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSessionFile(pid: number, body: object): void {
  fs.writeFileSync(path.join(tmpDir, `${pid}.json`), JSON.stringify(body));
}

const read = (id: string, dirs = [tmpDir]) => { resetSessionNameCache(); return readClaudeSessionName(id, { sessionsDirs: dirs }); };

describe('readClaudeSessionName', () => {
  it('finds the matching file across every session dir, skipping malformed files, and trims the name', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionName-other-'));
    try {
      fs.writeFileSync(path.join(otherDir, '9999.json'), JSON.stringify({ sessionId: 'version-b-sid', name: 'Title in version B' }));
      fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{not valid json');
      writeSessionFile(1111, { sessionId: 'other-id', name: 'Other task' });
      writeSessionFile(2222, { sessionId: 'version-a-sid', name: '  Title in version A  ' });
      expect(await read('version-a-sid', [tmpDir, otherDir])).toBe('Title in version A');
      expect(await read('version-b-sid', [tmpDir, otherDir])).toBe('Title in version B');
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('is null for an empty id, a missing dir, or a null or blank name', async () => {
    expect(await read('')).toBeNull();
    expect(await read('abc', [path.join(tmpDir, 'does-not-exist')])).toBeNull();
    writeSessionFile(1, { sessionId: 'null-name', name: null });
    writeSessionFile(2, { sessionId: 'blank-name', name: '   ' });
    expect(await read('null-name')).toBeNull();
    expect(await read('blank-name')).toBeNull();
  });

  it('hides Claude\'s derived <dirname>-<n> placeholder but keeps a user or legacy title', async () => {
    // Claude 2.1.207+ writes `<dirname>-<n>` as a derived placeholder: not a topic,
    // so the caller falls through to the LLM topic path.
    writeSessionFile(1, { sessionId: 'derived', name: 'agents-cli-55', nameSource: 'derived' });
    writeSessionFile(2, { sessionId: 'no-source', name: 'Fix Fleet Login' });
    writeSessionFile(3, { sessionId: 'user-set', name: 'Ship Release', nameSource: 'user' });
    expect(await read('derived')).toBeNull();
    expect(await read('no-source')).toBe('Fix Fleet Login');
    expect(await read('user-set')).toBe('Ship Release');
  });

  it('readClaudeSessionNameInfo exposes whether the name is the derived placeholder', async () => {
    writeSessionFile(1, { sessionId: 'derived', name: 'agents-cli-55', nameSource: 'derived' });
    writeSessionFile(2, { sessionId: 'old-cli', name: 'Fix Fleet Login' });
    expect(await readClaudeSessionNameInfo('derived', { sessionsDirs: [tmpDir] })).toEqual({ name: 'agents-cli-55', nameSource: 'derived', derived: true });
    resetSessionNameCache();
    expect(await readClaudeSessionNameInfo('old-cli', { sessionsDirs: [tmpDir] })).toEqual({ name: 'Fix Fleet Login', nameSource: null, derived: false });
    expect(await readClaudeSessionNameInfo('nope', { sessionsDirs: [tmpDir] })).toBeNull();
  });

  it('caches scans within the TTL window', async () => {
    writeSessionFile(44444, { sessionId: 'sid', name: 'First' });
    const t0 = 1_000_000;
    expect(await readClaudeSessionName('sid', { sessionsDirs: [tmpDir], now: t0 })).toBe('First');
    writeSessionFile(44444, { sessionId: 'sid', name: 'Second' });
    expect(await readClaudeSessionName('sid', { sessionsDirs: [tmpDir], now: t0 + 1_000 })).toBe('First');
    // Past TTL, a fresh scan picks up the new value.
    expect(await readClaudeSessionName('sid', { sessionsDirs: [tmpDir], now: t0 + 60_000 })).toBe('Second');
  });
});
