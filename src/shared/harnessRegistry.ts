// Shared harness registry derived from the CLI's agents.cli.ts snapshot.
// This is the single source of truth for harness ids and metadata used by both
// the extension core and the UI. Import from here instead of duplicating in
// ui/settings/constants/index.ts.

import { CLI_AGENT_IDS, CLI_AGENT_META, CliAgentId } from '../core/agents.cli';

/** Harness ids that are supported/launchable in the UI (excludes hard-deprecated agents). */
export const SUPPORTED_HARNESS_IDS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'openclaw',
  'copilot',
  'amp',
  'kiro',
  'goose',
  'antigravity',
  'grok',
  'kimi',
  'droid',
  'hermes',
  'pi',
  'muse',
  'warp',
] as const;

export type SupportedHarnessId = (typeof SUPPORTED_HARNESS_IDS)[number];

/** Display names for each supported harness. */
export const HARNESS_LABELS: Record<SupportedHarnessId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  copilot: 'Copilot',
  amp: 'Amp',
  kiro: 'Kiro',
  goose: 'Goose',
  antigravity: 'Antigravity',
  grok: 'Grok',
  kimi: 'Kimi',
  droid: 'Droid',
  hermes: 'Hermes',
  pi: 'Pi',
  muse: 'Muse',
  warp: 'Warp',
};

/** Install commands/URLs for each harness. */
export const HARNESS_INSTALL_INFO: Record<SupportedHarnessId, { command?: string; url?: string }> = {
  claude: { command: 'npm install -g @anthropic-ai/claude-code' },
  codex: { command: 'npm install -g @openai/codex' },
  cursor: { url: 'https://cursor.com' },
  opencode: { url: 'https://github.com/opencode-ai/opencode' },
  openclaw: { url: 'https://github.com/openai/openclaw' },
  copilot: { url: 'https://github.com/features/copilot' },
  amp: { url: 'https://amp.ai' },
  kiro: { url: 'https://kiro.ai' },
  goose: { url: 'https://github.com/0xgoose/goose' },
  antigravity: { command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', url: 'https://antigravity.google' },
  grok: { command: 'curl -fsSL https://x.ai/cli/install.sh | bash', url: 'https://x.ai' },
  kimi: { command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', url: 'https://code.kimi.com' },
  droid: { command: 'curl -fsSL https://app.factory.ai/cli | sh', url: 'https://factory.ai' },
  hermes: { url: 'https://github.com/anthropics/hermes' },
  pi: { url: 'https://pi.ai' },
  muse: { url: 'https://muse.ai' },
  warp: { url: 'https://warp.dev' },
};

/** Maps from agent display title abbreviation or name to harness id. */
export const HARNESS_TITLE_TO_ID: Record<string, SupportedHarnessId | string> = {
  'CC': 'claude',
  'CX': 'codex',
  'OC': 'opencode',
  'CR': 'cursor',
  'SH': 'shell',
  'AG': 'antigravity',
  'GK': 'grok',
  'KM': 'kimi',
  'DR': 'droid',
  'Claude': 'claude',
  'Codex': 'codex',
  'OpenCode': 'opencode',
  'Cursor': 'cursor',
  'Shell': 'shell',
  'Antigravity': 'antigravity',
  'Grok': 'grok',
  'Kimi': 'kimi',
  'Droid': 'droid',
};

/** Maps from harness id to display title abbreviation. */
export const HARNESS_ID_TO_TITLE: Record<SupportedHarnessId, string> = {
  claude: 'CC',
  codex: 'CX',
  opencode: 'OC',
  cursor: 'CR',
  antigravity: 'AG',
  grok: 'GK',
  kimi: 'KM',
  droid: 'DR',
  openclaw: 'OC',
  copilot: 'CP',
  amp: 'AM',
  kiro: 'KI',
  goose: 'GS',
  hermes: 'HM',
  pi: 'PI',
  muse: 'MS',
  warp: 'WP',
};

/** Swarm-capable agents (subset of supported harnesses). */
export const SWARM_CAPABLE_HARNESSES = ['claude', 'codex', 'opencode'] as const;
export type SwarmCapableHarness = (typeof SWARM_CAPABLE_HARNESSES)[number];
