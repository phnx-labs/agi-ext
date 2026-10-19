import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { applyPanelSetting, deviceSettingArgv, parseSettingsDevices, renderPanelSettings } from './panelSettings'
import { DEFAULT_CARD_SETTINGS, getDefaultSettings } from './settings'

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
  const html = renderPanelSettings({ settings: base, devices: null, defaultAgentTitle: 'CC', secondaryAgentTitle: 'CX', modifier: '⌘⇧' })
  expect(html).toContain('<kbd>⌘⇧B</kbd>')
  expect(html).toMatch(/data-setting="secondaryAgent"[^>]*>(<option[^>]*>[^<]*<\/option>)*<option value="CX" selected>Codex/)
})

test('Tabs: Review and Issues turn off on their own; Made is chips unless Settings asks for previews', () => {
  const base = getDefaultSettings()
  expect(applyPanelSetting(base, 'tabs.prs', false)?.tabs).toEqual({ prs: false, tickets: true })
  expect(applyPanelSetting(base, 'tabs.sessions', false)).toBeNull()
  expect(applyPanelSetting(base, 'tabs.tickets', 'off')).toBeNull()
  expect(DEFAULT_CARD_SETTINGS.made).toBe('chips')
  expect(applyPanelSetting(base, 'cards.made', 'previews')?.cards?.made).toBe('previews')
  expect(applyPanelSetting(base, 'cards.made', 'tiles')).toBeNull()
  const html = renderPanelSettings({ settings: { ...base, tabs: { prs: false, tickets: true } }, devices: null, defaultAgentTitle: 'CC', secondaryAgentTitle: 'CX', modifier: '⌘⇧' })
  expect(html).toContain('<input type="checkbox" data-setting="tabs.prs">')
  expect(html).toContain('<input type="checkbox" data-setting="tabs.tickets" checked>')
  expect(html).toContain('data-setting="cards.made"')
})

test('Session cards: pickers and part toggles write cards.*; banners are the AGI Menu\'s, so there is no alert setting', () => {
  const base = getDefaultSettings()
  expect(applyPanelSetting(base, 'cards.asks', 'off')?.cards).toEqual({ ...DEFAULT_CARD_SETTINGS, asks: 'off' })
  // A click fronts the tab and an answer goes at once unless Settings says otherwise (owner video, 2026-10-17).
  expect(DEFAULT_CARD_SETTINGS.click).toBe('front')
  expect(DEFAULT_CARD_SETTINGS.answerUndo).toBe('off')
  expect(applyPanelSetting(base, 'cards.click', 'show')?.cards?.click).toBe('show')
  expect(applyPanelSetting(base, 'cards.answerUndo', 'five')?.cards?.answerUndo).toBe('five')
  // Each part of a card turns off on its own; a part takes only a boolean.
  expect(applyPanelSetting(base, 'cards.description', false)?.cards?.description).toBe(false)
  expect(applyPanelSetting(base, 'cards.stateWord', true)?.cards?.stateWord).toBe(true)
  expect(applyPanelSetting(base, 'cards.description', 'no')).toBeNull()
  expect(applyPanelSetting(base, 'cards.title', false)).toBeNull()
  expect(applyPanelSetting(base, 'cards.options', 'details')?.cards?.options).toBe('details')
  expect(applyPanelSetting(base, 'cards.question', 'full')?.cards?.question).toBe('full')
  expect(applyPanelSetting(base, 'cards.asks', 'loud')).toBeNull()
  expect(applyPanelSetting(base, 'notifications.enabled', true)).toBeNull()
  const html = renderPanelSettings({ devices: null, settings: { ...base, cards: { ...DEFAULT_CARD_SETTINGS, asks: 'question', chips: false } }, defaultAgentTitle: 'CC', secondaryAgentTitle: 'CX', modifier: '⌘⇧' })
  expect(html).toContain('<div class="sh">Session cards</div>')
  expect(html).toMatch(/data-setting="cards\.asks"[^>]*><option value="answers">With answers<\/option><option value="question" selected>Question only<\/option><option value="off">Off<\/option>/)
  expect(html).toContain('<option value="titles" selected>Titles only</option>')
  expect(html).toContain('<option value="two" selected>Two lines</option>')
  expect(html).toContain('<input type="checkbox" data-setting="cards.chips">')
  expect(html).toContain('<input type="checkbox" data-setting="cards.description" checked>')
  expect(html).toContain('data-refresh')
  expect(html).not.toContain('Approval alerts')
  expect(html).not.toContain('notifications.')
})

const fleet = readFileSync(join(import.meta.dir, 'testdata', 'devices-list.json'), 'utf8')

test('Devices: draws the CLI\'s placement verdict per device and keeps every other setting', () => {
  const rows = parseSettingsDevices(fleet)
  const byName = Object.fromEntries(rows.map((d) => [d.name, d]))
  expect(byName['yosemite-s1']).toMatchObject({ enabled: true, preferred: true, autoSkip: null })
  expect(byName['yosemite-m5'].autoSkip).toBe('disk-low')
  expect(byName['mark-1']).toMatchObject({ enabled: false, autoSkip: 'off' })
  const html = renderPanelSettings({ settings: getDefaultSettings(), devices: { rows }, defaultAgentTitle: 'CC', secondaryAgentTitle: 'CX', modifier: '⌘⇧' })
  // The settings that were there before are all still drawn, in order, above Devices.
  const order = ['Session titles', 'Shortcuts', 'Pull requests', 'Session cards', 'Reader', 'Devices'].map((h) => html.indexOf(`<div class="sh">${h}`))
  expect(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]))).toBe(true)
  expect(html).toContain('data-setting="display.showLabelsInTitles"')
  expect(html).toContain('data-setting="editor.markdownViewerEnabled"')
  // Preferred, eligible boxes lead; the CLI's reasons are drawn as words.
  expect(html.indexOf('<b>yosemite-s0</b>')).toBeLessThan(html.indexOf('<b>yosemite-m1</b>'))
  expect(html).toMatch(/<b>yosemite-m5<\/b><span class="dskip">disk low<\/span>/)
  expect(html).toMatch(/data-star="yosemite-s1" aria-pressed="true"/)
  // Boxes no checkbox can bring into the pool are one line each, not rows.
  expect(html).not.toContain('data-device="zion"')
  expect(html).toContain('<div class="doff">Personal, never auto: zion</div>')
  expect(html).toMatch(/<div class="doff">Not workers: [^<]*win-mini/)
  expect(html).toContain('<div class="doff">Offline: yosemite-m0, yosemite-m3, yosemite-m4</div>')
})

test('Devices: an older CLI is an upgrade message, a failed read says so', () => {
  expect(() => parseSettingsDevices('[{"name":"a"}]')).toThrow('agents upgrade')
  const html = renderPanelSettings({ settings: getDefaultSettings(), devices: { error: 'Devices could not be read: boom' }, defaultAgentTitle: 'CC', secondaryAgentTitle: 'CX', modifier: '⌘⇧' })
  expect(html).toContain('Devices could not be read: boom')
})

test('Devices: each control is one agents devices verb', () => {
  expect(deviceSettingArgv('yosemite-m1', 'enabled', false)).toEqual(['devices', 'disable', 'yosemite-m1'])
  expect(deviceSettingArgv('yosemite-m1', 'enabled', true)).toEqual(['devices', 'enable', 'yosemite-m1'])
  expect(deviceSettingArgv('yosemite-s0', 'preferred', true)).toEqual(['devices', 'config', 'yosemite-s0', 'auto-launch.preferred', 'on'])
  expect(deviceSettingArgv('yosemite-s0', 'preferred', false)).toEqual(['devices', 'config', 'yosemite-s0', 'auto-launch.preferred', '--unset'])
})
