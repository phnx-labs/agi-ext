import { describe, test, expect } from 'bun:test';
import {
  PREWARM_CONFIGS,
  buildVersionedResumeCommand,
  supportsPrewarming,
  exitSequenceFor,
  DEFAULT_EXIT_SEQUENCE,
} from './prewarm';

describe('buildVersionedResumeCommand', () => {
  const FLEET_AGENTS = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'grok', 'kimi', 'droid', 'antigravity'];

  test('every fleet agent delegates to the canonical sessions command', () => {
    for (const agent of FLEET_AGENTS) {
      expect(buildVersionedResumeCommand(agent, 'abc123')).toBe(
        "agents sessions resume 'abc123' --vscodium",
      );
    }
  });

  test('offloaded metadata does not override CLI routing', () => {
    for (const agent of FLEET_AGENTS) {
      expect(buildVersionedResumeCommand(agent, 'abc123', undefined, 'yosemite-s1')).toBe(
        "agents sessions resume 'abc123' --vscodium",
      );
    }
  });

  test('no raw harness-binary resume command is ever emitted', () => {
    const rawPatterns = [
      /^claude(@[^ ]+)? -r /,
      /^codex(@[^ ]+)? resume /,
      /^gemini(@[^ ]+)? --resume /,
      /^cursor-agent(@[^ ]+)? --resume=/,
      /^opencode(@[^ ]+)? -s /,
    ];
    for (const agent of FLEET_AGENTS) {
      const localCmd = buildVersionedResumeCommand(agent, 'abc123');
      const hostCmd = buildVersionedResumeCommand(agent, 'abc123', undefined, 'zion');
      const versionCmd = buildVersionedResumeCommand(agent, 'abc123', '1.2.3');
      for (const cmd of [localCmd, hostCmd, versionCmd]) {
        for (const pattern of rawPatterns) {
          expect(cmd).not.toMatch(pattern);
        }
        expect(cmd).toBe("agents sessions resume 'abc123' --vscodium");
      }
    }
  });

  test('version argument is ignored (CLI resolves originating version)', () => {
    // The CLI resolves the version; AGI EXT must not pin one.
    expect(buildVersionedResumeCommand('claude', 'abc123', '2.1.113')).toBe(
      "agents sessions resume 'abc123' --vscodium",
    );
  });

  test('quotes a session selector so it cannot break out of the command', () => {
    expect(buildVersionedResumeCommand('claude', "a'; rm -rf /; #")).toBe(
      "agents sessions resume 'a'\\''; rm -rf /; #' --vscodium",
    );
  });

  test('resume launches with the original session id and zero tmux wrapper', () => {
    const sessionId = '7b1cf038-8761-4e46-af43-5336e7e5a776';
    const cmd = buildVersionedResumeCommand('claude', sessionId);
    expect(cmd).toBe(`agents sessions resume '${sessionId}' --vscodium`);
    expect(cmd).not.toContain('tmux');
    expect(cmd).not.toContain('agents tmux');
    expect(cmd).not.toContain('\n');
  });

  test('persisted remote metadata does not bypass canonical routing', () => {
    expect(buildVersionedResumeCommand('claude', '8a7b8d22-c741-4a51-91e7-2112948547dd', undefined, 'yosemite-s1')).toBe(
      "agents sessions resume '8a7b8d22-c741-4a51-91e7-2112948547dd' --vscodium",
    );
  });
});

describe('supportsPrewarming', () => {
  test('returns true for supported agents', () => {
    expect(supportsPrewarming('claude')).toBe(true);
    expect(supportsPrewarming('codex')).toBe(true);
    expect(supportsPrewarming('gemini')).toBe(false);
    expect(supportsPrewarming('cursor')).toBe(true);
    expect(supportsPrewarming('opencode')).toBe(true);
  });

  test('returns false for unsupported agents', () => {
    expect(supportsPrewarming('random')).toBe(false);
  });
});

describe('exitSequenceFor', () => {
  test('prewarm agents use their tuned exit sequence', () => {
    // Claude needs a leading Esc; the other four use Ctrl+C twice.
    expect(exitSequenceFor('claude')).toEqual(['\x1b', '\x03', '\x03']);
    expect(exitSequenceFor('codex')).toEqual(['\x03', '\x03']);
    expect(exitSequenceFor('opencode')).toEqual(['\x03', '\x03']);
  });

  test('non-prewarm harnesses fall back to Ctrl+C twice (#1747)', () => {
    // grok/kimi/droid/antigravity have no PREWARM_CONFIGS entry but must still
    // be reload-able; the generic exit is the default.
    for (const agent of ['grok', 'kimi', 'droid', 'antigravity']) {
      expect(exitSequenceFor(agent)).toEqual([...DEFAULT_EXIT_SEQUENCE]);
    }
    expect(DEFAULT_EXIT_SEQUENCE).toEqual(['\x03', '\x03']);
  });
});

describe('PREWARM_CONFIGS', () => {
  test('claude config has correct exit sequence', () => {
    // Claude needs Esc, then Ctrl+C twice
    expect(PREWARM_CONFIGS.claude.exitSequence).toEqual(['\x1b', '\x03', '\x03']);
  });

  test('codex config has correct exit sequence', () => {
    // Codex just needs Ctrl+C twice
    expect(PREWARM_CONFIGS.codex.exitSequence).toEqual(['\x03', '\x03']);
  });

  test('cursor config has correct settings', () => {
    expect(PREWARM_CONFIGS.cursor.command).toBe('cursor-agent');
    expect(PREWARM_CONFIGS.cursor.exitSequence).toEqual(['\x03', '\x03']);
  });
});
