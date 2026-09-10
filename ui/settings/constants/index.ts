import type {
  SwarmAgentType,
  TabId,
  TaskSource,
  NotificationSettings,
  EditorPreferences,
  ThemedIcon,
  BuiltInAgentConfig,
} from '../types'
import {
  SWARM_CAPABLE_HARNESSES,
  HARNESS_LABELS,
  HARNESS_INSTALL_INFO,
  HARNESS_TITLE_TO_ID,
  HARNESS_ID_TO_TITLE,
} from '@shared/harnessRegistry'

// All swarm-capable agents (derived from shared registry)
export const ALL_SWARM_AGENTS: SwarmAgentType[] = SWARM_CAPABLE_HARNESSES as any

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

// Swarm agent display labels (derived from shared registry)
export const SWARM_AGENT_LABELS: Record<SwarmAgentType, string> = {
  codex: HARNESS_LABELS.codex,
  claude: HARNESS_LABELS.claude,
  opencode: HARNESS_LABELS.opencode,
}

// Tab display labels
export const TAB_LABELS: Record<TabId, string> = {
  floor: 'Floor',
  bench: 'Bench',
  panel: 'Panel'
}

// Install commands/links for each agent (derived from shared registry)
export const AGENT_INSTALL_INFO: Record<string, { command?: string; url?: string }> = HARNESS_INSTALL_INFO as any

// Map from agent title (CC, CX, etc.) to key (claude, codex, etc.)
export const AGENT_TITLE_TO_KEY: Record<string, string> = HARNESS_TITLE_TO_ID

// Map from key to title (for dropdown)
export const AGENT_KEY_TO_TITLE: Record<string, string> = HARNESS_ID_TO_TITLE as any

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
