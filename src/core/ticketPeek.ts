// A ticket row's peek in the Issues tab: the description the list read already carries,
// the sessions on it and Start, drawn under the row when a click opens its Linear tab.
// The full ticket, comments included, is that tab.

import { escapeHtml } from './projectPanel';

/** What `agents projects tickets view <name> <ID> --json` gives a ticket tile that the
 *  Issues list does not hold (a closed ticket): the page to open, and its face. */
export interface TicketView {
  identifier: string;
  title: string;
  url: string;
  state: string;
}

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function parseTicketView(raw: string): TicketView {
  const d = rec(JSON.parse(raw));
  const identifier = str(d?.identifier);
  if (!d || !identifier) throw new Error('Unexpected linear issue shape from the CLI');
  return { identifier, title: str(d.title) ?? '', url: str(d.url) ?? '', state: str(rec(d.state)?.name) ?? '(no state)' };
}

/** The task a new agent gets for the ticket. */
export function ticketPrompt(t: { identifier: string; title: string; url: string | null }): string {
  return `Work on ${t.identifier}: ${t.title}${t.url ? ` (${t.url})` : ''}`;
}

const PEEK_CHARS = 600;

/** Inline marks on an already escaped line: bold, code, and links that read as their
 *  words (`[t](url)`, `[t](<url>)`, an image as a link to it); Linear's backslash
 *  escapes are dropped last. */
function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/!?\[([^\]]+)\]\((?:&lt;)?(https?:\/\/[^)\s<*]+?)(?:&gt;)?\)/g, '<a href="#" data-url="$2">$1</a>')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|])/g, '$1');
}

/** Headings, bullets, fenced code and paragraphs. Every line is escaped before any
 *  mark is added, so tracker text never becomes markup. */
function miniMarkdown(text: string): string {
  const out: string[] = [];
  let list = false;
  let fence: string[] | null = null;
  const closeList = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const raw of text.split('\n')) {
    if (raw.trim().startsWith('```')) {
      if (fence) { out.push(`<pre>${fence.join('\n')}</pre>`); fence = null; } else { closeList(); fence = []; }
      continue;
    }
    if (fence) { fence.push(escapeHtml(raw)); continue; }
    const line = escapeHtml(raw.trimEnd());
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(bullet[1])}</li>`); continue; }
    closeList();
    if (heading) out.push(`<h4>${inline(heading[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (fence) out.push(`<pre>${fence.join('\n')}</pre>`);
  return out.join('');
}

/** A session already on the ticket, as the peek lists it. */
export interface TicketSession { sessionId: string; host: string; title: string; state: string; where: string }

/** What Start runs: the delegated agent when it is one this version launches, else your default. */
export interface TicketStart { agentName: string; delegated: boolean }

/** The description's opening lines, cut at a line so no mark is split. */
function opening(description: string): { text: string; more: boolean } {
  if (description.length <= PEEK_CHARS) return { text: description, more: false };
  const lines: string[] = [];
  let n = 0;
  for (const line of description.split('\n')) {
    if (n + line.length > PEEK_CHARS && lines.length) break;
    lines.push(line);
    n += line.length + 1;
  }
  return { text: lines.join('\n'), more: true };
}

export function renderTicketPeek(id: string, description: string, start: TicketStart, onIt: TicketSession[] = []): string {
  const eid = escapeHtml(id);
  const { text, more } = opening(description.trim());
  const startBtn = (primary: boolean, words: string) => `<button class="${primary ? 'primary' : 'link'}" data-start-ticket="${eid}">${words}</button>`;
  // A ticket already being worked shows its sessions first; starting another is the quiet option.
  const work = onIt.length
    ? `<div class="sh">On it now</div><div class="onit">${onIt.map((s) => `<div class="ons"><span class="onm"><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.state)} · ${escapeHtml(s.where)}</small></span><button class="primary" data-open-session="${escapeHtml(s.sessionId)}" data-host="${escapeHtml(s.host)}">Open</button></div>`).join('')}</div>
      <div class="hint">Another agent on it? ${startBtn(false, `Start ${escapeHtml(start.agentName)} in a new tab`)}</div>`
    : `<div class="tact">${startBtn(true, `▶ Start ${escapeHtml(start.agentName)}`)}<span class="hint">${start.delegated ? 'Linear delegates it to this agent' : 'your default agent'}, in a new tab here</span></div>`;
  return `<div class="tpeek" data-peek="${eid}" hidden>
  <div class="tbody">${text ? miniMarkdown(text) : '<p class="none">No description.</p>'}${more ? '<p class="none">More in its tab.</p>' : ''}</div>
  ${work}
</div>`;
}
