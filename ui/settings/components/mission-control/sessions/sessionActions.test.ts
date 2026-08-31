import { describe, expect, test } from 'bun:test'
import type { FloorAgent } from '../floorModel'
import { postTerminalOpenForAgent, previousResumeMessage, terminalOpenMessageForAgent, type TerminalOpenMessage } from './sessionActions'

function previous(overrides: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'row-id', host: 'this-mac', project: 'agi-ext', name: 'session', abbr: 'CX', agentType: 'codex',
    phase: 'idle', verb: '', target: '', tok: 0, since: '1h', lastActivityMs: 1, files: 0, tools: 0,
    needs: false, pinned: false, pr: null, prUrl: null, ci: null, ticket: null, branch: '', worktreeSlug: '',
    worktreePath: '/repo', resp: '', messages: [], question: null, reply: { kind: 'none', host: 'this-mac' },
    todos: [], summary: '', recent: [], sessionState: 'inactive', resumable: true, sourceDevice: 'zion',
    recovery: { command: 'agents', args: ['sessions', 'resume', 'session-from-recovery', '--device', 'zion'] },
    ...overrides,
  }
}

describe('previousResumeMessage', () => {
  test('posts resumePreviousSession with the same harness and owning device', () => {
    expect(previousResumeMessage(previous())).toEqual({
      type: 'resumePreviousSession',
      sessionId: 'session-from-recovery',
      agentType: 'codex',
      sourceDevice: 'zion',
      device: 'zion',
      migrate: false,
    })
  })

  test('prefers the canonical session id and supports an alternate device', () => {
    expect(previousResumeMessage(previous({ sessionId: 'canonical-id' }), 'yosemite-s1')).toMatchObject({
      type: 'resumePreviousSession', sessionId: 'canonical-id', agentType: 'codex', sourceDevice: 'zion', device: 'yosemite-s1', migrate: true,
    })
  })

  test('never routes live or non-resumable rows through Previous recovery', () => {
    expect(previousResumeMessage(previous({ sessionState: 'running' }))).toBeNull()
    expect(previousResumeMessage(previous({ resumable: false, recovery: null }))).toBeNull()
  })

  test('refuses an alternate-device action when the origin is unknown', () => {
    expect(previousResumeMessage(previous({ sourceDevice: undefined, host: 'this-mac', hostLabel: undefined }), 'yosemite-s1')).toBeNull()
  })
})

describe('terminalOpenMessageForAgent', () => {
  test('a resumable Previous row takes recovery before dead-session focus', () => {
    const message = terminalOpenMessageForAgent(previous({ sessionId: 'canonical-id' }))
    expect(message).toMatchObject({
      type: 'resumePreviousSession',
      sessionId: 'canonical-id',
      agentType: 'codex',
      sourceDevice: 'zion',
      device: 'zion',
      migrate: false,
    })
    expect(message?.type).not.toBe('focusSession')
  })

  test('openTerminalForAgent posts recovery for a resumable Previous row, never focus', () => {
    const posted: TerminalOpenMessage[] = []
    expect(postTerminalOpenForAgent(previous({ sessionId: 'canonical-id' }), (message) => posted.push(message))).toBe(true)
    expect(posted).toEqual([{
      type: 'resumePreviousSession', sessionId: 'canonical-id', agentType: 'codex',
      sourceDevice: 'zion', device: 'zion', migrate: false,
    }])
    expect(posted.some((message) => message.type === 'focusSession')).toBe(false)
  })

  test('a live indexed row still uses focusSession', () => {
    expect(terminalOpenMessageForAgent(previous({
      sessionState: 'running',
      recovery: null,
      sessionId: 'live-id',
    }))).toEqual({ type: 'focusSession', sessionId: 'live-id', host: 'this-mac' })
  })
})
