import * as path from 'path';
import { displayPath, isInside } from './displayPath';
import { extractLinearTicketId } from './utils';
import { extractPrUrls, type PullRequestRef } from './panel.helpers';
import type { RemoteSession, RemoteSessionArtifact, RemoteTouchedPr, RemoteTouchedTicket } from './remoteSessions';
import { prRepo, prVerdict, type RemotePrStatus } from './prStatus';
import { ticketFace, type TicketFace } from './ticketFaces';

/** Image files the session cards preview inline. */
const THUMB_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export interface SessionCardFields {
  /** The options `displayPath` formats this session's paths with. */
  pathOptions: { cwd: string; home: string; isRemote: boolean; sessionId: string };
  artifacts: Array<RemoteSessionArtifact & { display: string; uri?: string }>;
  plan?: { path: string; display: string };
  pullRequests?: PullRequestRef[];
  linearIssue?: string;
  needsYou?: { kind: string; text: string; openedAtMs?: number };
  sessionLocal: boolean;
}

/** Where `artifacts render` writes the page for a source: beside it, or in its `.artifacts/` folder. */
export function renderedHtmlCandidates(sourcePath: string): string[] {
  if (/\.html?$/i.test(sourcePath)) return [sourcePath];
  const dir = sourcePath.replace(/[\\/][^\\/]*$/, '');
  const stem = sourcePath.slice(dir.length + 1).replace(/\.[^.]*$/, '');
  return [`${dir}/${stem}.html`, `${dir}/.artifacts/${stem}.html`];
}

/**
 * The session-card fields the sidebar reads beside the
 * stream row's own (timeline, userTurns, failures, activityHistogram, subagents):
 * display paths, inline previews, PR and ticket links, the open ask. Pure: the
 * caller supplies the webview URI for a local preview, so a remote session's
 * artifacts never get one (opening one copies it on click, `localArtifactUri`).
 */
/** A source the row lists beside its rendered page (`plan.md` and `plan.html`, or
 *  `.artifacts/plan.html`) shows once, as the page, which says what it was rendered from
 *  (owner video, 2026-10-17: "the HTML plan is not shown here"). Only what the row lists:
 *  nothing is read from disk. */
function renderedPages(list: readonly RemoteSessionArtifact[]): RemoteSessionArtifact[] {
  const listed = new Set(list.map((a) => a.path));
  const pageOf = (a: RemoteSessionArtifact) => /\.(md|markdown)$/i.test(a.path) ? renderedHtmlCandidates(a.path).find((p) => listed.has(p)) : undefined;
  const from = new Map<string, string>();
  for (const a of list) { const page = pageOf(a); if (page) from.set(page, a.basename); }
  return list.filter((a) => !pageOf(a)).map((a) => (from.has(a.path) ? { ...a, renderedFrom: from.get(a.path) } : a));
}

export function sessionCardFields(
  live: RemoteSession,
  opts: { sessionId: string; cwd?: string; home: string; remoteDevice?: string; previewUri?: (filePath: string) => string },
): SessionCardFields {
  const pathOptions = { cwd: live.cwd || opts.cwd || '', home: opts.home, isRemote: !!opts.remoteDevice, sessionId: opts.sessionId };
  const artifacts: SessionCardFields['artifacts'] = renderedPages(live.artifacts).map((artifact) => ({ ...artifact, display: displayPath(artifact.path, pathOptions) }));
  if (opts.previewUri && !opts.remoteDevice) {
    for (const artifact of artifacts) {
      if (THUMB_EXT.test(artifact.path) && isInside(artifact.path, opts.home)) artifact.uri = opts.previewUri(artifact.path);
    }
  }
  const fields: SessionCardFields = { pathOptions, artifacts, sessionLocal: !opts.remoteDevice };
  if (live.planFile) {
    // The plan reads as its rendered page when the row lists one, like any other source.
    const page = renderedHtmlCandidates(live.planFile).find((p) => artifacts.some((a) => a.path === p)) ?? live.planFile;
    fields.plan = { path: page, display: displayPath(page, pathOptions) };
  }
  const prs = extractPrUrls([...live.prUrls, live.prUrl ?? '']);
  if (prs.length) fields.pullRequests = prs;
  const linear = extractLinearTicketId(live.topic) || extractLinearTicketId(live.lastResponse);
  if (linear) fields.linearIssue = linear;
  if (live.attention && live.attention.state === 'open') {
    const openedAtMs = Date.parse(live.attention.openedAt);
    fields.needsYou = {
      kind: live.attention.kind,
      text: live.attention.question?.text || live.awaitingReason || '',
      openedAtMs: Number.isFinite(openedAtMs) ? openedAtMs : undefined,
    };
  }
  return fields;
}

/** What the Made shelf draws (`renderMadeShelf`, src/shared/sessionCards.ts), the same
 *  for the Active Session sidebar and the Project panel's pinned card: the PRs the
 *  session opened, the tickets it is on or created, its artifacts, and what it acted on. */
export interface MadeShelf {
  pullRequests?: PullRequestRef[];
  prStatus?: RemotePrStatus;
  prVerdict?: ReturnType<typeof prVerdict>;
  prRepo?: string;
  ticket?: TicketFace;
  createdTickets?: TicketFace[];
  artifacts: SessionCardFields['artifacts'];
  plan?: SessionCardFields['plan'];
  sessionLocal: boolean;
  touchedPrs?: RemoteTouchedPr[];
  touchedTickets?: RemoteTouchedTicket[];
}

export function madeShelf(live: Pick<RemoteSession, 'prStatus' | 'createdTickets' | 'touchedPrs' | 'touchedTickets'>, card: SessionCardFields): MadeShelf {
  const shelf: MadeShelf = { artifacts: card.artifacts, sessionLocal: card.sessionLocal };
  if (card.plan) shelf.plan = card.plan;
  if (card.pullRequests) shelf.pullRequests = card.pullRequests;
  if (live.prStatus) {
    shelf.prStatus = live.prStatus;
    shelf.prVerdict = prVerdict(live.prStatus);
    shelf.prRepo = prRepo(live.prStatus.url);
  }
  if (card.linearIssue) shelf.ticket = ticketFace(card.linearIssue);
  if (live.createdTickets?.length) shelf.createdTickets = live.createdTickets.map(ticketFace);
  if (live.touchedPrs) shelf.touchedPrs = live.touchedPrs;
  if (live.touchedTickets) shelf.touchedTickets = live.touchedTickets;
  return shelf;
}

export interface RequestImageThumb {
  path: string;
  label: string;
  uri: string;
}

/**
 * The images pasted into the session's request that this machine can show. A
 * pasted image is in this machine's attachment store under the name the request
 * carries, wherever the agent runs; the CLI's hash-named cache copies of the same
 * pastes count only for a local session whose request named none found here.
 */
export function requestImageThumbs(
  live: Pick<RemoteSession, 'request' | 'attachments'>,
  opts: { home: string; remoteDevice?: string; exists: (filePath: string) => boolean; previewUri: (filePath: string) => string },
): RequestImageThumb[] {
  const store = path.join(opts.home, '.agents', '.history', 'attachments');
  const pasted = (live.request?.attachments ?? [])
    .filter((a) => a.kind === 'image' && a.name && path.basename(a.name) === a.name)
    .map((a) => path.join(store, a.name))
    .filter(opts.exists)
    .map((p) => ({ path: p, label: path.basename(p), uri: opts.previewUri(p) }));
  if (pasted.length || opts.remoteDevice) return pasted;
  const cache = path.join(opts.home, '.agents', '.cache', 'attachments');
  return live.attachments
    .filter((a) => a.mediaType.startsWith('image/') && isInside(a.path, cache))
    .map((a) => ({ path: a.path, label: a.label, uri: opts.previewUri(a.path) }));
}
