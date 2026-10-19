// Open tabs is every agent tab in this window, whatever project the CLI filed it under.
// testdata/session-rows.window-tabs.json is cut down from zion's `agents ps --json --local`
// on 2026-10-19 (ids, windows, tab numbers and attribution kept; titles and paths
// neutralized): tab 1 of the agi-ext window ran an agent in the folder above the project
// with confirmedProject null, and the agi-ui panel dropped it (owner video, 12:58 AM: "there's an agent running in the shell, it's not
// properly recognizing it").
import { test, expect } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_SESSION_PREFS, projectFallback, projectSessions, renderSessions, type SessionHere, type SessionLike } from './projectPanel'
import { resumeItems } from './sessionPicker'

type Row = SessionLike & { cwd?: string; windowId?: string | null; tabIndex?: number | null }
const ROWS: Row[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata', 'session-rows.window-tabs.json'), 'utf8'))
const THIS_WINDOW = 'someValue.sessionId-47130'
const tabHere = (r: Row) => r.windowId === THIS_WINDOW && r.tabIndex != null
const fallback = projectFallback({ name: 'agi-ui', root: '~/src/agi-ext' }, [{ name: 'agi-ui', linearName: null }, { name: 'rush', linearName: null }])
const NOW = Date.parse('2026-10-19T09:52:00Z')
const HERE: SessionHere = { device: 'zion', localHost: 'this-mac', workspace: 'agi-ext', editor: 'vscodium', editorName: 'VSCodium', icons: {} }
const ids = (rows: Row[]) => rows.map((r) => r.sessionId.slice(0, 8))

test('a tab in this window is listed whatever its project; attribution still decides every session without a tab here', () => {
  // Without this window's tabs, the CLI's attribution alone drops tab 1.
  expect(ids(projectSessions(ROWS, 'agi-ui', fallback))).toEqual(['509fd525'])
  // With them, tab 1 joins; the session with no project and no tab here, and the rush tab in
  // another window, stay out.
  expect(ids(projectSessions(ROWS, 'agi-ui', fallback, tabHere)).sort()).toEqual(['509fd525', '6ba28438'])
})

test('the unattributed tab draws in Open tabs with its tab number', () => {
  const rows = projectSessions(ROWS, 'agi-ui', fallback, tabHere).map((r) => ({ ...r, tabHere: tabHere(r), tabIndex: r.tabIndex ?? undefined }))
  const html = renderSessions(rows, NOW, { selectedId: null, here: HERE, prefs: DEFAULT_SESSION_PREFS })
  const open = html.slice(html.indexOf('data-group="here"'), html.indexOf('</section>', html.indexOf('data-group="here"')))
  expect(open).toContain('data-session="6ba28438-9302-47c2-8ceb-4246d43a78c8"')
  expect(open).toContain('data-session="509fd525-5935-49cc-9a32-a86e076fd65e"')
  expect(open.indexOf('6ba28438')).toBeLessThan(open.indexOf('509fd525'))
})

test('the resume picker keeps the attribution rule: a tab here is not a reason to offer a session', () => {
  const items = resumeItems(ROWS, ['agi-ui'], { localHost: 'codium', localName: 'zion', isOpen: (id) => ROWS.some((r) => r.sessionId === id && tabHere(r)), fallback: new Map([['agi-ui', fallback]]) })
  expect(items.map((i) => i.sessionId.slice(0, 8))).toEqual(['509fd525'])
})
