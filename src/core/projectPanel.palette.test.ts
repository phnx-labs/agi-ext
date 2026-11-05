// ⌘K as the Project panel draws it (owner video, 2026-10-19 1:42 AM): sessions only,
// favorites first, then asks by the CLI's urgency and wait, what runs, idle turns, and
// ended sessions last and dimmed; each row aligns its details right and shows what it
// made and what you attached instead of the model.
import { expect, test } from 'bun:test'
import { paletteMatch, paletteOrder, renderPalette, saidSnippet, type PaletteEntry, type SessionHere, type SessionLike } from './projectPanel'

const HERE: SessionHere = { device: 'zion', localHost: 'this-mac', workspace: 'agi', editor: 'vscodium', editorName: 'VSCodium', icons: {} }

const NOW = Date.parse('2026-10-19T02:00:00Z')
const row = (o: Partial<SessionLike>): SessionLike => ({
  sessionId: 's', host: 'yosemite-s1', title: 'T', label: '', topic: '', phase: 'idle', liveStatus: 'idle', lastResponse: '', activity: '',
  ticket: null, lastActivityMs: NOW - 60_000, confirmedProject: 'agi', agentType: 'claude', ...o,
})
const ask = (key: string, urgency: string, ago: number): Partial<SessionLike> => ({
  phase: 'waiting', liveStatus: 'waiting', attention: { key, kind: 'question', state: 'open', urgency, openedAt: new Date(NOW - ago).toISOString(), question: { text: 'Ok?' } },
})
const entry = (o: Partial<SessionLike>, extra: Partial<PaletteEntry> = {}): PaletteEntry => ({ row: row(o), made: null, images: [], ...extra })
const ENTRIES = [
  entry({ sessionId: 'ended-new', title: 'Ended new', phase: 'done', liveStatus: 'closed', lastActivityMs: NOW - 1_000 }),
  entry({ sessionId: 'idle-old', title: 'Idle old', lastActivityMs: NOW - 3_600_000 }),
  entry({ sessionId: 'idle-new', title: 'Idle new', lastActivityMs: NOW - 120_000 }),
  entry({ sessionId: 'run', title: 'Running', phase: 'running', liveStatus: 'running' }),
  entry({ sessionId: 'ask-normal', title: 'Asks normal', ...ask('k1', 'normal', 600_000) }),
  entry({ sessionId: 'ask-urgent', title: 'Asks urgent', ...ask('k2', 'urgent', 60_000) }),
  entry({ sessionId: 'ask-normal-longer', title: 'Asks longer', ...ask('k3', 'normal', 900_000) }),
  entry({ sessionId: 'fav-ended', title: 'Fav ended', phase: 'done', liveStatus: 'closed', lastActivityMs: NOW - 9_000_000 }),
]

test('favorites lead, then asks by urgency and longest wait, running, idle newest first, ended last', () => {
  expect(paletteOrder(ENTRIES, new Set(['fav-ended'])).map((e) => e.row.sessionId)).toEqual([
    'fav-ended', 'ask-urgent', 'ask-normal-longer', 'ask-normal', 'run', 'idle-new', 'idle-old', 'ended-new',
  ])
})

test('a row: logo and title, then state, age in one unit and ☆ on the right; where it runs (never the device or a tab number), PRs, pages, attached images and the recap below (owner, 2026-11-04 5:57 and 9:49 PM)', () => {
  const html = renderPalette([entry({
    sessionId: 'abcdef12-3456', title: 'Body alignment', tabHere: true, tabIndex: 3, recap: { text: 'Fixed the hips. Then the rest.', at: '2026-10-19T01:00:00Z' }, model: 'claude-opus',
  }, {
    made: { prs: [{ label: '#4325', url: 'https://github.com/o/r/pull/4325' }], ticket: null, folders: [{ name: 'plan', display: '~/plan', files: [{ name: 'plan.html', path: '/h/plan/plan.html' }], images: [] }] },
    images: [{ uri: 'vscode-resource:/h/.agents/.history/attachments/a.png', path: '/h/.agents/.history/attachments/a.png', label: 'a.png' }],
  })], NOW, new Set(['abcdef12-3456']), HERE)
  expect(html).toContain('data-here="1" data-reach="here" data-title="Body alignment" data-ids="abcdef12-3456 abcdef12"')
  expect(html).toContain('<i class="hx hx-claude"')
  expect(html).toContain('<span class="kt">Body alignment</span>')
  expect(html).toContain('<span class="kmeta"><span class="pill st-idle"><i></i>Idle</span><span class="kw">1m</span><button class="kstar" data-fav="abcdef12-3456" aria-pressed="true"')
  expect(html).not.toContain('tab 3')
  expect(html).not.toContain('class="kapp')
  expect(html).toContain('data-url="https://github.com/o/r/pull/4325"')
  expect(html).toContain('data-artifact="/h/plan/plan.html"')
  expect(html).toContain('<a class="kth" href="#" data-ql="vscode-resource:/h/.agents/.history/attachments/a.png" data-name="a.png"')
  expect(html).toContain('<img data-thumb="vscode-resource:/h/.agents/.history/attachments/a.png"')
  expect(html).toContain('<span class="knote">Fixed the hips.</span>')
  // The model is not on the row.
  expect(html).not.toContain('claude-opus')
  // An ended session is dimmed and says so; an ask shows its wait.
  const ended = renderPalette([entry({ sessionId: 'e', phase: 'done', liveStatus: 'closed' })], NOW, new Set(), HERE)
  expect(ended).toContain('<div class="krow ended"')
  expect(ended).toContain('<span class="pill st-ended"><i></i>Ended</span>')
  expect(renderPalette([entry({ sessionId: 'q', ...ask('k', 'normal', 125_000) })], NOW, new Set(), HERE)).toContain('Asks</span><span class="kw">2m</span>')
  expect(renderPalette([entry({ sessionId: 'd', lastActivityMs: NOW - 28 * 3_600_000 })], NOW, new Set(), HERE)).toContain('<span class="kw">28h</span>')
})

test('matching: an exact id, then a title that starts with the words, a title holding them, then any other words', () => {
  const doc = (title: string, ids = '', text = '') => ({ ids, title, text })
  expect(paletteMatch(doc('Anything', 'a26860ac-1b2c a26860ac'), 'a26860ac')).toBe(0)
  expect(paletteMatch(doc('Anything', 'a26860ac-1b2c a26860ac'), 'a26860')).toBe(0)
  expect(paletteMatch(doc('MCP server plan'), 'mcp ser')).toBe(1)
  expect(paletteMatch(doc('Rush MCP server'), 'server mcp')).toBe(2)
  expect(paletteMatch(doc('Rush plan', '', 's1 #4325 Fixed the hips.'), '4325 hips')).toBe(3)
  expect(paletteMatch(doc('Rush plan'), 'mcp')).toBeNull()
  expect(paletteMatch(doc('Rush plan'), '   ')).toBe(3)
})

// Owner screenshot, 2026-10-19 11:32 PM: "intuit" found nothing while the front tab's agent
// was talking about Intuit. What was said in a session matches too, after everything else.
test('what was said matches last; the row carries your prompts, the question, the recap and the newest steps', () => {
  expect(paletteMatch({ ids: '', title: 'Clean services', text: 's1', said: 'Trying Intuit\'s older app dashboard.' }, 'intuit')).toBe(4)
  expect(paletteMatch({ ids: '', title: 'Clean services', text: 's1', said: 'QuickBooks' }, 'clean quickbooks')).toBe(4)
  expect(paletteMatch({ ids: '', title: 'Clean services', text: 's1', said: 'QuickBooks' }, 'intuit')).toBeNull()
  const html = renderPalette([entry({
    sessionId: 'said', title: 'fork of Platform usability', startedAs: 'Add **QuickBooks** to Rush', request: { headline: 'It\'s clicked' },
    recap: { text: 'We are adding QuickBooks. The Intuit app is half set up.', at: '2026-10-19T01:00:00Z' },
    timeline: { steps: [{ text: 'oldest step' }, ...['a', 'b', 'c'].map((t) => ({ text: `step ${t}` })), { text: 'Trying [Intuit](https://x)\'s older app dashboard.' }] },
    lastResponse: 'Trying [Intuit](https://x)\'s older app dashboard.',
  })], NOW, new Set(), HERE)
  const said = html.match(/data-said="([^"]*)"/)![1]
  expect(said).toBe('Trying Intuit&#39;s older app dashboard. · It&#39;s clicked · step c · step b · step a · We are adding QuickBooks. The Intuit app is half set up. · Add QuickBooks to Rush')
  // Each piece and the whole are capped, the oldest dropped first: the latest reply stays.
  const long = renderPalette([entry({ lastResponse: 'newest Intuit', timeline: { steps: Array.from({ length: 4 }, (_, i) => ({ text: String(i).repeat(900) })) }, recap: { text: 'r'.repeat(900), at: '' }, userTurns: Array.from({ length: 4 }, (_, i) => ({ atMs: i, text: 'u' + String(i).repeat(900) })), startedAs: 'first prompt' })], NOW, new Set(), HERE)
  const longSaid = long.match(/data-said="([^"]*)"/)![1]
  expect(longSaid.length).toBe(2000)
  expect(longSaid.startsWith('newest Intuit · ')).toBe(true)
  expect(longSaid).not.toContain('first prompt')
})

// Live yosemite-m1 row, 2026-10-20: "intuit" was in your own earlier message and 796
// characters into the agent's reply, past a 300-character cut.
test('your last messages and a long latest reply are searched too', () => {
  const docOf = (o: Partial<SessionLike>) => {
    const m = renderPalette([entry(o)], NOW, new Set(), HERE).match(/data-title="([^"]*)" data-ids="([^"]*)" data-text="([^"]*)" data-said="([^"]*)"/)!
    return { title: m[1], ids: m[2], text: m[3], said: m[4] }
  }
  const turns = ['first', 'Wait for the intuit. I put the client ID in 1Password.', 'go', 'ok', 'yes'].map((text, i) => ({ atMs: i, text }))
  expect(paletteMatch(docOf({ userTurns: turns }), 'intuit')).toBe(4)
  expect(paletteMatch(docOf({ userTurns: turns.concat(turns.slice(2)) }), 'intuit')).toBeNull()
  expect(paletteMatch(docOf({ lastResponse: 'x '.repeat(398) + 'Intuit side is done.' }), 'intuit')).toBe(4)
})

test('a snippet starts at a word boundary near the first match and marks it', () => {
  const said = 'The workspace card says it has one app, but the Apps tab says none. Trying Intuit older app dashboard.'
  expect(saidSnippet(said, 'intuit')).toEqual({ before: '\u2026but the Apps tab says none. Trying ', hit: 'Intuit', after: ' older app dashboard.' })
  expect(saidSnippet('Intuit first', 'intuit')).toEqual({ before: '', hit: 'Intuit', after: ' first' })
  expect(saidSnippet(said, 'zzz')).toBeNull()
  // The whole phrase before its longest word.
  expect(saidSnippet('~/.agents/x · the three agents finished', 'three  agents')?.hit).toBe('three agents')
  // Never across the pieces' separator.
  expect(saidSnippet('Shipped it · Trying Intuit now · step b', 'intuit')).toEqual({ before: 'Trying ', hit: 'Intuit', after: ' now' })
})

// Owner video, 2026-10-27 9:24 AM: a green dot beside s0 reads as the machine being live; a dot is only ever a state.
test('a machine never carries a dot, alive or ended', () => {
  const html = renderPalette([
    entry({ sessionId: 'live-ask', title: 'Merged changes verification', host: 'yosemite-s0', pidAlive: true, ...ask('k9', 'normal', 60_000) }),
    entry({ sessionId: 'gone', title: 'Gone', host: 'yosemite-s0', phase: 'done', liveStatus: 'closed' }),
  ], NOW, new Set(), HERE)
  const rowOf = (id: string) => html.split('<div class="krow').find((r) => r.includes(`data-session="${id}"`)) ?? ''
  expect(rowOf('live-ask')).toContain('<span class="kw">1m</span>')
  // It runs where nothing here shows it: the app is an icon under the logo, named only on hover
  // (owner, 2026-11-05 3:24 AM), and Enter opens it in place, naming the machine.
  expect(rowOf('live-ask')).toContain('<span class="kapp far" title="Background" role="img" aria-label="Background">')
  expect(rowOf('live-ask')).not.toContain('>Background<')
  expect(rowOf('live-ask')).toContain('Running in the background on s0 with no tab here')
  expect(html).not.toContain('class="run"')
})

// Owner, 2026-11-05 3:24 AM: "show it directly under the agent's icon … do not show the name".
test('the app a session runs in is its own icon under the agent logo, named only on hover', () => {
  const here = { ...HERE, icons: { ghostty: 'vscode-resource:/ext/assets/apps/ghostty.png', vscodium: 'vscode-resource:/ext/assets/apps/vscodium.png' } }
  const html = renderPalette([entry({ sessionId: 'gh', title: 'In Ghostty', host: 'this-mac', pidAlive: true, terminalApp: 'Ghostty' })], NOW, new Set(), here)
  expect(html).toContain('<span class="kapp far" title="Ghostty" role="img" aria-label="Ghostty"><img class="appic" src="vscode-resource:/ext/assets/apps/ghostty.png" alt="Ghostty"></span>')
  expect(html).not.toContain('>Ghostty<')
  // Typing the app's name still finds the row.
  expect(html).toMatch(/data-text="[^"]*Ghostty/)
  // Another window: this editor's icon, its workspace on hover.
  const win = renderPalette([entry({ sessionId: 'w', title: 'Elsewhere', host: 'this-mac', pidAlive: true, observers: [{ device: 'zion', viewingIn: 'VSCodium tab 4', workspaceDir: '/Users/me/src/agents-cli' }] } as Partial<SessionLike>)], NOW, new Set(), here)
  expect(win).toContain('<span class="kapp" title="agents-cli window" role="img" aria-label="agents-cli"><img class="appic" src="vscode-resource:/ext/assets/apps/vscodium.png" alt="VSCodium"></span>')
})
