import { describe, expect, test } from 'bun:test'
import type { FloorAgent } from '../floorModel'
import { previousResumeMessage } from './sessionActions'

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
      device: 'zion',
      cwd: '/repo',
    })
  })

  test('prefers the canonical session id and supports an alternate device', () => {
    expect(previousResumeMessage(previous({ sessionId: 'canonical-id' }), 'yosemite-s1')).toMatchObject({
      type: 'resumePreviousSession', sessionId: 'canonical-id', agentType: 'codex', device: 'yosemite-s1',
    })
  })

  test('never routes live or non-resumable rows through Previous recovery', () => {
    expect(previousResumeMessage(previous({ sessionState: 'running' }))).toBeNull()
    expect(previousResumeMessage(previous({ resumable: false, recovery: null }))).toBeNull()
  })
})
