import { describe, test, expect } from 'bun:test'
import {
  abbrFor,
  splitActivity,
  deriveProject,
  sinceFromMs,
  isoToMs,
  floorPrLabel,
  toFloorAgentFromUnified,
  toFloorAgentFromRemote,
  adaptRemote,
  composeFloorAgents,
  adaptTickets,
  cleanWorktreeSlug,
  detectCreatedCommits,
  type UnifiedAgentLike,
  type RemoteSessionLike,
} from './floorAdapter'
import type { UnifiedTask } from '../../types'
import { SessionPresentationStore } from '../../../../src/core/sessionPresentationStore'
import { isPrevious, mergeSessionAgents, visibleFloorAgents } from './floorModel'
import { resumeMessageForAgent } from './sessions/sessionActions'

const NOW = 1_700_000_000_000

describe('canonical stream → Previous row', () => {
  test('preserves lifecycle, recovery, source device, and first request through the adapter', () => {
    const store = new SessionPresentationStore()
    store.apply({
      v: 1, type: 'reset', streamId: 'stream', sequence: 1, capturedAt: NOW, scope: 'yosemite-s0', attention: [],
      agents: [{
        rowKey: 'previous-row', sessionId: 'previous-session-id', kind: 'codex', context: 'recent',
        sourceDevice: 'yosemite-s0', previous: true, status: 'idle', resumable: true,
        recovery: { command: 'agents', args: ['sessions', 'resume', 'previous-session-id', '--device', 'yosemite-s0'], cwd: '/remote/repo' },
        firstUserMessage: 'Fix the recovery button and prove the terminal opens.',
        cwd: '/remote/repo', startedAtMs: NOW - 120_000, lastActivityMs: NOW - 60_000,
      }],
    })

    const presented = store.presentedSessions('zion', 'this-mac', [], NOW)
    expect(presented[0]).toMatchObject({
      state: 'inactive', resumable: true, sourceDevice: 'yosemite-s0',
      firstUserMessage: 'Fix the recovery button and prove the terminal opens.',
      recovery: { command: 'agents', args: ['sessions', 'resume', 'previous-session-id', '--device', 'yosemite-s0'] },
    })
    const [floor] = adaptRemote(presented, new Set(), 'zion')
    expect(isPrevious(floor!)).toBe(true)
    expect(resumeMessageForAgent(floor!)).toMatchObject({ type: 'resumeSession', sessionId: 'previous-session-id', host: 'yosemite-s0' })
  })
})

describe('abbrFor', () => {
  test('maps known agent types to their tab prefix', () => {
    expect(abbrFor('claude')).toBe('CC')
    expect(abbrFor('Codex')).toBe('CX')
    expect(abbrFor('gemini')).toBe('SH')
    expect(abbrFor('cursor')).toBe('CR')
    expect(abbrFor('opencode')).toBe('OC')
    expect(abbrFor('antigravity')).toBe('AG')
    expect(abbrFor('grok')).toBe('GK')
    expect(abbrFor('kimi')).toBe('KM')
    expect(abbrFor('droid')).toBe('DR')
  })
  test('unknown types fall back to Shell', () => {
    expect(abbrFor('mystery')).toBe('SH')
    expect(abbrFor('')).toBe('SH')
  })
})

describe('splitActivity', () => {
  test('a shell command reads as Running <cmd>', () => {
    expect(splitActivity('$ bun test core/')).toEqual({ verb: 'Running', target: 'bun test core/' })
  })
  test('first word is the verb, the rest the target', () => {
    expect(splitActivity('Editing src/core/tasks.ts')).toEqual({ verb: 'Editing', target: 'src/core/tasks.ts' })
  })
  test('a lone word is all verb, no target', () => {
    expect(splitActivity('idle')).toEqual({ verb: 'idle', target: '' })
  })
  test('empty stays empty', () => {
    expect(splitActivity('')).toEqual({ verb: '', target: '' })
  })
})

describe('deriveProject', () => {
  test('a repo name always wins', () => {
    expect(deriveProject('/anything/here', 'swarmify', 'fallback')).toBe('swarmify')
  })
  test('folds a worktree path back to its repo', () => {
    expect(deriveProject('/Users/x/src/github.com/o/swarmify/.agents/worktrees/floor-port', null, 'fb')).toBe('swarmify')
  })
  test('plain cwd uses the last path segment', () => {
    expect(deriveProject('/Users/x/src/github.com/o/prix-api', null, 'fb')).toBe('prix-api')
  })
  test('no cwd and no repo uses the fallback', () => {
    expect(deriveProject(null, null, 'fb')).toBe('fb')
  })
})

describe('sinceFromMs', () => {
  test('renders human units and rejects negatives', () => {
    expect(sinceFromMs(5_000)).toBe('5s')
    expect(sinceFromMs(90_000)).toBe('1m')
    expect(sinceFromMs(3 * 3600_000)).toBe('3h')
    expect(sinceFromMs(2 * 86_400_000)).toBe('2d')
    expect(sinceFromMs(-1)).toBe('')
  })
})

describe('isoToMs', () => {
  test('parses an ISO stamp to epoch ms', () => {
    expect(isoToMs(new Date(NOW).toISOString())).toBe(NOW)
  })
  test('unparseable input reads as 0 (unknown)', () => {
    expect(isoToMs('not-a-date')).toBe(0)
    expect(isoToMs('')).toBe(0)
  })
})

describe('floorPrLabel', () => {
  test('extracts the PR number from a github url', () => {
    expect(floorPrLabel('https://github.com/o/r/pull/142')).toBe('#142')
  })
  test('accepts a bare #number', () => {
    expect(floorPrLabel('#412')).toBe('#412')
  })
  test('null in, null out', () => {
    expect(floorPrLabel(null)).toBeNull()
    expect(floorPrLabel(undefined)).toBeNull()
  })
})

describe('detectCreatedCommits', () => {
  test('extracts short commit shas from successful command output', () => {
    expect(detectCreatedCommits([
      { name: 'Bash', output: '[rush-1547-linear-artifacts 095e588093ca] RUSH-1547: surface ticket artifacts' },
      { name: 'Bash', output: '[rush-1547-linear-artifacts 095e588093ca] duplicate line' },
      { name: 'Bash', output: '[rush-1547-linear-artifacts 1111111] another change' },
    ])).toEqual(['095e588093ca', '1111111'])
  })

  test('ignores failed command output', () => {
    expect(detectCreatedCommits([
      { name: 'Bash', output: '[rush-1547-linear-artifacts deadbee] failed change', isError: true },
    ])).toEqual([])
  })
})

function baseUnified(over: Partial<UnifiedAgentLike>): UnifiedAgentLike {
  return {
    id: 'term-1',
    agentType: 'claude',
    displayName: 'auth-refactor',
    activity: 'Editing src/auth.ts',
    active: true,
    timestamp: new Date(NOW - 5000).toISOString(),
    status: 'running',
    files: ['a.ts', 'b.ts'],
    toolCalls: 7,
    ...over,
  }
}

describe('PHNX-3939 — UnifiedAgentsPane composition', () => {
  function workerStream(extra: Record<string, unknown>[] = []) {
    const store = new SessionPresentationStore()
    store.apply({
      v: 1, type: 'reset', streamId: 'composition', sequence: 1, capturedAt: NOW, scope: 'worker', attention: [],
      agents: [{
        rowKey: 'owner', sessionId: 'S', kind: 'codex', context: 'headless',
        sourceDevice: 'worker', status: 'running', pid: 1234,
        observerTerminals: [{ device: 'desktop', terminalId: 'TAB' }],
        firstUserMessage: 'Keep the worker visible in its local tab.',
        lastAssistantMessage: 'The worker is running.', cwd: '/remote/agi-ext',
        startedAtMs: NOW - 10_000, lastActivityMs: NOW,
      }, ...extra],
    })
    return store
  }

  function compose(store: SessionPresentationStore, sessionId = store.terminalSessionMap(undefined, 'desktop').get('TAB')) {
    return composeFloorAgents([baseUnified({
      id: 'term-TAB', agentType: 'codex', sessionId,
      terminal: { id: 'TAB', sessionId },
    })], {
      pinned: new Set(['term-TAB']), nowMs: NOW, localHostName: 'desktop',
      projectedSessions: store.presentedSessions('desktop', 'this-mac', [], NOW),
    })
  }

  test('observer binding → actual pane composition → one Sessions row and one default-visible row', () => {
    const store = workerStream()
    expect(store.terminalSessionMap(undefined, 'desktop').get('TAB')).toBe('S')
    const floor = compose(store)
    const sessions = mergeSessionAgents(floor.filter((a) => !isPrevious(a)), floor.filter(isPrevious))
    expect(floor).toHaveLength(1)
    expect(sessions).toHaveLength(1)
    expect(visibleFloorAgents(floor, false)).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'term-TAB', host: 'worker', sourceDevice: 'worker', agentType: 'codex', sessionId: 'S',
      context: 'headless', localTerminalAttached: true, pinned: true, pid: 1234,
      firstUserMessage: 'Keep the worker visible in its local tab.',
      reply: { kind: 'terminal', host: 'this-mac', terminalId: 'TAB' },
    })
    // Closing the actual tab leaves the same owner as an opt-in background run.
    const detached = composeFloorAgents([], { pinned: new Set(), nowMs: NOW, localHostName: 'desktop', projectedSessions: store.presentedSessions('desktop', 'this-mac', [], NOW) })
    expect(detached).toHaveLength(1)
    expect(visibleFloorAgents(detached, false)).toHaveLength(0)
    expect(visibleFloorAgents(detached, true)).toHaveLength(1)
  })

  test('a different harness with the same native id survives composition and Previous merge', () => {
    const floor = compose(workerStream([{
      rowKey: 'other-harness', sessionId: 'S', kind: 'claude', sourceDevice: 'worker',
      context: 'recent', previous: true, status: 'idle', resumable: true,
    }]))
    const sessions = mergeSessionAgents(floor.filter((a) => !isPrevious(a)), floor.filter(isPrevious))
    expect(sessions).toHaveLength(2)
    expect(sessions.map((a) => a.agentType)).toEqual(['codex', 'claude'])
    expect(sessions[0]?.host).toBe('worker')
  })

  test('a native id on two execution owners is ambiguous, never an arbitrary cross-device join', () => {
    const floor = compose(workerStream([{
      rowKey: 'other-owner', sessionId: 'S', kind: 'codex', sourceDevice: 'other-worker',
      context: 'headless', status: 'running',
    }]))
    expect(floor).toHaveLength(3)
    expect(floor[0]?.sourceDevice).toBeUndefined()
    expect(floor.filter((a) => a.host !== 'this-mac').map((a) => a.host)).toEqual(['worker', 'other-worker'])
    expect(mergeSessionAgents(floor, [])).toHaveLength(3)
  })

  test('raw remote terminalId collision cannot borrow worker metadata or suppress its row', () => {
    const store = workerStream([{
      rowKey: 'collision', sessionId: 'unrelated', kind: 'codex', sourceDevice: 'other-worker',
      terminalId: 'TAB', context: 'headless', status: 'running', firstUserMessage: 'Unrelated task',
    }])
    const floor = compose(store, '')
    expect(floor).toHaveLength(3)
    expect(floor[0]?.firstUserMessage).toBeUndefined()
    expect(floor[0]?.host).toBe('this-mac')
    expect(floor[0]?.reply).toEqual({ kind: 'terminal', host: 'this-mac', terminalId: 'TAB' })
  })

  test('same-device raw terminal binding still composes once before session-id hydration', () => {
    const store = new SessionPresentationStore()
    store.apply({ v: 1, type: 'reset', streamId: 'local', sequence: 1, capturedAt: NOW, scope: 'desktop', attention: [], agents: [{
      rowKey: 'local', sessionId: 'local-S', kind: 'codex', sourceDevice: 'desktop', terminalId: 'TAB', context: 'headless', status: 'running',
    }] })
    const floor = compose(store, '')
    expect(floor).toHaveLength(1)
    expect(floor[0]).toMatchObject({ host: 'this-mac', sourceDevice: 'desktop', sessionId: 'local-S', context: 'headless', localTerminalAttached: true })
    expect(visibleFloorAgents(floor, false)).toHaveLength(1)
  })

  test('two editor tabs observing the same execution still compose one row with a real reply target', () => {
    const store = workerStream()
    const floor = composeFloorAgents(['TAB', 'TAB-2'].map((id) => baseUnified({
      id: `term-${id}`, agentType: 'codex', sessionId: 'S', terminal: { id, sessionId: 'S' },
    })), { pinned: new Set(), nowMs: NOW, projectedSessions: store.presentedSessions('desktop', 'this-mac', [], NOW) })
    expect(floor).toHaveLength(1)
    expect(floor[0]?.reply).toEqual({ kind: 'terminal', host: 'this-mac', terminalId: 'TAB' })
    expect(visibleFloorAgents(floor, false)).toHaveLength(1)
  })

  test('a known native id cannot be replaced by a conflicting local raw terminal id', () => {
    const store = new SessionPresentationStore()
    store.apply({ v: 1, type: 'reset', streamId: 'local-conflict', sequence: 1, capturedAt: NOW, scope: 'desktop', attention: [], agents: [{
      rowKey: 'unrelated', sessionId: 'unrelated', kind: 'codex', sourceDevice: 'desktop', terminalId: 'TAB', context: 'headless', status: 'running',
    }] })
    const floor = compose(store, 'known-session')
    expect(floor).toHaveLength(2)
    expect(floor[0]?.sessionId).toBe('known-session')
    expect(floor[1]?.sessionId).toBe('unrelated')
  })
})

describe('toFloorAgentFromUnified', () => {
  test('a terminal awaiting input becomes a waiting, needs-you agent with a parsed question', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        activity: 'idle',
        status: 'idle',
        active: false,
        terminal: { id: 't1', waitingForInput: true },
        agent: null,
        // last response is a real choice question
      }),
      { pinned: new Set(), workspaceRepo: 'swarmify', nowMs: NOW, projectedSessions: [{ host: 'this-mac', terminalId: 't1', sessionId: 's1', phase: 'waiting', agentType: 'claude', attention: { key: 'a1', sessionId: 's1', kind: 'question', source: 'hook', state: 'open', openedAt: '2026-08-23T00:00:00Z', fingerprint: 'exact-fingerprint', question: { text: 'Which path?', options: [{ label: 'A', id: 'a' }, { label: 'B', id: 'b' }] } } } as RemoteSessionLike] },
    )
    // no agent.last_messages, so resp is empty (the now-line, not the body, carries the
    // live activity); phase is waiting from the flag; needs is still true.
    expect(a.phase).toBe('waiting')
    expect(a.needs).toBe(true)
    expect(a.question?.clusterKey).toBe('exact-fingerprint')
    expect(a.attentionSource).toBe('hook')
    expect(a.host).toBe('this-mac')
    expect(a.abbr).toBe('CC')
  })

  test('surfaces commit artifacts from recent terminal output', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        terminal: {
          id: 't1',
          recentToolCalls: [
            { name: 'Bash', output: '[rush-1547-linear-artifacts abc1234] RUSH-1547: wire ticket links' },
          ],
        },
        agent: null,
      }),
      { pinned: new Set(), workspaceRepo: 'agents-cli', nowMs: NOW },
    )
    expect(a.createdCommits).toEqual(['abc1234'])
  })

  test('a completed agent with a stale waiting flag lands in done, not needs-you (RUSH-1522)', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        status: 'completed',
        active: false,
        terminal: { id: 't1', waitingForInput: true },
        agent: null,
      }),
      { pinned: new Set(), workspaceRepo: 'swarmify', nowMs: NOW },
    )
    expect(a.phase).toBe('done')
    expect(a.needs).toBe(false) // no PR — nothing for the user to do
  })

  test('a stopped agent with a stale waiting flag settles to idle, not needs-you (RUSH-1522)', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        status: 'stopped',
        active: false,
        terminal: { id: 't1', waitingForInput: true },
        agent: null,
      }),
      { pinned: new Set(), workspaceRepo: 'swarmify', nowMs: NOW },
    )
    expect(a.phase).toBe('idle')
    expect(a.needs).toBe(false)
  })

  test('resp is empty (not the live-activity placeholder) when there is no last message', () => {
    // Regression: resp used to fall back to u.activity, so a placeholder now-line
    // ("Thinking...") rendered twice — once as the card body, once as the verb nowline.
    const a = toFloorAgentFromUnified(
      baseUnified({ activity: 'Thinking...', status: 'idle', active: false, agent: null }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.resp).toBe('')
    // The activity still reaches the card via the verb/target now-line, not the body.
    expect(a.verb).toBe('Thinking...')
  })

  test('local agent keeps host this-mac (routing) but takes hostLabel from localHostName (display)', () => {
    const withName = toFloorAgentFromUnified(
      baseUnified({}),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW, localHostName: 'zion' },
    )
    // host stays the routing key so reply/nudge/reassign still target the local machine.
    expect(withName.host).toBe('this-mac')
    // hostLabel is the real device name every Floor surface renders.
    expect(withName.hostLabel).toBe('zion')

    // Before the fleet list resolves (no localHostName), hostLabel is undefined and
    // callers fall back to host.
    const noName = toFloorAgentFromUnified(baseUnified({}), { pinned: new Set(), workspaceRepo: null, nowMs: NOW })
    expect(noName.host).toBe('this-mac')
    expect(noName.hostLabel).toBeUndefined()
  })

  test('a desktop-launched worker session keeps its remote execution host but replies through the local terminal (PHNX-3939)', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        id: 'term-worker',
        sessionId: 's-worker', // Hydrated from the observer-scoped stream binding.
        displayName: 'phnx-3939-worker-preview',
        terminal: { id: 't-worker', firstUserMessage: 'Implement the worker preview fix.' },
        agent: null,
      }),
      {
        pinned: new Set(),
        workspaceRepo: 'agi-ext',
        nowMs: NOW,
        localHostName: 'desktop',
        // The CLI's canonical reconciled row: the agent executes on worker-7 even
        // though its live terminal is a tab in THIS (desktop) window.
        projectedSessions: [{
          host: 'worker-7',
          sourceDevice: 'worker-7',
          terminalId: 't-worker',
          sessionId: 's-worker',
          agentType: 'claude',
          phase: 'running',
          activity: 'Editing floorAdapter.ts',
          lastResponse: 'Preserved the worker host on the local tab.',
          firstUserMessage: 'Implement the worker preview fix.',
          // A tmux-backed remote reply the local terminal must OVERRIDE.
          replyRail: 'tmux',
          replyMuxSocket: '/tmp/mux.sock',
          replyMuxTarget: '%3',
        } as RemoteSessionLike],
      },
    )
    // Execution host + source stay truthful — the agent runs on worker-7, not local.
    expect(a.host).toBe('worker-7')
    expect(a.hostLabel).toBeUndefined() // remote hosts render `host` directly, no local label
    expect(a.sourceDevice).toBe('worker-7')
    // …but the LIVE terminal in THIS window is still the reply transport.
    expect(a.reply).toEqual({ kind: 'terminal', host: 'this-mac', terminalId: 't-worker' })
    // Genuine first turn + real last response ride through — no faked label.
    expect(a.firstUserMessage).toBe('Implement the worker preview fix.')
    expect(a.prompt).toBe('Implement the worker preview fix.')
    expect(a.resp).toBe('Preserved the worker host on the local tab.')
    // Identity stays the local tab id so favorites/selection keep working.
    expect(a.id).toBe('term-worker')
    expect(a.name).toBe('phnx-3939-worker-preview')
  })

  test('a projected LOCAL session (host this-mac) is unchanged — folds under the local device', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({ id: 'term-local', terminal: { id: 't-local', firstUserMessage: 'Local task.' }, agent: null }),
      {
        pinned: new Set(),
        workspaceRepo: 'agi-ext',
        nowMs: NOW,
        localHostName: 'desktop',
        projectedSessions: [{
          host: 'this-mac', terminalId: 't-local', sessionId: 's-local', agentType: 'claude',
          phase: 'running', activity: '', lastResponse: '', firstUserMessage: 'Local task.',
        } as RemoteSessionLike],
      },
    )
    expect(a.host).toBe('this-mac')
    expect(a.hostLabel).toBe('desktop')
    expect(a.reply).toEqual({ kind: 'terminal', host: 'this-mac', terminalId: 't-local' })
  })

  test('a metadata-only projected row with no genuine first turn leaves firstUserMessage empty (no faked "You ›")', () => {
    // The gate SessionRow applies keys off `firstUserMessage`. Prove the adapter
    // only ever fills it from GENUINE sources — the CLI's canonical first turn,
    // the terminal's first user message, or a headless agent's DISPATCH prompt
    // (all user-authored). A synthesized task label (topic / worktree slug /
    // displayName) is never one of them, so a metadata-only row stays empty and
    // the row drops the "You ›" line downstream.
    const a = toFloorAgentFromUnified(
      baseUnified({
        id: 'term-metaonly',
        sessionId: 's-meta', // Hydrated from the observer-scoped stream binding.
        displayName: 'phnx-3939-worker-preview',
        terminal: { id: 't-meta' }, // no firstUserMessage
        agent: null,                // no dispatch prompt
      }),
      {
        pinned: new Set(),
        workspaceRepo: 'agi-ext',
        nowMs: NOW,
        localHostName: 'desktop',
        projectedSessions: [{
          host: 'worker-7', terminalId: 't-meta', sessionId: 's-meta', agentType: 'claude',
          phase: 'running', activity: 'Editing floorAdapter.ts', lastResponse: 'Working.',
          // canonical row carries only a task label (topic/slug), NOT a first turn
          topic: 'phnx-3939-worker-preview', worktreeSlug: 'phnx-3939-worker-preview',
        } as RemoteSessionLike],
      },
    )
    expect(a.firstUserMessage).toBeUndefined()
    // prompt still falls back to the label so other surfaces have a task line,
    // but firstUserMessage — the "You ›" gate — stays empty.
    expect(a.host).toBe('worker-7')
  })

  test('a headless dispatch prompt IS a genuine first turn and populates firstUserMessage', () => {
    // Provenance guard: agent.prompt is the user's dispatch instruction, so a
    // projected row without its own firstUserMessage still gets a truthful one.
    const a = toFloorAgentFromUnified(
      baseUnified({
        id: 'term-headless',
        sessionId: 's-headless',
        terminal: null,
        agent: { prompt: 'Fix the worker preview attribution.' },
      }),
      {
        pinned: new Set(),
        workspaceRepo: 'agi-ext',
        nowMs: NOW,
        projectedSessions: [{
          host: 'worker-7', sessionId: 's-headless', agentType: 'claude',
          phase: 'running', activity: '', lastResponse: '',
        } as RemoteSessionLike],
      },
    )
    expect(a.firstUserMessage).toBe('Fix the worker preview attribution.')
  })

  test('a failed agent does not invent attention or a retry question', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({ status: 'failed', active: false, activity: 'build broke' }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.phase).toBe('failed')
    expect(a.needs).toBe(false)
    expect(a.question).toBeNull()
  })

  test('a running agent does not need you', () => {
    const a = toFloorAgentFromUnified(baseUnified({}), { pinned: new Set(), workspaceRepo: null, nowMs: NOW })
    expect(a.phase).toBe('running')
    expect(a.needs).toBe(false)
    expect(a.files).toBe(2)
    expect(a.tools).toBe(7)
    // u.timestamp is the last-activity stamp -> exact heartbeat anchor locally.
    expect(a.lastActivityMs).toBe(NOW - 5000)
  })

  test('a completed agent with an open PR does not derive needs-you', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({ status: 'completed', active: false, prUrl: 'https://github.com/o/r/pull/9' }),
      { pinned: new Set(['term-1']), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.phase).toBe('done')
    expect(a.needs).toBe(false)
    expect(a.pr).toBe('#9')
    expect(a.pinned).toBe(true)
  })

  test('an unprojected headless agent defers waiting/needs to the CLI attention stream', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        id: 'agent-x',
        activity: 'working',
        status: 'idle',
        active: false,
        terminal: null,
        agent: {
          status: 'input_required',
          repo_name: 'prix-api',
          branch: 'feat-rl',
          last_messages: ['Token bucket per-user, or a sliding window?'],
        },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    // The ext no longer re-derives 'waiting' from the raw agent status — phase is a
    // straight rename of the reported status (idle), and needs-you / the parsed question
    // ride the CLI attention stream, which has not indexed this tab yet.
    expect(a.phase).toBe('idle')
    expect(a.project).toBe('prix-api')
    expect(a.branch).toBe('feat-rl')
    expect(a.needs).toBe(false)
    expect(a.attentionKind).toBeUndefined()
    expect(a.question).toBeNull()
  })

  test('maps the ORIGINAL task (terminal firstUserMessage) into prompt, distinct from the last message', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        activity: 'Editing FeedItem.tsx',
        terminal: { id: 't1', firstUserMessage: 'Surface the original prompt on cards' },
        agent: { last_messages: ['Done — wired renderMarkdown into the resp line'] },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.prompt).toBe('Surface the original prompt on cards')
    // resp is the LAST message, not the prompt — the two are independent.
    expect(a.resp).toBe('Done — wired renderMarkdown into the resp line')
  })

  test('a headless run maps its dispatch prompt into prompt', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        terminal: null,
        agent: { prompt: 'Fix the rate limiter', last_messages: [] },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.prompt).toBe('Fix the rate limiter')
  })

  test('carries the full last_messages window into messages (Activity feed), not just the last one', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        agent: { last_messages: ['first', '', '  ', 'second', 'third'] },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    // blank entries are dropped; order preserved; resp is still the last non-blank one.
    expect(a.messages).toEqual(['first', 'second', 'third'])
    expect(a.resp).toBe('third')
  })

  test('renders a clean worktree slug from a real worktree cwd (never a raw path)', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        terminal: { id: 't1', cwd: '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1531' },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.worktreeSlug).toBe('rush-1531')
    expect(a.worktreeSlug).not.toContain('/')
    expect(a.worktreeSlug).not.toContain('WT=')
  })

  test('detects plan artifacts from output and recent worktree files', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        files: ['ref-cycle-18.md'],
        agent: { last_messages: ['Rendered ref-plan.html'] },
        terminal: {
          id: 't1',
          cwd: '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525',
          recentToolCalls: [{ name: 'Bash', output: 'open .agents/artifacts/ref-review.md' }],
        },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.plans?.map((p) => p.path)).toEqual([
      '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525/ref-plan.html',
      '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525/ref-cycle-18.md',
      '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525/.agents/artifacts/ref-review.md',
    ])
  })

  test('ignores plan-like paths that are only mentioned by the user task', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        activity: 'Review ref-task.html',
        terminal: {
          id: 't1',
          cwd: '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525',
          firstUserMessage: 'Please render ref-plan.html',
          lastUserMessage: 'Open ref-review.md when done',
          currentActivity: 'Thinking about ref-current.html',
        },
        agent: { prompt: 'Build a plan named ref-prompt.md', last_messages: [] },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.plans).toEqual([])
  })
})

describe('cleanWorktreeSlug — kills the WT=<path> leak', () => {
  test('a real worktree path yields the trailing slug', () => {
    expect(cleanWorktreeSlug('/Users/x/repo/.agents/worktrees/rush-1531')).toBe('rush-1531')
  })
  test('strips a WT= prefix and any surviving path down to the slug', () => {
    expect(cleanWorktreeSlug('WT=/Users/x/repo/.agents/worktrees/card-ux')).toBe('card-ux')
  })
  test('a non-worktree cwd resolves to empty (no chip)', () => {
    expect(cleanWorktreeSlug('/Users/x/src/repo')).toBe('')
    expect(cleanWorktreeSlug('')).toBe('')
    expect(cleanWorktreeSlug(null)).toBe('')
    expect(cleanWorktreeSlug(undefined)).toBe('')
  })
})

describe('toFloorAgentFromRemote', () => {
  test('carries the remote host and normalized fields through', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'yosemite-s0',
      sessionId: 'abcd1234efgh',
      agentType: 'codex',
      cwd: '/home/u/src/prix-api',
      project: 'prix-api',
      phase: 'waiting',
      activity: 'Running cargo build',
      tokPerSec: 88,
      waitingForInput: true,
      lastResponse: 'Merge the green PR?',
      prUrl: 'https://github.com/o/r/pull/50',
      ticket: 'RUSH-812',
      createdTickets: ['RUSH-901'],
      spawnedTeam: 'rate-limiter',
      branch: 'feat-x',
      sinceMs: 42_000,
      startedAtMs: NOW - 42_000,
      topic: 'Wire the rate limiter',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 4321,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
      attention: { key: 'a2', sessionId: 'abcd1234efgh', kind: 'question', source: 'lifecycle', state: 'open', openedAt: '2026-08-23T00:00:00Z', fingerprint: 'remote-fingerprint', question: { text: 'Merge the green PR?', options: [{ label: 'Merge', id: 'merge' }, { label: 'Wait', id: 'wait' }] } },
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.host).toBe('yosemite-s0')
    expect(a.id).toBe('remote-yosemite-s0-abcd1234efgh')
    expect(a.abbr).toBe('CX')
    expect(a.tok).toBe(88)
    expect(a.since).toBe('42s')
    expect(a.needs).toBe(true)
    expect(a.attentionKind).toBe('question')
    expect(a.pr).toBe('#50')
    expect(a.ticket).toBe('RUSH-812')
    expect(a.createdTickets).toEqual(['RUSH-901'])
    expect(a.spawnedTeam).toBe('rate-limiter')
    expect(a.question?.kind).toBe('choice')
    expect(a.question?.clusterKey).toBe('remote-fingerprint')
    // No lastActivityMs on the payload → heartbeat falls back to session-start.
    expect(a.lastActivityMs).toBe(NOW - 42_000)
    // a genuinely-remote host is already its real name — no display override.
    expect(a.hostLabel).toBeUndefined()
  })

  test('prefers the CLI lastActivityMs stamp over startedAtMs for the heartbeat', () => {
    // The CLI now stamps the transcript last-write on active sessions (active.ts
    // sessionFileTimes), so a session started long ago but touched seconds ago reads
    // as freshly active — not "started 1h ago".
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'yosemite-s0',
      sessionId: 'live999',
      agentType: 'claude',
      cwd: '/Users/muqsit/src/github.com/muqsitnawaz',
      project: 'muqsitnawaz',
      phase: 'running',
      activity: 'working',
      tokPerSec: 40,
      waitingForInput: false,
      lastResponse: 'editing files',
      prUrl: null,
      ticket: null,
      branch: '',
      sinceMs: 3_600_000,
      startedAtMs: NOW - 3_600_000, // started 1h ago
      lastActivityMs: NOW - 20_000, // but last wrote 20s ago
      topic: 'Long-running interactive session',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 999,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.lastActivityMs).toBe(NOW - 20_000)
  })

  test('detects remote plan artifacts from output and attachment refs', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'yosemite-s0',
      sessionId: 'plan123',
      agentType: 'codex',
      cwd: '/home/u/src/agents-cli/.agents/worktrees/rush-1525',
      project: 'agents-cli',
      phase: 'running',
      activity: 'Writing plan',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: 'Plan rendered at ref-plan.html',
      output: 'See ref-cycle.md',
      attachments: ['capture (/tmp/ref-screenshot.html)'],
      prUrl: null,
      ticket: 'RUSH-1525',
      branch: 'rush-1525',
      sinceMs: 1000,
      startedAtMs: NOW - 1000,
      topic: 'Preview plan files',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 4321,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.plans?.map((p) => p.path)).toEqual([
      '/home/u/src/agents-cli/.agents/worktrees/rush-1525/ref-plan.html',
      '/home/u/src/agents-cli/.agents/worktrees/rush-1525/ref-cycle.md',
      '/tmp/ref-screenshot.html',
    ])
  })

  test('carries structured remote attachments onto the Floor card', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'yosemite-s0',
      sessionId: 'shot123',
      agentType: 'codex',
      cwd: '/home/u/src/agents-cli',
      project: 'agents-cli',
      phase: 'running',
      activity: 'Reading screenshot',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      output: '',
      attachments: [{
        path: '/home/u/.agents/.history/attachments/factory-floor.png',
        label: 'factory-floor.png',
        mediaType: 'image/png',
        sizeBytes: 12345,
        thumbnailUri: 'vscode-resource://factory-floor.png',
      }],
      prUrl: null,
      ticket: 'RUSH-1524',
      branch: 'rush-1524',
      sinceMs: 1000,
      startedAtMs: NOW - 1000,
      topic: 'Preview session attachments',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 4321,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.attachments).toEqual([{
      path: '/home/u/.agents/.history/attachments/factory-floor.png',
      label: 'factory-floor.png',
      mediaType: 'image/png',
      sizeBytes: 12345,
      thumbnailUri: 'vscode-resource://factory-floor.png',
    }])
  })

  test('ignores remote plan-like paths that are only labels or task topics', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'yosemite-s0',
      sessionId: 'plan456',
      agentType: 'codex',
      cwd: '/home/u/src/agents-cli/.agents/worktrees/rush-1525',
      project: 'agents-cli',
      phase: 'running',
      activity: 'Reviewing ref-activity.html',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      output: '',
      attachments: [],
      prUrl: null,
      ticket: 'RUSH-1525',
      branch: 'rush-1525',
      sinceMs: 1000,
      startedAtMs: NOW - 1000,
      topic: 'Create ref-plan.html',
      label: 'ref-topic.md',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 4321,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.plans).toEqual([])
  })

  test('carries context/sessionId/pid so a headless run gets the bg badge + Focus/Stop', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'this-mac',
      sessionId: 'headless99abcd',
      agentType: 'claude',
      cwd: '/home/u/src/app',
      project: 'app',
      phase: 'running',
      activity: 'Editing src/auth.ts',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: '',
      sinceMs: 9_000,
      startedAtMs: NOW - 9_000,
      topic: 'auth refactor',
      context: 'headless',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 40912,
      transport: '',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set(), 'zion')
    // context drives the bg badge; sessionId/pid drive Focus/Stop.
    expect(a.context).toBe('headless')
    expect(a.sessionId).toBe('headless99abcd')
    expect(a.pid).toBe(40912)
    // 'this-mac' folds to the real device name so the run groups under 'zion'.
    expect(a.hostLabel).toBe('zion')
  })

  test("this machine's out-of-window sessions (host 'this-mac') take the real name as hostLabel so they fold, not duplicate", () => {
    const base: RemoteSessionLike = {
      tmuxPane: '',
      host: 'this-mac',
      sessionId: 'localsess1',
      cloudTaskId: '', cloudProvider: '', teamName: '', pid: 0,
      transport: '', replyRail: '', replyMuxTarget: '', replyMuxSocket: '',
      agentType: 'claude',
      cwd: '/home/u/src/web',
      project: 'web',
      phase: 'running',
      activity: 'Editing App.tsx',
      tokPerSec: 10,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: 'feat-z',
      sinceMs: 1_000,
      startedAtMs: NOW - 1_000,
      topic: '',
      context: 'terminal',
    }
    const a = toFloorAgentFromRemote(base, new Set(), 'zion')
    // host stays the routing key; only the display name resolves to the real device.
    expect(a.host).toBe('this-mac')
    expect(a.hostLabel).toBe('zion')
  })

  test('a remote session with an unknown start (0) disables the heartbeat rather than false-stalling', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'zion',
      sessionId: 'deadbeef',
      agentType: 'claude',
      cwd: '/home/u/src/web',
      project: 'web',
      phase: 'running',
      activity: 'Editing App.tsx',
      tokPerSec: 40,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: 'feat-y',
      sinceMs: 0,
      startedAtMs: 0,
      topic: 'Dark mode',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 0,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    expect(toFloorAgentFromRemote(r, new Set()).lastActivityMs).toBe(0)
  })

  test('a cloud task gets its own "Cloud" category instead of folding under the dispatching machine', () => {
    // The CLI attributes a cloud task to the querier ('zion') for reply routing, but
    // it runs in a provider sandbox — the feed must NOT show it under the local host.
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'zion',
      sessionId: 'task_e',
      agentType: 'codex',
      cwd: '',
      project: '',
      phase: 'waiting',
      activity: '',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: '',
      sinceMs: 0,
      startedAtMs: NOW,
      topic: 'Read README.md',
      context: 'cloud',
      cloudTaskId: 'task_e',
      cloudProvider: 'codex',
      teamName: '',
      pid: 0,
      transport: '',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set(), 'zion')
    // Groups under "Cloud", never the local machine — grouping keys off hostLabel ?? host.
    expect(a.hostLabel).toBe('Cloud')
    // Reply routing still targets the real querier host, unaffected by the display label.
    expect(a.reply.host).toBe('zion')
  })

  test('uses a remote manual label as the card name before topic or ids', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'yosemite-s0',
      sessionId: '019e30a2-raw-session-id',
      agentType: 'codex',
      cwd: '/home/u/src/app',
      project: 'app',
      phase: 'running',
      activity: 'Editing src/app.ts',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: 'feature-branch',
      sinceMs: 1_000,
      startedAtMs: NOW - 1_000,
      label: 'factory floor labels',
      topic: 'Fix AGI EXT header labels',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 1,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.name).toBe('factory floor labels')
    expect(a.name).not.toContain('019e30a2')
  })

  test('falls back to topic, never a raw session id slice, when label is absent', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'zion',
      sessionId: '019e30a2-dead-beef',
      agentType: 'claude',
      cwd: '',
      project: '',
      phase: 'running',
      activity: '',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: '',
      sinceMs: 1_000,
      startedAtMs: NOW - 1_000,
      topic: 'Audit cloud UUID headers',
      context: 'cloud',
      cloudTaskId: 'task_123',
      cloudProvider: 'codex',
      teamName: '',
      pid: 0,
      transport: '',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.name).toBe('Audit cloud UUID headers')
    expect(a.name).not.toContain('019e30a2')
  })

  test('uses a generic agent label instead of a uuid when no human fields exist', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'zion',
      sessionId: '019e30a2-dead-beef',
      agentType: 'claude',
      cwd: '',
      project: '',
      phase: 'running',
      activity: '',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: '',
      sinceMs: 1_000,
      startedAtMs: NOW - 1_000,
      topic: '',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 0,
      transport: '',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.name).toBe('Claude session')
    expect(a.name).not.toContain('019e30a2')
    expect(a.summary).toBe('')
  })

  test('uses a remote worktree slug as the task anchor when topic is absent', () => {
    const r: RemoteSessionLike = {
      tmuxPane: '',
      host: 'yosemite-m0', sessionId: 'remote-1', agentType: 'codex',
      cwd: '/home/u/src/app/.agents/worktrees/rush-2031-factory-floor', project: 'app',
      phase: 'running', activity: '', tokPerSec: 0, waitingForInput: false,
      lastResponse: '', prUrl: null, ticket: null, branch: 'rush-2031-factory-floor',
      worktreeSlug: 'rush-2031-factory-floor', sinceMs: 0, startedAtMs: NOW,
      topic: '', context: 'terminal', cloudTaskId: '', cloudProvider: '', teamName: '',
      pid: 0, transport: 'ssh', replyRail: '', replyMuxTarget: '', replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.prompt).toBe('rush-2031-factory-floor')
    expect(a.summary).toBe('')
  })

  test('keeps the streamed recap title separate from the full first user turn', () => {
    const r = {
      host: 'yosemite-m2', sessionId: 's-first', agentType: 'codex', cwd: '/repo', project: 'agi-ext',
      phase: 'running', activity: '', tokPerSec: 0, waitingForInput: false, lastResponse: '',
      prUrl: null, ticket: null, branch: '', sinceMs: 0, startedAtMs: NOW,
      topic: 'one-line request summary', title: 'Overhauling the Sessions view',
      firstUserMessage: 'Build the entire Sessions overhaul.\nPreserve the genuine second line.',
      context: 'terminal', cloudTaskId: '', cloudProvider: '', teamName: '', pid: 0,
      transport: 'ssh', replyRail: '', replyMuxTarget: '', replyMuxSocket: '',
    } as RemoteSessionLike
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.title).toBe('Overhauling the Sessions view')
    expect(a.firstUserMessage).toBe('Build the entire Sessions overhaul.\nPreserve the genuine second line.')
    expect(a.prompt).toBe(a.firstUserMessage)
  })
})

describe('deriveReplyTargetFromRemote', () => {
  const base: RemoteSessionLike = {
    tmuxPane: '',
    host: 'this-mac', sessionId: 's1', agentType: 'claude', cwd: '/x', project: 'x',
    phase: 'waiting', activity: '', tokPerSec: 0, waitingForInput: true, lastResponse: '',
    prUrl: null, ticket: null, branch: '', sinceMs: 0, startedAtMs: 0, topic: '',
    context: '', cloudTaskId: '', cloudProvider: '', teamName: '', pid: 0,
    transport: '', replyRail: '', replyMuxTarget: '', replyMuxSocket: '',
  }

  test('a tmux-backed remote session routes to the tmux rail (ssh + send-keys)', () => {
    const r = toFloorAgentFromRemote({
      ...base, host: 'yosemite-s0', context: 'terminal', transport: 'ssh',
      replyRail: 'tmux', replyMuxTarget: '%65', replyMuxSocket: '/tmp/tmux-1000/default',
    }, new Set())
    expect(r.reply.kind).toBe('tmux')
    expect(r.reply.host).toBe('yosemite-s0')
    expect(r.reply.muxTarget).toBe('%65')
    expect(r.reply.muxSocket).toBe('/tmp/tmux-1000/default')
  })

  test('a tmux rail missing its pane/socket degrades to none, not a dead send', () => {
    const r = toFloorAgentFromRemote({ ...base, context: 'terminal', replyRail: 'tmux', replyMuxTarget: '', replyMuxSocket: '' }, new Set())
    expect(r.reply.kind).toBe('none')
  })

  test('cloud row routes to `agents cloud message` on its owning host', () => {
    const r = toFloorAgentFromRemote({ ...base, host: 'this-mac', context: 'cloud', cloudTaskId: 'vclfel94', cloudProvider: 'rush' }, new Set())
    expect(r.reply.kind).toBe('cloud')
    expect(r.reply.cloudTaskId).toBe('vclfel94')
    expect(r.reply.host).toBe('this-mac')
  })

  test('a remote cloud row keeps its host so the handler can ssh to it', () => {
    const r = toFloorAgentFromRemote({ ...base, host: 'yosemite-s0', context: 'cloud', cloudTaskId: 't7' }, new Set())
    expect(r.reply.kind).toBe('cloud')
    expect(r.reply.host).toBe('yosemite-s0')
  })

  test('teams row routes to `agents factory answer` with the team name', () => {
    const r = toFloorAgentFromRemote({ ...base, context: 'teams', teamName: 'auth-team' }, new Set())
    expect(r.reply.kind).toBe('team')
    expect(r.reply.teamName).toBe('auth-team')
  })

  test('a raw terminal session has no injectable channel (none + reason)', () => {
    const local = toFloorAgentFromRemote({ ...base, host: 'this-mac', context: 'terminal' }, new Set())
    expect(local.reply.kind).toBe('none')
    expect(local.reply.reason).toBeTruthy()
    const remote = toFloorAgentFromRemote({ ...base, host: 'zion', context: 'terminal' }, new Set())
    expect(remote.reply.kind).toBe('none')
    expect(remote.reply.reason).toContain('zion')
  })

  test('a cloud row missing its task id degrades to none rather than a dead send', () => {
    const r = toFloorAgentFromRemote({ ...base, context: 'cloud', cloudTaskId: '' }, new Set())
    expect(r.reply.kind).toBe('none')
  })
})

describe('adaptTickets', () => {
  test('maps UnifiedTask fields onto FloorTicket', () => {
    const tasks: UnifiedTask[] = [
      {
        id: 'lin-1',
        source: 'linear',
        title: 'Fix the thing',
        description: 'details',
        status: 'in_progress',
        priority: 'high',
        metadata: { identifier: 'RUSH-1', repo: 'swarmify', labels: ['bug'] },
      },
    ]
    const [t] = adaptTickets(tasks)
    expect(t?.id).toBe('RUSH-1')
    expect(t?.source).toBe('LN')
    expect(t?.pri).toBe('high')
    expect(t?.status).toBe('in-progress')
    expect(t?.project).toBe('swarmify')
    expect(t?.labels).toEqual(['bug'])
  })
})

describe('toFloorAgentFromRemote — plan progress (RUSH-1380)', () => {
  const remote = (over: Partial<RemoteSessionLike>): RemoteSessionLike => ({
    host: 'yosemite-s0',
    sessionId: 's1',
    agentType: 'claude',
    cwd: '/home/u/src/web',
    project: 'web',
    phase: 'running',
    activity: '',
    tokPerSec: 0,
    waitingForInput: false,
    lastResponse: '',
    prUrl: null,
    ticket: null,
    branch: '',
    sinceMs: 1_000,
    startedAtMs: NOW - 1_000,
    topic: '',
    context: 'headless',
    ...over,
  } as RemoteSessionLike)

  test('maps the CLI todos onto the FloorAgent checklist', () => {
    const a = toFloorAgentFromRemote(remote({
      activity: 'Bash: bun test',
      todos: [
        { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
        { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
      ],
    }), new Set())
    expect(a.todos).toEqual([
      { content: 'Read the code', status: 'completed' },
      { content: 'Ship it', status: 'in_progress' },
    ])
    // A live tool action is present, so it stays the now-line verb (not overridden).
    expect(a.verb).toBe('Bash:')
  })

  test('with no live activity, surfaces the in-progress step as the now-line', () => {
    const a = toFloorAgentFromRemote(remote({
      activity: '',
      todos: [
        { content: 'Done', status: 'completed' },
        { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
      ],
    }), new Set())
    expect(a.verb).toBe('Plan')
    expect(a.target).toBe('Shipping it')
  })

  test('no todos ⇒ empty checklist, no verb override', () => {
    const a = toFloorAgentFromRemote(remote({ activity: '' }), new Set())
    expect(a.todos).toEqual([])
    expect(a.verb).toBe('')
  })
})

describe('project attribution across a real fleet batch (PHNX-3796)', () => {
  // Shapes taken from the live roster that produced the 48-row blank bucket: cloud
  // rows carry no cwd and the CLI's project slot holds the run CONTEXT word "cloud".
  const row = (over: Partial<RemoteSessionLike>): RemoteSessionLike => ({
    host: 'pinnacles', sessionId: 's', agentType: 'claude', cwd: '', project: '',
    phase: 'running', activity: '', tokPerSec: 0, waitingForInput: false, lastResponse: '',
    prUrl: null, ticket: null, branch: '', sinceMs: 0, startedAtMs: 0, topic: '',
    context: 'cloud', cloudTaskId: '9hk9oiqv', cloudProvider: 'rush', teamName: '', pid: 0,
    transport: '', replyRail: '', replyMuxTarget: '', replyMuxSocket: '', tmuxPane: '',
    ...over,
  })

  test('a cwd-bearing row seeds the project pool that hint-only rows in the same batch bind to', () => {
    const batch = [
      row({ sessionId: 'local', host: 'zion', context: 'terminal', cwd: '/home/m/src/github.com/phnx-labs/agi-ext', cloudTaskId: '', cloudProvider: '' }),
      row({ sessionId: 'cloudpr', prUrl: 'https://github.com/phnx-labs/agi-ext/pull/412', project: 'cloud' }),
      row({ sessionId: 'branchy', branch: 'agi-ext/fix-lease', project: 'cloud' }),
      row({ sessionId: 'norepo', label: 'echo hello from balanced factory run', project: 'cloud' }),
    ]
    const projects = adaptRemote(batch, new Set(), 'zion').map((a) => a.project)
    expect(projects).toEqual(['agi-ext', 'agi-ext', 'agi-ext', ''])
  })

  test("a genuinely repo-less run gets '' (the labeled Unassigned bucket), never the old '—' placeholder", () => {
    const [a] = adaptRemote([row({ sessionId: 'norepo', project: 'cloud' })], new Set(), 'zion')
    expect(a!.project).toBe('')
    expect(a!.project).not.toBe('—')
  })

  test('managed project names widen attribution without any extra fetch', () => {
    const batch = [row({ sessionId: 'team', context: 'teams', teamName: 'agents-cli', project: '', cloudTaskId: '' })]
    expect(adaptRemote(batch, new Set(), 'zion', [], []).map((a) => a.project)).toEqual([''])
    expect(adaptRemote(batch, new Set(), 'zion', [], ['agents-cli']).map((a) => a.project)).toEqual(['agents-cli'])
  })

  test('project rules still win over every widened hint', () => {
    const rules = [{ pattern: '/home/m/src/**/agi-ext', project: 'AGI EXT' }]
    const batch = [row({ sessionId: 'local', context: 'terminal', cwd: '/home/m/src/github.com/phnx-labs/agi-ext', prUrl: 'https://github.com/o/other/pull/1', cloudTaskId: '' })]
    expect(adaptRemote(batch, new Set(), 'zion', rules).map((a) => a.project)).toEqual(['AGI EXT'])
  })
})
