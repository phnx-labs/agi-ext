import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ALL_SWARM_AGENTS } from '../core/settings';
import { buildCloudDispatchCommand, writeSwarmConfig } from './settingsActions';

const temporaryDirectories: string[] = [];
function scratch(): string {
  const root = path.resolve('.agents/scratch');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'settings-actions-'));
  temporaryDirectories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true });
});

describe('shared agent configuration writes', () => {
  test.each(['{ broken', 'null', '[]', '{"agents":[]}', '{"agents":{"claude":false}}'])(
    'leaves invalid configuration byte-for-byte intact: %s', (original) => {
      const file = path.join(scratch(), 'config.json');
      fs.writeFileSync(file, original);
      expect(() => writeSwarmConfig(file, ['claude'])).toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    },
  );

  test('preserves unrelated configuration and agent fields', () => {
    const file = path.join(scratch(), 'config.json');
    const original = {
      theme: 'light', providers: { custom: { region: 'west' } },
      agents: { claude: { enabled: false, models: { default: 'custom' }, provider: 'custom' }, custom: { opaque: true } },
    };
    fs.writeFileSync(file, JSON.stringify(original));
    writeSwarmConfig(file, ['claude']);
    const actual = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(actual.theme).toBe(original.theme);
    expect(actual.providers).toEqual(original.providers);
    expect(actual.agents.custom).toEqual(original.agents.custom);
    expect(actual.agents.claude).toEqual({ ...original.agents.claude, enabled: true });
    for (const agent of ALL_SWARM_AGENTS) expect(actual.agents[agent].enabled).toBe(agent === 'claude');
  });

  test('creates a missing configuration and adds a missing agents section', () => {
    const file = path.join(scratch(), 'nested', 'config.json');
    writeSwarmConfig(file, []);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).agents.claude.enabled).toBe(false);
    fs.writeFileSync(file, '{"unrelated":42}');
    writeSwarmConfig(file, ['claude']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).unrelated).toBe(42);
  });

  test('propagates read errors without replacing the existing path', () => {
    const dir = scratch();
    expect(() => writeSwarmConfig(dir, [])).toThrow();
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});

describe('cloud dispatch shell boundary', () => {
  test('round-trips metacharacters as literal argv without executing them', () => {
    const dir = scratch();
    const sentinel = path.join(dir, 'injected');
    const payload = `topic'; touch ${sentinel}; echo '$(touch ${sentinel})\nnext`;
    const request = { provider: 'rush' as const, agent: payload, repo: `owner/${payload}`, branch: payload, mode: 'edit' as const, prompt: payload };
    const command = buildCloudDispatchCommand(request);
    // A shell function prints the real argv without launching an agent or cloud task.
    const output = execFileSync('/bin/sh', ['-c', `agents() { printf '%s\\0' "$@"; }; ${command}`]);
    expect(output.toString().split('\0').slice(0, -1)).toEqual([
      'cloud', 'run', '--provider', 'rush', '--agent', payload,
      '--repo', request.repo, '--branch', payload, '--mode', 'edit', '-p', payload,
    ]);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  test.each([undefined, '', 'auto (new branch)'])('omits automatic branch choice %s', (branch) => {
    const command = buildCloudDispatchCommand({ provider: 'factory', agent: 'codex', repo: 'owner/repo', branch, mode: 'full', prompt: 'hello' });
    expect(command).not.toContain('--branch');
  });
});
