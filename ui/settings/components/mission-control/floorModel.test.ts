import { describe, test, expect } from 'bun:test'
import type { UnifiedTask, ProjectRule } from '../../types'
import {
  phaseFromStatus,
  sortByAttention,
  latestTodos,
  todoProgress,
  groupAgents,
  sortAgents,
  clusterByQuestion,
  computeHostRows,
  orderManagedProjects,
  sessionKey,
  toFloorTicket,
  groupTickets,
  sortTickets,
  ticketWorkers,
  projectRollups,
  resolveProject,
  sessionTaskLine,
  partitionFloorAgents,
  visibleFloorAgents,
  mergeSessionAgents,
  todosWithFallback,
  linearIssueLabel,
  linearIssueUrl,
  PHASE_PROGRESS_RANK,
  ATTENTION_KIND_RANK,
  type FloorAgent,
  type StructuredQuestion,
  type ManagedProject,
  type TodoItem,
} from './floorModel'

describe('resolveProject', () => {
  const RULES: ProjectRule[] = [
    { pattern: '**/agents/prix/api', project: 'Prix API' },
    { pattern: '**/agents/prix/app', project: 'Prix App' },
    { pattern: '/home/muqsit/src/monorepo', project: 'Monorepo Root' },
  ]

  test('user rules win first, and the first matching rule wins', () => {
    expect(resolveProject('/x/y/agents/prix/api', RULES)).toBe('Prix API')
    expect(resolveProject('/x/y/agents/prix/app', RULES)).toBe('Prix App')
  })

  test('a glob captures work inside the matched directory', () => {
    expect(resolveProject('/x/y/agents/prix/api/src/routes', RULES)).toBe('Prix API')
  })

  test('a path-prefix rule matches the dir and descendants but not a shared-prefix sibling', () => {
    expect(resolveProject('/home/muqsit/src/monorepo/packages/api', RULES)).toBe('Monorepo Root')
    expect(resolveProject('/home/muqsit/src/monorepo-two', RULES)).toBe('monorepo-two')
  })

  test('rules beat the git-repo-root default', () => {
    expect(resolveProject('/x/y/agents/prix/api', RULES, '/x/y/agents')).toBe('Prix API')
  })

  test('a monorepo subdir with no rule folds to its git repo root basename', () => {
    expect(resolveProject('/x/y/agents/prix/api', [], '/x/y/agents')).toBe('agents')
  })

  test('worktree folding beats the git-repo-root default', () => {
    expect(
      resolveProject(
        '/Users/m/src/o/swarmify/.agents/worktrees/floor-port',
        [],
        '/Users/m/src/o/swarmify/.agents/worktrees/floor-port',
      ),
    ).toBe('swarmify')
  })

  test('no rules, no repoRoot -> legacy last-segment', () => {
    expect(resolveProject('/x/y/prix-api')).toBe('prix-api')
    expect(resolveProject('')).toBe('')
  })
})

describe('Linear issue refs', () => {
  test('builds a Linear URL from a ticket id', () => {
    expect(linearIssueUrl('RUSH-1545')).toBe('https://linear.app/issue/RUSH-1545')
    expect(linearIssueLabel('RUSH-1545')).toBe('RUSH-1545')
  })

  test('preserves a Linear issue URL and extracts the display id', () => {
    const url = 'https://linear.app/getrush/issue/RUSH-1545/file-created-ticket-links'
    expect(linearIssueUrl(url)).toBe(url)
    expect(linearIssueLabel(url)).toBe('RUSH-1545')
  })

  test('returns null for non-Linear refs', () => {
    expect(linearIssueUrl('#812')).toBeNull()
    expect(linearIssueUrl('')).toBeNull()
  })
})

function makeAgent(overrides: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'a1',
    host: 'this-mac',
    project: 'swarmify',
    name: 'auth-refactor',
    abbr: 'CC',
    phase: 'running',
    verb: 'Editing',
    target: 'src/core/tasks.ts',
    tok: 0,
    since: '2s',
    lastActivityMs: 0,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: null,
    prUrl: null,
    ci: null,
    ticket: null,
    branch: 'feat-auth',
    worktreeSlug: '',
    worktreePath: '',
    resp: '',
    messages: [],
    question: null,
    reply: { kind: 'terminal', host: 'this-mac', terminalId: 'CC-1' },
    todos: [],
    summary: '',
    recent: [],
    ...overrides,
  }
}

function makeTask(overrides: Partial<UnifiedTask> = {}): UnifiedTask {
  return {
    id: 'raw-id',
    source: 'linear',
    title: 'Some ticket',
    status: 'todo',
    metadata: {},
    ...overrides,
  }
}

describe('phaseFromStatus — a straight CLI-status rename, no classification', () => {
  // The extension classifies nothing: this only renames the CLI-reported status of a
  // local tab the stream has not indexed yet. needs-you / awaiting-input / stall all ride
  // the CLI attention stream, so there is no waitingForInput/PR/heartbeat promotion here.
  test('completed -> done, failed -> failed, running -> running', () => {
    expect(phaseFromStatus('completed')).toBe('done')
    expect(phaseFromStatus('failed')).toBe('failed')
    expect(phaseFromStatus('running')).toBe('running')
  })

  test('stopped and idle both settle to idle (a quiet, unfinished tab)', () => {
    expect(phaseFromStatus('stopped')).toBe('idle')
    expect(phaseFromStatus('idle')).toBe('idle')
  })
})

describe('sortByAttention — needs-you order comes from the CLI attention kind', () => {
  test('orders question -> permission -> plan_review -> declared -> failure -> stall -> review', () => {
    const kinds = ['review', 'stall', 'failure', 'declared', 'plan_review', 'permission', 'question'] as const
    const agents = kinds.map((k, i) => makeAgent({ id: `${k}-${i}`, needs: true, attentionKind: k }))
    expect(sortByAttention(agents).map((a) => a.attentionKind)).toEqual([
      'question', 'permission', 'plan_review', 'declared', 'failure', 'stall', 'review',
    ])
    // The rank table is the single source of that order.
    expect(ATTENTION_KIND_RANK.question).toBeLessThan(ATTENTION_KIND_RANK.permission)
    expect(ATTENTION_KIND_RANK.permission).toBeLessThan(ATTENTION_KIND_RANK.plan_review)
    expect(ATTENTION_KIND_RANK.failure).toBeLessThan(ATTENTION_KIND_RANK.stall)
    expect(ATTENTION_KIND_RANK.stall).toBeLessThan(ATTENTION_KIND_RANK.review)
  })

  test('within one kind, the most-stuck (oldest activity) leads; no-kind rows sort last', () => {
    const fresh = makeAgent({ id: 'fresh', attentionKind: 'question', lastActivityMs: 2000 })
    const stuck = makeAgent({ id: 'stuck', attentionKind: 'question', lastActivityMs: 1000 })
    const noKind = makeAgent({ id: 'nokind', attentionKind: undefined })
    expect(sortByAttention([fresh, noKind, stuck]).map((a) => a.id)).toEqual(['stuck', 'fresh', 'nokind'])
  })
})

describe('groupAgents', () => {
  const agents = [
    makeAgent({ id: 'a', host: 'this-mac', project: 'swarmify', abbr: 'CC', phase: 'running' }),
    makeAgent({ id: 'b', host: 'yosemite-s0', project: 'prix-api', abbr: 'CX', phase: 'waiting' }),
    makeAgent({ id: 'c', host: 'this-mac', project: 'prix-api', abbr: 'CC', phase: 'running' }),
  ]

  test('groups by host, preserving first-seen key order', () => {
    const g = groupAgents(agents, 'host')
    expect([...g.keys()]).toEqual(['this-mac', 'yosemite-s0'])
    expect(g.get('this-mac')!.map((a) => a.id)).toEqual(['a', 'c'])
  })

  test('groups by project / status / agent dimensions', () => {
    expect([...groupAgents(agents, 'project').keys()]).toEqual(['swarmify', 'prix-api'])
    expect([...groupAgents(agents, 'status').keys()]).toEqual(['running', 'waiting'])
    expect([...groupAgents(agents, 'agent').keys()]).toEqual(['CC', 'CX'])
  })

  test('groups by outcome: ticket > PR > worktree > Unassigned (RUSH-1479)', () => {
    const mixed = [
      makeAgent({ id: 't1', ticket: 'RUSH-1125', pr: '#9', worktreeSlug: 'rush-1125' }),
      makeAgent({ id: 't2', ticket: 'RUSH-1125' }),
      makeAgent({ id: 'p1', ticket: null, pr: '#534' }),
      makeAgent({ id: 'w1', ticket: null, pr: null, worktreeSlug: 'ship-1-20' }),
      makeAgent({ id: 'u1', ticket: null, pr: null, worktreeSlug: '' }),
    ]
    const g = groupAgents(mixed, 'outcome')
    expect([...g.keys()]).toEqual(['RUSH-1125', 'PR#534', 'ship-1-20', 'Unassigned'])
    expect(g.get('RUSH-1125')!.map((a) => a.id)).toEqual(['t1', 't2'])
    expect(g.get('Unassigned')!.map((a) => a.id)).toEqual(['u1'])
  })
})

describe('sortAgents', () => {
  // Root AGENTS.md "Purpose": rank by PROGRESS, not liveness. Every phase that has
  // STOPPED progressing outranks `running`, and `done` is the terminal state below
  // both — so idle-but-unfinished work is never the bottom of the list (RUSH-2838).
  test("'needs' orders by PHASE_PROGRESS_RANK (waiting < failed < idle < running < done)", () => {
    const agents = [
      makeAgent({ id: 'idle', phase: 'idle' }),
      makeAgent({ id: 'done', phase: 'done' }),
      makeAgent({ id: 'running', phase: 'running' }),
      makeAgent({ id: 'failed', phase: 'failed' }),
      makeAgent({ id: 'waiting', phase: 'waiting' }),
    ]
    const ordered = sortAgents(agents, 'needs').map((a) => a.id)
    expect(ordered).toEqual(['waiting', 'failed', 'idle', 'running', 'done'])
    const ranks = sortAgents(agents, 'needs').map((a) => PHASE_PROGRESS_RANK[a.phase])
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y))
  })

  test('idle-but-unfinished outranks running, and done is terminal below both', () => {
    // The invariant itself, independent of the exact permutation above: an idle agent
    // is unfinished work that stopped progressing (the CLI maps a FINISHED agent to
    // 'done'), so it is the one to raise — a running agent needs nothing.
    expect(PHASE_PROGRESS_RANK.idle).toBeLessThan(PHASE_PROGRESS_RANK.running)
    expect(PHASE_PROGRESS_RANK.running).toBeLessThan(PHASE_PROGRESS_RANK.done)
    for (const stopped of ['waiting', 'failed', 'idle'] as const) {
      expect(PHASE_PROGRESS_RANK[stopped]).toBeLessThan(PHASE_PROGRESS_RANK.running)
    }
    expect(phaseFromStatus('completed')).toBe('done')
    expect(phaseFromStatus('stopped')).toBe('idle')
  })

  test("'tok' orders by throughput descending", () => {
    const agents = [makeAgent({ id: 'lo', tok: 10 }), makeAgent({ id: 'hi', tok: 200 }), makeAgent({ id: 'mid', tok: 90 })]
    expect(sortAgents(agents, 'tok').map((a) => a.id)).toEqual(['hi', 'mid', 'lo'])
  })

  test("'recent' orders by elapsed time ascending (freshest first)", () => {
    const agents = [makeAgent({ id: 'h', since: '3h' }), makeAgent({ id: 's', since: '2s' }), makeAgent({ id: 'm', since: '14m' })]
    expect(sortAgents(agents, 'recent').map((a) => a.id)).toEqual(['s', 'm', 'h'])
  })

  test("'name' orders alphabetically and does not mutate input", () => {
    const agents = [makeAgent({ id: '1', name: 'zeta' }), makeAgent({ id: '2', name: 'alpha' })]
    expect(sortAgents(agents, 'name').map((a) => a.name)).toEqual(['alpha', 'zeta'])
    expect(agents.map((a) => a.name)).toEqual(['zeta', 'alpha'])
  })
})

describe('clusterByQuestion', () => {
  function waitingAgent(id: string, clusterKey: string | null): FloorAgent {
    const question: StructuredQuestion | null = clusterKey
      ? { kind: 'choice', text: 'q', options: ['A', 'B'], clusterKey }
      : null
    return makeAgent({ id, phase: 'waiting', question })
  }

  test('collapses agents sharing a clusterKey into one card, keeps singletons as [agent]', () => {
    const waiting = [
      waitingAgent('a', 'ratelimit'),
      waitingAgent('b', 'ratelimit'),
      waitingAgent('c', 'mergegreen'),
    ]
    const clusters = clusterByQuestion(waiting)
    expect(clusters.length).toBe(2)
    expect(clusters[0]?.map((a) => a.id)).toEqual(['a', 'b'])
    expect(clusters[1]?.map((a) => a.id)).toEqual(['c'])
  })

  test('agents without a parsed question never batch together', () => {
    const clusters = clusterByQuestion([waitingAgent('x', null), waitingAgent('y', null)])
    expect(clusters.length).toBe(2)
    expect(clusters.every((c) => c.length === 1)).toBe(true)
  })
})

describe('sessionKey — one canonical identity across origins', () => {
  const uuid = '4a78949e-1111-2222-3333-444455556666'

  test('same session via local tab + local sweep collapse to one key', () => {
    const fromTab = sessionKey({ origin: 'local', host: 'this-mac', cliSessionUuid: uuid, terminalId: 'CC-1705-1' })
    const fromSweep = sessionKey({ origin: 'local', host: 'this-mac', cliSessionUuid: uuid })
    expect(fromTab).toBe(uuid)
    expect(fromSweep).toBe(uuid)
    expect(fromTab).toBe(fromSweep)
  })

  test('provisional key re-keys once the UUID appears', () => {
    const provisional = sessionKey({ origin: 'local', terminalId: 'CC-1705-1' })
    const resolved = sessionKey({ origin: 'local', cliSessionUuid: uuid, terminalId: 'CC-1705-1' })
    expect(provisional).toBe('provisional:CC-1705-1')
    expect(resolved).toBe(uuid)
    expect(provisional).not.toBe(resolved)
  })

  test('provisional falls back through terminal -> cloud -> agent id', () => {
    expect(sessionKey({ origin: 'cloud', cloudTaskId: 'task-abc' })).toBe('provisional:task-abc')
    expect(sessionKey({ origin: 'local', agentId: 'agent-xyz' })).toBe('provisional:agent-xyz')
    expect(sessionKey({ origin: 'local' })).toBe('provisional:unknown')
  })

  test('remote keys namespaced by host do not collide across hosts', () => {
    const onHostA = sessionKey({ origin: 'remote', host: 'yosemite-s0', cliSessionUuid: uuid })
    const onHostB = sessionKey({ origin: 'remote', host: 'zion-m1', cliSessionUuid: uuid })
    expect(onHostA).toBe(`yosemite-s0:${uuid}`)
    expect(onHostB).toBe(`zion-m1:${uuid}`)
    expect(onHostA).not.toBe(onHostB)
  })

  test('remote falls back to the session file stem when the UUID is unknown', () => {
    expect(sessionKey({ origin: 'remote', host: 'zion-m1', sessionFileStem: 'rollout-2024' })).toBe('zion-m1:rollout-2024')
  })

  test('a genuinely remote UUID does not collide with the same session seen locally', () => {
    const local = sessionKey({ origin: 'local', host: 'this-mac', cliSessionUuid: uuid })
    const remote = sessionKey({ origin: 'remote', host: 'yosemite-s0', cliSessionUuid: uuid })
    expect(local).not.toBe(remote)
  })
})

describe('toFloorTicket — field mapping', () => {
  test('medium priority remaps to med', () => {
    expect(toFloorTicket(makeTask({ priority: 'medium' })).pri).toBe('med')
  })

  test('missing priority defaults to med; urgent/high/low pass through', () => {
    expect(toFloorTicket(makeTask({ priority: undefined })).pri).toBe('med')
    expect(toFloorTicket(makeTask({ priority: 'urgent' })).pri).toBe('urgent')
    expect(toFloorTicket(makeTask({ priority: 'high' })).pri).toBe('high')
    expect(toFloorTicket(makeTask({ priority: 'low' })).pri).toBe('low')
  })

  test('source remaps linear->LN, github->GH', () => {
    expect(toFloorTicket(makeTask({ source: 'linear' })).source).toBe('LN')
    expect(toFloorTicket(makeTask({ source: 'github' })).source).toBe('GH')
  })

  test('status remaps in_progress->in-progress, done->done, else todo', () => {
    expect(toFloorTicket(makeTask({ status: 'in_progress' })).status).toBe('in-progress')
    expect(toFloorTicket(makeTask({ status: 'done' })).status).toBe('done')
    expect(toFloorTicket(makeTask({ status: 'todo' })).status).toBe('todo')
  })

  test('id prefers metadata.identifier, falls back to id; project from repo; labels/desc defaulted', () => {
    const withId = toFloorTicket(
      makeTask({ id: 'raw', metadata: { identifier: 'RUSH-812', repo: 'prix-api', labels: ['bug'] }, description: 'd' }),
    )
    expect(withId.id).toBe('RUSH-812')
    expect(withId.project).toBe('prix-api')
    expect(withId.labels).toEqual(['bug'])
    expect(withId.desc).toBe('d')

    const bare = toFloorTicket(makeTask({ id: 'raw', metadata: {} }))
    expect(bare.id).toBe('raw')
    expect(bare.project).toBe('')
    expect(bare.labels).toEqual([])
    expect(bare.desc).toBe('')
  })

  test('owner maps from metadata.assignee, defaults to empty when unassigned', () => {
    expect(toFloorTicket(makeTask({ metadata: { assignee: 'Muqsit' } })).owner).toBe('Muqsit')
    expect(toFloorTicket(makeTask({ metadata: {} })).owner).toBe('')
  })
})

describe('groupTickets / sortTickets', () => {
  const tickets = [
    toFloorTicket(makeTask({ id: 'RUSH-2', source: 'linear', priority: 'low', metadata: { repo: 'web' } })),
    toFloorTicket(makeTask({ id: '#1', source: 'github', priority: 'urgent', metadata: { repo: 'swarmify' } })),
    toFloorTicket(makeTask({ id: 'RUSH-3', source: 'linear', priority: 'high', metadata: { repo: 'web' } })),
  ]

  test('sortTickets by priority uses PRI_RANK', () => {
    expect(sortTickets(tickets, 'priority').map((t) => t.pri)).toEqual(['urgent', 'high', 'low'])
  })

  test('sortTickets by id uses localeCompare', () => {
    expect(sortTickets(tickets, 'id').map((t) => t.id)).toEqual(['#1', 'RUSH-2', 'RUSH-3'])
  })

  test('groupTickets by source renders human labels', () => {
    expect([...groupTickets(tickets, 'source').keys()].sort()).toEqual(['GitHub', 'Linear'])
  })

  test('groupTickets by project buckets by repo', () => {
    const g = groupTickets(tickets, 'project')
    expect(g.get('web')!.map((t) => t.id)).toEqual(['RUSH-2', 'RUSH-3'])
    expect(g.get('swarmify')!.map((t) => t.id)).toEqual(['#1'])
  })

  test('groupTickets by owner buckets by assignee; unassigned collapses to Unassigned', () => {
    const owned = [
      toFloorTicket(makeTask({ id: 'RUSH-10', metadata: { assignee: 'Muqsit' } })),
      toFloorTicket(makeTask({ id: 'RUSH-11', metadata: { assignee: 'Bisma' } })),
      toFloorTicket(makeTask({ id: 'RUSH-12', metadata: { assignee: 'Muqsit' } })),
      toFloorTicket(makeTask({ id: 'RUSH-13', metadata: {} })),
    ]
    const g = groupTickets(owned, 'owner')
    expect(g.get('Muqsit')!.map((t) => t.id)).toEqual(['RUSH-10', 'RUSH-12'])
    expect(g.get('Bisma')!.map((t) => t.id)).toEqual(['RUSH-11'])
    expect(g.get('Unassigned')!.map((t) => t.id)).toEqual(['RUSH-13'])
  })
})

describe('computeHostRows', () => {
  const devices = [
    { name: 'zion', online: true, agents: 0 },
    { name: 'yosemite-s0', online: true, agents: 0 },
    { name: 'mac-mini', online: true, agents: 0 },
  ]

  test('folds the local machine into ONE row under its real name (the reported bug)', () => {
    // Local agents arrive from two paths, both labelled hostLabel='zion':
    //   - in-window (adaptUnified): host 'this-mac'
    //   - out-of-window / tmux (adaptRemote): host 'this-mac'
    // plus a genuinely-remote agent on yosemite-s0.
    const rows = computeHostRows(
      [
        makeAgent({ id: 'a', host: 'this-mac', hostLabel: 'zion' }),
        makeAgent({ id: 'b', host: 'this-mac', hostLabel: 'zion' }),
        makeAgent({ id: 'c', host: 'yosemite-s0' }),
      ],
      devices,
      [],
    )
    const names = rows.map((r) => r.name)
    // The machine shows exactly once, as 'zion' — never also as 'this-mac'.
    expect(names).toEqual(['mac-mini', 'yosemite-s0', 'zion'])
    expect(names).not.toContain('this-mac')
    const zion = rows.find((r) => r.name === 'zion')!
    expect(zion.count).toBe(2) // both local agents counted under the real name
    expect(zion.offline).toBe(false)
    expect(rows.find((r) => r.name === 'yosemite-s0')!.count).toBe(1)
    expect(rows.find((r) => r.name === 'mac-mini')!.count).toBe(0) // registry-only, 0 agents
  })

  test('never surfaces a raw this-mac phantom row; folds onto localHost when given', () => {
    // Before the fleet list resolves, hostLabel is undefined so the agent's host is
    // the synthetic 'this-mac'. That must NOT spawn a phantom 'this-mac' HOSTS row.
    const rowsNoLocal = computeHostRows([makeAgent({ id: 'a', host: 'this-mac' })], devices, [])
    expect(rowsNoLocal.map((r) => r.name)).not.toContain('this-mac')

    // Passing the local machine name gives it a row and folds the this-mac count into
    // it — even when the local machine is not in the device registry.
    const rows = computeHostRows([makeAgent({ id: 'a', host: 'this-mac' })], devices, [], [], 'yosemite-s1')
    const local = rows.find((r) => r.name === 'yosemite-s1')!
    expect(local.count).toBe(1)
    expect(local.offline).toBe(false)
    expect(rows.map((r) => r.name)).not.toContain('this-mac')
  })

  test('a session on an unregistered host creates NO phantom row (the reported bug)', () => {
    // ssh-config aliases / tailnet peers (mark, phoenix, pi) used to each spawn a HOST
    // row. Now an agent on an unregistered host is silently dropped from the roster —
    // only registered devices, pins, and the local machine make rows.
    const rows = computeHostRows(
      [
        makeAgent({ id: 'a', host: 'phoenix' }),
        makeAgent({ id: 'b', host: 'pi' }),
        makeAgent({ id: 'c', host: 'yosemite-s0' }),
      ],
      devices,
      [],
    )
    const names = rows.map((r) => r.name)
    expect(names).toEqual(['mac-mini', 'yosemite-s0', 'zion'])
    expect(names).not.toContain('phoenix')
    expect(names).not.toContain('pi')
    expect(rows.find((r) => r.name === 'yosemite-s0')!.count).toBe(1)
  })

  test('normalizes host case / FQDN onto the registry device row', () => {
    // A session reported as 'ZION' or a FQDN folds onto the 'zion' device row.
    const rows = computeHostRows(
      [
        makeAgent({ id: 'a', host: 'ZION' }),
        makeAgent({ id: 'b', host: 'mac-mini.tail1a85a1.ts.net' }),
      ],
      devices,
      [],
    )
    expect(rows.find((r) => r.name === 'zion')!.count).toBe(1)
    expect(rows.find((r) => r.name === 'mac-mini')!.count).toBe(1)
  })

  test('a host with agents whose device is offline lists, marked offline', () => {
    // Device-registry reachability is authoritative: an agent bucket on an offline
    // device still renders (from byHost) but shows offline, not its count.
    const rows = computeHostRows(
      [makeAgent({ id: 'a', host: 'win-mini' })],
      [{ name: 'win-mini', online: false, agents: 0 }],
      [],
    )
    expect(rows).toEqual([{ name: 'win-mini', count: 1, offline: true, pinned: false }])
  })

  test('pinned hosts render first in pin order, then the alphabetical remainder', () => {
    const rows = computeHostRows(
      [makeAgent({ id: 'a', host: 'yosemite-s0' })],
      devices,
      [],
      ['zion', 'mac-mini'], // user pinned zion then mac-mini
    )
    // pinned first in the user's order, unpinned (yosemite-s0) after, all sorted within groups
    expect(rows.map((r) => r.name)).toEqual(['zion', 'mac-mini', 'yosemite-s0'])
    expect(rows.filter((r) => r.pinned).map((r) => r.name)).toEqual(['zion', 'mac-mini'])
    expect(rows.find((r) => r.name === 'yosemite-s0')!.pinned).toBe(false)
  })

  test('a pinned host stays listed even with no agents and no online device', () => {
    // e.g. the local machine pinned by default while its registry entry is momentarily
    // absent — the pin keeps it visible so the user can still see/reorder it.
    const rows = computeHostRows([], [], [], ['zion'])
    expect(rows).toEqual([{ name: 'zion', count: 0, offline: false, pinned: true }])
  })

  test('running counts come only from the agents session collection (ignore device agents)', () => {
    // deviceHealth.runningAgents used to double as a second count source and drift
    // from the feed. Host rows must count floor agents only.
    const rows = computeHostRows(
      [makeAgent({ id: 'a', host: 'zion', hostLabel: 'zion' })],
      [{ name: 'zion', online: true, agents: 99 }],
      [],
      [],
      'zion',
    )
    expect(rows.find((r) => r.name === 'zion')!.count).toBe(1)
  })
})

describe('latestTodos -- the checklist from the newest TodoWrite', () => {
  const tw = (todos: unknown) => ({ name: 'TodoWrite', input: { todos } })

  test('reads the NEWEST TodoWrite, superseding earlier ones', () => {
    // recentToolCalls is NEWEST-FIRST (session.summary.ts unshifts each call), so the
    // most recent TodoWrite (the 3-item list) sits ahead of the older one-item list.
    const calls = [
      { name: 'Bash', input: { command: 'bun test' } },
      tw([
        { content: 'read code', status: 'completed' },
        { content: 'write code', status: 'in_progress' },
        { content: 'open PR', status: 'pending' },
      ]),
      { name: 'Edit', input: { file: 'a.ts' } },
      tw([{ content: 'first plan', status: 'completed' }]),
    ]
    expect(latestTodos(calls)).toEqual([
      { content: 'read code', status: 'completed' },
      { content: 'write code', status: 'in_progress' },
      { content: 'open PR', status: 'pending' },
    ])
  })

  test('returns [] when there is no TodoWrite', () => {
    expect(latestTodos([{ name: 'Edit', input: {} }, { name: 'Bash', input: {} }])).toEqual([])
  })

  test('returns [] for undefined / empty input', () => {
    expect(latestTodos(undefined)).toEqual([])
    expect(latestTodos([])).toEqual([])
  })

  test('falls back to activeForm for content and defaults unknown status to pending', () => {
    expect(latestTodos([tw([
      { activeForm: 'Migrating token store', status: 'weird' },
      { content: '', status: 'completed' },        // dropped: no content
      { content: 'ok', status: 'in_progress' },
    ])])).toEqual([
      { content: 'Migrating token store', status: 'pending' },
      { content: 'ok', status: 'in_progress' },
    ])
  })

  test('tolerates malformed todos payload', () => {
    expect(latestTodos([tw('not-an-array')])).toEqual([])
    expect(latestTodos([{ name: 'TodoWrite', input: null }])).toEqual([])
  })

  test('todoProgress tallies completed vs total', () => {
    expect(todoProgress([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'pending' },
    ])).toEqual({ done: 2, total: 4 })
    expect(todoProgress([])).toEqual({ done: 0, total: 0 })
  })
})

describe('orderManagedProjects', () => {
  const mk = (name: string, confidence: ManagedProject['confidence']): ManagedProject => ({
    id: name.toLowerCase(),
    name,
    path: `/repos/${name}`,
    dirs: [{ path: `/repos/${name}` }],
    confidence,
    source: 'manual',
  })

  test('confidence is the primary sort: high > medium > low', () => {
    const projects = [mk('low-one', 'low'), mk('high-one', 'high'), mk('med-one', 'medium')]
    expect(orderManagedProjects(projects, {}).map((p) => p.name)).toEqual([
      'high-one',
      'med-one',
      'low-one',
    ])
  })

  test('within one confidence tier, higher active-agent count wins', () => {
    const projects = [mk('quiet', 'high'), mk('busy', 'high'), mk('mid', 'high')]
    const counts = { busy: 5, mid: 2, quiet: 0 }
    expect(orderManagedProjects(projects, counts).map((p) => p.name)).toEqual([
      'busy',
      'mid',
      'quiet',
    ])
  })

  test('confidence outranks count: a high project with 0 agents beats a low project with many', () => {
    const projects = [mk('low-busy', 'low'), mk('high-idle', 'high')]
    const counts = { 'low-busy': 99, 'high-idle': 0 }
    expect(orderManagedProjects(projects, counts).map((p) => p.name)).toEqual([
      'high-idle',
      'low-busy',
    ])
  })

  test('name asc breaks a confidence+count tie', () => {
    const projects = [mk('zebra', 'medium'), mk('alpha', 'medium'), mk('mango', 'medium')]
    const counts = { zebra: 3, alpha: 3, mango: 3 }
    expect(orderManagedProjects(projects, counts).map((p) => p.name)).toEqual([
      'alpha',
      'mango',
      'zebra',
    ])
  })

  test('missing count entries are treated as 0 and it does not mutate the input', () => {
    const projects = [mk('a', 'high'), mk('b', 'high')]
    const frozen = [...projects]
    const ordered = orderManagedProjects(projects, { a: 1 })
    expect(ordered.map((p) => p.name)).toEqual(['a', 'b'])
    expect(projects).toEqual(frozen)
  })
})

describe('sessionTaskLine — prompt anchors the card ahead of the drifting last message', () => {
  test('prompt wins over summary and resp when present (the task, not the last message)', () => {
    const a = makeAgent({
      prompt: 'Add markdown to card bodies',
      summary: 'Editing FeedItem.tsx',
      resp: 'All 3 remaining hits are intentional',
      worktreeSlug: 'card-ux',
    })
    expect(sessionTaskLine(a)).toBe('Add markdown to card bodies')
  })

  test('falls back to summary -> resp -> worktreeSlug -> branch when there is no prompt', () => {
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: 'live preview' }))).toBe('live preview')
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: '', resp: 'last msg' }))).toBe('last msg')
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: '', resp: '', worktreeSlug: 'rush-1531' }))).toBe('rush-1531')
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: '', resp: '', worktreeSlug: '', branch: 'feat-x' }))).toBe('feat-x')
  })

  test('a blank/whitespace prompt is skipped so it does not blank the task line', () => {
    expect(sessionTaskLine(makeAgent({ prompt: '   ', summary: 'real work' }))).toBe('real work')
  })

  test('returns a clear placeholder when the agent carries no task signal at all', () => {
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: '', resp: '', worktreeSlug: '', branch: '' }))).toBe('No topic')
  })
})

describe('floor visibility and section counts', () => {
  test('an actual local tab stays visible without changing its headless execution context', () => {
    const attached = makeAgent({ id: 'attached', host: 'worker', context: 'headless', localTerminalAttached: true })
    const detached = makeAgent({ id: 'detached', host: 'worker', context: 'headless' })
    expect(visibleFloorAgents([attached, detached], false)).toEqual([attached])
    expect(attached.context).toBe('headless')
  })

  test('Previous dedupe uses execution owner and harness, preserving copied native ids elsewhere', () => {
    const live = makeAgent({ id: 'live', host: 'worker', agentType: 'codex', sessionId: 'S' })
    const duplicate = { ...live, id: 'previous', sessionState: 'inactive' }
    const otherHost = { ...duplicate, id: 'other-host', host: 'other-worker' }
    const otherHarness = { ...duplicate, id: 'other-harness', agentType: 'claude' }
    expect(mergeSessionAgents([live], [duplicate, otherHost, otherHarness])).toEqual([live, otherHost, otherHarness])
  })

  test('background agents are hidden by default and available through the toggle', () => {
    const foreground = makeAgent({ id: 'foreground', context: 'terminal' })
    const background = makeAgent({ id: 'background', context: 'headless' })
    expect(visibleFloorAgents([foreground, background], false).map((a) => a.id)).toEqual(['foreground'])
    expect(visibleFloorAgents([foreground, background], true).map((a) => a.id)).toEqual(['foreground', 'background'])
  })

  test('every rendered card belongs to exactly one counted section, and idle is its own section above active', () => {
    const agents = [
      makeAgent({ id: 'needs', needs: true, phase: 'waiting' }),
      makeAgent({ id: 'running', phase: 'running' }),
      makeAgent({ id: 'idle', phase: 'idle' }),
      makeAgent({ id: 'done', phase: 'done' }),
    ]
    const sections = partitionFloorAgents(agents)
    expect(sections.needs.map((a) => a.id)).toEqual(['needs'])
    // Idle is unfinished work that stopped progressing — the highest abandonment risk
    // — so it gets its own bucket and is NOT mixed in with running under 'active'
    // (root AGENTS.md "Purpose"; RUSH-2838).
    expect(sections.idle.map((a) => a.id)).toEqual(['idle'])
    expect(sections.active.map((a) => a.id)).toEqual(['running'])
    expect(sections.done.map((a) => a.id)).toEqual(['done'])
    expect(sections.needs.length + sections.idle.length + sections.active.length + sections.done.length).toBe(agents.length)
  })
})

describe('todosWithFallback — the checklist survives the recent-tool window cap', () => {
  const set = (n: number): TodoItem[] =>
    Array.from({ length: n }, (_, i) => ({ content: `t${i}`, status: 'pending' as const }))

  test('a fresh non-empty parse is used as-is', () => {
    const fresh = set(3)
    expect(todosWithFallback(fresh, set(1))).toBe(fresh)
  })

  test('an empty fresh parse falls back to the remembered set (checklist does not vanish)', () => {
    const remembered = set(2)
    expect(todosWithFallback([], remembered)).toBe(remembered)
  })

  test('empty fresh + no remembered set yields empty (no phantom checklist)', () => {
    expect(todosWithFallback([], undefined)).toEqual([])
    expect(todosWithFallback([], [])).toEqual([])
  })
})

describe('ticketWorkers', () => {
  test('groups agents by carried ticket, skipping agents with none', () => {
    const agents = [
      makeAgent({ id: 'a', ticket: 'RUSH-812' }),
      makeAgent({ id: 'b', ticket: 'RUSH-812', phase: 'waiting' }),
      makeAgent({ id: 'c', ticket: '#412' }),
      makeAgent({ id: 'd', ticket: null }),
    ]
    const by = ticketWorkers(agents)
    expect(Object.keys(by).sort()).toEqual(['#412', 'RUSH-812'])
    expect(by['RUSH-812']!.map((a) => a.id)).toEqual(['a', 'b'])
    expect(by['#412']!.map((a) => a.id)).toEqual(['c'])
  })

  test('keeps done agents — a finished worker with an open PR still owns the ticket', () => {
    const by = ticketWorkers([makeAgent({ id: 'a', ticket: 'RUSH-1', phase: 'done', pr: '#9' })])
    expect(by['RUSH-1']).toHaveLength(1)
  })

  test('empty input yields empty map', () => {
    expect(ticketWorkers([])).toEqual({})
  })
})

describe('projectRollups', () => {
  test('one pass over agents + tickets: run/wait/backlog/prs/lastActivity per project', () => {
    const by = projectRollups(
      [
        makeAgent({ id: 'a', project: 'swarmify', needs: true, lastActivityMs: 100, prUrl: 'https://x/pull/1' }),
        makeAgent({ id: 'b', project: 'swarmify', lastActivityMs: 900, prUrl: 'https://x/pull/1' }),
        makeAgent({ id: 'c', project: 'rush', lastActivityMs: 50 }),
      ],
      [
        { id: 'T-1', title: '', project: 'swarmify', source: 'LN', pri: 'high', status: 'todo', desc: '', labels: [], owner: '' },
        { id: 'T-2', title: '', project: 'swarmify', source: 'LN', pri: 'low', status: 'done', desc: '', labels: [], owner: '' },
        { id: 'T-3', title: '', project: 'ghost', source: 'GH', pri: 'med', status: 'in-progress', desc: '', labels: [], owner: '' },
      ],
    )
    expect(by['swarmify']).toEqual({ run: 2, wait: 1, backlog: 1, prs: 1, lastActivityMs: 900 })
    expect(by['rush']).toEqual({ run: 1, wait: 0, backlog: 0, prs: 0, lastActivityMs: 50 })
    // A ticket-only project still gets a rollup (the Projects pane may manage it).
    expect(by['ghost']).toEqual({ run: 0, wait: 0, backlog: 1, prs: 0, lastActivityMs: 0 })
  })

  test('empty inputs yield an empty map', () => {
    expect(projectRollups([], [])).toEqual({})
  })
})
