import { useEffect, useState } from 'react'

/** VS Code sets this class alongside its theme variables. */
export function useEditorTheme(): boolean {
  const read = () => document.body.classList.contains('vscode-light')
  const [light, setLight] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setLight(read()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return light
}
