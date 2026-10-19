// ⌘K as the Project panel draws it (owner video, 2026-10-19 1:42 AM): sessions only,
// favorites first, then asks by the CLI's urgency and wait, what runs, idle turns, and
// ended sessions last and dimmed; each row aligns its details right and shows what it
// made and what you attached instead of the model.
import { expect, test } from 'bun:test'
import { paletteMatch, paletteOrder, renderPalette, type PaletteEntry, type SessionLike } from './projectPanel'

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

test('a row: logo and title, then state, machine, age and tab on the right; PRs, pages, attached images and the recap below', () => {
  const html = renderPalette([entry({
    sessionId: 'abcdef12-3456', title: 'Body alignment', tabHere: true, tabIndex: 3, recap: { text: 'Fixed the hips. Then the rest.', at: '2026-10-19T01:00:00Z' }, model: 'claude-opus',
  }, {
    made: { prs: [{ label: '#4325', url: 'https://github.com/o/r/pull/4325' }], ticket: null, folders: [{ name: 'plan', display: '~/plan', files: [{ name: 'plan.html', path: '/h/plan/plan.html' }], images: [] }] },
    images: [{ uri: 'vscode-resource:/h/.agents/.history/attachments/a.png', path: '/h/.agents/.history/attachments/a.png', label: 'a.png' }],
  })], NOW, new Set(['abcdef12-3456']))
  expect(html).toContain('data-here="1" data-title="Body alignment" data-ids="abcdef12-3456 abcdef12"')
  expect(html).toContain('<i class="hx hx-claude"')
  expect(html).toContain('<span class="kt"><span class="kfav" title="Favorite">★</span>Body alignment</span>')
  expect(html).toContain('<span class="kmeta"><span class="pill st-idle"><i></i>Idle</span>s1 · 1m · tab 3</span>')
  expect(html).toContain('data-url="https://github.com/o/r/pull/4325"')
  expect(html).toContain('data-artifact="/h/plan/plan.html"')
  expect(html).toContain('<a class="kth" href="#" data-ql="vscode-resource:/h/.agents/.history/attachments/a.png" data-name="a.png"')
  expect(html).toContain('<img data-thumb="vscode-resource:/h/.agents/.history/attachments/a.png"')
  expect(html).toContain('<span class="knote">Fixed the hips.</span>')
  // The model is not on the row.
  expect(html).not.toContain('claude-opus')
  // An ended session is dimmed and says so; an ask shows its wait.
  const ended = renderPalette([entry({ sessionId: 'e', phase: 'done', liveStatus: 'closed' })], NOW, new Set())
  expect(ended).toContain('<div class="krow ended"')
  expect(ended).toContain('<span class="pill st-ended"><i></i>Ended</span>')
  expect(renderPalette([entry({ sessionId: 'q', ...ask('k', 'normal', 125_000) })], NOW, new Set())).toContain('Asks</span>s1 · 2m 05s')
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
