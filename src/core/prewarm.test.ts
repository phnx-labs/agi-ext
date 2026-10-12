import { describe, test, expect } from 'bun:test';
import {
  PREWARM_CONFIGS,
  inTabResumeCommand,
  agentTabShell,
  supportsPrewarming,
  exitSequenceFor,
  DEFAULT_EXIT_SEQUENCE,
} from './prewarm';

describe('inTabResumeCommand', () => {
  test('runs the CLI recovery command in place, quietly', () => {
    expect(inTabResumeCommand('7b1cf038-8761-4e46-af43-5336e7e5a776')).toBe(
      "agents run auto --resume '7b1cf038-8761-4e46-af43-5336e7e5a776' --interactive --quiet",
    );
  });

  test("the resume command is the tab's own process, run by the login shell, never typed at a prompt", () => {
    expect(agentTabShell("agents run auto --resume 'x' --interactive --quiet", '/bin/bash')).toEqual({
      shellPath: '/bin/bash',
      shellArgs: ['-l', '-i', '-c', "agents run auto --resume 'x' --interactive --quiet"],
    });
    expect(agentTabShell('cmd', undefined).shellPath).toBe('/bin/zsh');
  });

  test('never asks the CLI for another surface from inside a tab', () => {
    const cmd = inTabResumeCommand('abc123');
    for (const flag of ['--terminal', '--vscodium', '--device', '--iterm', '--ghostty', '--tmux']) expect(cmd).not.toContain(flag);
    expect(cmd).not.toMatch(/(^|; )claude /);
  });

  test('quotes a session selector so it cannot break out of the command', () => {
    expect(inTabResumeCommand("a'; rm -rf /; #")).toBe("agents run auto --resume 'a'\\''; rm -rf /; #' --interactive --quiet");
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
