import { test, expect } from 'bun:test'
import { applyPanelSetting, renderPanelSettings } from './panelSettings'
import { getDefaultSettings } from './settings'

test('each Settings control writes its own key and nothing else', () => {
  const base = getDefaultSettings()
  base.quickLaunch = { slots: { '1': { agent: 'claude', modelAlias: 'opus' } } }
  expect(applyPanelSetting(base, 'display.showSessionIdInTitles', false)?.display).toEqual({ ...base.display, showSessionIdInTitles: false })
  expect(applyPanelSetting(base, 'notifications.style', 'vscode')?.notifications).toMatchObject({ style: 'vscode', enabled: base.notifications!.enabled })
  // A slot keeps its model while its agent is unchanged, starts fresh for a new agent, and clears to none.
  expect(applyPanelSetting(base, 'quickLaunch.1', 'claude')?.quickLaunch?.slots?.['1']).toEqual({ agent: 'claude', modelAlias: 'opus' })
  expect(applyPanelSetting(base, 'quickLaunch.1', 'codex')?.quickLaunch?.slots?.['1']).toEqual({ agent: 'codex' })
  expect(applyPanelSetting(base, 'quickLaunch.1', '')?.quickLaunch?.slots).toEqual({})
  expect(applyPanelSetting(base, 'display.prompts', true)).toBeNull()
  expect(applyPanelSetting(base, 'quickLaunch.1', 'gemini')).toBeNull()
  const html = renderPanelSettings({ settings: base, defaultAgentTitle: 'CC', secondaryAgentTitle: 'CX', modifier: '⌘⇧' })
  expect(html).toContain('<kbd>⌘⇧B</kbd>')
  expect(html).toMatch(/data-setting="secondaryAgent"[^>]*>(<option[^>]*>[^<]*<\/option>)*<option value="CX" selected>Codex/)
})
