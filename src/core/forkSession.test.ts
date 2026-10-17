import { describe, expect, test } from 'bun:test';
import { wrapNativeAgentCommand } from './agents';
import { buildForkSessionRequest, forkCommand, forkFailed, forkTabLabel } from './forkSession';

test('forkCommand is the bare fork verb here, and carries the device for another box', () => {
  expect(forkCommand('s1', undefined)).toBe("agents fork 's1'");
  expect(forkCommand('s1', 'yosemite-s0')).toContain("--device 'yosemite-s0'");
});

describe('buildForkSessionRequest', () => {
  test('a fork runs where its source lives', () => {
    expect(buildForkSessionRequest({ sessionId: 'session-123', agentKey: 'Codex' })).toEqual({
      ok: true,
      sessionId: 'session-123',
      agentKey: 'codex',
      host: undefined,
    });
    const remote = buildForkSessionRequest({ sessionId: 'session-remote', agentKey: 'claude', host: 'yosemite-s0' });
    if (!remote.ok) throw new Error('expected fork request');
    expect(forkCommand(remote.sessionId, remote.host)).toBe("agents fork 'session-remote' --device 'yosemite-s0'");
  });

  test('a picked device wins, and picking this machine brings a remote source home', () => {
    expect(buildForkSessionRequest({ sessionId: 's', agentKey: 'claude' }, { host: 'yosemite-m0' }))
      .toMatchObject({ ok: true, host: 'yosemite-m0' });
    expect(buildForkSessionRequest({ sessionId: 's', agentKey: 'claude', host: 'yosemite-s0' }, {}))
      .toMatchObject({ ok: true, host: undefined });
  });

  test('rejects a terminal without a session id or a recognized harness', () => {
    expect(buildForkSessionRequest({ agentKey: 'gemini' })).toEqual({ ok: false, reason: 'no_session' });
    expect(buildForkSessionRequest({ sessionId: 'session-123' })).toEqual({ ok: false, reason: 'no_agent' });
  });
});

describe('fork tab naming (PHNX-4387)', () => {
  test('names the tab after its source before it starts, and says when it failed', () => {
    expect(forkTabLabel('Fix fork across devices')).toBe('fork of Fix fork across devices');
    expect(forkTabLabel('Fix fork across devices', true)).toBe('fork failed: Fix fork across devices');
  });

  test('only the fork verb ending with a known nonzero status is a failed fork', () => {
    const line = wrapNativeAgentCommand(forkCommand('abc-123', 'yosemite-m5'), false);
    expect(forkFailed(line, 1)).toBe(true);
    expect(forkFailed(line, 0)).toBe(false);
    expect(forkFailed(line, undefined)).toBe(false);
    expect(forkFailed('git status', 1)).toBe(false);
  });
});
