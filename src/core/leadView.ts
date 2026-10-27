// The Project panel's ✳ Lead tab: the project Lead's conversation as the panel draws
// it. History (`agents lead history --json`, read when the tab shows and when agents-cli writes it)
// first, then this window's live turns. A turn shows what you said and what the Lead
// answered; what it ran stays out of sight while it works. An action the Lead held
// (stop, answer, send, start, dispatch, a PR) is a row with its own ✓, and a turn
// holding more than one offers ✓ Confirm all. Every string from the Lead goes in escaped.

import { linkify, uniqueRefs, type LeadHistoryTurn, type LeadRef, type LeadSegment, type LeadTurn } from './lead';
import { escapeHtml } from '../shared/sessionCards';

/** One turn as the tab draws it; text is pre-split into text and links. */
export interface TabTurn {
  key: string;
  ask: string;
  /** `asks`: nobody asked; the Lead drafted replies for agents that stopped to ask. */
  trigger?: 'asks';
  voiceSecs?: number;
  at?: number;
  segments: LeadSegment[];
  confirms: { token: string; action: string; label: string; detail?: string; state: string; message?: string }[];
  refs: LeadRef[];
  error?: string;
  live: boolean;
  phase?: string;
}

const fromHistory = (h: LeadHistoryTurn, i: number): TabTurn => ({
  key: h.turn || `h${i}`, ask: h.ask, ...(h.trigger ? { trigger: h.trigger } : {}), ...(h.voiceSecs !== undefined ? { voiceSecs: h.voiceSecs } : {}), ...(h.at !== undefined ? { at: h.at } : {}),
  segments: linkify(h.text, h.refs), confirms: [], refs: uniqueRefs(h.refs), live: false,
});

const fromLive = (t: LeadTurn, i: number): TabTurn => ({
  key: t.turn || `l${i}-${t.startedAt}`, ask: t.ask, ...(t.voiceSecs !== undefined ? { voiceSecs: t.voiceSecs } : {}), at: t.endedAt ?? t.startedAt,
  segments: linkify(t.text, t.refs),
  confirms: t.confirms.map((c) => ({ token: c.token, action: c.action, label: c.label, state: c.state, ...(c.detail ? { detail: c.detail } : {}), ...(c.message ? { message: c.message } : {}) })),
  refs: uniqueRefs(t.refs), ...(t.error ? { error: t.error } : {}), live: !t.finished, ...(t.phase ? { phase: t.phase } : {}),
});

/** History first, then this window's turns that history does not already hold. A turn a
 *  Confirm started (no words of yours) folds into the row it confirmed, which turns done or
 *  failed; it draws only when it failed or holds another action that needs its own ✓. */
export function mergeTurns(history: LeadHistoryTurn[], live: LeadTurn[]): TabTurn[] {
  const out = history.map(fromHistory);
  const seen = new Set(history.map((h) => h.turn).filter(Boolean));
  live.forEach((t, i) => {
    if (!t.ask && !t.error && !t.confirms.length) return;
    if (!t.turn || !seen.has(t.turn)) out.push(fromLive(t, i));
  });
  return out;
}

export interface LeadTabModel {
  project: string;
  turns: TabTurn[];
  busy: boolean;
  mic: 'idle' | 'listening' | 'transcribing';
  /** The Lead's model and whether its process is warm, from `agents lead status --json`. */
  model?: string;
  state?: string;
  host?: string;
  loading: boolean;
  error?: string;
  now: number;
}

const ACTION_MARK: Record<string, string> = { stop: '■', answer: '↩', send: '✉', start: '＋', dispatch: '＋', pr: '⑂' };

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function segmentsHtml(segments: LeadSegment[]): string {
  return segments.map((s) => s.kind === 'ref'
    ? `<button class="lt-link" data-lead-ref="${escapeHtml(JSON.stringify(s.ref))}">${escapeHtml(s.text)}</button>`
    : escapeHtml(s.text)).join('');
}

function refRow(r: LeadRef): string {
  const text = r.kind === 'ticket' ? r.id : r.kind === 'pr' ? `${r.repo}#${r.number}` : (r.title || r.id.slice(0, 8));
  return `<button class="lt-ref k-${r.kind}" data-lead-ref="${escapeHtml(JSON.stringify(r))}"><span class="d"></span><span class="t">${escapeHtml(text)}</span></button>`;
}

function actionsHtml(t: TabTurn, busy: boolean): string {
  if (!t.confirms.length) return '';
  const open = t.confirms.filter((c) => c.state === 'open');
  const one = t.confirms.length === 1;
  const rows = t.confirms.map((c) => {
    const done = c.state === 'done';
    const failed = c.state === 'failed';
    const mark = done ? '✓' : failed ? '✕' : c.state === 'running' ? '…' : (ACTION_MARK[c.action] ?? '•');
    const label = done ? `Done: ${c.label}` : failed ? `Failed: ${c.label}` : c.label;
    const sub = failed && c.message ? c.message : c.detail ?? '';
    const button = c.state === 'open' && !one ? `<button class="one" data-lead-confirm="${escapeHtml(c.token)}" title="Do this one"${busy ? ' disabled' : ''}>✓</button>` : '';
    return `<div class="lt-act s-${escapeHtml(c.state)}"><span class="k">${mark}</span><div class="w"><b>${escapeHtml(label)}</b>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</div>${button}</div>`;
  }).join('');
  const all = open.length > 1
    ? `<button class="go" data-lead-confirm-all="${escapeHtml(open.map((c) => c.token).join(' '))}"${busy ? ' disabled' : ''}>✓ Confirm all ${open.length}</button>`
    : open.length === 1 && one ? `<button class="go" data-lead-confirm="${escapeHtml(open[0].token)}"${busy ? ' disabled' : ''}>✓ Confirm</button>` : '';
  return `<div class="lt-acts">${rows}${all ? `<div class="row">${all}</div>` : ''}</div>`;
}

function turnHtml(t: TabTurn, busy: boolean): string {
  const you = t.ask
    ? `<div class="lt lt-you"><div class="lt-cap">${t.voiceSecs !== undefined ? `<span title="Spoken, transcribed on this machine">🎙 ${Math.round(t.voiceSecs)} s</span>` : 'You'}${t.at ? `<span class="tm">${escapeHtml(clock(t.at))}</span>` : ''}</div><div class="q">${escapeHtml(t.ask)}</div></div>`
    : '';
  const working = t.live && !t.segments.length
    ? `<div class="lt-work"><span class="spin"></span>${t.phase === 'booting' ? 'Starting the Lead…' : 'Working…'}</div>` : '';
  const text = t.segments.length ? `<p class="lt-say">${segmentsHtml(t.segments)}</p>` : '';
  const linked = new Set(t.segments.flatMap((s) => s.kind === 'ref' ? [JSON.stringify(s.ref)] : []));
  const refs = t.live ? '' : t.refs.filter((r) => !linked.has(JSON.stringify(r))).map(refRow).join('');
  const err = t.error ? `<div class="lt-err">${escapeHtml(t.error)}</div>` : '';
  const cap = t.trigger === 'asks'
    ? `✳ Lead<span class="why" title="Nobody asked: agents stopped to ask, so the Lead drafted replies for their cards">· for new asks</span>${t.at ? `<span class="tm">${escapeHtml(clock(t.at))}</span>` : ''}`
    : '✳ Lead';
  return `${you}<div class="lt lt-lead${t.trigger ? ' own' : ''}" data-key="${escapeHtml(t.key)}"><div class="lt-cap">${cap}</div>${working}${text}${refs}${actionsHtml(t, busy)}${err}</div>`;
}

/** The Lead's own reply box: the reply box's look (REPLY_BOX_CSS) with its own ids, so the
 *  pinned card's box and this one never answer for each other. It is `data-keep` (a patch
 *  never redraws inside it, so what you type survives); the mic and busy state ride on its
 *  attributes and the panel script copies them inward (`syncLeadBox`). */
function askBox(m: LeadTabModel): string {
  const mic = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg>';
  return `<div class="lead-ask" data-keep data-mic="${m.mic}" data-busy="${m.busy}"><div class="reply-box">` +
    '<textarea id="lead-input" rows="1" placeholder="Ask the Lead… (Enter asks)"></textarea>' +
    '<div class="dictation" hidden><span class="dict-dot"></span><span class="dict-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="dict-t"></span></div>' +
    `<button type="button" class="reply-mic" id="lead-mic" title="Talk to the Lead (⌥Space): click to start, again to send" aria-label="Talk to the Lead" aria-pressed="false">${mic}</button>` +
    '</div><div class="hint"><span><kbd>Enter</kbd> asks</span><span><kbd>⌥Space</kbd> talks</span></div></div>';
}

/** The whole tab: the conversation and the box. It has no controls of its own on the tab
 *  row: it redraws when agents-cli writes the history (`watchLeadHistory`), and reading
 *  answers aloud is a setting (owner, 2026-10-27 4:51 AM). */
export function renderLeadTab(m: LeadTabModel): string {
  const id = `<div class="lead-id" title="One Claude session for this project, kept across every question"><span class="live${m.state === 'warm' || m.busy ? ' on' : ''}"></span><span class="who">Lead · ${escapeHtml(m.project || 'no project')}</span><span class="st">${escapeHtml([m.model, m.busy ? 'working' : m.state].filter(Boolean).join(' · '))}</span>${m.host ? `<span class="sid">${escapeHtml(m.host)}</span>` : ''}</div>`;
  const body = m.turns.length
    ? m.turns.map((t) => turnHtml(t, m.busy)).join('')
    : `<div class="empty">${m.loading ? 'Reading the Lead’s history…' : m.error ? '' : 'Ask about this project, or tell the Lead what to do: answer an agent, message a tab, start an agent, act on a PR. Anything that changes something waits for your ✓.'}</div>`;
  const err = m.error ? `<div class="lt-err">${escapeHtml(m.error)}</div>` : '';
  return `<div class="lead">${id}${err}${body}${askBox(m)}</div>`;
}

export const LEAD_TAB_CSS = `
  .lead { display: flex; flex-direction: column; gap: 8px; padding: 2px 2px 10px; }
  .lead-id { display: flex; align-items: center; gap: 6px; white-space: nowrap; font: 500 10.5px var(--r-sans); color: var(--r-caption); }
  .lead-id .who { color: var(--r-text); font-weight: 600; margin-left: 0; }
  .lead-id .live { width: 6px; height: 6px; border-radius: 50%; background: var(--r-faint); flex: none; }
  .lead-id .live.on { background: var(--r-ok); }
  .lead-id .st { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .lead-id .sid { margin-left: auto; font-family: var(--r-mono); color: var(--r-faint); }
  .lt { display: flex; flex-direction: column; gap: 4px; }
  .lt-cap { display: flex; align-items: center; gap: 6px; font: 500 10px var(--r-sans); letter-spacing: .06em; text-transform: uppercase; color: var(--r-faint); }
  .lt-cap .why { text-transform: none; letter-spacing: 0; }
  .lt-cap .tm { margin-left: auto; text-transform: none; letter-spacing: 0; font-family: var(--r-mono); }
  .lt-you .q { font-size: 12px; color: var(--r-text); line-height: 1.45; padding: 6px 8px; border-radius: 6px; background: var(--r-well); white-space: pre-wrap; overflow-wrap: anywhere; }
  .lt-lead.own { background: transparent; }
  .lt-lead { border: 1px solid var(--r-edge); border-radius: 8px; padding: 8px 9px; gap: 6px; background: var(--r-glass); }
  .lt-say { font-size: 12px; line-height: 1.5; color: var(--r-text); margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .lt-link { font: inherit; color: var(--r-link); text-decoration: underline; text-decoration-color: var(--r-edge-hi); background: none; border: 0; padding: 0; cursor: pointer; }
  .lt-work { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--r-caption); }
  .lt-work .spin { width: 9px; height: 9px; border: 1.5px solid var(--r-edge-hi); border-top-color: var(--r-gold-line); border-radius: 50%; animation: lt-rot .8s linear infinite; }
  @keyframes lt-rot { to { transform: rotate(360deg); } }
  .lt-ref { display: flex; align-items: center; gap: 7px; font: inherit; font-size: 11.5px; padding: 5px 7px; border: 1px solid var(--r-edge); border-radius: 6px; background: transparent; cursor: pointer; color: var(--r-text); text-align: left; }
  .lt-ref:hover { background: var(--r-glass-hover); }
  .lt-ref .d { width: 7px; height: 7px; border-radius: 50%; background: var(--r-caption); flex: none; }
  .lt-ref .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .lt-acts { display: flex; flex-direction: column; gap: 5px; border: 1px solid var(--r-gold-line); border-radius: 8px; padding: 7px; }
  .lt-act { display: flex; align-items: flex-start; gap: 8px; }
  .lt-act .k { width: 16px; flex: none; text-align: center; color: var(--r-gold-line); font-size: 12px; line-height: 1.4; }
  .lt-act.s-done .k, .lt-act.s-done .w b { color: var(--r-ok); }
  .lt-act.s-failed .k, .lt-act.s-failed .w b { color: var(--r-bad); }
  .lt-act .w { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .lt-act .w b { font-size: 11.5px; font-weight: 600; color: var(--r-text); }
  .lt-act .w span { font-size: 11px; line-height: 1.4; color: var(--r-caption); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .lt-act .one { flex: none; font: 600 11px var(--r-sans); width: 24px; height: 22px; border-radius: 5px; border: 1px solid var(--r-edge); background: transparent; color: var(--r-text); cursor: pointer; }
  .lt-act .one:hover { background: var(--r-glass-hover); }
  .lt-acts .row { display: flex; gap: 6px; margin-top: 2px; }
  .lt-acts .go { font: 600 11px var(--r-sans); background: var(--r-gold); color: var(--r-on-gold); border: 0; border-radius: 5px; padding: 4px 10px; cursor: pointer; }
  .lt-acts button[disabled] { opacity: .5; cursor: default; }
  .lt-err { font-size: 11px; color: var(--r-bad); overflow-wrap: anywhere; }
  .lead-ask { position: sticky; bottom: 0; padding-top: 6px; background: var(--vscode-sideBar-background); }
  .lead-ask .hint { font-size: 10px; color: var(--r-faint); margin-top: 4px; display: flex; gap: 8px; }
  .lead-ask .hint kbd { font: 10px var(--r-mono); border: 1px solid var(--r-edge); border-radius: 3px; padding: 0 3px; }
  @media (prefers-reduced-motion: reduce) { .lt-work .spin { animation: none; } }
`;
