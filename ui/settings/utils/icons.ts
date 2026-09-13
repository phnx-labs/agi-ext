import type { ThemedIcon, ContextAgentType, IconConfig } from '../types'

/**
 * Get the appropriate icon path based on theme
 */
export function getIcon(icon: string | ThemedIcon | null | undefined, isLight: boolean): string {
  if (!icon) return ''
  return typeof icon === 'string' ? icon : isLight ? icon.light : icon.dark
}

export function getAgentIcon(icons: IconConfig, key: string, isLight: boolean): string {
  return getIcon(Object.entries(icons).find(([name]) => name === key)?.[1], isLight)
}
