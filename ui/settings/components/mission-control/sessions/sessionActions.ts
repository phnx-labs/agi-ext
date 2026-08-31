import { agentIdFromPrefix } from '../AgentAvatar'
import { isPrevious, recoverySessionId, resumeCommand, type FloorAgent } from '../floorModel'

export interface ResumePreviousSessionMessage {
  type: 'resumePreviousSession'
  sessionId: string
  agentType: string
  device: string
  cwd?: string
}

/** Build the only valid Previous-row resume intent, or null when no Resume should
 * be rendered. This is shared by the button guard and click handler. */
export function previousResumeMessage(a: FloorAgent, deviceOverride?: string): ResumePreviousSessionMessage | null {
  if (!isPrevious(a) || !resumeCommand(a)) return null
  const sessionId = recoverySessionId(a)
  if (!sessionId) return null
  const device = deviceOverride ?? a.sourceDevice ?? (a.host !== 'this-mac' ? a.host : '')
  return {
    type: 'resumePreviousSession',
    sessionId,
    agentType: a.agentType || agentIdFromPrefix(a.abbr) || '',
    device,
    cwd: a.worktreePath || a.recovery?.cwd || undefined,
  }
}
