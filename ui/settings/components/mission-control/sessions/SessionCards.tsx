import React, { useEffect, useRef } from 'react'
import { SESSION_CARDS_SCRIPT, sessionPanelCss, sessionPanelFontFaces } from '@shared/sessionCards'
import { postMessage } from '../../../hooks'
import type { SessionCardSnapshot } from '../floorModel'

// The Active Session sidebar's own Artifacts and Timeline cards, drawn inside an
// expanded Fleet row from the module both surfaces share (src/shared/sessionCards.ts).
// They live in a shadow root with the sidebar's stylesheet, so its rules and the
// Fleet's never meet. The stylesheet keys its tokens on `body` and VS Code's theme
// class, so the shadow root holds a `body` element mirroring that class.

interface CardsEnv {
  render(snapshot: SessionCardSnapshot): void
  onMessage(message: unknown): void
  dispose(): void
}

// One view state for every Fleet card, like the sidebar's one per webview:
// filters and ranges are keyed by session id inside it.
const viewState: Record<string, unknown> = {}

// The sidebar adds a page around its cards (padding, a sky, full height); a Fleet
// row is not a page.
const ROW_HOST_CSS = 'body { padding: 0; margin: 0; min-height: 0; background: transparent; background-image: none; } body > h2:first-child { margin-top: 0; }'

// A shadow root ignores @font-face, so the panel faces are declared on the
// document once, for every card.
function ensureFontFaces(): void {
  if (document.getElementById('session-panel-fonts')) return
  const fonts = window.__SESSION_FONTS__
  if (!fonts) return
  const style = document.createElement('style')
  style.id = 'session-panel-fonts'
  style.textContent = sessionPanelFontFaces(fonts.jost, fonts.inter)
  document.head.appendChild(style)
}

declare global {
  interface Window { __SESSION_FONTS__?: { jost: string; inter: string } }
}

function createEnv(root: HTMLElement, post: (message: Record<string, unknown>) => void): CardsEnv {
  const vscode = { postMessage: post, setState: () => {} }
  // The shared script reads root, viewState, vscode, lastSnapshot and render.
  const factory = new Function('root', 'viewState', 'vscode', `let lastSnapshot = null;
${SESSION_CARDS_SCRIPT}
function render(s) {
  lastSnapshot = s;
  const stripScroll = saveStripScroll();
  root.innerHTML = renderArtifactsCard(s) + renderTimelineCard(s);
  restoreStripScroll(stripScroll);
  bindSessionCards();
}
return {
  render,
  dispose() { thumbObserver.disconnect(); },
  onMessage(msg) {
    if (msg && msg.type === 'timelineFilter' && lastSnapshot && msg.sessionId === lastSnapshot.fullSessionId && applyTimelineFilter(msg, lastSnapshot)) render(lastSnapshot);
  },
};`)
  return factory(root, viewState, vscode) as CardsEnv
}

/** Timeline and Artifacts for one session, exactly as the sidebar draws them. */
export function SessionCards({ snapshot }: { snapshot: SessionCardSnapshot }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const envRef = useRef<CardsEnv | null>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    ensureFontFaces()
    const style = document.createElement('style')
    style.textContent = sessionPanelCss('') + ROW_HOST_CSS
    const body = document.createElement('body')
    const syncTheme = () => { body.className = document.body.className }
    syncTheme()
    shadow.replaceChildren(style, body)
    const themeWatch = new MutationObserver(syncTheme)
    themeWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    // Every click names its session so the host acts on this row, not the sidebar's subject.
    const env = createEnv(body, (action) => {
      const s = snapshotRef.current
      postMessage({ type: 'sessionCardAction', sessionId: s.fullSessionId, host: s.sessionHost, action })
    })
    envRef.current = env
    env.render(snapshotRef.current)
    const onMessage = (e: MessageEvent) => env.onMessage(e.data)
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      themeWatch.disconnect()
      env.dispose()
      envRef.current = null
    }
  }, [])

  useEffect(() => { envRef.current?.render(snapshot) }, [snapshot])

  return <div className="sx-cards" ref={hostRef} onClick={(e) => e.stopPropagation()} />
}
