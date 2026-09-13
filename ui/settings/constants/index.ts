import type {
  SwarmAgentType,
  TabId,
  NotificationSettings,
  EditorPreferences,
  ThemedIcon,
  BuiltInAgentConfig,
} from '../types'

import { BUILT_IN_AGENTS, CLI_AGENT_META, type CliAgentId } from '@shared/agents'

// The harnesses the swarm settings panel offers. This is the one hand-written
// list in the UI: SwarmAgentType is derived from it, ids must be CLI ids
// (drift.test.ts checks), and labels come from the CLI catalog.
export const ALL_SWARM_AGENTS = ['claude', 'codex', 'opencode'] as const satisfies readonly CliAgentId[]

export const SWARM_AGENT_LABELS: Record<SwarmAgentType, string> = Object.fromEntries(
  ALL_SWARM_AGENTS.map((id) => [id, CLI_AGENT_META[id].name]),
) as Record<SwarmAgentType, string>

// Default settings
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  style: 'native',
  enabledAgents: ['claude']
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  markdownViewerEnabled: true
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
  opencode: { url: 'https://github.com/opencode-ai/opencode' },
  cursor: { url: 'https://cursor.com' },
  antigravity: { command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', url: 'https://antigravity.google' },
  grok: { command: 'curl -fsSL https://x.ai/cli/install.sh | bash', url: 'https://x.ai' },
  kimi: { command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', url: 'https://code.kimi.com' },
  droid: { command: 'curl -fsSL https://app.factory.ai/cli | sh', url: 'https://factory.ai' },
}


// Map from agent title (uppercase prefix like 'CC', 'CX') or name ('Claude', 'Codex')
// to key (claude, codex, etc.). Derived from BUILT_IN_AGENTS.
export const AGENT_TITLE_TO_KEY: Record<string, string> = (() => {
  const mapping: Record<string, string> = {}
  for (const agent of BUILT_IN_AGENTS) {
    mapping[agent.title] = agent.key
    // Shell is presented but is not a CLI harness; its display name is fixed.
    mapping[agent.key === 'shell' ? 'Shell' : CLI_AGENT_META[agent.key as CliAgentId].name] = agent.key
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
    { key: 'antigravity', name: 'Antigravity', icon: icons.antigravity },
    { key: 'grok', name: 'Grok', icon: icons.grok },
    { key: 'kimi', name: 'Kimi', icon: icons.kimi },
    { key: 'droid', name: 'Droid', icon: icons.droid },
    { key: 'opencode', name: 'OpenCode', icon: icons.opencode },
    { key: 'cursor', name: 'Cursor', icon: icons.cursor },
    { key: 'shell', name: 'Shell', icon: icons.shell },
  ]
}
