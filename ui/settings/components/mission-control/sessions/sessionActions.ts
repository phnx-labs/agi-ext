import { agentIdFromPrefix } from '../AgentAvatar'
import { isPrevious, recoverySessionId, resumeCommand, type FloorAgent } from '../floorModel'

export interface ResumePreviousSessionMessage {
  type: 'resumePreviousSession'
  sessionId: string
  agentType: string
  /** Device that owns the indexed transcript. */
  sourceDevice: string
  /** Requested destination; equal to sourceDevice for ordinary Resume. */
  device: string
  migrate: boolean
}

export type TerminalOpenMessage =
  | ResumePreviousSessionMessage
  | { type: 'focusTerminal'; terminalId: string }
  | { type: 'focusRemoteSession'; host: string; muxSocket?: string; muxTarget: string; sessionId?: string; label: string }
  | { type: 'focusSession'; sessionId: string; host: string }

export function resumeSourceDevice(a: Pick<FloorAgent, 'sourceDevice' | 'hostLabel' | 'host'>): string {
  return a.sourceDevice || a.hostLabel || (a.host !== 'this-mac' ? a.host : '')
}

/** Build the only valid Previous-row resume intent, or null when no Resume should
 * be rendered. This is shared by the button guard and click handler. */
export function previousResumeMessage(a: FloorAgent, deviceOverride?: string): ResumePreviousSessionMessage | null {
  if (!isPrevious(a) || !resumeCommand(a)) return null
  const sessionId = recoverySessionId(a)
  if (!sessionId) return null
  const sourceDevice = resumeSourceDevice(a)
  if (deviceOverride && !sourceDevice) return null
  const device = deviceOverride ?? sourceDevice
  return {
    type: 'resumePreviousSession',
    sessionId,
    agentType: a.agentType || agentIdFromPrefix(a.abbr) || '',
    sourceDevice,
    device,
    migrate: Boolean(deviceOverride && sourceDevice && deviceOverride !== sourceDevice),
  }
}

/** Resolve the one message a row click sends before the parent considers its
 * local-terminal fallback. Previous recovery is intentionally first: a dead
 * session must never fall through to `focusSession`. */
export function terminalOpenMessageForAgent(a: FloorAgent): TerminalOpenMessage | null {
  const previous = previousResumeMessage(a)
  if (previous) return previous
  if (a.reply.kind === 'terminal' && a.reply.terminalId) {
    return { type: 'focusTerminal', terminalId: a.reply.terminalId }
  }
  if (a.reply.kind === 'tmux' && a.reply.muxTarget) {
    return {
      type: 'focusRemoteSession',
      host: a.reply.host,
      muxSocket: a.reply.muxSocket,
      muxTarget: a.reply.muxTarget,
      sessionId: a.reply.sessionId ?? a.sessionId,
      label: a.name,
    }
  }
  if (a.sessionId) return { type: 'focusSession', sessionId: a.sessionId, host: a.host }
  return null
}

/** Post the resolved one-click terminal action. Kept outside React so the exact
 * webview bridge message used by `openTerminalForAgent` is unit-testable. */
export function postTerminalOpenForAgent(
  a: FloorAgent,
  post: (message: TerminalOpenMessage) => void,
): boolean {
  const message = terminalOpenMessageForAgent(a)
  if (!message) return false
  post(message)
  return true
}
