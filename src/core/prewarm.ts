// Session pre-warming - pure functions and types
// VS Code integration in prewarm.vscode.ts

export type PrewarmAgentType = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';

/** Configuration for pre-warming per agent type */
export interface PrewarmConfig {
  agentType: PrewarmAgentType;
  command: string;              // CLI command (e.g., 'claude', 'codex', 'gemini')
  statusCommand: string;        // Command to get session info (e.g., '/status', '/stats')
  sessionIdPattern: RegExp;     // Pattern to extract session ID from output
  exitSequence: string[];       // Key sequences to cleanly exit
}

/** Terminal-to-session mapping for crash recovery */
export interface TerminalSessionMapping {
  terminalId: string;           // AGENT_TERMINAL_ID
  sessionId: string;            // CLI session ID
  agentType: PrewarmAgentType;
  createdAt: number;
  workingDirectory: string;
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
  gemini: {
    agentType: 'gemini',
    command: 'gemini',
    statusCommand: '/stats',
    // Matches session ID pattern
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
 * Build the canonical resume command for any harness. The legacy parameters
 * remain at call sites as display metadata; none may override CLI policy.
 */
export function buildVersionedResumeCommand(
  _agentType: PrewarmAgentType | string,
  sessionId: string,
  _version?: string,
  _host?: string,
): string {
  return `agents sessions resume ${shellQuoteArg(sessionId)} --vscodium`;
}

/** Quote a session selector only when shell syntax requires it. */
function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9._:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Check if an agent type supports pre-warming
 */
export function supportsPrewarming(agentType: string): agentType is PrewarmAgentType {
  return agentType === 'claude' || agentType === 'codex' || agentType === 'gemini' || agentType === 'cursor' || agentType === 'opencode';
}

/**
 * Ctrl+C twice — the exit sequence for any agent without a {@link PREWARM_CONFIGS}
 * entry. Four of the five prewarm agents already use exactly this; the fifth
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

export type BlockedReason = 'trust_prompt' | 'auth_required' | 'rate_limit' | 'unknown_prompt';
export type FailedReason = 'timeout' | 'cli_error' | 'parse_error' | 'cli_not_found';

export interface PrewarmResult {
  status: 'success' | 'blocked' | 'failed';
  sessionId?: string;
  blockedReason?: BlockedReason;
  failedReason?: FailedReason;
  rawOutput?: string;
}
