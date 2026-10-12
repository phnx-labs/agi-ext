import { describe, expect, test } from 'bun:test';
import { loadBrowsableSessions } from './sessionBrowser.vscode';

describe('session browser CLI boundary', () => {
  test('performs one bounded non-interactive history query of this machine', async () => {
    const calls: string[][] = [];
    const rows = [{ id: 'abc', shortId: 'abc', agent: 'codex' }];
    const sessions = await loadBrowsableSessions(async (args) => {
      calls.push(args);
      return { stdout: JSON.stringify(rows), stderr: '' };
    }, {
      localMachine: 'this-mac',
      limit: 60,
      currentSessionId: 'abc',
      currentSessionDevice: 'elsewhere',
      quote: JSON.stringify,
    });
    expect(calls).toEqual([['--all', '--json', '--no-interactive', '--limit', '60']]);
    expect(sessions).toEqual(rows);
  });

  test('reads a chosen device over --host, and a remote shell warning on stderr is not an error', async () => {
    const calls: string[][] = [];
    const rows = [{ id: 'def', shortId: 'def', agent: 'claude', machine: 'yosemite-s0' }];
    const sessions = await loadBrowsableSessions(async (args) => {
      calls.push(args);
      return { stdout: JSON.stringify(rows), stderr: 'nvm: your .npmrc has a prefix setting\n' };
    }, { device: 'yosemite-s0', localMachine: 'this-mac', limit: 60, quote: JSON.stringify });
    expect(calls).toEqual([['--all', '--json', '--no-interactive', '--limit', '60', '--host', 'yosemite-s0']]);
    expect(sessions).toEqual(rows);
  });

  test('surfaces CLI errors without a filesystem or active-query fallback', async () => {
    // Await the rejection rather than leaning on the runner. Verified by
    // mutation (swap the throw for a silent `return []`) that bun does catch
    // the un-awaited form today via unhandled-rejection detection — so this is
    // hardening, not a repair: the explicit await is what keeps the guard
    // working under a different runner or a changed unhandled-rejection
    // setting, and it reports the real assertion instead of a stray rejection.
    await expect(loadBrowsableSessions(async () => ({ stdout: '', stderr: 'upgrade agents-cli' }), {
      localMachine: 'this-mac', limit: 60, quote: JSON.stringify,
    })).rejects.toThrow('upgrade agents-cli');
  });
});
