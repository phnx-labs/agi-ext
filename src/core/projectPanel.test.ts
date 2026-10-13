import { test, expect } from 'bun:test'
import {
  parsePrs, parseProjectDetection, parseProjectList, parseTickets,
  activityLine, backgroundKind, preferLive, projectSessions, readSessionPrefs, renderPrs, renderSessionCard, renderSessions, renderTickets,
  sessionCount, sessionMade, sessionPlace, DEFAULT_SESSION_PREFS, displayHome, projectsInFolder, ranFor, ranSpan, renderPrsProgress,
  DEFAULT_REVIEW_PREFS, applyReviewPref, readReviewPrefs, cleanTitle, sessionTitle, waitFor,
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
    .toEqual([{ name: 'agi', linearName: 'AGI', repos: [] }, { name: 'wispr', linearName: null, repos: [] }])
})

test('the project menu offers the projects with a repository inside the window folder', () => {
  const all = parseProjectList(JSON.stringify([
    { name: 'agi', linear: { name: 'AGI' }, repos: [{ slug: 'phnx-labs/agents-cli', path: '~/src/gh/agents-cli' }, { slug: 'phnx-labs/.agents-system', path: '~/.agents/.system' }] },
    { name: 'rush', repos: [{ slug: 'phnx-labs/rush', path: '/work/rush' }] },
    { name: 'site', repos: [{ slug: 'me/site', path: '~/src/gh-other/site' }] },
  ]))
  expect(all[0]!.repos).toEqual([{ slug: 'phnx-labs/agents-cli', path: '~/src/gh/agents-cli' }, { slug: 'phnx-labs/.agents-system', path: '~/.agents/.system' }])
  expect(projectsInFolder(all, '/home/me/src/gh', '/home/me').projects).toEqual([{ name: 'agi', repos: ['agents-cli', '.agents-system'] }])
  expect(projectsInFolder(all, '/work/rush', '/home/me').projects.map((p) => p.name)).toEqual(['rush'])
  expect(displayHome('/home/me/src/gh', '/home/me')).toBe('~/src/gh')
})

test('an ended card says how long it ran and when; durations read in minutes, hours and days', () => {
  expect(ranFor(47 * 60_000)).toBe('47m')
  expect(ranFor((13 * 60 + 8) * 60_000)).toBe('13h 8m')
  expect(ranFor(51 * 3_600_000)).toBe('2d 3h')
  const now = new Date(2026, 9, 13, 9, 0).getTime()
  expect(ranSpan(new Date(2026, 9, 12, 18, 50).getTime(), new Date(2026, 9, 13, 7, 56).getTime(), now)).toBe('yesterday 6:50 PM → today 7:56 AM')
  expect(ranSpan(new Date(2026, 9, 11, 4, 20).getTime(), new Date(2026, 9, 11, 12, 32).getTime(), now)).toBe('Oct 11 · 4:20 AM → 12:32 PM')
})

const OPTS = { prefs: DEFAULT_REVIEW_PREFS, mergeWith: 'squash' }

test('Review while repositories answer: each finished one draws, the rest say they are being read', () => {
  const done = new Map([['me/a', { slug: 'me/a', error: null, branch: null, release: null, open: [{ number: 7, title: 'Fix', url: 'https://github.com/me/a/pull/7', isDraft: false, ciState: 'SUCCESS', author: 'me', avatar: null, date: '2026-10-12T00:00:00Z', failing: 0 }], merged: [] }]])
  const html = renderPrsProgress(['me/a', 'me/b'], done, Date.parse('2026-10-13T00:00:00Z'), OPTS)
  expect(html).toContain('Reading b…')
  expect(html).toContain('>Fix<')
  done.set('me/b', { slug: 'me/b', error: null, branch: null, release: null, open: [], merged: [] })
  const all = renderPrsProgress(['me/a', 'me/b'], done, Date.parse('2026-10-13T00:00:00Z'), OPTS)
  expect(all).not.toContain('Reading')
})

const issue = (id: string, type: string, name: string, priority: number, extra: object = {}) =>
  ({ identifier: id, title: `t ${id}`, url: `https://linear.app/x/${id}`, priority, state: { type, name }, ...extra })

test('tickets: Doing before Todo before Backlog, urgent first, no-priority last', () => {
  const groups = parseTickets(JSON.stringify({ issues: [
    issue('A-1', 'backlog', 'Backlog', 3),
    issue('A-2', 'unstarted', 'Todo', 0),
    issue('A-3', 'started', 'Doing', 2, { delegate: { name: 'claude' }, assignee: { name: 'Muqsit Nawaz' }, projectMilestone: { name: 'Ship B' } }),
    issue('A-4', 'unstarted', 'Todo', 1),
  ] }))
  expect(groups.map((g) => g.state)).toEqual(['Doing', 'Todo', 'Backlog'])
  expect(groups[1].tickets.map((t) => t.identifier)).toEqual(['A-4', 'A-2'])
  expect(groups[0].tickets[0]).toMatchObject({ delegate: 'claude', assignee: 'Muqsit Nawaz', milestone: 'Ship B' })
  const html = renderTickets(groups)
  expect(html).toContain('data-ticket="A-3"')
  // People, not names: the delegated agent as its harness logo, the assignee as a colored initial.
  expect(html).toContain('<span class="iav agent" title="Delegated to claude"><i class="hx hx-claude"')
  expect(html).toMatch(/<span class="iav av\d" title="Muqsit Nawaz">MN<\/span>/)
})

test('tickets render escapes titles from the tracker', () => {
  const html = renderTickets(parseTickets(JSON.stringify({ issues: [{ ...issue('A-9', 'started', 'Doing', 2), title: '<img src=x onerror=alert(1)>' }] })))
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;img')
})

test('prs: repos with open PRs first, a failed repo shows its error, partial is announced, drafts and merges show on request', () => {
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
  const html = renderPrs(model, now, OPTS)
  expect(html).toContain('this list is incomplete')
  expect(html).toContain('o/broken: could not read: HTTP 502')
  // Drafts are hidden by default and counted in the header.
  expect(html).toContain('0 open · 1 draft hidden')
  expect(html).not.toContain('feat: x')
  const all = renderPrs(model, now, { ...OPTS, prefs: { ...DEFAULT_REVIEW_PREFS, showDrafts: true, showMerged: true } })
  expect(all).toContain('class="rs draft">Draft<')
  expect(all).toContain('#7 · busy · 24h</span>')
  // The author as a face on the left: a colored initial when the row carries no GitHub avatar.
  expect(all).toMatch(/<li class="prli"><span class="iav av\d"/)
  expect(all).toContain('Recently merged</span><span class="n">5</span>')
})

test('prs: a ready PR is one Merge button at the right; failing checks are counted; a draft never merges', () => {
  const model = parsePrs(JSON.stringify({ repositories: [{ slug: 'o/busy', pullRequests: [
    { number: 7, title: 'draft', url: 'https://github.com/o/busy/pull/7', isDraft: true, ciState: 'SUCCESS', author: { login: 'm' }, createdAt: '2026-10-08T00:00:00Z' },
    { number: 8, title: 'ready', url: 'https://github.com/o/busy/pull/8', isDraft: false, ciState: 'SUCCESS', author: { login: 'm' }, createdAt: '2026-10-08T00:00:00Z' },
    { number: 9, title: 'red', url: 'https://github.com/o/busy/pull/9', isDraft: false, ciState: 'FAILURE', failingChecks: [{ name: 'a' }, { name: 'b' }], author: { login: 'codex1' }, createdAt: '2026-10-08T00:00:00Z' },
  ], recentlyMerged: [] }] }))
  const html = renderPrs(model, Date.parse('2026-10-09T00:00:00Z'), { prefs: { ...DEFAULT_REVIEW_PREFS, showDrafts: true }, mergeWith: 'rebase' })
  expect(html).toContain('<button class="rs merge" data-merge-repo="o/busy" data-merge-number="8" title="Merge #8 with rebase (change in Settings)">Merge</button></li>')
  expect(html).not.toContain('data-merge-number="7"')
  expect(html).toContain('<span class="rs fail" title="2 checks failing">✕ 2</span>')
  // Status grouping puts ready ones first; an agent author shows as its harness logo.
  expect(html.indexOf('Ready to merge')).toBeLessThan(html.indexOf('Failing'))
  expect(html).toContain('title="Delegated to codex1"')
})

test('Review preferences: unknown values fall back, one change at a time', () => {
  expect(readReviewPrefs({ group: 'x', showDrafts: 'yes' })).toEqual(DEFAULT_REVIEW_PREFS)
  expect(applyReviewPref(DEFAULT_REVIEW_PREFS, 'group', 'author')).toEqual({ ...DEFAULT_REVIEW_PREFS, group: 'author' })
  expect(applyReviewPref(DEFAULT_REVIEW_PREFS, 'showDrafts', 'true')).toMatchObject({ showDrafts: true })
  expect(applyReviewPref(DEFAULT_REVIEW_PREFS, 'group', 'nope')).toBeNull()
})

test('titles skip the note another session inserts, hand-backs and bare commands', () => {
  expect(cleanTitle('Another Claude session sent a message: <agent-message from="a1">Merge 3867, then the blog imagery PRs</agent-message>')).toBe('Merge 3867, then the blog imagery PRs')
  expect(cleanTitle('Another Claude session sent a message: …')).toBe('')
  expect(cleanTitle('[Subagent hand-back] The text below is the final report')).toBe('')
  expect(cleanTitle('/compact')).toBe('')
  expect(sessionTitle({ title: 'Another Claude session sent a message: …', topic: '/compact', label: 'Rush API observability', request: undefined })).toBe('Rush API observability')
  expect(sessionTitle({ title: '', topic: '', label: '', request: undefined })).toBe('Untitled')
})

test('a wait reads in seconds, then minutes and seconds, hours, days', () => {
  expect(waitFor(12_000)).toBe('12s')
  expect(waitFor(5 * 60_000 + 2_000)).toBe('5m 02s')
  expect(waitFor((18 * 60 + 4) * 60_000)).toBe('18h 4m')
  expect(waitFor(51 * 3_600_000)).toBe('2d 3h')
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
  // The CLI sends an editor tab's observer with its workspace but often no viewingIn words.
  expect(place({ host: 'yosemite-m6', context: 'terminal', presence: 'attached', observers: [{ device: 'zion', viewingIn: '', workspaceDir: '/Users/me/src/svatlas' }] })).toMatchObject({ kind: 'window', name: 'svatlas' })
  // A tab on another machine is not this desktop's window.
  expect(place({ host: 'yosemite-m6', context: 'terminal', presence: 'attached', observers: [{ device: 'mac-mini', viewingIn: 'VSCodium tab 2', workspaceDir: '/x/agents-cli' }] }).kind).toBe('terminal')
})

test('a card shows one fixed preview: the agent latest words, previews of images, and chips with each service mark', () => {
  const s = row({
    title: 'Health', phase: 'idle', liveStatus: 'idle', request: { headline: 'Dude, no, no, dude.' }, tabHere: true, tabIndex: 3, host: 'yosemite-m6',
    timeline: { steps: [{ text: 'older' }, { text: 'Your trusted publisher is set up correctly.' }] }, lastResponse: 'stale reply',
    lastActivityMs: NOW - 22 * 60000, prStatus: { number: 3855, checks: 'passing', isDraft: false }, ticket: 'PHNX-9',
  })
  const made = sessionMade({ artifacts: [{ path: '/h/.agents/artifacts/2026-10-10/covers/a.png', basename: 'a.png', bucket: 'artifacts', display: '~/.agents/artifacts/2026-10-10/covers/a.png', uri: 'vscode-resource:/a.png' }], pullRequests: [{ ownerRepo: 'phnx-labs/agi-cli', number: 3886, url: 'https://github.com/phnx-labs/agi-cli/pull/3886' }] })
  const html = card(s, { made, thumbs: [{ uri: 'vscode-resource:/in.png', path: '/h/.agents/.history/attachments/in.png', label: 'in.png' }], selected: true })
  expect(html).toContain('class="ttl" title="Health">Health<')
  expect(html).toContain('class="pill st-yours"><i></i>Your move · idle<')
  expect(html).toContain('class="where">m6 · tab 3<')
  expect(html).toContain('class="line said">Your trusted publisher is set up correctly.<')
  expect(html).not.toContain('stale reply')
  // No hidden full card: hover changes nothing but the icons.
  expect(html).not.toContain('class="full"')
  expect(html).toContain('title="Attached by you: in.png"')
  expect(html).toContain('title="Made by the agent: a.png"')
  expect(html).toContain('aria-hidden="true"><path fill="currentColor" stroke="none" d="M8 0C3.58')
  expect(html).toContain('agi-cli #3886')
  expect(html).toContain('data-open-ticket="PHNX-9"')
  expect(html).toContain('fill="#5E6AD2"')
  expect(html).toContain('data-act="focus"')
  expect(html).toContain('data-act="close"')
  expect(html).toContain('data-here="1"')
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

test('a pending question shows in the card, opens on a click, and says how long it has waited', () => {
  const ask = card(row({ phase: 'waiting', liveStatus: 'input_required', question: { text: 'Run the restart on m2?' } }))
  expect(ask).toContain('<div class="ask" data-expand title="Show the whole question"><span class="q">Run the restart on m2?</span><span class="exp">more</span></div>')
  const opened = new Date(NOW - 12_000).toISOString()
  const fresh = card(row({ phase: 'waiting', liveStatus: 'input_required', attention: { kind: 'question', state: 'open', openedAt: opened } }))
  expect(fresh).toContain(`Your move · asks · <span class="wait" data-since="${NOW - 12_000}">12s</span>`)
  expect(fresh).toContain('card st-asks fresh')
  const old = card(row({ phase: 'waiting', liveStatus: 'input_required', attention: { kind: 'question', state: 'open', openedAt: new Date(NOW - 3_600_000).toISOString() } }))
  expect(old).not.toContain(' fresh')
})

test('the longest-waiting question leads Your move', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString()
  const html = renderSessions([
    row({ sessionId: 'new', phase: 'waiting', liveStatus: 'input_required', attention: { kind: 'question', state: 'open', openedAt: at(60_000) } }),
    row({ sessionId: 'old', phase: 'waiting', liveStatus: 'input_required', attention: { kind: 'question', state: 'open', openedAt: at(3_600_000) } }),
  ], NOW, { selectedId: null, here: HERE, prefs: prefs() })
  expect(html.indexOf('data-session="old"')).toBeLessThan(html.indexOf('data-session="new"'))
})

test('your move is pinned above every grouping; group by app orders this window, other windows, Ghostty, background, then tabs with no agent', () => {
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
  // The header carries only its controls; the tab already counts.
  expect(html).not.toContain('your move</span>')
  expect(html).toContain('data-search')
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
  expect(draw({ folded: [] })).toContain('data-session="ended"')
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
  // Three states: the replied session is pinned under Your move, the working one groups under Running.
  expect(byState.indexOf('data-session="b"')).toBeLessThan(byState.indexOf('data-group="state:running"'))
  expect(byState.indexOf('data-group="state:running"')).toBeLessThan(byState.indexOf('data-session="a"'))
  expect(byState).not.toContain('data-group="state:yours"')
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

test('stored preferences keep only values this version knows; older ones get Ended shown and folded', () => {
  expect(readSessionPrefs({ group: 'nonsense', sort: 'name', showEnded: true, folded: ['here', 3], hidden: { a: 5, b: 'x' } }))
    .toEqual({ ...DEFAULT_SESSION_PREFS, sort: 'name', showEnded: true, folded: ['here'], hidden: { a: 5 } })
  expect(readSessionPrefs(undefined)).toEqual(DEFAULT_SESSION_PREFS)
  // Before v2, Ended off was the old default, not a choice.
  expect(readSessionPrefs({ group: 'app', showEnded: false, folded: ['here'] })).toMatchObject({ showEnded: true, folded: ['here', 'ended', 'state:ended'], v: 2 })
  // Machine grouping has no Ended group to fold, so Ended stays off rather than flooding the list.
  expect(readSessionPrefs({ group: 'machine', showEnded: false })).toMatchObject({ showEnded: false })
  const byState = renderSessions([row({ sessionId: 'gone', phase: 'done', liveStatus: 'closed' })], NOW, { selectedId: null, here: HERE, prefs: readSessionPrefs({ group: 'state' }) })
  expect(byState).toContain('class="grp closed" data-group="state:ended"')
  expect(readSessionPrefs({ showEnded: false, folded: [], v: 2 })).toMatchObject({ showEnded: false, folded: [] })
})

test('a card leads with its harness logo and ends its meta line with the model the CLI reported', () => {
  const html = card(row({ agentType: 'claude', model: 'claude-opus-5-5' }))
  expect(html).toContain('<div class="top"><i class="hx hx-claude" role="img" aria-label="Claude" title="Claude"></i><span class="ttl" title="T">')
  expect(html).toMatch(/<span class="where">[^<]*<\/span><span class="mdl" title="claude-opus-5-5">opus-5-5<\/span><\/div>/)
  const bare = card(row({ agentType: 'amp' }))
  expect(bare).not.toContain('class="hx')
  expect(bare).not.toContain('class="mdl"')
})

test('your move leads with a question, then an idle turn; a crashed process is Ended', () => {
  const html = renderSessions([
    row({ sessionId: 'done', phase: 'idle', liveStatus: 'idle', lastActivityMs: 9 }),
    row({ sessionId: 'crash', phase: 'failed', liveStatus: 'crashed', lastActivityMs: 8, tabHere: true }),
    row({ sessionId: 'ask', phase: 'waiting', liveStatus: 'input_required', lastActivityMs: 1, attention: { kind: 'question', state: 'open' } }),
    row({ sessionId: 'run', phase: 'running', liveStatus: 'running', lastActivityMs: 10 }),
  ], NOW, { selectedId: null, here: HERE, prefs: prefs({ group: 'state', folded: [] }) })
  const at = (id: string) => html.indexOf(`data-session="${id}"`)
  expect([at('ask'), at('done'), at('run'), at('crash')]).toEqual([at('ask'), at('done'), at('run'), at('crash')].sort((x, y) => x - y))
  expect(html).toContain('<div class="ph">Your move <span class="n">2</span></div>')
})

test('needs you orders by the CLI attention kind: a question before a permission before a stall', () => {
  const ask = (id: string, kind: string, ms: number) => row({ sessionId: id, phase: 'waiting', liveStatus: 'input_required', lastActivityMs: ms, attention: { kind, state: 'open' } })
  const html = renderSessions([ask('stall', 'stall', 3), ask('perm', 'permission', 2), ask('q', 'question', 1)], NOW, { selectedId: null, here: HERE, prefs: prefs() })
  const at = (id: string) => html.indexOf(`data-session="${id}"`)
  expect([at('q'), at('perm'), at('stall')]).toEqual([at('q'), at('perm'), at('stall')].sort((x, y) => x - y))
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


test("today's goal: its sessions carry ☀, the header counts them, and the toggle shows only them", () => {
  const rows = [
    row({ sessionId: 'goal', title: 'Secrets in cloud runs', topic: 'Work on PHNX-4353: make the Rush Cloud infrastructure work with secrets', tabHere: true }),
    row({ sessionId: 'other', title: 'Landing page hero', topic: 'PHNX-4290 landing page', tabHere: true }),
  ]
  const html = renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: prefs(), todayId: 'PHNX-4353' })
  expect(html).toContain('data-pref="todayOnly" data-value="true" aria-pressed="false"')
  expect(html).toContain('☀ 1 on today</button>')
  const goalCard = html.slice(html.indexOf('data-session="goal"'), html.indexOf('data-session="goal"') + 600)
  expect(goalCard).toContain('<span class="tday" title="On today\'s goal">☀</span>')
  const only = renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: prefs({ todayOnly: true }), todayId: 'PHNX-4353' })
  expect(only).toContain('data-session="goal"')
  expect(only).not.toContain('data-session="other"')
  // No goal read yet: no toggle, no marks, nothing filtered.
  const none = renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: prefs({ todayOnly: true }) })
  expect(none).not.toContain('on today')
  expect(none).toContain('data-session="other"')
  expect(readSessionPrefs({ todayOnly: true }).todayOnly).toBe(true)
  expect(readSessionPrefs({}).todayOnly).toBe(false)
})

test('prs: the author shows as their GitHub avatar, only from avatars.githubusercontent.com', () => {
  const pr = (avatarUrl: string) => parsePrs(JSON.stringify({ repositories: [{ slug: 'o/r', pullRequests: [{ number: 9, title: 't', url: 'https://github.com/o/r/pull/9', isDraft: false, ciState: 'SUCCESS', author: { login: 'muqsitnawaz', avatarUrl }, createdAt: '2026-10-08T00:00:00Z' }], recentlyMerged: [] }] }))
  expect(renderPrs(pr('https://avatars.githubusercontent.com/u/13007401?v=4'), Date.parse('2026-10-09T00:00:00Z'), OPTS)).toContain('<img class="pav" src="https://avatars.githubusercontent.com/u/13007401?v=4" alt="muqsitnawaz"')
  expect(renderPrs(pr('https://evil.example/x.png'), Date.parse('2026-10-09T00:00:00Z'), OPTS)).not.toContain('evil.example')
})

test('a session whose agent posted blocked is pinned first, as Your move · blocked', () => {
  const rows = [
    row({ sessionId: 'ask', phase: 'waiting', liveStatus: 'input_required', attention: { kind: 'question', state: 'open' }, tabHere: true }),
    row({ sessionId: 'session_stuck', phase: 'idle', liveStatus: 'idle', tabHere: true }),
  ]
  const html = renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: prefs(), blockedIds: new Set(['stuck']) })
  expect(html.indexOf('data-session="session_stuck"')).toBeLessThan(html.indexOf('data-session="ask"'))
  expect(html).toContain('<span class="pill st-blocked"><i></i>Your move · blocked</span>')
  expect(renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: prefs() })).not.toContain('st-blocked')
})
