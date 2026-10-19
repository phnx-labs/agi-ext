import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { PATCH_SCRIPT } from './sessionCards';
import { REPLY_SCRIPT, replyBoxHtml } from './replyBox';
import { DEFAULT_SESSION_PREFS, renderSessionCard, renderSessions, sessionPlace, type SessionHere, type SessionLike } from '../core/projectPanel';

// The Project panel redraws its list on every stream tick. A card thumbnail used
// to be a full-size <img src> that each redraw rewrote, so the browser decoded the
// render again and the picture flashed (owner video, 2026-10-13, 4:12). These run
// the real PATCH_SCRIPT against a DOM and check that an unchanged card keeps its
// very <img> node, and that a card moved by an insertion above keeps its own.

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const { patchChildren } = new Function('document', `${PATCH_SCRIPT}\nreturn { patchChildren };`)(document) as { patchChildren: (live: unknown, html: string) => void };

const NOW = Date.parse('2026-10-13T00:00:00Z');
const HERE: SessionHere = { device: 'zion', localHost: 'this-mac', workspace: 'agents', editor: 'vscodium', editorName: 'VSCodium', icons: {} };
const row = (o: Partial<SessionLike>): SessionLike => ({
  sessionId: 's', host: 'yosemite-m6', title: 'T', label: '', topic: '', phase: 'idle', liveStatus: 'idle',
  lastResponse: 'done', activity: '', ticket: null, lastActivityMs: NOW - 60_000, confirmedProject: 'rush', ...o,
});
const card = (s: SessionLike) => renderSessionCard(s, sessionPlace(s, HERE), NOW, {
  selected: false, pinned: false, here: HERE, made: null,
  thumbs: [{ uri: `vscode-resource:/${s.sessionId}.png`, path: `/h/.agents/.history/attachments/${s.sessionId}.png`, label: `${s.sessionId}.png` }],
});

test('redrawing an unchanged card keeps the same <img> node and the small copy it shows', () => {
  const root = document.createElement('main');
  const html = card(row({ sessionId: 'a' }));
  patchChildren(root, html);
  const img = root.querySelector('img[data-thumb]')!;
  // The 480 px cache filled it (THUMB_SCRIPT); a redraw must not take it away.
  img.setAttribute('src', 'data:image/webp;base64,AAAA');
  patchChildren(root, html);
  expect(root.querySelector('img[data-thumb]') === img).toBe(true);
  expect(img.getAttribute('src')).toBe('data:image/webp;base64,AAAA');
});

test('a card whose fields hash is unchanged is not patched at all', () => {
  const root = document.createElement('main');
  const html = card(row({ sessionId: 'a' }));
  patchChildren(root, html);
  const live = root.querySelector('.card')!;
  // Something the page did to the live card (an opened question) survives the redraw.
  live.classList.add('viewer-mark');
  patchChildren(root, html);
  expect(root.querySelector('.card') === live).toBe(true);
  expect(live.classList.contains('viewer-mark')).toBe(true);
  // A changed card is patched in place: same node, new words.
  patchChildren(root, card(row({ sessionId: 'a', lastResponse: 'new words' })));
  expect(root.querySelector('.card') === live).toBe(true);
  expect(live.textContent).toContain('new words');
});

test('a card inserted above another leaves the other card its own node and image', () => {
  const root = document.createElement('main');
  patchChildren(root, card(row({ sessionId: 'b' })));
  const bCard = root.querySelector('.card[data-session="b"]')!;
  const bImg = bCard.querySelector('img')!;
  patchChildren(root, card(row({ sessionId: 'a' })) + card(row({ sessionId: 'b' })));
  expect(root.querySelector('.card[data-session="b"]') === bCard).toBe(true);
  expect(bCard.querySelector('img') === bImg).toBe(true);
  expect(root.querySelectorAll('.card').length).toBe(2);
  expect(root.querySelector('.card')!.getAttribute('data-session')).toBe('a');
  // Removing the card above keeps it too.
  patchChildren(root, card(row({ sessionId: 'b' })));
  expect(root.querySelector('.card') === bCard).toBe(true);
  expect(root.querySelectorAll('.card').length).toBe(1);
});

test('a redraw puts a clicked checkbox back to the stored value (Settings, a write that failed)', () => {
  const root = document.createElement('main');
  const html = '<div class="drow" data-key="box-a"><input type="checkbox" data-device="box-a" checked></div>';
  patchChildren(root, html);
  const box = root.querySelector('input') as unknown as { checked: boolean };
  box.checked = false;
  patchChildren(root, html);
  expect(root.querySelector('input') === box).toBe(true);
  expect(box.checked).toBe(true);
  patchChildren(root, html.replace(' checked', ''));
  expect(box.checked).toBe(false);
});

// The front tab's card is pinned on top with a reply box inside it. A stream tick
// patches the card (a new step, a new recap) while the owner types or dictates; the
// box (data-keep) must be the same node with the same words and the mic's state.
test('the pinned card takes a new recap and step while its reply box keeps the draft, the node and the mic state', () => {
  const front = (o: Partial<SessionLike>) => renderSessions([row({ sessionId: 'f', tabHere: true, tabIndex: 2, agentType: 'claude', ...o })], NOW, { selectedId: null, frontId: 'f', here: HERE, prefs: DEFAULT_SESSION_PREFS })
  const root = document.createElement('main')
  patchChildren(root, front({ recap: { text: 'First recap.', at: new Date(NOW - 120_000).toISOString() }, timeline: { steps: [{ text: 'step one', at: new Date(NOW - 60_000).toISOString() }] } }))
  const input = root.querySelector('.card.front textarea') as unknown as { value: string }
  const box = root.querySelector('.card.front .reply-box')!
  input.value = 'half a sentence'
  box.classList.add('listening')
  patchChildren(root, front({ recap: { text: 'Second recap.', at: new Date(NOW - 30_000).toISOString() }, timeline: { steps: [{ text: 'step one', at: new Date(NOW - 60_000).toISOString() }, { text: 'step two', at: new Date(NOW - 10_000).toISOString() }] } }))
  expect(root.querySelector('.card.front textarea') === (input as unknown)).toBe(true)
  expect(input.value).toBe('half a sentence')
  expect(root.querySelector('.card.front .reply-box')!.classList.contains('listening')).toBe(true)
  expect(root.querySelector('.fc-rt')!.textContent).toBe('Second recap.')
  expect(root.querySelector('.fc-act')!.textContent).toContain('step two')
})

test('a recap older than your last message is dimmed and says so; a newer one is not', () => {
  const html = (lastUser: number) => renderSessionCard(row({ sessionId: 'f', tabHere: true, recap: { text: 'R', at: new Date(NOW - 600_000).toISOString() }, userTurns: [{ atMs: lastUser }] }), sessionPlace(row({ tabHere: true }), HERE), NOW, { selected: false, front: true, pinned: true, thumbs: [], made: null, here: HERE })
  const root = document.createElement('main')
  patchChildren(root, html(NOW - 60_000))
  expect(root.querySelector('.fc-recap')!.classList.contains('stale')).toBe(true)
  expect(root.querySelector('.fc-recap .fc-k')!.textContent).toBe('Recap · 10 min agobefore your last message')
  patchChildren(root, html(NOW - 900_000))
  expect(root.querySelector('.fc-recap')!.classList.contains('stale')).toBe(false)
  expect(root.querySelector('.fc-old')).toBeNull()
})

// REPLY_SCRIPT, as both panels run it: a draft belongs to its session, so a box the
// list had to rebuild (the card moved between groups) gets the draft back, and the
// mic's words land with the session they were spoken for.
test('the reply box keeps each session\'s draft across a rebuilt box and a moved subject', () => {
  const posted: unknown[] = []
  const api = new Function('document', 'vscode', `${PATCH_SCRIPT}\n${REPLY_SCRIPT}\n${replyBoxHtml}\nreturn { showReplyDraft, setDictation, bindReplyBox, replyBoxHtml };`)(document, { postMessage: (m: unknown) => posted.push(m) }) as {
    showReplyDraft: (box: unknown, id: string) => boolean; setDictation: (box: unknown, state: string, text?: string) => void; bindReplyBox: (box: unknown, send: (t: string) => void) => void; replyBoxHtml: (p: string, h: boolean) => string
  }
  const make = () => { const root = document.createElement('div'); root.innerHTML = api.replyBoxHtml('Reply…', false); return root.querySelector('.reply-box')! }
  const sent: string[] = []
  const a = make()
  api.showReplyDraft(a, 's1'); api.bindReplyBox(a, (t) => sent.push(t))
  const input = a.querySelector('textarea') as unknown as { value: string; dispatchEvent: (e: unknown) => void }
  input.value = 'draft for s1'
  input.dispatchEvent(new window.Event('input'))
  const b = make()
  expect(api.showReplyDraft(b, 's1')).toBe(false)
  expect((b.querySelector('textarea') as unknown as { value: string }).value).toBe('draft for s1')
  // Recording starts on s1, the front moves to s2 before the words arrive: they go to s1's draft.
  api.setDictation(b, 'listening')
  expect(b.classList.contains('listening')).toBe(true)
  expect(api.showReplyDraft(b, 's2')).toBe(true)
  expect((b.querySelector('textarea') as unknown as { value: string }).value).toBe('')
  api.setDictation(b, 'idle', 'and the rest')
  api.showReplyDraft(b, 's1')
  expect((b.querySelector('textarea') as unknown as { value: string }).value).toBe('draft for s1 and the rest')
  // Enter sends once and clears the draft; the mic asks the host.
  input.value = 'go'; input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }))
  expect(sent).toEqual(['go'])
  ;(a.querySelector('.reply-mic') as unknown as { click: () => void }).click()
  expect(posted).toEqual([{ type: 'dictate', on: true }])
})
