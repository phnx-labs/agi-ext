// The Sessions list after the owner's 2026-10-19 videos (12:58 and 1:42 AM): ★ favorites
// on top and still in their own group, a prompt the agent has not answered marked
// "You:", the pinned title renaming only a Claude tab here, and Settings > Show the
// session list off leaving the front tab's card alone.
import { expect, test } from 'bun:test'
import { DEFAULT_CARD_SETTINGS, cardSettings } from './settings'
import { DEFAULT_SESSION_PREFS, readSessionPrefs, renderSessions, type SessionHere, type SessionLike } from './projectPanel'
import { applyPanelSetting, renderPanelSettings } from './panelSettings'
import { getDefaultSettings } from './settings'

const NOW = Date.parse('2026-10-19T02:00:00Z')
const HERE: SessionHere = { device: 'zion', localHost: 'this-mac', workspace: 'agents', editor: 'vscodium', editorName: 'VSCodium', icons: {} }
const row = (o: Partial<SessionLike>): SessionLike => ({
  sessionId: 's', host: 'this-mac', title: 'T', label: '', topic: '', phase: 'idle', liveStatus: 'idle', lastResponse: '', activity: '',
  ticket: null, lastActivityMs: NOW - 60_000, confirmedProject: 'agi', agentType: 'claude', ...o,
})
const ROWS = [
  row({ sessionId: 'front', title: 'Front tab', tabHere: true, tabIndex: 1, lastResponse: 'Merged it.' }),
  row({ sessionId: 'starred', title: 'Starred one', tabHere: true, tabIndex: 2, lastResponse: 'Looking.' }),
  row({ sessionId: 'asker', title: 'Asks you', tabHere: true, tabIndex: 3, phase: 'waiting', liveStatus: 'waiting',
    attention: { key: 'k1', kind: 'question', state: 'open', openedAt: new Date(NOW - 30_000).toISOString(), question: { text: 'Ship it?' }, choices: [{ id: 'y', label: 'Yes' }] } }),
]
const draw = (o: { favorites?: string[]; cards?: Partial<typeof DEFAULT_CARD_SETTINGS> } = {}) => renderSessions(ROWS, NOW, {
  selectedId: 'front', frontId: 'front', here: HERE, prefs: DEFAULT_SESSION_PREFS, favorites: new Set(o.favorites ?? []), cards: { ...DEFAULT_CARD_SETTINGS, ...o.cards },
})
const sectionOf = (html: string, key: string) => html.slice(html.indexOf(`data-group="${key}"`), html.indexOf('</section>', html.indexOf(`data-group="${key}"`)))
const ids = (html: string) => [...html.matchAll(/class="card [^"]*"[^>]*data-session="([^"]+)"/g)].map((m) => m[1])

test('Add to Favorites is in ⋯ (owner video, 2026-10-27 9:24 AM); a favorite shows ★ and leads the list under the pinned card, still in its own group', () => {
  const plain = draw()
  expect(plain).toContain('<button class="favitem" data-fav="starred" aria-pressed="false">Add to Favorites</button>')
  expect(plain).not.toContain('class="star')
  expect(plain).not.toContain('data-group="favorites"')
  const html = draw({ favorites: ['starred', 'asker'] })
  expect(html).toContain('<button class="favitem" data-fav="starred" aria-pressed="true">Remove from Favorites</button>')
  expect(html).toContain('<span class="star on" title="Favorite" aria-label="Favorite">★</span>')
  // Pinned card, then Favorites, then the grouping.
  expect(html.indexOf('front-pin')).toBeLessThan(html.indexOf('data-group="favorites"'))
  expect(html.indexOf('data-group="favorites"')).toBeLessThan(html.indexOf('data-group="here"'))
  const favs = sectionOf(html, 'favorites')
  expect(favs).toContain('<b>Favorites</b> <span class="n">2</span>')
  // A group header is its icon, name and count; no row of colored dots (owner video, 2026-10-27 9:24 AM).
  expect(html).not.toContain('class="dots"')
  // An ask leads, as in every group; a copy asks with its question only, so its answers exist once.
  expect(ids(favs)).toEqual(['asker', 'starred'])
  expect(favs).toContain('Ship it?')
  expect(favs).not.toContain('data-choice')
  expect(ids(sectionOf(html, 'here'))).toEqual(['asker', 'front', 'starred'])
  // Listed cards show the question only by default; Settings > Asks on listed cards puts the answers back.
  expect(sectionOf(html, 'here')).not.toContain('data-choice="y"')
  expect(sectionOf(draw({ favorites: ['starred', 'asker'], cards: { asks: 'answers' } }), 'here')).toContain('data-choice="y"')
  // Settings > Favorites group off: the stars stay, the group goes.
  const off = draw({ favorites: ['starred'], cards: { favorites: false } })
  expect(off).not.toContain('data-group="favorites"')
  expect(off).toContain('<span class="star on" title="Favorite" aria-label="Favorite">★</span>')
})

test('a card whose agent has not spoken yet marks your prompt "You:", on the list and on the pinned card', () => {
  const quiet = row({ sessionId: 'new', title: 'New one', tabHere: true, tabIndex: 1, phase: 'running', liveStatus: 'running', request: { headline: 'Fix the **login** page' } })
  const html = renderSessions([quiet], NOW, { selectedId: null, frontId: 'new', here: HERE, prefs: DEFAULT_SESSION_PREFS })
  expect(html.match(/<div class="line said you"><b>You:<\/b> Fix the login page<\/div>/g)).toHaveLength(2)
  // Once the agent says something, that is the line, unmarked.
  const spoke = renderSessions([{ ...quiet, lastResponse: 'On it.' }], NOW, { selectedId: null, frontId: null, here: HERE, prefs: DEFAULT_SESSION_PREFS })
  expect(spoke).toContain('<div class="line said">On it.</div>')
  expect(spoke).not.toContain('You:')
})

test('the pinned title renames a Claude session with a tab here; any other title says why it cannot', () => {
  const pinned = (o: Partial<SessionLike>) => {
    const html = renderSessions([row({ sessionId: 'p', tabHere: true, tabIndex: 1, ...o })], NOW, { selectedId: null, frontId: 'p', here: HERE, prefs: DEFAULT_SESSION_PREFS })
    return html.slice(html.indexOf('front-pin'), html.indexOf('data-group='))
  }
  expect(pinned({})).toContain('<span class="ttl rn" data-keep data-ttl="T" data-rename="1" title="T\nClick to rename (Claude /rename)">T</span>')
  expect(pinned({ agentType: 'codex' })).toContain('data-rename="0" title="T\nCodex has no /rename, so its name comes from the session"')
  // A listed card's title is never editable.
  const listed = renderSessions([row({ sessionId: 'p', tabHere: true, tabIndex: 1 })], NOW, { selectedId: null, frontId: null, here: HERE, prefs: DEFAULT_SESSION_PREFS })
  expect(listed).not.toContain('data-rename')
})

test('Show the session list off leaves the pinned card and its ask; with no agent tab in front it says where the rest are', () => {
  const askFront = renderSessions(ROWS, NOW, { selectedId: null, frontId: 'asker', here: HERE, prefs: DEFAULT_SESSION_PREFS, cards: { ...DEFAULT_CARD_SETTINGS, list: false } })
  expect(ids(askFront)).toEqual(['asker'])
  expect(askFront).toContain('data-choice="y"')
  expect(askFront).not.toContain('<section')
  const none = renderSessions(ROWS, NOW, { selectedId: null, frontId: null, here: HERE, prefs: DEFAULT_SESSION_PREFS, cards: { ...DEFAULT_CARD_SETTINGS, list: false } })
  expect(ids(none)).toEqual([])
  expect(none).toContain('The session list is off in Settings. ⌘K finds every session.')
})

test('Settings > Session list: both on by default, each a checkbox that writes its own key', () => {
  expect(cardSettings(undefined)).toMatchObject({ list: true, favorites: true })
  expect(cardSettings({ list: false } as never)).toMatchObject({ list: false, favorites: true })
  const s = getDefaultSettings()
  expect(applyPanelSetting(s, 'cards.list', false)?.cards).toMatchObject({ list: false, favorites: true })
  expect(applyPanelSetting(s, 'cards.favorites', 'no')).toBeNull()
  const html = renderPanelSettings({ settings: s, devices: null, defaultAgentTitle: 'Claude', secondaryAgentTitle: 'Codex', modifier: '⌘⇧' })
  expect(html).toContain('<div class="sh">Session list</div>')
  expect(html).toContain('<b>Show the session list</b>')
  expect(html).toContain('data-setting="cards.list" checked')
  expect(html).toContain('data-setting="cards.favorites" checked')
})

test('Settings round-trip every Asks choice; previews and the state pill are parts of their own, on by default (owner, 2026-10-22 12:30 PM)', () => {
  expect(cardSettings(undefined)).toMatchObject({ asks: 'question', previews: true, state: true })
  for (const asks of ['answers', 'question', 'off'] as const) expect(cardSettings({ asks }).asks).toBe(asks)
  expect(applyPanelSetting(getDefaultSettings(), 'cards.previews', false)?.cards).toMatchObject({ previews: false })
  expect(applyPanelSetting(getDefaultSettings(), 'cards.state', false)?.cards).toMatchObject({ state: false })
})

test('⇅ > View > Compact draws listed cards as the title row, the latest line and what it made; Default keeps the rest (owner, 2026-10-22 1:02 PM)', () => {
  expect(readSessionPrefs(undefined).view).toBe('default')
  expect(readSessionPrefs({ view: 'compact', v: 4 }).view).toBe('compact')
  const thumbs = () => [{ uri: 'data:x', path: '/a.png', label: 'a.png' }]
  const at = (view: 'default' | 'compact') => renderSessions(ROWS, NOW, { selectedId: 'front', frontId: 'front', here: HERE, prefs: { ...DEFAULT_SESSION_PREFS, view }, cards: DEFAULT_CARD_SETTINGS, thumbsFor: thumbs })
  const compact = at('compact')
  expect(compact).toContain('data-pref="view" data-value="compact"><span class="ck">✓</span>Compact')
  const listed = compact.slice(compact.indexOf('data-group="here"'))
  expect(listed).toMatch(/class="card st-asks compact/)
  expect(listed).not.toContain('class="thumbs"')
  expect(listed).not.toContain('class="ask')
  expect(listed).toContain('<span class="pill st-asks"><i></i>Asks</span>')
  // The pinned card is never compact and keeps its answers.
  expect(compact.slice(0, compact.indexOf('data-group'))).not.toContain(' compact')
  const full = at('default')
  expect(full.slice(full.indexOf('data-group="here"'))).toContain('class="thumbs"')
  expect(full).not.toMatch(/class="card [^"]*compact/)
})
