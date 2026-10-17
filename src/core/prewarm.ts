// Session pre-warming - pure functions and types

import { shellQuote } from './shellQuote';

export type PrewarmAgentType = 'claude' | 'codex' | 'cursor' | 'opencode';

/** The keys that cleanly exit each pre-warmable agent. */
export const PREWARM_CONFIGS: Record<PrewarmAgentType, { exitSequence: string[] }> = {
  claude: { exitSequence: ['\x1b', '\x03', '\x03'] },  // Esc, Ctrl+C, Ctrl+C (need Esc first for Claude)
  codex: { exitSequence: ['\x03', '\x03'] },
  cursor: { exitSequence: ['\x03', '\x03'] },
  opencode: { exitSequence: ['\x03', '\x03'] },
};

/**
 * What a tab runs to become the session's live agent: the CLI's own recovery
 * command (`agents run auto --resume <id> --interactive`, what `agents ps focus`
 * opens for a session with no live pane), in place, with its preamble off
 * (`--quiet`). The CLI resolves the harness, origin device, account and cwd
 * itself. Never `--terminal` or `--device` here: from inside a tab those ask the
 * CLI to open the session on another surface, so the tab itself never became the
 * agent (the 2026-10-10 restore sat on that command).
 */
export function inTabResumeCommand(sessionId: string): string {
  return `agents run auto --resume ${shellQuote(sessionId)} --interactive --quiet`;
}

/**
 * Terminal options that make `command` the tab's own process, run by the user's
 * login shell. Nothing is typed into a prompt, so the tab's first screen is the
 * agent, not a command line.
 */
export function agentTabShell(command: string, shell: string | undefined): { shellPath: string; shellArgs: string[] } {
  return { shellPath: shell || '/bin/zsh', shellArgs: ['-l', '-i', '-c', command] };
}

/**
 * Check if an agent type supports pre-warming
 */
export function supportsPrewarming(agentType: string): agentType is PrewarmAgentType {
  return agentType === 'claude' || agentType === 'codex' || agentType === 'cursor' || agentType === 'opencode';
}

/**
 * Ctrl+C twice — the exit sequence for any agent without a {@link PREWARM_CONFIGS}
 * entry. Three of the four prewarm agents already use exactly this; the fourth
 * (Claude) needs a leading Esc. A resumable non-prewarm agent (grok/kimi/droid/
 * antigravity) is a Ctrl+C-to-quit CLI, so this is the safe default.
 */
export const DEFAULT_EXIT_SEQUENCE: readonly string[] = ['\x03', '\x03'];

/**
 * Keystrokes that cleanly exit a running agent before a reload/resume. Prewarm
 * agents use their tuned sequence; every other resumable harness falls back to
 * {@link DEFAULT_EXIT_SEQUENCE}. Keeping this beside {@link PREWARM_CONFIGS} means
 * reload never has to know which agents are prewarm-capable.
 */
export function exitSequenceFor(agentType: string): readonly string[] {
  return agentType in PREWARM_CONFIGS
    ? PREWARM_CONFIGS[agentType as PrewarmAgentType].exitSequence
    : DEFAULT_EXIT_SEQUENCE;
}
