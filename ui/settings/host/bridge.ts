// HostBridge: the webview's one channel to the VS Code extension host, reached
// through the injected acquireVsCodeApi(). Inbound messages arrive as ordinary
// window 'message' events.

import type { VsCodeApi } from '../types'

export interface HostBridge {
  post(message: unknown): void
  onMessage(handler: (message: unknown) => void): () => void
}

declare function acquireVsCodeApi(): VsCodeApi

function windowMessageSubscription(handler: (message: unknown) => void): () => void {
  const listener = (e: MessageEvent) => handler(e.data)
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

let bridge: HostBridge | null = null

export function resolveBridge(): HostBridge {
  if (bridge) return bridge
  if (typeof acquireVsCodeApi === 'undefined') {
    throw new Error('HostBridge: acquireVsCodeApi is not available (not running in a VS Code webview)')
  }
  const api = acquireVsCodeApi()
  bridge = { post: (m) => api.postMessage(m), onMessage: windowMessageSubscription }
  return bridge
}

/**
 * Drop the cached bridge so the next resolveBridge() re-reads acquireVsCodeApi.
 * Test-only: the singleton is resolved once per process, so a test that installs
 * its own acquireVsCodeApi must reset it to be observed.
 */
export function resetHostBridge(): void {
  bridge = null
}
