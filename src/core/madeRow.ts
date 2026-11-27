// What a session made, as one row of chips that scrolls sideways, on every listed card
// (owner, 2026-11-26 8:00–8:49 PM, the approved prototype's C3–C8): a page by its
// headline, every PR with its verdict in words, the PRs its latest reply names first,
// when the agent last changed each one, whether you have opened it, and a ready PR's
// merge ring. Pure: the host passes what it read (Review's PR lists) and what this
// viewer opened.

import { escapeHtml, serviceMark } from '../shared/sessionCards';
import { ageWords } from '../shared/sessionState';
import { prVerdict, type RemotePrStatus } from './prStatus';
import type { PullRequestRef } from './panel.helpers';

/** A PR as Review's last read of its repository has it (`agents projects prs list`). */
export interface PrFact {
  url: string;
  slug: string;
  number: number;
  title: string;
  word: string;
  /** Green only for Ready; red for what blocks it; no color otherwise (C7). */
  tone: 'ok' | 'bad' | '';
  /** Ready to merge from its ring, at the head commit the list read. */
  ready: boolean;
  headSha?: string | null;
  /** When it opened, or merged: the last change the list tells. */
  atMs?: number;
}

/** Has the viewer seen the latest of it: never opened since it changed, changed since opened, or seen. */
export type ReadState = 'new' | 'changed' | 'seen';

export interface MadeItem {
  kind: 'pr' | 'page';
  /** The PR's URL (lowercased) or the file's path: what "opened" is remembered by. */
  key: string;
  label: string;
  tip: string;
  url?: string;
  path?: string;
  word?: string;
  tone?: 'ok' | 'bad' | '';
  merge?: { repo: string; number: number; sha?: string };
  /** Named in its latest reply: first in the row, marked “. */
  mention: boolean;
  atMs?: number;
  read: ReadState;
}

const PR_URL = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi;
const PR_REF = /(?:^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d{1,7})\b/g;

/** The PRs a reply names: full links, `owner/repo#N`, and a bare `#N` only when exactly one
 *  PR this session made, touched or the project lists has that number. */
export function prMentions(text: string, known: readonly { url: string; slug: string; number: number }[]): string[] {
  const out: string[] = [];
  const add = (url: string) => { const k = url.toLowerCase(); if (!out.includes(k)) out.push(k); };
  for (const m of text.matchAll(PR_URL)) add(`https://github.com/${m[1]}/pull/${Number(m[2])}`);
  for (const m of text.matchAll(PR_REF)) {
    const n = Number(m[2]);
    if (m[1]) { add(`https://github.com/${m[1]}/pull/${n}`); continue; }
    const hits = [...new Set(known.filter((k) => k.number === n).map((k) => k.url.toLowerCase()))];
    if (hits.length === 1) add(hits[0]!);
  }
  return out;
}

/** The word and color of a PR the session row itself carries (its main PR). */
function rowVerdict(pr: Pick<RemotePrStatus, 'state' | 'isDraft' | 'checks' | 'mergeable' | 'review'>): { word: string; tone: PrFact['tone'] } {
  const v = prVerdict(pr);
  return { word: v.word, tone: v.word === 'Ready' ? 'ok' : v.tone === 'bad' ? 'bad' : '' };
}

export function readState(atMs: number | undefined, opened: number | undefined, since: number): ReadState {
  if (!atMs) return 'seen';
  if (opened === undefined) return atMs > since ? 'new' : 'seen';
  return atMs > opened ? 'changed' : 'seen';
}

export interface MadeInput {
  /** PRs it opened (the card's fields), its main PR as the row carries it, and PRs it acted on. */
  prs: PullRequestRef[];
  main?: Pick<RemotePrStatus, 'url' | 'number' | 'state' | 'isDraft' | 'checks' | 'mergeable' | 'review' | 'headSha' | 'title'>;
  touched: { url: string; number: number; repo?: string; action: string }[];
  /** Pages and docs; images are the card's previews, never chips. */
  files: { path: string; name: string; title?: string; editedAtMs?: number }[];
  /** Its latest words: the reply, the newest step and the recap. */
  said: string;
  fact: (urlLower: string) => PrFact | undefined;
  /** Every PR the project lists, so a bare #N in the reply can be matched. */
  known: readonly { url: string; slug: string; number: number }[];
  opened: (key: string) => number | undefined;
  /** Before this, everything counts as seen: the first run marks nothing new. */
  since: number;
}

export function madeItems(m: MadeInput): MadeItem[] {
  const prs = new Map<string, { url: string; number: number; repo: string; action?: string }>();
  const addPr = (url: string, number: number, repo: string, action?: string) => {
    const k = url.toLowerCase();
    if (!prs.has(k)) prs.set(k, { url, number, repo, action });
  };
  if (m.main) addPr(m.main.url, m.main.number, m.main.url.match(/github\.com\/([\w.-]+\/[\w.-]+)\//)?.[1] ?? '');
  for (const p of m.prs) addPr(p.url, p.number, p.ownerRepo);
  for (const t of m.touched) addPr(t.url, t.number, t.repo ?? t.url.match(/github\.com\/([\w.-]+\/[\w.-]+)\//)?.[1] ?? '', t.action);
  const mentioned = prMentions(m.said, [...m.known, ...[...prs.values()].map((p) => ({ url: p.url, slug: p.repo, number: p.number }))]);
  for (const k of mentioned) if (!prs.has(k)) { const f = m.fact(k); const mm = k.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/); if (mm) addPr(f?.url ?? k, Number(mm[2]), f?.slug ?? mm[1]!); }
  const prItems = [...prs.entries()].map(([k, p]): MadeItem => {
    const f = m.fact(k);
    const own = m.main && m.main.url.toLowerCase() === k ? m.main : undefined;
    // Review's list is the newer read; the row's own PR status speaks when the list has no word.
    const v = f ? { word: f.word, tone: f.tone } : own ? rowVerdict(own) : p.action === 'merged' ? { word: 'Merged', tone: '' as const } : { word: '', tone: '' as const };
    const sha = f?.headSha ?? own?.headSha;
    const ready = f ? f.ready : !!own && v.word === 'Ready' && !!own.headSha;
    const repo = f?.slug ?? p.repo;
    const title = f?.title || own?.title || '';
    return {
      kind: 'pr', key: k, url: p.url, label: `#${p.number}`, word: v.word, tone: v.tone,
      tip: [`${repo}#${p.number}${title ? `: ${title}` : ''}`, v.word, p.action && !f && !own ? `It ${p.action} this PR` : '', ready ? 'Opens on GitHub; the ring merges it' : 'Opens on GitHub'].filter(Boolean).join('\n'),
      ...(ready && repo ? { merge: { repo, number: p.number, ...(sha ? { sha } : {}) } } : {}),
      mention: mentioned.includes(k), atMs: f?.atMs, read: readState(f?.atMs, m.opened(k), m.since),
    };
  });
  const pages = [...m.files].sort((a, b) => (b.editedAtMs ?? 0) - (a.editedAtMs ?? 0)).map((f): MadeItem => ({
    kind: 'page', key: f.path, path: f.path, label: f.title || f.name,
    tip: `${f.title ? `${f.title}\n` : ''}${f.path}`, mention: false, atMs: f.editedAtMs, read: readState(f.editedAtMs, m.opened(f.path), m.since),
  }));
  // Named in its latest reply first, then what it made, newest first.
  return [...prItems.filter((i) => i.mention), ...prItems.filter((i) => !i.mention), ...pages];
}

const GITHUB = serviceMark('github', 'ic mark');
const DOC = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12"/></svg>';
const READ_WORD: Record<ReadState, string> = { new: 'Never opened', changed: 'Changed since you opened it', seen: '' };

/** One chip; a ready PR's chip is followed by Review's merge ring (`ring`). */
export function madeChip(i: MadeItem, now: number, ring: (merge: NonNullable<MadeItem['merge']>) => string): string {
  const when = i.atMs ? ageWords(i.atMs, now) : '';
  const changed = i.read === 'changed' ? `changed ${when}` : when;
  const tip = [i.tip, READ_WORD[i.read], i.mention ? 'Named in its latest reply' : ''].filter(Boolean).join('\n');
  const cls = `chip mi ${i.kind}${i.tone ? ` pr-${i.tone}` : ''} r-${i.read}`;
  const head = `${i.read !== 'seen' ? '<i class="rd" aria-hidden="true"></i>' : ''}${i.mention ? '<span class="said-q" aria-hidden="true">“</span>' : ''}${i.kind === 'pr' ? GITHUB : DOC}`;
  const body = i.kind === 'pr'
    ? `<span class="mn">${escapeHtml(i.label)}</span>${i.word ? `<span class="mw">${escapeHtml(i.word)}</span>` : ''}`
    : `<span class="mt">${escapeHtml(i.label)}</span>`;
  const attrs = i.kind === 'pr' ? `data-url="${escapeHtml(i.url!)}"` : `data-artifact="${escapeHtml(i.path!)}"`;
  const chip = `<a class="${cls}" href="#" ${attrs} data-made-key="${escapeHtml(i.key)}" title="${escapeHtml(tip)}">${head}${body}${changed ? `<span class="mwhen">${escapeHtml(changed)}</span>` : ''}</a>`;
  return i.merge ? `<span class="mi-pr">${chip}${ring(i.merge)}</span>` : chip;
}
