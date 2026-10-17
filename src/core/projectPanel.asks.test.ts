// The Sessions tab's asks (PHNX-4369), drawn from testdata/session-rows.asks.json:
// rows in the stream's shape with agents-cli's attention items (key, choices,
// urgency, urgencyReason), modeled on the owner's 2026-10-13 recording.
import { test, expect } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_SESSION_PREFS, TRY_ANOTHER_WAY, answerArgv, answerFailure, renderSessionCard, renderSessions, sessionCount, sessionPlace, type SessionHere, type SessionLike } from './projectPanel'
import { DEFAULT_CARD_SETTINGS, type CardSettings } from './settings'

const ROWS: SessionLike[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata', 'session-rows.asks.json'), 'utf8'))
const NOW = Date.parse('2026-10-14T01:37:00Z')
const HERE: SessionHere = { device: 'zion', localHost: 'this-mac', workspace: 'agents', editor: 'vscodium', editorName: 'VSCodium', icons: {} }
const list = (cards?: CardSettings, folded = DEFAULT_SESSION_PREFS.folded) => renderSessions(ROWS, NOW, { selectedId: null, here: HERE, prefs: { ...DEFAULT_SESSION_PREFS, folded }, cards })
const byId = (id: string) => ROWS.find((r) => r.sessionId === id)!
const card = (id: string, cards: CardSettings = DEFAULT_CARD_SETTINGS) => renderSessionCard(byId(id), sessionPlace(byId(id), HERE), NOW, { selected: false, pinned: true, thumbs: [], made: null, here: HERE, cards })
const between = (html: string, from: string, to: string) => html.slice(html.indexOf(from), to ? html.indexOf(to, html.indexOf(from) + 1) : undefined)

test('only real asks are your move: urgent and high under Needs you now, the rest under Asks, by urgency then longest wait', () => {
  const html = list()
  const now = between(html, '<div class="pinned now">', '<div class="pinned">')
  const asks = between(html, '<div class="pinned">', '<section')
  expect(now).toContain('<div class="ph">Needs you now <span class="n">2</span></div>')
  expect(now.indexOf('data-session="9b1f0c2e-publish"')).toBeLessThan(now.indexOf('data-session="51ac77d0-secrets"'))
  // Normal: the stall (33 min) before the question (4 min); then low.
  expect(asks).toContain('<div class="ph">Asks <span class="n">3</span></div>')
  const at = (id: string) => asks.indexOf(`data-session="${id}"`)
  expect([at('3f9e2b10-stall'), at('e4d2a913-cards'), at('77c0d1aa-copy')].every((x, i, a) => x > 0 && (i === 0 || x > a[i - 1]))).toBe(true)
  // The badge counts the five asks, never an idle turn or a review.
  expect(sessionCount(ROWS, HERE).asks).toBe(5)
})

test('a finished turn that asked nothing is in Idle, folded with its count, unless its tab is open here; a review request is Ready for review', () => {
  const html = list()
  expect(html).toContain('<section class="grp closed" data-group="idle">')
  expect(html).toContain('<b>Idle</b> <span class="n">3</span> <span class="gs">· finished, no tab here</span>')
  for (let i = 1; i < 4; i++) expect(html).not.toContain(`data-session="idle-${i}"`)
  // idle-0's tab is open in this window: it keeps its card in Open tabs (PHNX-4387).
  expect(between(html, 'data-group="here"', '</section>')).toContain('data-session="idle-0"')
  expect(between(html, 'data-group="review"', '</section>')).toContain('data-session="a81c55e2-review"')
  expect(html.indexOf('data-group="review"')).toBeLessThan(html.indexOf('data-group="idle"'))
  expect(list(undefined, [])).toContain('data-session="idle-1"')
  // Running, Waiting and Ended keep the viewer's grouping below.
  expect(html.indexOf('data-group="idle"')).toBeLessThan(html.indexOf('data-session="run-1"'))
})

test('a compact ask: the reason under the title, the question in two lines, one-line answers with keys, Other… and Try another way', () => {
  const html = card('9b1f0c2e-publish')
  expect(html).toContain('<div class="why u-urgent">Blocks a release (npm publish) · waiting <span data-since="1791939060000">46m 00s</span></div>')
  expect(html).toContain('<div class="ask" data-ask="yosemite-m5/9b1f0c2e-publish/b-7f3a" data-undo="0"><div class="ah">Asks · Publish</div>')
  expect(html).toMatch(/<div class="q" title="The 1\.23\.0 tag is pushed[^"]*" data-expand>/)
  expect(html).toContain('<button class="opt" data-choice="yes-publish-from-zion" data-label="Yes, publish from zion" title="Runs scripts/release.sh 1.23.0 --confirm on zion, where the npm secrets live"><span class="k">1</span><span class="ol">Yes, publish from zion</span></button>')
  expect(html).toContain('<span class="k">3</span><span class="ol">Wait until morning</span>')
  expect(html).not.toContain('<small>')
  expect(html).toContain('<button class="lnk" data-ask-other>Other…</button>')
  expect(html).toContain(`data-ask-text="I can&#39;t answer this right now. Try a different approach that doesn&#39;t need me; if there is none, park this and move to the next task." data-label="Try another way"`)
  // The wait ticks in the age slot; the red card is the state.
  expect(html).toContain('<span class="age wait" data-since="1791939060000" title="Waiting on you">46m 00s</span>')
})

test('a permission ask shows its command line and Approve, Approve for session and Deny from the CLI choices', () => {
  const html = card('51ac77d0-secrets')
  expect(html).toContain('<div class="ah">Asks · Approval needed</div><div class="q cmdq" title="Claude needs approval to run Bash: secrets exec prod -- kubectl')
  expect(html.match(/data-choice="([^"]+)"/g)).toEqual(['data-choice="approve"', 'data-choice="approve-session"', 'data-choice="deny"'])
  expect(html).toContain('<div class="why u-high">High-priority ticket PHNX-4353 · waiting')
})

test('Session cards settings: Off leaves the red card and its wait, Question only drops the answers, Full and details show everything', () => {
  const off = card('9b1f0c2e-publish', { ...DEFAULT_CARD_SETTINGS, asks: 'off' })
  expect(off).not.toContain('class="ask"')
  expect(off).toMatch(/^<div class="card st-asks"/)
  expect(off).toContain('<span class="age wait" data-since="1791939060000" title="Waiting on you">46m 00s</span>')
  const question = card('9b1f0c2e-publish', { ...DEFAULT_CARD_SETTINGS, asks: 'question' })
  expect(question).toContain('<div class="ask"><div class="ah">Asks · Publish</div>')
  expect(question).not.toContain('class="opt"')
  expect(question).not.toContain('data-ask-other')
  const full = card('9b1f0c2e-publish', { ...DEFAULT_CARD_SETTINGS, asks: 'answers', options: 'details', question: 'full' })
  expect(full).toMatch(/<div class="q full" title="[^"]*">/)
  expect(full).not.toContain('data-expand')
  expect(full).toContain('<span class="ol">Copy the token to m5</span><small>Moves the npm credential to yosemite-m5 first; needs your approval on zion</small></button>')
})

test('an answer is one `agents feed answer` argv; what the CLI says about a failed delivery is the card error', () => {
  expect(answerArgv('h/s/g', { choice: 'approve' })).toEqual(['feed', 'answer', 'h/s/g', '--choice', 'approve', '--json'])
  expect(answerArgv('h/s/g', { text: TRY_ANOTHER_WAY })).toEqual(['feed', 'answer', 'h/s/g', '--text', TRY_ANOTHER_WAY, '--json'])
  expect(answerFailure('{"status":"delivered","attentionKey":"h/s/g"}')).toBeNull()
  expect(answerFailure('{"status":"already_answered","attentionKey":"h/s/g"}')).toBeNull()
  expect(answerFailure('{"status":"failed","reason":"no rail"}')).toBe('Not delivered: no rail')
  expect(answerFailure('{"status":"unknown"}')).toBe('Delivery unconfirmed: no receipt yet')
})
