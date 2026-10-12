import { describe, test, expect } from 'bun:test';
import {
  inlineContinueInstructions,
  buildAgentRunLaunchCommand,
  buildAutoRunLaunchCommand,
  buildResumeInput,
} from './resumeInBest';

describe('inlineContinueInstructions', () => {
  const REAL_CONTINUE_MD = `---
description: Resume a previous task - load context via sessions, assess state, then continue working
---

Resume previous work: $ARGUMENTS

You are picking up where a previous session left off.

## Step 1: Load the prior session

Run \`sessions $ARGUMENTS --markdown\` to load the transcript.`;

  test('strips YAML frontmatter', () => {
    const out = inlineContinueInstructions(REAL_CONTINUE_MD, 'abc123');
    expect(out).not.toContain('description:');
    expect(out).not.toMatch(/^---/);
    expect(out.startsWith('Resume previous work:')).toBe(true);
  });

  test('substitutes $ARGUMENTS with session id everywhere', () => {
    const out = inlineContinueInstructions(REAL_CONTINUE_MD, 'abc123');
    expect(out).not.toContain('$ARGUMENTS');
    expect(out).toContain('Resume previous work: abc123');
    expect(out).toContain('sessions abc123 --markdown');
  });

  test('handles body without frontmatter', () => {
    const out = inlineContinueInstructions('Just content with $ARGUMENTS', 'xyz');
    expect(out).toBe('Just content with xyz');
  });

  test('handles empty session id', () => {
    const out = inlineContinueInstructions('Run with $ARGUMENTS here.', '');
    expect(out).toBe('Run with  here.');
  });
});

describe('buildAgentRunLaunchCommand', () => {
  test('no version pin — balanced rotation picks the account', () => {
    expect(buildAgentRunLaunchCommand('codex')).toBe('agents run codex --interactive');
  });

  test('host is shell-quoted', () => {
    expect(buildAgentRunLaunchCommand('claude', 'yosemite-s0')).toBe(
      "agents run claude --interactive --device 'yosemite-s0'",
    );
  });

  test('claude gets --session-id; other harnesses do not', () => {
    expect(buildAgentRunLaunchCommand('claude', undefined, 'new-id')).toBe(
      'agents run claude --interactive --session-id new-id',
    );
    expect(buildAgentRunLaunchCommand('codex', undefined, 'ignored')).toBe(
      'agents run codex --interactive',
    );
  });

});

describe('buildAutoRunLaunchCommand', () => {
  test('full auto — the CLI resolves host, harness, and account', () => {
    expect(buildAutoRunLaunchCommand({ sessionId: 'new-id' })).toBe(
      'agents run auto --interactive --session-id new-id',
    );
  });

  test('host is shell-quoted; --session-id is always passed (claude-only on the CLI side)', () => {
    expect(buildAutoRunLaunchCommand({ host: 'yosemite-s0', sessionId: 'new-id' })).toBe(
      "agents run auto --interactive --device 'yosemite-s0' --session-id new-id",
    );
  });

});

describe('buildResumeInput', () => {
  test('uses /continue when the slash command is synced', () => {
    const input = buildResumeInput('old-abc', true, null);
    expect(input).toBe('/continue old-abc');
  });

  test('inlines continue.md body when slash command is missing', () => {
    const md = `---\ndescription: test\n---\n\nResume work: $ARGUMENTS`;
    const input = buildResumeInput('old-xyz', false, md);
    expect(input).toContain('Resume work: old-xyz');
    expect(input).not.toContain('$ARGUMENTS');
    expect(input).not.toContain('description:');
  });

  test('falls back to terse instructions when continue.md cannot be read', () => {
    const input = buildResumeInput('old-fallback', false, null);
    expect(input).toContain('old-fallback');
    expect(input).toContain('sessions old-fallback --markdown');
  });

  test('always uses the OLD session id, never a new one', () => {
    // This is a regression guard — the new session id is for the fresh
    // claude process's container; /continue must load the OLD transcript.
    const input = buildResumeInput('OLD-ID', true, null);
    expect(input).toBe('/continue OLD-ID');
    expect(input).not.toContain('NEW');
  });
});
