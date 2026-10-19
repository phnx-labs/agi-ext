// The reply box with its mic, as both sidebars draw it: the Active Session
// sidebar below its card, and the Project panel inside the front tab's card.
// The host side is one rail for each: `deliverReply` (src/vscode/sessionReply.ts)
// and the `dictation` recorder (src/vscode/dictation.vscode.ts).

/** The box's markup. Plain JavaScript with no outside names, so a webview script
 *  reuses it by interpolation (`${replyBoxHtml}`). */
export function replyBoxHtml(placeholder: string, hidden: boolean): string {
  const mic = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg>';
  return '<div class="reply-box"' + (hidden ? ' hidden' : '') + '>' +
    '<textarea id="reply-input" rows="1" placeholder="' + placeholder + '"></textarea>' +
    '<div class="dictation" hidden><span class="dict-dot"></span><span class="dict-wave">' +
      '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="dict-t"></span></div>' +
    '<button type="button" class="reply-mic" id="reply-mic" title="Dictate: click to talk, click again to stop" aria-label="Dictate" aria-pressed="false">' + mic + '</button>' +
    '<div class="reply-err" id="reply-err" hidden></div>' +
  '</div>';
}

/** The box, its mic and the listening wave; each page places the box itself. */
export const REPLY_BOX_CSS = `
  .reply-box { position: relative; }
  .reply-box textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 30px;
    background: var(--r-glass);
    color: var(--r-text);
    border: 1px solid var(--r-edge);
    border-radius: 4px;
    padding: 6px 38px 6px 8px;
    font: inherit;
    font-size: 11.5px;
  }
  .reply-box textarea:focus { outline: 1px solid var(--r-focus); outline-offset: -1px; }
  .reply-err { color: var(--r-bad); font-size: 10.5px; margin-top: 4px; }
  .reply-box .reply-mic { position: absolute; right: 8px; top: 8px; width: 24px; height: 24px; border-radius: 999px; border: 0; background: transparent; color: var(--r-caption); cursor: pointer; display: grid; place-items: center; padding: 0; }
  .reply-mic svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; }
  .reply-mic:hover { background: var(--r-well); color: var(--r-text); }
  .reply-box.listening .reply-mic { color: var(--r-bad); box-shadow: 0 0 0 1px var(--r-bad); }
  .reply-box.listening .reply-mic rect { fill: currentColor; }
  .reply-mic:disabled { opacity: 0.5; cursor: default; }
  .dictation { position: absolute; left: 12px; right: 40px; top: 10px; display: flex; align-items: center; gap: 8px; pointer-events: none; }
  .dictation[hidden], .reply-err[hidden], .reply-box[hidden] { display: none; }
  .reply-box.listening textarea, .reply-box.transcribing textarea { color: transparent; }
  .reply-box.listening textarea::placeholder, .reply-box.transcribing textarea::placeholder { color: transparent; }
  .dict-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--r-bad); animation: dict-pulse 1s infinite; flex: none; }
  .dict-wave { display: flex; align-items: center; gap: 2px; height: 14px; flex: 1; }
  .dict-wave i { width: 2px; height: 30%; background: var(--r-text-2); border-radius: 1px; animation: dict-wave .6s ease-in-out infinite alternate; }
  .dict-wave i:nth-child(3n) { animation-delay: .2s; } .dict-wave i:nth-child(3n+1) { animation-delay: .4s; }
  .reply-box.transcribing .dict-wave i { animation: none; opacity: 0.4; }
  .reply-box.transcribing .dict-dot { background: var(--r-faint); animation: none; }
  .dict-t { font-family: var(--r-mono); font-size: 10.5px; color: var(--r-caption); flex: none; }
  @keyframes dict-wave { to { height: 100%; } }
  @keyframes dict-pulse { 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .dict-wave i, .dict-dot { animation: none; } }`;

// The box's behavior, for a page that also carries PATCH_SCRIPT (bindOnce) and
// `vscode`. Plain webview JavaScript, no backticks. A draft belongs to its
// session: the box always shows the draft of the session it replies to, so a
// subject change or a rebuilt box never loses what was typed (owner video,
// 2026-10-12). The session the mic recorded for gets its words even when the
// box moved on while they were transcribed.
export const REPLY_SCRIPT = `
const replyDrafts = {};
let replySession = '';
let dictationSession = '';
let dictationState = 'idle';

// Point the box at session id; true when that is a different session than before.
function showReplyDraft(box, id) {
  const input = box.querySelector('textarea');
  const changed = id !== replySession;
  replySession = id;
  const draft = replyDrafts[id] || '';
  if (input.value !== draft) input.value = draft;
  return changed;
}

function showReplyError(box, message) {
  const el = box && box.querySelector('.reply-err');
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

// The mic as the host reports it. Listening shows a moving wave (CSS, no timer);
// the words land in the draft of the session they were spoken for.
function drawDictation(box) {
  if (!box) return;
  const mic = box.querySelector('.reply-mic');
  box.classList.toggle('listening', dictationState === 'listening');
  box.classList.toggle('transcribing', dictationState === 'transcribing');
  mic.setAttribute('aria-pressed', String(dictationState === 'listening'));
  mic.disabled = dictationState === 'transcribing';
  box.querySelector('.dictation').hidden = dictationState === 'idle';
  box.querySelector('.dict-t').textContent = dictationState === 'transcribing' ? 'Transcribing…' : 'Listening · click the mic to stop';
}

function setDictation(box, state, text) {
  if (state === 'listening' && dictationState !== 'listening') dictationSession = replySession;
  dictationState = state;
  drawDictation(box);
  if (!text) return;
  const join = (draft) => draft ? draft.replace(/\\s+$/, '') + ' ' + text : text;
  const owner = dictationSession || replySession;
  replyDrafts[owner] = join(replyDrafts[owner] || '');
  if (!box || owner !== replySession) return;
  const input = box.querySelector('textarea');
  input.value = replyDrafts[owner];
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// Enter sends (Shift+Enter is a newline) through send(text); the mic asks the host
// to start or stop. Each binding runs once per node.
function bindReplyBox(box, send) {
  const input = box.querySelector('textarea');
  if (!bindOnce(input, 'reply')) return;
  input.addEventListener('input', () => { replyDrafts[replySession] = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send(text);
    input.value = '';
    replyDrafts[replySession] = '';
  });
  const mic = box.querySelector('.reply-mic');
  mic.addEventListener('click', (e) => {
    e.stopPropagation();
    showReplyError(box, '');
    vscode.postMessage({ type: 'dictate', on: mic.getAttribute('aria-pressed') !== 'true' });
  });
}
`;
