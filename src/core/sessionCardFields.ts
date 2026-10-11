import * as path from 'path';
import { displayPath } from './displayPath';
import { extractLinearTicketId } from './utils';
import { extractPrUrls, type PullRequestRef } from './panel.helpers';
import type { RemoteSession, RemoteSessionArtifact } from './remoteSessions';

/** Image files the session cards preview inline. */
const THUMB_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

function isInside(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, path.resolve(filePath));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

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

/**
 * The session-card fields the sidebar and the Fleet card both read beside the
 * stream row's own (timeline, userTurns, failures, activityHistogram, subagents):
 * display paths, inline previews, PR and ticket links, the open ask. Pure: the
 * caller supplies the webview URI for a local preview, so a remote session's
 * artifacts never get one (opening one copies it on click, `localArtifactUri`).
 */
export function sessionCardFields(
  live: RemoteSession,
  opts: { sessionId: string; cwd?: string; home: string; remoteDevice?: string; previewUri?: (filePath: string) => string },
): SessionCardFields {
  const pathOptions = { cwd: live.cwd || opts.cwd || '', home: opts.home, isRemote: !!opts.remoteDevice, sessionId: opts.sessionId };
  const artifacts: SessionCardFields['artifacts'] = live.artifacts.map((artifact) => ({ ...artifact, display: displayPath(artifact.path, pathOptions) }));
  if (opts.previewUri && !opts.remoteDevice) {
    for (const artifact of artifacts) {
      if (THUMB_EXT.test(artifact.path) && isInside(artifact.path, opts.home)) artifact.uri = opts.previewUri(artifact.path);
    }
  }
  const fields: SessionCardFields = { pathOptions, artifacts, sessionLocal: !opts.remoteDevice };
  if (live.planFile) fields.plan = { path: live.planFile, display: displayPath(live.planFile, pathOptions) };
  if (live.prUrl) fields.pullRequests = extractPrUrls([live.prUrl]);
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
