import type { DisplayPreferences } from '../types'

const TERMINAL_PREFIX_NAMES: Record<string, string> = {
  CC: 'Claude',
  CX: 'Codex',
  GX: 'Gemini',
  OC: 'OpenCode',
  CR: 'Cursor',
  SH: 'Shell',
  AG: 'Antigravity',
  GK: 'Grok',
  KM: 'Kimi',
  DR: 'Droid',
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  grok: 'Grok',
  kimi: 'Kimi',
  droid: 'Droid',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  shell: 'Shell',
}

export interface TerminalTitlePreviewOptions {
  label?: string | null
  sessionChunk?: string | null
  isFocused?: boolean
}

export function formatPreviewTerminalTitle(
  prefix: string,
  display: DisplayPreferences,
  options?: TerminalTitlePreviewOptions
): string {
  let showLabelsInTitles = display.showLabelsInTitles
  if (options?.isFocused === false && display.showLabelOnlyOnFocus) {
    showLabelsInTitles = false
  }

  const base = display.showFullAgentNames
    ? (TERMINAL_PREFIX_NAMES[prefix] || prefix)
    : prefix
  const sessionChunk = display.showSessionIdInTitles ? options?.sessionChunk?.trim() : null
  const label = options?.label?.trim()

  if (sessionChunk) {
    if (showLabelsInTitles && label) {
      return `${base} ${sessionChunk} - ${label}`
    }
    return `${base} ${sessionChunk}`
  }

  if (!showLabelsInTitles || !label) {
    return base
  }

  if (display.labelReplacesTitle) {
    return label
  }

  return `${base} - ${label}`
}
