import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { PATCH_SCRIPT } from './sessionCards';
import { renderSessionCard, sessionPlace, type SessionHere, type SessionLike } from '../core/projectPanel';

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
