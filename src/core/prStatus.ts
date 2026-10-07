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
  const url = str(v.url);
  const number = typeof v.number === 'number' && Number.isFinite(v.number) ? v.number : Number(url.match(/\/pull\/(\d+)/)?.[1]);
  if (!url || !Number.isFinite(number)) return undefined;
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
  if (pr.mergeable === 'mergeable') return { kind: 'merge', reason: 'ready to merge' };
  return { kind: 'none', reason: 'GitHub is still computing mergeability' };
}

/** `owner/repo` from a GitHub pull request URL. */
export function prRepo(url: string): string | undefined {
  return url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/)?.[1];
}
