import { describe, expect, test, beforeEach } from 'bun:test';
import { resolveAgentsBin, runAgents, runCliArgs, clearAgentsBinCache, AgentsBinNotFoundError, bootstrapPath } from './agentsBin';

describe('agentsBin', () => {
  beforeEach(() => {
    clearAgentsBinCache();
  });

  test('resolveAgentsBin returns an absolute path that exists', async () => {
    // Slow zshrc files can push shell-based resolution past Bun's default 5s.

    const bin = await resolveAgentsBin();
    expect(bin.startsWith('/')).toBe(true);
    const fs = await import('fs');
    expect(fs.existsSync(bin)).toBe(true);
    expect(fs.statSync(bin).isFile()).toBe(true);
  });

  test('resolveAgentsBin caches across calls (same path)', async () => {
    const a = await resolveAgentsBin();
    const b = await resolveAgentsBin();
    expect(a).toBe(b);
  });

  test('runAgents executes the resolved binary and returns stdout', async () => {
    const { stdout } = await runAgents('--version', { timeout: 5_000 });
    // agents-cli prints something like "1.14.2"
    expect(/\d+\.\d+\.\d+/.test(stdout)).toBe(true);
  });

  test('runAgents forwards nested subcommand arguments to the installed CLI', async () => {
    const { stdout } = await runAgents('cloud run --help', { timeout: 5_000 });
    expect(stdout).toContain('Usage: agents cloud run');
    expect(stdout).toContain('--provider');
    expect(stdout).toContain('--repo');
  });

  test('runCliArgs resolves the standalone sessions CLI the same way as agents', async () => {
    const { stdout } = await runCliArgs('sessions', ['--version'], { timeout: 5_000 });
    expect(/\d+\.\d+\.\d+/.test(stdout)).toBe(true);
  });

  test('bootstrapPath includes the binary directory and node fallbacks', () => {
    const aug = bootstrapPath('/Users/test/.nvm/versions/node/v22.0.0/bin/agents');
    expect(aug.includes('/Users/test/.nvm/versions/node/v22.0.0/bin')).toBe(true);
    expect(aug.includes('/usr/bin')).toBe(true);
    expect(aug.includes('/bin')).toBe(true);
  });

  test('bootstrapPath puts the newest nvm node ahead of the binary dir and homebrew', () => {
    const dirs = bootstrapPath('/opt/homebrew/bin/agents').split(':');
    const nvm = dirs.findIndex((d) => d.includes('/.nvm/versions/node/'));
    const bin = dirs.indexOf('/opt/homebrew/bin');
    const shims = dirs.findIndex((d) => d.endsWith('/.agents/shims'));
    // A stale homebrew node must never shadow the nvm node the CLI was built for.
    if (nvm !== -1) expect(nvm).toBe(0);
    expect(bin).toBeGreaterThanOrEqual(0);
    expect(bin).toBeLessThan(shims);
    expect(dirs.indexOf('/usr/bin')).toBeGreaterThan(shims);
  });

  test('AgentsBinNotFoundError carries a useful message', () => {
    const err = new AgentsBinNotFoundError();
    expect(err.message.includes('agents CLI not found')).toBe(true);
    expect(new AgentsBinNotFoundError('sessions').message.includes('sessions CLI not found')).toBe(true);
    expect(err.name).toBe('AgentsBinNotFoundError');
  });
});
