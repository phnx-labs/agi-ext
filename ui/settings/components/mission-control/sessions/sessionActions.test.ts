import { describe, expect, test } from 'bun:test'
import type { FloorAgent } from '../floorModel'
import { migrateMessageForAgent, resumeMessageForAgent } from './sessionActions'

function previous(overrides: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'row-id', host: 'this-mac', project: 'agi-ext', name: 'session', abbr: 'CX', agentType: 'codex',
    phase: 'idle', verb: '', target: '', tok: 0, since: '1h', lastActivityMs: 1, files: 0, tools: 0,
    needs: false, pinned: false, pr: null, prUrl: null, ci: null, ticket: null, branch: '', worktreeSlug: '',
    worktreePath: '/repo', resp: '', messages: [], question: null, reply: { kind: 'none', host: 'this-mac' },
    todos: [], summary: '', recent: [], sessionState: 'inactive', resumable: true, sourceDevice: 'zion',
    title: 'Fix the recovery button',
    recovery: { command: 'agents', args: ['sessions', 'resume', 'session-from-recovery', '--device', 'zion'] },
    ...overrides,
  }
}

describe('resumeMessageForAgent', () => {
  test('a Previous row resumes the session its recovery names', () => {
    expect(resumeMessageForAgent(previous())).toEqual({
      type: 'resumeSession', sessionId: 'session-from-recovery', host: 'this-mac', title: 'Fix the recovery button',
    })
  })

  test('the canonical session id wins over the one in the recovery args', () => {
    expect(resumeMessageForAgent(previous({ sessionId: 'canonical-id', host: 'yosemite-m2' }))).toMatchObject({
      sessionId: 'canonical-id', host: 'yosemite-m2',
    })
  })

  test('a live row resumes by its session id; a live row without one has nothing to resume', () => {
    expect(resumeMessageForAgent(previous({ sessionState: 'running', recovery: null, sessionId: 'live-id' }))).toMatchObject({
      type: 'resumeSession', sessionId: 'live-id',
    })
    expect(resumeMessageForAgent(previous({ sessionState: 'running', recovery: null, sessionId: undefined }))).toBeNull()
  })

  test('a Previous row the CLI cannot resume offers no resume', () => {
    expect(resumeMessageForAgent(previous({ resumable: false, recovery: null }))).toBeNull()
  })
})

describe('migrateMessageForAgent', () => {
  test('moves a Previous session from its owning device to the picked one', () => {
    expect(migrateMessageForAgent(previous({ sessionId: 'canonical-id' }), 'yosemite-s1')).toEqual({
      type: 'migrateSession', sessionId: 'canonical-id', agentType: 'codex', sourceDevice: 'zion', device: 'yosemite-s1',
    })
  })

  test('refuses the same device, an unknown origin, and live rows', () => {
    expect(migrateMessageForAgent(previous(), 'zion')).toBeNull()
    expect(migrateMessageForAgent(previous({ sourceDevice: undefined, host: 'this-mac', hostLabel: undefined }), 'yosemite-s1')).toBeNull()
    expect(migrateMessageForAgent(previous({ sessionState: 'running' }), 'yosemite-s1')).toBeNull()
  })
})
