// The Tickets tab's detail view: one `linear tasks <ID> --json` read on the click
// that opens it, drawn in the panel. Comments leave as one `linear update` argv.

import { escapeHtml } from './projectPanel';

export interface TicketDetail {
  identifier: string;
  title: string;
  url: string;
  state: string;
  assignee: string | null;
  /** The agent Linear delegates the ticket to ("Claude", "codex1"), when one is. */
  delegate: string | null;
  milestone: string | null;
  description: string;
  comments: { author: string; date: string; body: string }[];
}

const COMMENTS_SHOWN = 3;
const COMMENT_CHARS = 900;

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** `linear tasks <ID> --json`: one issue object. */
export function parseTicketDetail(raw: string): TicketDetail {
  const d = rec(JSON.parse(raw));
  const identifier = str(d?.identifier);
  if (!d || !identifier) throw new Error('Unexpected linear issue shape from the CLI');
  const nodes = rec(d.comments)?.nodes;
  return {
    identifier,
    title: str(d.title) ?? '',
    url: str(d.url) ?? '',
    state: str(rec(d.state)?.name) ?? '(no state)',
    assignee: str(rec(d.assignee)?.name),
    delegate: str(rec(d.delegate)?.name),
    milestone: str(rec(d.projectMilestone)?.name),
    description: str(d.description) ?? '',
    comments: (Array.isArray(nodes) ? nodes : []).map((c) => {
      const o = rec(c) ?? {};
      return { author: str(rec(o.user)?.name) ?? 'Unknown', date: (str(o.createdAt) ?? '').slice(0, 10), body: str(o.body) ?? '' };
    }),
  };
}

/** The argv that adds one comment; `--comment=` keeps a leading "-" in the text from reading as a flag. */
export function commentArgv(identifier: string, text: string): string[] {
  return ['update', identifier, `--comment=${text}`];
}

/** The task a new agent gets for the ticket. */
export function ticketPrompt(t: Pick<TicketDetail, 'identifier' | 'title' | 'url'>): string {
  return `Work on ${t.identifier}: ${t.title}${t.url ? ` (${t.url})` : ''}`;
}

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

/** A session already on the ticket, as the detail lists it. */
export interface TicketSession { sessionId: string; host: string; title: string; state: string; where: string }

/** What Start runs: the delegated agent when it is one this version launches, else your default. */
export interface TicketStart { agentName: string; delegated: boolean }

export function renderTicketDetail(t: TicketDetail, start: TicketStart, onIt: TicketSession[] = []): string {
  const shown = t.comments.slice(-COMMENTS_SHOWN);
  const clip = (b: string) => (b.length > COMMENT_CHARS ? `${b.slice(0, COMMENT_CHARS)}…` : b);
  const id = escapeHtml(t.identifier);
  const who = t.delegate ? `Delegated to <b>${escapeHtml(t.delegate)}</b> · ${escapeHtml(t.assignee ? `assigned to ${t.assignee}` : 'unassigned')}` : escapeHtml(t.assignee ? `Not delegated · assigned to ${t.assignee}` : 'Not delegated · unassigned');
  const startBtn = (primary: boolean, words: string) => `<button class="${primary ? 'primary' : 'link'}" data-start>${words}</button>`;
  // A ticket already being worked shows its sessions first; starting another is the quiet option.
  const work = onIt.length
    ? `<div class="sh">On it now</div><div class="onit">${onIt.map((s) => `<div class="ons"><span class="onm"><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.state)} · ${escapeHtml(s.where)}</small></span><button class="primary" data-open-session="${escapeHtml(s.sessionId)}" data-host="${escapeHtml(s.host)}">Open</button></div>`).join('')}</div>
      <div class="hint">Another agent on it? ${startBtn(false, `Start ${escapeHtml(start.agentName)} in a new tab`)}</div>`
    : `${startBtn(true, `▶ Start ${escapeHtml(start.agentName)} in a new tab`)}<span class="hint">Opens an agent tab in this window with the ticket as its first message${start.delegated ? `; ${escapeHtml(start.agentName)} is the agent Linear delegates it to` : `, using your default agent`}.</span>`;
  return `<div class="tdetail" data-ticket="${id}">
  <button class="back" data-back>‹ Tickets</button>
  <div class="th1"><span class="tid">${id}</span><span class="tstate"><i></i>${escapeHtml(t.state)}</span></div>
  <h3>${escapeHtml(t.title)}</h3>
  <div class="tmeta">${escapeHtml(t.milestone ?? 'No milestone')}${t.url ? ` · <a href="#" data-url="${escapeHtml(t.url)}">Open in Linear ↗</a>` : ''}</div>
  <div class="dispatch"><div class="dwho">${who}</div>${work}</div>
  <details open><summary>Description</summary><div class="tbody">${t.description ? miniMarkdown(t.description) : '<p class="none">No description.</p>'}</div></details>
  <details open><summary>Comments <span class="n">${t.comments.length}</span></summary>
    ${t.comments.length > shown.length ? `<div class="older">${t.comments.length - shown.length} older in Linear</div>` : ''}
    <div class="comments">${shown.map((c) => `<div class="cmt"><div class="cby">${escapeHtml(c.author)} · ${escapeHtml(c.date)}</div><div class="cbody">${miniMarkdown(clip(c.body))}</div></div>`).join('')}</div>
    <textarea class="cnew" placeholder="Comment on ${id}…" rows="3" aria-label="Comment on ${id}"></textarea>
    <button class="primary" data-comment>Comment</button>
  </details>
</div>`;
}
