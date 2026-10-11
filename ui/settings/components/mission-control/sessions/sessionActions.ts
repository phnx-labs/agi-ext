import { agentIdFromPrefix } from '../AgentAvatar'
import { isPrevious, recoverySessionId, resumeCommand, type FloorAgent } from '../floorModel'
import { sessionRowView } from '../recapModel'

/** Resume (or open) a session: the host runs `agents.resumeSession`, the same action
 * as the "Agents: Resume Session…" picker and the side panel's ↻. */
export interface ResumeSessionMessage {
  type: 'resumeSession'
  sessionId: string
  host: string
  title: string
}

/** Move a Previous session to another device (Resume's right-click menu). */
export interface MigrateSessionMessage {
  type: 'migrateSession'
  sessionId: string
  agentType: string
  /** Device that owns the indexed transcript. */
  sourceDevice: string
  /** The device it moves to. */
  device: string
}

export function resumeSourceDevice(a: Pick<FloorAgent, 'sourceDevice' | 'hostLabel' | 'host'>): string {
  return a.sourceDevice || a.hostLabel || (a.host !== 'this-mac' ? a.host : '')
}

/** The resume intent for a row, or null when the row has nothing to resume: a live
 * row needs its session id; a Previous row needs the CLI's recovery for it. */
export function resumeMessageForAgent(a: FloorAgent): ResumeSessionMessage | null {
  if (isPrevious(a) && !resumeCommand(a)) return null
  const sessionId = isPrevious(a) ? recoverySessionId(a) : a.sessionId
  if (!sessionId) return null
  return { type: 'resumeSession', sessionId, host: a.host, title: sessionRowView(a).title }
}

/** The move-to-device intent for a Previous row, or null when it cannot move there. */
export function migrateMessageForAgent(a: FloorAgent, device: string): MigrateSessionMessage | null {
  if (!isPrevious(a) || !resumeCommand(a)) return null
  const sessionId = recoverySessionId(a)
  const sourceDevice = resumeSourceDevice(a)
  if (!sessionId || !sourceDevice || !device || device === sourceDevice) return null
  return {
    type: 'migrateSession',
    sessionId,
    agentType: a.agentType || agentIdFromPrefix(a.abbr) || '',
    sourceDevice,
    device,
  }
}
