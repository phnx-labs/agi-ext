import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The registry resolves ~/.agents/.cache/terminals at import, so each case runs
// in its own process with a temp HOME and reads back the real file.
function run(body: string, seed?: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'terminal-registry-'));
  const file = join(home, '.agents', '.cache', 'terminals', 'live-terminals.json');
  try {
    if (seed) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify(seed));
    }
    const script = `
      import { mock } from 'bun:test';
      import { vscodeDouble } from ${JSON.stringify(join(import.meta.dir, '../testing/vscodeDouble.ts'))};
      const surface = vscodeDouble({ env: { sessionId: 'win' }, window: { terminals: [], tabGroups: { all: [] } } });
      mock.module('vscode', () => vscodeDouble(surface));
      const registry = await import(${JSON.stringify(join(import.meta.dir, 'terminalRegistry.vscode.ts'))});
      const tab = (name, env) => ({ name, processId: Promise.resolve(process.pid), creationOptions: { env } });
      ${body}
    `;
    const result = spawnSync('bun', ['-e', script], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return JSON.parse(readFileSync(file, 'utf8'));
  } finally { rmSync(home, { recursive: true }); }
}

const live = (terminalId: string | undefined, sessionId?: string) =>
  ({ terminalId, sessionId, pid: process.pid, kind: 'codex', startedAtMs: 1 });

describe('terminal registry', () => {
  test('Codex and Grok tabs without a minted session id are published by terminalId', () => {
    const reg = run(`
      surface.window.terminals = [
        // buildAgentTerminalEnv's shape when no session id was minted.
        tab('CX', { AGENT_TERMINAL_ID: 'cx-1759700000000-1', AGENT_SESSION_ID: '' }),
        tab('GK', { AGENT_TERMINAL_ID: 'gk-1759700000000-2', AGENT_SESSION_ID: '' }),
        tab('zsh', {}),
      ];
      await registry.publishLiveTerminals(await registry.snapshotOwnTerminals());
      await registry.publishLiveTerminals(await registry.snapshotOwnTerminals());
    `);
    const entries = Object.values(reg).flatMap((s: any) => s.entries);
    expect(entries.map((e: any) => [e.terminalId, e.kind])).toEqual([
      ['cx-1759700000000-1', 'codex'],
      ['gk-1759700000000-2', 'grok'],
    ]);
    for (const e of entries) expect(Object.keys(e)).not.toContain('sessionId');
  });

  test('a stale peer slice is pruned even while its pids are alive', () => {
    const now = Date.now();
    const reg = run(`await registry.publishLiveTerminals([]);`, {
      reloaded: { at: new Date(now - 11 * 60_000).toISOString(), entries: [live('cx-1-1')] },
      current: { at: new Date(now).toISOString(), entries: [live('gk-1-1')] },
    });
    expect(Object.keys(reg)).not.toContain('reloaded');
    expect(Object.keys(reg)).toContain('current');
  });

});
