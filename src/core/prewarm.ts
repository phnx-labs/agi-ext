// Session pre-warming - pure functions and types

import { shellQuote } from './deviceDispatchShell';

export type PrewarmAgentType = 'claude' | 'codex' | 'cursor' | 'opencode';

/** Configuration for pre-warming per agent type */
export interface PrewarmConfig {
  agentType: PrewarmAgentType;
  command: string;              // CLI command (e.g., 'claude', 'codex')
  statusCommand: string;        // Command to get session info (e.g., '/status', '/stats')
  sessionIdPattern: RegExp;     // Pattern to extract session ID from output
  exitSequence: string[];       // Key sequences to cleanly exit
}

// Pre-warm configurations per agent
export const PREWARM_CONFIGS: Record<PrewarmAgentType, PrewarmConfig> = {
  claude: {
    agentType: 'claude',
    command: 'claude',
    statusCommand: '/status',
    // Matches: "Session ID: 01J9..."/"Session: 01J9..."
    sessionIdPattern: /Session(?:\s+ID)?:\s*([a-zA-Z0-9_-]+)/i,
    exitSequence: ['\x1b', '\x03', '\x03'],  // Esc, Ctrl+C, Ctrl+C (need Esc first for Claude)
  },
  codex: {
    agentType: 'codex',
    command: 'codex',
    statusCommand: '/status',
    // Matches: "Session: 01J9..." or "Session ID: 01J9..."
    sessionIdPattern: /Session(?:\s+ID)?:\s*([a-zA-Z0-9_-]+)/i,
    exitSequence: ['\x03', '\x03'],  // Ctrl+C twice
  },
  cursor: {
    agentType: 'cursor',
    command: 'cursor-agent',
    statusCommand: '/status',
    // Matches session ID pattern
    sessionIdPattern: /Session(?:\s+ID)?:\s*([a-zA-Z0-9_-]+)/i,
    exitSequence: ['\x03', '\x03'],  // Ctrl+C twice
  },
  opencode: {
    agentType: 'opencode',
    command: 'opencode',
    statusCommand: '',  // OpenCode doesn't have /status - session ID tracked via session list
    // Matches OpenCode session ID format: ses_xxx
    sessionIdPattern: /ses_[a-zA-Z0-9]+/i,
    exitSequence: ['\x03', '\x03'],  // Ctrl+C twice
  }
};

/**
 * What a tab runs to become the session's live agent: the CLI's strict resume,
 * in place, with its routing banners off (`-q`). The CLI restores the harness,
 * device, account and cwd itself. Never `--vscodium` or `--device` here: from
 * inside a tab those ask the CLI to open the session on another surface, so the
 * tab itself never became the agent (the 2026-10-10 restore sat on that command).
 */
export function inTabResumeCommand(sessionId: string): string {
  return `agents sessions resume ${shellQuote(sessionId)} -q`;
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

// === Blocking Prompt Detection ===

type BlockedReason = 'trust_prompt' | 'auth_required' | 'rate_limit' | 'unknown_prompt';
type FailedReason = 'timeout' | 'cli_error' | 'parse_error' | 'cli_not_found';
