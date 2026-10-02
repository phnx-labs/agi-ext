import { test, expect } from 'bun:test'
import { isLightEditorTheme } from './useEditorTheme'

function body(...classes: string[]): HTMLElement {
  const el = document.createElement('body')
  el.className = classes.join(' ')
  return el
}

test('light and high-contrast light editor themes read as light', () => {
  expect(isLightEditorTheme(body('vscode-light'))).toBe(true)
  expect(isLightEditorTheme(body('vscode-high-contrast', 'vscode-high-contrast-light'))).toBe(true)
})

test('dark and high-contrast dark editor themes read as dark', () => {
  expect(isLightEditorTheme(body('vscode-dark'))).toBe(false)
  expect(isLightEditorTheme(body('vscode-high-contrast'))).toBe(false)
})
