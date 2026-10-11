import { describe, test, expect } from 'bun:test';
import {
  generateTerminalId,
  buildAgentTerminalEnv,
  resolveRestoredVersion,
  SENSITIVE_ENV_KEYS
} from './terminals';

describe('generateTerminalId', () => {
  test('is <prefix>-<now>-<counter>', () => {
    const before = Date.now();
    const [prefix, timestamp, counter] = generateTerminalId('cx', 5).split('-');
    expect([prefix, counter]).toEqual(['cx', '5']);
    expect(parseInt(timestamp!, 10)).toBeGreaterThanOrEqual(before);
    expect(parseInt(timestamp!, 10)).toBeLessThanOrEqual(Date.now());
  });
});

describe('buildAgentTerminalEnv', () => {
  test('carries the tracking ids, empty when absent, and marks the tab an agent', () => {
    expect(buildAgentTerminalEnv('CC-123', 'session-abc', '/path/to/workspace', '2.1.113')).toMatchObject({
      AGENT_TERMINAL_ID: 'CC-123',
      AGENT_SESSION_ID: 'session-abc',
      AGENT_WORKSPACE_DIR: '/path/to/workspace',
      AGENT_VERSION: '2.1.113',
      AGENT_TERMINAL_KIND: 'agent',
    });
    expect(buildAgentTerminalEnv('CC-123', null, null)).toMatchObject({
      AGENT_SESSION_ID: '',
      AGENT_WORKSPACE_DIR: '',
      AGENT_VERSION: '',
    });
  });

  test('every SENSITIVE_ENV_KEY and every credential-shaped process.env key is set to null so VS Code deletes it', () => {
    const injected = ['MY_CUSTOM_SECRET', 'DB_PASSWORD', 'TEAM_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
    for (const key of injected) process.env[key] = 'dummy';
    try {
      const env = buildAgentTerminalEnv('CC-123', 'session-abc');
      for (const key of [...SENSITIVE_ENV_KEYS, ...injected, 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID']) {
        expect(env[key]).toBeNull();
      }
    } finally {
      for (const key of injected) delete process.env[key];
    }
  });

  test('does not scrub PWD, internal AGENT_ variables, or SQL schema keys (FOREIGN_KEY, PRIMARY_KEY)', () => {
    const kept = { PWD: '/some/path', AGENT_CUSTOM_VAR: 'value', FOREIGN_KEY: 'user_id', PRIMARY_KEY: 'id', PARTITION_KEY: 'tenant_id' };
    Object.assign(process.env, kept);
    try {
      const env = buildAgentTerminalEnv('CC-123', 'session-abc');
      for (const key of Object.keys(kept)) expect(env[key]).toBeUndefined();
    } finally {
      for (const key of Object.keys(kept)) delete process.env[key];
    }
  });

  test('a user shell tab keeps its normal environment and is marked a shell', () => {
    const original = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_realtoken';
    try {
      const env = buildAgentTerminalEnv('SH-123', null, '/ws', undefined, { scrubSensitive: false, kind: 'shell' });
      for (const key of SENSITIVE_ENV_KEYS) expect(env[key]).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      // The signal a user rc file gates its agent fast-path on; the id stays for tracking.
      expect(env.AGENT_TERMINAL_KIND).toBe('shell');
      expect(env.AGENT_TERMINAL_ID).toBe('SH-123');
    } finally {
      if (original === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = original;
    }
  });
});

// Regression guard for the "Cmd+Shift+J loses version pin across reload" bug:
// the restored tab's env version wins, else the persisted one; empty is absent.
describe('resolveRestoredVersion', () => {
  test('prefers the env version, then the persisted one', () => {
    expect(resolveRestoredVersion('2.1.118', '2.1.113')).toBe('2.1.118');
    expect(resolveRestoredVersion('', '2.1.113')).toBe('2.1.113');
  });

  test('is undefined when neither source has a version', () => {
    expect(resolveRestoredVersion(undefined, undefined)).toBeUndefined();
    expect(resolveRestoredVersion('', '')).toBeUndefined();
    expect(resolveRestoredVersion(null, null)).toBeUndefined();
  });
});
