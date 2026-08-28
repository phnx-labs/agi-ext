import { useEffect, useRef } from 'react'

// Runs `onFocus` whenever the VS Code window regains focus (the user tabbed
// back in). The extension host posts { type: 'windowFocusRegained' } from its
// vscode.window.onDidChangeWindowState listener (settings.vscode.ts) — the same
// real signal the Issues Panel uses (PHNX-2833). This is the sanctioned
// replacement for a fixed-cadence refresh timer (PHNX-3447 / one-scheduler
// rule): surfaces that aren't fed by the session CLI stream refresh when the
// user comes back to look at them, not on a blind interval.
//
// The callback is kept in a ref and refreshed after every render so the handler
// always invokes the latest closure (current tab, loading flags, etc.) without
// re-subscribing the message listener on each render.
export function useWindowFocusRegained(onFocus: () => void): void {
  const cb = useRef(onFocus)
  useEffect(() => {
    cb.current = onFocus
  })
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'windowFocusRegained') cb.current()
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])
}
