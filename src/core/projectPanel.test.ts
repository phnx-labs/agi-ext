import { test, expect } from 'bun:test'
import {
  parseOverview, parsePrs, parseProjectDetection, parseProjectList, parseTickets,
  activityLine, backgroundKind, preferLive, projectSessions, readSessionPrefs, renderOverview, renderPrs, renderSessionCard, renderSessions, renderTickets,
  sessionCount, sessionMade, sessionPlace, DEFAULT_SESSION_PREFS,
  type SessionHere, type SessionLike, type SessionListPrefs,
} from './projectPanel'

// Shapes captured from agents-cli 1.22.123 / linear-cli on 2026-10-08.

test('detection: a matched workspace yields name + Linear name; no match is null', () => {
  expect(parseProjectDetection('{"name":"agi","linear":{"name":"AGI","projectId":"x"},"root":"~/src/a"}'))
    .toEqual({ name: 'agi', linearName: 'AGI' })
  expect(parseProjectDetection('{"name":null,"linear":null,"root":null}')).toBeNull()
})

test('project list keeps projects without a Linear binding', () => {
  expect(parseProjectList('[{"name":"agi","linear":{"name":"AGI"}},{"name":"wispr"}]'))
    .toEqual([{ name: 'agi', linearName: 'AGI' }, { name: 'wispr', linearName: null }])
})

const STATUS = JSON.stringify([{
  name: 'agi', description: 'Agents CLI',
  linear: { name: 'AGI', done: 90, total: 100, inProgress: 4,
    nextMilestone: { name: 'Ship B' },
    milestones: [
      { name: 'Ship A', done: 3, total: 3, targetDate: '2026-08-01' },
      { name: 'Ship C', done: 1, total: 4, targetDate: '2026-12-01' },
      { name: 'Ship B', done: 2, total: 5, targetDate: '2026-09-01' },
    ] },
  schedule: { kind: 'overdue', milestone: 'Ship B', days: 37 },
  byStatus: { running: 1, idle: 9 },
  openPrs: [{ number: 1 }, { number: 2 }],
  latestRelease: { tag: 'v1.2.3', publishedAt: '2026-10-08T22:32:31Z' },
}])

test('overview: the current milestone shows; with none current it says so and counts unplanned work', () => {
  const groups = parseTickets(JSON.stringify({ issues: [
    { identifier: 'A-1', title: 'a', url: 'u', priority: 2, state: { type: 'started', name: 'Doing' } },
    { identifier: 'A-2', title: 'b', url: 'u', priority: 3, state: { type: 'unstarted', name: 'Todo' }, projectMilestone: { name: 'Ship C' } },
  ] }))
  const withCurrent = renderOverview(parseOverview(STATUS), '2026-10-08', groups)
  expect(withCurrent).toContain('Ship C')
  expect(withCurrent).toContain('1/4')
  expect(withCurrent).toContain('90%')
  expect(withCurrent).toMatch(/aria-label="1 Doing, 1 Todo"/)
  const none = renderOverview(parseOverview(STATUS), '2026-12-31', groups)
  expect(none).toContain('No current milestone.')
  expect(none).toContain('2 past due.')
  expect(none).toContain('1 open tickets unplanned.')
})

test('overview refuses a status that is not one project card', () => {
  expect(() => parseOverview('[]')).toThrow('Expected one project card, got 0')
  expect(() => parseOverview('{}')).toThrow('Unexpected project status shape')
})

const issue = (id: string, type: string, name: string, priority: number, extra: object = {}) =>
  ({ identifier: id, title: `t ${id}`, url: `https://linear.app/x/${id}`, priority, state: { type, name }, ...extra })

test('tickets: Doing before Todo before Backlog, urgent first, no-priority last', () => {
  const groups = parseTickets(JSON.stringify({ issues: [
    issue('A-1', 'backlog', 'Backlog', 3),
    issue('A-2', 'unstarted', 'Todo', 0),
    issue('A-3', 'started', 'Doing', 2, { delegate: { name: 'Claude' }, projectMilestone: { name: 'Ship B' } }),
    issue('A-4', 'unstarted', 'Todo', 1),
  ] }))
  expect(groups.map((g) => g.state)).toEqual(['Doing', 'Todo', 'Backlog'])
  expect(groups[1].tickets.map((t) => t.identifier)).toEqual(['A-4', 'A-2'])
  expect(groups[0].tickets[0]).toMatchObject({ owner: 'Claude', milestone: 'Ship B' })
  expect(renderTickets(groups)).toContain('data-url="https://linear.app/x/A-3"')
})

test('tickets render escapes titles from the tracker', () => {
  const html = renderTickets(parseTickets(JSON.stringify({ issues: [{ ...issue('A-9', 'started', 'Doing', 2), title: '<img src=x onerror=alert(1)>' }] })))
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;img')
})

test('prs: repos with open PRs first, a failed repo shows its error, partial is announced, state is a ring', () => {
  const now = Date.parse('2026-10-09T00:00:00Z')
  const model = parsePrs(JSON.stringify({ partial: true, repositories: [
    { slug: 'o/quiet', pullRequests: [], recentlyMerged: [] },
    { slug: 'o/broken', error: 'HTTP 502', pullRequests: [], recentlyMerged: [] },
    { slug: 'o/busy', defaultBranch: { name: 'main', ciState: 'FAILURE' },
      pullRequests: [{ number: 7, title: 'feat: x', url: 'https://github.com/o/busy/pull/7', isDraft: true, ciState: 'SUCCESS', author: { login: 'm' }, createdAt: '2026-10-08T00:00:00Z' }],
      recentlyMerged: Array.from({ length: 8 }, (_, i) => ({ number: i, title: `m${i}`, url: `https://github.com/o/busy/pull/${i}`, ciState: 'SUCCESS', author: { login: 'm' }, mergedAt: '2026-10-07T00:00:00Z' })) },
  ] }))
  expect(model.repos[0].slug).toBe('o/busy')
  expect(model.repos[0].merged).toHaveLength(5)
  const html = renderPrs(model, now)
  expect(html).toContain('this list is incomplete')
  expect(html).toContain('Could not read: HTTP 502')
  expect(html).toContain('aria-label="Draft"')
  expect(html).toContain('#7 · 24h · m')
  expect(html).not.toContain('o/quiet')
  expect(html).toContain('<details open><summary>merged <span class="n">5</span>')
})

const row = (o: Partial<SessionLike>): SessionLike => ({
  sessionId: 's', host: 'yosemite-m6', title: 'T', label: '', topic: '', phase: 'running', liveStatus: 'running',
  lastResponse: '', activity: '', ticket: null, lastActivityMs: 0, confirmedProject: 'agi', ...o,
})
const NOW = Date.parse('2026-10-09T00:00:00Z')

test('projectSessions keeps only the CLI-confirmed project, newest first', () => {
  const ordered = projectSessions([
    row({ sessionId: 'old', lastActivityMs: 1 }),
    row({ sessionId: 'other', confirmedProject: 'rush', lastActivityMs: 9 }),
    row({ sessionId: 'new', lastActivityMs: 5 }),
  ], 'AGI')
  expect(ordered.map((r) => r.sessionId)).toEqual(['new', 'old'])
})

const HERE: SessionHere = {
  device: 'zion', localHost: 'this-mac', workspace: 'agents', editor: 'vscodium', editorName: 'VSCodium',
  icons: { vscodium: 'vscode-resource:/assets/apps/vscodium.png', ghostty: 'vscode-resource:/assets/apps/ghostty.png' },
}
const prefs = (o: Partial<SessionListPrefs> = {}): SessionListPrefs => ({ ...DEFAULT_SESSION_PREFS, ...o })
const card = (s: SessionLike, o: { thumbs?: { uri: string; path: string; label: string }[]; made?: ReturnType<typeof sessionMade> | null; selected?: boolean } = {}) =>
  renderSessionCard(s, sessionPlace(s, HERE), NOW, { selected: !!o.selected, pinned: false, here: HERE, thumbs: o.thumbs ?? [], made: o.made ?? null })

test('a session lives where its tab is: this window, another window by its workspace, Ghostty, the background, or a tab its agent left', () => {
  const place = (o: Partial<SessionLike>) => sessionPlace(row(o), HERE)
  expect(place({ host: 'yosemite-m5', tabHere: true, tabIndex: 32 })).toMatchObject({ kind: 'here', key: 'here', name: 'agents', where: 'm5 · tab 32' })
  expect(place({ host: 'yosemite-m6', observers: [{ device: 'zion', viewingIn: 'VSCodium tab 4', workspaceDir: '/Users/me/src/agents-cli' }] }))
    .toMatchObject({ kind: 'window', key: 'window:agents-cli', name: 'agents-cli', where: 'm6 · tab 4' })
  expect(place({ host: 'this-mac', terminalApp: 'ghostty', context: 'terminal', presence: 'attached' })).toMatchObject({ kind: 'ghostty', where: 'zion' })
  expect(place({ host: 'yosemite-m2', context: 'headless' })).toMatchObject({ kind: 'background', where: 'm2 · headless' })
  expect(place({ host: 'yosemite-m1', context: 'terminal', presence: 'attached' })).toMatchObject({ kind: 'terminal' })
  expect(place({ phase: 'done', liveStatus: 'closed', tabHere: true })).toMatchObject({ kind: 'leftover', name: 'Tabs with no agent' })
  expect(place({ phase: 'done', liveStatus: 'closed' })).toMatchObject({ kind: 'ended' })
  // A multi-root window: a tab whose workspace is one of this window's folders is this window, not another.
  expect(sessionPlace(row({ host: 'yosemite-m6', context: 'terminal', presence: 'attached', observers: [{ device: 'zion', viewingIn: 'VSCodium tab 4', workspaceDir: '/x/agents-cli' }] }), { ...HERE, folders: ['agents', 'agents-cli'] }).kind).toBe('terminal')
  // A tab on another machine is not this desktop's window.
  expect(place({ host: 'yosemite-m6', context: 'terminal', presence: 'attached', observers: [{ device: 'mac-mini', viewingIn: 'VSCodium tab 2', workspaceDir: '/x/agents-cli' }] }).kind).toBe('terminal')
})

test('a card at rest is one line plus a strip; the full card keeps your ask, the agent, and what it made', () => {
  const s = row({
    title: 'Health', phase: 'idle', liveStatus: 'idle', request: { headline: 'Dude, no, no, dude.' }, tabHere: true, tabIndex: 3, host: 'yosemite-m6',
    timeline: { steps: [{ text: 'older' }, { text: 'Your trusted publisher is set up correctly.' }] }, lastResponse: 'stale reply',
    lastActivityMs: NOW - 22 * 60000, prStatus: { number: 3855, checks: 'passing', isDraft: false },
  })
  const made = sessionMade({ artifacts: [{ path: '/h/.agents/artifacts/2026-10-10/covers/a.png', basename: 'a.png', bucket: 'artifacts', display: '~/.agents/artifacts/2026-10-10/covers/a.png', uri: 'vscode-resource:/a.png' }], pullRequests: [{ ownerRepo: 'phnx-labs/agi-cli', number: 3886, url: 'https://github.com/phnx-labs/agi-cli/pull/3886' }] })
  const html = card(s, { made, thumbs: [{ uri: 'vscode-resource:/in.png', path: '/h/.agents/.history/attachments/in.png', label: 'in.png' }], selected: true })
  expect(html).toContain('class="ttl">Health<')
  expect(html).toContain('class="pill st-yours"><i></i>Your turn<')
  expect(html).toContain('class="where">m6 · tab 3<')
  expect(html).toContain('class="cline">Your trusted publisher is set up correctly.<')
  expect(html).not.toContain('stale reply')
  expect(html).toContain('PR #3855: ready to merge')
  expect(html).toContain('<div class="lab">You</div><div class="line">Dude, no, no, dude.<')
  expect(html).toContain('<i>attached</i>')
  expect(html).toContain('<div class="lab">Made</div>')
  expect(html).toContain('agi-cli #3886')
  expect(html).toContain('<b>covers/</b>')
  expect(html).toContain('title="Made by the agent: a.png"')
  expect(html).toContain('data-act="focus"')
  expect(html).toContain('data-act="close"')
  expect(html).toContain('card st-yours sel')
  expect(html).toContain('>22m<')
  expect(card(row({ lastResponse: 'I filed [PHNX-4324](https://linear.app/x/issue/PHNX-43' }))).toContain('I filed PHNX-4324<')
})

test('what a card offers follows where it lives: close a tab here, hide one with no tab, resume a tab its agent left', () => {
  const busy = card(row({ phase: 'running', tabHere: true }))
  expect(busy).toContain('data-busy="1"')
  expect(busy).toContain('data-tab="1"')
  const elsewhere = card(row({ host: 'yosemite-m1', context: 'terminal', presence: 'attached', lastResponse: 'x' }))
  expect(elsewhere).toContain('data-act="hide"')
  expect(elsewhere).not.toContain('data-act="close"')
  const left = card(row({ phase: 'done', liveStatus: 'closed', tabHere: true, lastResponse: 'Done.' }))
  expect(left).toContain('data-act="resume"')
  expect(left).toContain('data-act="close"')
  expect(card(row({ phase: 'done', liveStatus: 'closed', tabHere: true, resumable: false }))).not.toContain('data-act="resume"')
})

test('a pending question shows as what the agent is waiting on, in the compact line too', () => {
  const ask = card(row({ phase: 'waiting', liveStatus: 'input_required', question: { text: 'Run the restart on m2?' } }))
  expect(ask).toContain('class="cline">Run the restart on m2?<')
  expect(ask).toContain('Agent · waiting on you</div><div class="ask">Run the restart on m2?<')
})

test('needs you is pinned above every grouping; group by app orders this window, other windows, Ghostty, background, then tabs with no agent', () => {
  const rows = [
    row({ sessionId: 'left', phase: 'done', liveStatus: 'closed', tabHere: true, lastResponse: 'Done.' }),
    row({ sessionId: 'bg', host: 'yosemite-m2', context: 'headless', lastResponse: 'Running.' }),
    row({ sessionId: 'gh', host: 'this-mac', terminalApp: 'ghostty', context: 'terminal', presence: 'attached', lastResponse: 'Hi.' }),
    row({ sessionId: 'win', host: 'yosemite-m6', observers: [{ device: 'zion', viewingIn: 'VSCodium tab 1', workspaceDir: '/x/agents-cli' }], lastResponse: 'Ok.' }),
    row({ sessionId: 'mine', tabHere: true, lastResponse: 'Here.' }),
    row({ sessionId: 'ask', phase: 'waiting', liveStatus: 'input_required', host: 'yosemite-m2', context: 'headless' }),
  ]
  const html = renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: prefs() })
  const at = (id: string) => html.indexOf(`data-session="${id}"`)
  expect(html.indexOf('class="pinned"')).toBeLessThan(html.indexOf('data-group='))
  expect(at('ask')).toBeLessThan(at('mine'))
  expect([at('mine'), at('win'), at('gh'), at('bg'), at('left')]).toEqual([at('mine'), at('win'), at('gh'), at('bg'), at('left')].sort((x, y) => x - y))
  expect(html).toContain('<b>agents</b> <span class="n">1</span> <span class="gs">· VSCodium · this window</span>')
  expect(html).toContain('<b>agents-cli</b>')
  expect(html).toContain('src="vscode-resource:/assets/apps/ghostty.png"')
  expect(html).toContain('data-act="close-all"')
  expect(html).toContain('2 tabs · 5 live · 1 needs you')
  expect(html.match(/data-group=/g)?.length).toBe(5)
})

test('show, hide and fold: leftover tabs and ended sessions follow Show, a hidden session returns when it moves, a folded group draws no cards', () => {
  const left = row({ sessionId: 'left', phase: 'done', liveStatus: 'closed', tabHere: true })
  const ended = row({ sessionId: 'ended', phase: 'done', liveStatus: 'closed', lastResponse: 'Shipped.' })
  const live = row({ sessionId: 'live', tabHere: true, lastActivityMs: 50 })
  const draw = (p: Partial<SessionListPrefs>) => renderSessions([left, ended, live], NOW, { selectedId: null, here: HERE, prefs: prefs(p) })
  expect(draw({})).toContain('data-session="left"')
  expect(draw({})).not.toContain('data-session="ended"')
  expect(draw({ showLeftover: false, showEnded: true })).not.toContain('data-session="left"')
  expect(draw({ showEnded: true })).toContain('data-session="ended"')
  expect(draw({ hidden: { live: 50 } })).not.toContain('data-session="live"')
  expect(draw({ hidden: { live: 40 } })).toContain('data-session="live"')
  const folded = draw({ folded: ['here'] })
  expect(folded).toContain('class="grp closed" data-group="here"')
  expect(folded).not.toContain('data-session="live"')
  expect(sessionCount([live, left, row({ phase: 'waiting' })], HERE, prefs())).toEqual({ shown: 2, asks: 1, tabs: 2 })
  // Closing the last visible session still has somewhere to offer Undo.
  expect(draw({ hidden: { live: 50 }, showLeftover: false })).toContain('<div class="toast" hidden></div>')
})

test('group by machine, by state, or not at all', () => {
  const rows = [row({ sessionId: 'a', host: 'yosemite-m5', tabHere: true }), row({ sessionId: 'b', host: 'this-mac', phase: 'idle', liveStatus: 'idle', tabHere: true })]
  const byMachine = renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: prefs({ group: 'machine' }) })
  expect(byMachine.indexOf('data-group="machine:zion"')).toBeLessThan(byMachine.indexOf('data-group="machine:yosemite-m5"'))
  const byState = renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: prefs({ group: 'state' }) })
  expect(byState.indexOf('data-group="state:working"')).toBeLessThan(byState.indexOf('data-group="state:yours"'))
  expect(renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: prefs({ group: 'none' }) })).not.toContain('data-group=')
})

test('what the agent made groups by folder; only images this machine can show get a thumbnail', () => {
  const made = sessionMade({
    artifacts: [
      { path: '/h/a/run/board.png', basename: 'board.png', bucket: 'artifacts', display: '~/a/run/board.png', uri: 'vscode-resource:/board.png' },
      { path: '/h/a/run/notes.md', basename: 'notes.md', bucket: 'artifacts', display: '~/a/run/notes.md' },
      { path: '/r/a/remote/shot.png', basename: 'shot.png', bucket: 'artifacts', display: 'm5:~/a/remote/shot.png' },
    ],
    plan: { path: '/h/plans/plan.md', display: '~/plans/plan.md' },
    linearIssue: 'PHNX-1',
  })
  expect(made.folders.map((f) => [f.name, f.images.length, f.files.map((x) => x.name)])).toEqual([['run', 1, ['notes.md']], ['remote', 0, ['shot.png']], ['plans', 0, ['plan.md']]])
  expect(made.ticket).toBe('PHNX-1')
})

test('stored preferences keep only values this version knows', () => {
  expect(readSessionPrefs({ group: 'nonsense', sort: 'name', showEnded: true, folded: ['here', 3], hidden: { a: 5, b: 'x' } }))
    .toEqual({ ...DEFAULT_SESSION_PREFS, sort: 'name', showEnded: true, folded: ['here'], hidden: { a: 5 } })
  expect(readSessionPrefs(undefined)).toEqual(DEFAULT_SESSION_PREFS)
})

test('one row per session: a live row wins over its ended or previous twin', () => {
  const rows = preferLive([
    row({ sessionId: 'a', phase: 'idle', liveStatus: 'idle', state: 'inactive' }),
    row({ sessionId: 'a', phase: 'running', liveStatus: 'running' }),
    row({ sessionId: 'b', phase: 'done', liveStatus: 'closed' }),
  ])
  expect(rows.map((r) => `${r.sessionId}:${r.phase}`)).toEqual(['a:running', 'b:done'])
})

test('a live tool call reads as the command it runs, never as a "Tool: args" label', () => {
  expect(activityLine('Bash: agents ssh zion ls')).toBe('<span class="cmd">$ agents ssh zion ls</span>')
  expect(activityLine('Read: src/a.ts')).toBe('<span class="tool">Read</span> <span class="cmd">src/a.ts</span>')
  expect(activityLine('thinking about it')).toBe('thinking about it')
  const html = card(row({ activity: 'Bash: cd /tmp && ls', lastResponse: 'Checking the tree.' }))
  expect(html).toContain('<span class="cmd">$ cd /tmp &amp;&amp; ls</span>')
  expect(html).not.toContain('Bash:')
})

test('overview shows a failed ticket read in place instead of an empty bar', () => {
  const html = renderOverview(parseOverview(STATUS), '2026-10-08', [], 'linear: HTTP 401')
  expect(html).toContain('Tickets could not be read: linear: HTTP 401')
  expect(html).not.toContain('class="sbar"')
})
