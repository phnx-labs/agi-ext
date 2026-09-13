import React, { useState } from 'react'
import type { IconConfig } from '../../types'
import { getIcons } from '../../hooks/useVscodeApi'
import { getIcon } from '../../utils/icons'

export type AgentId = 'claude' | 'codex' | 'opencode' | 'cursor' | 'shell' | 'watchdog' | 'agents' | 'antigravity' | 'grok' | 'kimi' | 'droid'

const BG: Record<AgentId, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  opencode: 'var(--opencode)',
  cursor: 'var(--cursor)',
  shell: 'var(--shell)',
  watchdog: 'var(--ds-text-dim)',
  agents: 'var(--agents, var(--ds-text-dim))',
  antigravity: 'var(--antigravity, var(--ds-text-dim))',
  grok: 'var(--grok, var(--ds-text-dim))',
  kimi: 'var(--kimi, var(--ds-text-dim))',
  droid: 'var(--droid, var(--ds-text-dim))',
}

const LETTER: Record<AgentId, string> = {
  claude: 'C',
  codex: 'X',
  opencode: 'O',
  cursor: 'K',
  shell: '$',
  watchdog: 'W',
  agents: 'A',
  antigravity: 'A',
  grok: 'R',
  kimi: 'K',
  droid: 'D',
}

// Which window.__ICONS__ key backs each agent id (letter fallback for the rest).
const ICON_KEY: Partial<Record<string, keyof IconConfig>> = {
  claude: 'claude', codex: 'codex', opencode: 'opencode',
  cursor: 'cursor', shell: 'shell', agents: 'agents', antigravity: 'antigravity', grok: 'grok',
  kimi: 'kimi', droid: 'droid',
}

/** Resolve a real brand logo URI for an agent id, honoring the active theme. '' if none. */
function resolveIcon(id: string): string {
  try {
    const icons = getIcons()
    if (!icons) return ''
    const key = ICON_KEY[id]
    if (!key) return ''
    const isLight = typeof document !== 'undefined' && !!document.querySelector('.swarmify-root.theme-light')
    return getIcon(icons[key] as string | { dark: string; light: string }, isLight)
  } catch {
    return ''
  }
}

export function AgentAvatar({ id, size = 18, title }: {
  id: AgentId | string
  size?: 14 | 16 | 18 | 20 | 24 | 28
  title?: string
}) {
  const normalized = id.toLowerCase()
  const src = resolveIcon(normalized)
  const [failed, setFailed] = useState(false)
  const showImg = !!src && !failed
  const bg = showImg ? 'var(--ds-bg-sunken, var(--sunken, transparent))' : (BG[normalized as AgentId] ?? 'var(--ds-text-dim)')
  const letter = LETTER[normalized as AgentId] ?? id.slice(0, 1).toUpperCase()
  return (
    <span
      className={`sw-avatar sz-${size}`}
      style={{ background: bg }}
      title={title ?? id}
    >
      {showImg
        ? <img src={src} alt={id} className="sw-avatar-img" onError={() => setFailed(true)} />
        : letter}
    </span>
  )
}

export function agentIdFromPrefix(prefix: string | null | undefined): AgentId | null {
  switch (prefix) {
    case 'CC': return 'claude'
    case 'CX': return 'codex'
    case 'OC': return 'opencode'
    case 'CR': return 'cursor'
    case 'SH': return 'shell'
    case 'AG': return 'antigravity'
    case 'GK': return 'grok'
    case 'KM': return 'kimi'
    case 'DR': return 'droid'
    default: return null
  }
}
