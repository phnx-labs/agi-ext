// A ticket row's peek in the Issues tab: the description the list read already carries
// and the sessions on it, drawn under the row when a click unfolds it. The full ticket,
// comments included, is its Linear page.

import { escapeHtml } from '../shared/sessionCards';

/** What `linear tasks <ID> --json` gives a ticket tile that the
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

/** The description's opening lines, cut at a line so no mark is split. */
function opening(description: string): string {
  if (description.length <= PEEK_CHARS) return description;
  const lines: string[] = [];
  let n = 0;
  for (const line of description.split('\n')) {
    if (n + line.length > PEEK_CHARS && lines.length) break;
    lines.push(line);
    n += line.length + 1;
  }
  return lines.join('\n');
}

/** The description's opening lines and the sessions already on it, each one click to
 *  its tab. Starting an agent is the row's logo, the page its ↗ (owner, 2026-10-27 6:11 AM). */
export function renderTicketPeek(id: string, description: string, onIt: TicketSession[] = []): string {
  const text = opening(description.trim());
  const work = onIt.length
    ? `<div class="onit">${onIt.map((s) => `<button class="ons" data-open-session="${escapeHtml(s.sessionId)}" data-host="${escapeHtml(s.host)}"><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.state)} · ${escapeHtml(s.where)}</small></button>`).join('')}</div>`
    : '';
  return `<div class="tpeek" data-peek="${escapeHtml(id)}" hidden><div class="tbody">${text ? miniMarkdown(text) : '<p class="none">No description.</p>'}</div>${work}</div>`;
}
