import { useEffect, useState } from 'react'

/** VS Code marks the webview body with its theme kind; high-contrast light carries its own class. */
export function isLightEditorTheme(body: HTMLElement = document.body): boolean {
  return body.classList.contains('vscode-light') || body.classList.contains('vscode-high-contrast-light')
}

export function useEditorTheme(): boolean {
  const [light, setLight] = useState(() => isLightEditorTheme())
  useEffect(() => {
    const observer = new MutationObserver(() => setLight(isLightEditorTheme()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return light
}
