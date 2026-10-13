// The session's pull request as the CLI row carries it (`pr`, filled by the feed
// from one cached `gh pr view` per session). The panel renders it and offers at
// most one action, decided here so the webview and the host agree: the host
// re-checks this against its own snapshot before it runs anything.

interface RemoteCheckItem {
  name: string;
  state: 'passed' | 'failed' | 'running' | 'skipped';
  url?: string;
}

export interface RemotePrStatus {
  url: string;
  number: number;
  title?: string;
  state?: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  review?: 'approved' | 'changes_requested' | 'review_required';
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  checks?: 'passing' | 'failing' | 'pending';
  checkItems: RemoteCheckItem[];
  /** The head commit the merge is pinned to; absent on rows from an agents CLI that does not project it. */
  headSha?: string;
}

const CHECK_ITEMS_MAX = 30;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const lower = (v: unknown): string => str(v).toLowerCase();

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function normalizePrStatus(raw: unknown): RemotePrStatus | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  // The number is the one in the URL, so the PR the card links is the PR a merge
  // targets; a row whose number disagrees with its URL is not trusted at all.
  const url = str(v.url);
  const number = Number(url.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\/?$/)?.[1]);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  if (v.number !== undefined && v.number !== number) return undefined;
  const items = Array.isArray(v.checkItems) ? v.checkItems : [];
  const checkItems = items.flatMap((item): RemoteCheckItem[] => {
    if (!item || typeof item !== 'object') return [];
    const c = item as Record<string, unknown>;
    const name = str(c.name).trim();
    const state = oneOf(lower(c.state), ['passed', 'failed', 'running', 'skipped'] as const);
    if (!name || !state) return [];
    const link = str(c.url);
    return [{ name, state, ...(/^https:\/\//.test(link) ? { url: link } : {}) }];
  }).slice(0, CHECK_ITEMS_MAX);
  const headSha = str(v.headSha);
  const title = str(v.title).trim();
  const state = oneOf(lower(v.state), ['open', 'merged', 'closed'] as const);
  const review = oneOf(lower(v.reviewDecision), ['approved', 'changes_requested', 'review_required'] as const);
  const mergeable = oneOf(lower(v.mergeable), ['mergeable', 'conflicting', 'unknown'] as const);
  const checks = oneOf(lower(v.checks), ['passing', 'failing', 'pending'] as const);
  return {
    url,
    number,
    ...(title ? { title } : {}),
    ...(state ? { state } : {}),
    isDraft: v.isDraft === true,
    ...(review ? { review } : {}),
    ...(mergeable ? { mergeable } : {}),
    ...(checks ? { checks } : {}),
    checkItems,
    ...(/^[0-9a-f]{7,40}$/i.test(headSha) ? { headSha } : {}),
  };
}

export type PrAction = { kind: 'merge' | 'automerge'; reason: string } | { kind: 'none'; reason: string };

/** The one action the card may offer, with the reason it reads beside the PR. */
export function prAction(pr: RemotePrStatus | undefined): PrAction {
  if (!pr) return { kind: 'none', reason: '' };
  if (pr.state === 'merged') return { kind: 'none', reason: 'merged' };
  if (pr.state === 'closed') return { kind: 'none', reason: 'closed' };
  if (pr.state !== 'open') return { kind: 'none', reason: 'status not reported yet' };
  if (pr.isDraft) return { kind: 'none', reason: 'draft' };
  if (pr.mergeable === 'conflicting') return { kind: 'none', reason: 'has conflicts' };
  if (pr.review === 'changes_requested') return { kind: 'none', reason: 'changes requested' };
  if (pr.checks === 'failing') return { kind: 'none', reason: 'a check failed' };
  if (!pr.headSha) return { kind: 'none', reason: 'merging from here needs a newer agents CLI (head commit not on the row)' };
  if (pr.checks === 'pending') return { kind: 'automerge', reason: 'checks running' };
  if (pr.mergeable === 'mergeable') return { kind: 'merge', reason: pr.review === 'approved' ? 'ready to merge' : 'not approved; your branch rules decide' };
  return { kind: 'none', reason: 'GitHub is still computing mergeability' };
}

import type { MergeMethod } from './settings';

/** One choice in the Merge ▾ menu: a method, or an admin merge that bypasses
 *  branch protection (offered only when you may). */
export interface MergeChoice { method: MergeMethod; admin: boolean; label: string; detail: string }

/** Whether the session's PR can be offered Merge ▾ at all; the choices themselves
 *  come from one read of the PR on the click (`mergeWithMenu`). */
export function canOfferMerge(pr: RemotePrStatus | undefined): boolean {
  return !!pr && pr.state === 'open' && !pr.isDraft && !!pr.headSha && pr.mergeable !== 'conflicting';
}

/** One PR as `agents projects prs <project> --json --repo R --number N` reads it, for a
 *  merge from the Project panel's PR list (the list itself carries no head commit). */
export interface PrForMerge {
  headSha?: string; isDraft: boolean; state: string; mergeableState: string; reviewDecision: string; ciState: string; viewerIsAdmin: boolean; adminBypass: boolean;
  /** The methods the repository allows, as GitHub reports them; empty when the CLI did not say. */
  methods: MergeMethod[];
}

export function parsePrForMerge(stdout: string, repo: string, number: number): PrForMerge | undefined {
  const env = JSON.parse(stdout) as { repositories?: { slug?: string; merge?: { viewerIsAdmin?: unknown; adminBypass?: unknown; methods?: unknown }; pullRequests?: Record<string, unknown>[] }[] };
  const r = (env.repositories ?? []).find((x) => x.slug === repo);
  const p = (r?.pullRequests ?? []).find((x) => x.number === number);
  if (!r || !p) return undefined;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const head = s(p.headSha);
  return {
    ...(/^[0-9a-f]{7,40}$/i.test(head) ? { headSha: head } : {}),
    isDraft: p.isDraft === true,
    state: s(p.state).toLowerCase(),
    mergeableState: s(p.mergeableState).toLowerCase(),
    reviewDecision: s(p.reviewDecision).toLowerCase(),
    ciState: s(p.ciState).toLowerCase(),
    viewerIsAdmin: r.merge?.viewerIsAdmin === true,
    adminBypass: r.merge?.adminBypass === true,
    methods: Array.isArray(r.merge?.methods) ? (r.merge!.methods as unknown[]).filter((m): m is MergeMethod => m === 'squash' || m === 'rebase' || m === 'merge') : [],
  };
}

/** The one-click Merge: your chosen method when GitHub would merge the PR that way and
 *  the repository allows it, else the first method it allows; undefined when only an
 *  admin merge (or nothing) is possible. */
export function oneClickMerge(pr: PrForMerge | undefined, preferred: MergeMethod): MergeChoice | undefined {
  const open = rowMergeChoices(pr).filter((c) => !c.admin);
  const allowed = pr && pr.methods.length ? open.filter((c) => pr.methods.includes(c.method)) : open;
  return allowed.find((c) => c.method === preferred) ?? allowed[0];
}

/** The Merge menu for a PR list row: the three methods when GitHub would merge it,
 *  and an admin merge when you are an admin of a repo that allows the bypass. */
export function rowMergeChoices(pr: PrForMerge | undefined): MergeChoice[] {
  if (!pr || pr.state !== 'open' || pr.isDraft || !pr.headSha || pr.mergeableState === 'dirty') return [];
  const ready = (pr.mergeableState === 'clean' || pr.mergeableState === 'unstable' || pr.mergeableState === 'has_hooks') && pr.ciState !== 'failure' && pr.reviewDecision !== 'changes_requested';
  const out: MergeChoice[] = ready
    ? [
      { method: 'squash', admin: false, label: 'Squash and merge', detail: 'one commit on the base branch' },
      { method: 'rebase', admin: false, label: 'Rebase and merge', detail: 'replays each commit on the base branch' },
      { method: 'merge', admin: false, label: 'Create a merge commit', detail: 'keeps every commit' },
    ]
    : [];
  if (pr.viewerIsAdmin && pr.adminBypass) out.push({ method: 'squash', admin: true, label: 'Admin merge (squash)', detail: 'bypasses branch protection as a repository admin' });
  return out;
}

/** `owner/repo` from a GitHub pull request URL. */
export function prRepo(url: string): string | undefined {
  return url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/)?.[1];
}
