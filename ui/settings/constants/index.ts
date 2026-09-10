import type {
  SwarmAgentType,
  TabId,
  TaskSource,
  NotificationSettings,
  EditorPreferences,
  ThemedIcon,
  BuiltInAgentConfig,
} from '../types'

import { BUILT_IN_AGENTS, CLI_AGENT_META, CLI_AGENT_IDS, type CliAgentId } from '@shared/agents'

// All swarm-capable agents — derived from BUILT_IN_AGENTS (presented agents).
// Filters to the subset that matches SwarmAgentType union (the four agents the
// UI's swarm settings panel offers).
export const ALL_SWARM_AGENTS: SwarmAgentType[] = BUILT_IN_AGENTS
  .filter(a => a.key !== 'shell' && !isNonSwarmAgent(a.key))
  .map(a => a.key as SwarmAgentType)

// Swarm agent display labels — derived from CLI_AGENT_META for each swarm agent.
export const SWARM_AGENT_LABELS: Record<SwarmAgentType, string> = {
  claude: CLI_AGENT_META.claude.name,
  codex: CLI_AGENT_META.codex.name,
  gemini: CLI_AGENT_META.gemini.name,
  opencode: CLI_AGENT_META.opencode.name,
}

// Helper to check if an agent key should not be in SwarmAgentType.
// Extend this if the SwarmAgentType union changes.
function isNonSwarmAgent(key: string): boolean {
  return !['claude', 'codex', 'gemini', 'opencode'].includes(key)
}

// Default settings
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  style: 'native',
  enabledAgents: ['claude']
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  markdownViewerEnabled: true
}

// Source badges for task sources
export const SOURCE_BADGES: Record<TaskSource, { label: string; color: string }> = {
  linear: { label: 'LN', color: '#5e6ad2' },
  github: { label: 'GH', color: '#238636' }
}

// Tab display labels
export const TAB_LABELS: Record<TabId, string> = {
  floor: 'Floor',
  bench: 'Bench',
  panel: 'Panel'
}

// Install commands/links for each agent — keyed by CliAgentId so only valid CLI
// agent IDs are permitted. Entries that existed on main are preserved; new agents
// added to the CLI must be added here explicitly (they won't appear by accident).
export const AGENT_INSTALL_INFO: Partial<Record<CliAgentId, { command?: string; url?: string }>> = {
  claude: { command: 'npm install -g @anthropic-ai/claude-code' },
  codex: { command: 'npm install -g @openai/codex' },
  gemini: { command: 'npm install -g @google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli' },
  opencode: { url: 'https://github.com/opencode-ai/opencode' },
  cursor: { url: 'https://cursor.com' },
  antigravity: { command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', url: 'https://antigravity.google' },
  grok: { command: 'curl -fsSL https://x.ai/cli/install.sh | bash', url: 'https://x.ai' },
  kimi: { command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', url: 'https://code.kimi.com' },
  droid: { command: 'curl -fsSL https://app.factory.ai/cli | sh', url: 'https://factory.ai' },
}

// agents-cli package for managing agent configurations
export const AGENTS_CLI_PACKAGE = '@swarmify/agents-cli'

// Map from agent title (uppercase prefix like 'CC', 'CX') or name ('Claude', 'Codex')
// to key (claude, codex, etc.). Derived from BUILT_IN_AGENTS.
export const AGENT_TITLE_TO_KEY: Record<string, string> = (() => {
  const mapping: Record<string, string> = {}
  for (const agent of BUILT_IN_AGENTS) {
    mapping[agent.title] = agent.key
    if (agent.key !== 'shell') {
      const cliId = agent.key as CliAgentId
      mapping[CLI_AGENT_META[cliId].name] = agent.key
    }
  }
  return mapping
})()

// Map from key to title (uppercase prefix for dropdown). Derived from BUILT_IN_AGENTS.
export const AGENT_KEY_TO_TITLE: Record<string, string> = (() => {
  const mapping: Record<string, string> = {}
  for (const agent of BUILT_IN_AGENTS) {
    if (agent.key !== 'shell') {
      mapping[agent.key] = agent.title
    }
  }
  return mapping
})()

// Notification-capable agents
// Markdown rendering allowed tags
export const TODO_MARKDOWN_ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'span',
  'ul'
]

// Markdown rendering allowed attributes
export const TODO_MARKDOWN_ALLOWED_ATTRS = ['href', 'title', 'target', 'rel', 'class']

// Sessions per page for pagination
export const SESSIONS_PER_PAGE = 20

// Factory function to create BUILT_IN_AGENTS (needs icons at runtime)
export function createBuiltInAgents(icons: {
  claude: string
  codex: ThemedIcon
  gemini: string
  opencode: string
  cursor: ThemedIcon
  shell: string
  antigravity: string
  grok: ThemedIcon
  kimi: string
  droid: ThemedIcon
}): BuiltInAgentConfig[] {
  return [
    { key: 'claude', name: 'Claude', icon: icons.claude },
    { key: 'codex', name: 'Codex', icon: icons.codex },
    // gemini is hard-deprecated (Antigravity is the replacement) — the extension
    // registers no `agents.newGemini` command, so it must never be offered as a
    // launchable agent. supported:false filters it out of the spawn menus.
    { key: 'gemini', name: 'Gemini', icon: icons.gemini, supported: false },
    { key: 'antigravity', name: 'Antigravity', icon: icons.antigravity },
    { key: 'grok', name: 'Grok', icon: icons.grok },
    { key: 'kimi', name: 'Kimi', icon: icons.kimi },
    { key: 'droid', name: 'Droid', icon: icons.droid },
    { key: 'opencode', name: 'OpenCode', icon: icons.opencode },
    { key: 'cursor', name: 'Cursor', icon: icons.cursor },
    { key: 'shell', name: 'Shell', icon: icons.shell },
  ]
}
