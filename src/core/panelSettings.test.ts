import { test, expect } from 'bun:test'
import { applyPanelSetting, renderPanelSettings } from './panelSettings'
import { getDefaultSettings } from './settings'

test('each Settings control writes its own key and nothing else', () => {
  const base = getDefaultSettings()
  base.quickLaunch = { slots: { '1': { agent: 'claude', modelAlias: 'opus' } } }
  expect(applyPanelSetting(base, 'display.showSessionIdInTitles', false)?.display).toEqual({ ...base.display, showSessionIdInTitles: false })
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

test('Session cards: three pickers write cards.*; banners are the AGI Menu\'s, so there is no alert setting', () => {
  const base = getDefaultSettings()
  expect(applyPanelSetting(base, 'cards.asks', 'off')?.cards).toEqual({ asks: 'off', options: 'titles', question: 'two' })
  expect(applyPanelSetting(base, 'cards.options', 'details')?.cards?.options).toBe('details')
  expect(applyPanelSetting(base, 'cards.question', 'full')?.cards?.question).toBe('full')
  expect(applyPanelSetting(base, 'cards.asks', 'loud')).toBeNull()
  expect(applyPanelSetting(base, 'notifications.enabled', true)).toBeNull()
  const html = renderPanelSettings({ settings: { ...base, cards: { asks: 'question', options: 'titles', question: 'two' } }, defaultAgentTitle: 'CC', secondaryAgentTitle: 'CX', modifier: '⌘⇧' })
  expect(html).toContain('<div class="sh">Session cards</div>')
  expect(html).toMatch(/data-setting="cards\.asks"[^>]*><option value="answers">With answers<\/option><option value="question" selected>Question only<\/option><option value="off">Off<\/option>/)
  expect(html).toContain('<option value="titles" selected>Titles only</option>')
  expect(html).toContain('<option value="two" selected>Two lines</option>')
  expect(html).not.toContain('Approval alerts')
  expect(html).not.toContain('notifications.')
})
