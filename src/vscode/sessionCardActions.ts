// What a click inside the shared session cards (src/shared/sessionCards.ts) does
// on the host. The Active Session sidebar and the Fleet card both route here, so
// opening an artifact or loading a heavy timeline filter behaves the same on both.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgents } from '../core/agentsBin';
import { shellQuote } from '../core/deviceDispatchShell';
import { isInside } from '../core/displayPath';
import { sessionCardFields, type SessionCardFields } from '../core/sessionCardFields';
import type { RemoteSession } from '../core/remoteSessions';
import { remoteDeviceArg } from './remoteSessions.vscode';
import { openExternalUrl } from './webviewSecurity';

const REMOTE_ARTIFACT_CACHE_DIR = path.join(os.homedir(), '.agents', '.cache', 'remote-artifacts');

/** Timeline filters that need the full transcript stream, one `agents sessions` call per click. */
export const VERB_FILTER_ROLES = new Set(['assistant', 'thinking', 'tools']);

/**
 * A local artifact opens in place. A remote session's artifact is copied once
 * into the local cache with one `agents ssh` call on this click, so it opens
 * in the Reader without a Remote-SSH connection. `named` says the session's row
 * lists this path: a stream value must never choose where we write.
 */
async function localArtifactUri(filePath: string, sessionHost: string | undefined, named: boolean): Promise<vscode.Uri | undefined> {
  const device = remoteDeviceArg(sessionHost);
  if (!device) return vscode.Uri.file(filePath);
  const local = path.join(REMOTE_ARTIFACT_CACHE_DIR, device, filePath);
  if (!named || !path.posix.isAbsolute(filePath) || !/^[\w.-]+$/.test(device) || !isInside(local, path.join(REMOTE_ARTIFACT_CACHE_DIR, device))) {
    void vscode.window.showErrorMessage(`Not opening ${filePath}: it is not an artifact of this session.`);
    return undefined;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Fetching ${path.basename(filePath)} from ${device}` },
      async () => {
        const argv = shellQuote(JSON.stringify(['base64', filePath]));
        const { stdout } = await runAgents(`ssh ${shellQuote(device)} --argv ${argv}`, { timeout: 60_000, maxBuffer: 128 * 1024 * 1024 });
        await fs.promises.mkdir(path.dirname(local), { recursive: true });
        await fs.promises.writeFile(local, Buffer.from(stdout, 'base64'));
      },
    );
    return vscode.Uri.file(local);
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not fetch ${filePath} from ${device}: ${(err as Error).message.split('\n')[0]}`);
    return undefined;
  }
}

/** A plan or report opens as an editor tab in the Agents Reader; anything else opens normally. */
export async function openSessionArtifact(filePath: string, sessionHost: string | undefined, named: boolean): Promise<void> {
  const uri = await localArtifactUri(filePath, sessionHost, named);
  if (!uri) return;
  const viewType = /\.html?$/i.test(filePath) ? 'agents.htmlReader' : /\.md$/i.test(filePath) ? 'agents.markdownEditor' : undefined;
  if (viewType) await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  else await vscode.commands.executeCommand('vscode.open', uri);
}

/**
 * A heavy timeline filter (agent messages, reasoning, tool calls) is too big to
 * ride every stream row, so it is one `agents sessions <id> --include <role>`
 * call per explicit click, for a session on this machine. A CLI error comes back
 * as the answer, not hidden.
 */
export async function fetchTimelineFilter(role: string, sessionId: string): Promise<{ items?: unknown[]; error?: string }> {
  try {
    const { stdout } = await runAgents(`sessions ${shellQuote(sessionId)} --include ${role} --json`, { timeout: 20_000 });
    const parsed = JSON.parse(stdout);
    const items = role === 'tools'
      ? ((parsed.sessions || []).find((x: { id?: string }) => x.id === sessionId)?.calls || []).map((c: { timestamp?: string; tool?: string; input?: string; outcome?: string }) => ({
          at: c.timestamp, text: (c.tool || 'tool') + ': ' + String(c.input || '').slice(0, 300), bad: c.outcome && c.outcome !== 'ok',
        }))
      : (parsed.events || []).map((e: { timestamp?: string; content?: string }) => ({ at: e.timestamp, text: String(e.content || '').slice(0, 600) }));
    return { items };
  } catch (err) {
    return { error: err instanceof Error ? err.message.split('\n')[0] : String(err) };
  }
}

// ── Fleet ───────────────────────────────────────────────────────────────────
// The Fleet webview draws the same cards for every session row, so each row
// carries its card fields and every click names the session it belongs to.

/** Rows as the Fleet webview receives them: the stream row plus its card fields. */
export function withSessionCards(sessions: RemoteSession[], webview?: vscode.Webview): Array<RemoteSession & { card: SessionCardFields }> {
  const previewUri = webview ? (filePath: string) => webview.asWebviewUri(vscode.Uri.file(filePath)).toString() : undefined;
  return sessions.map((session) => ({
    ...session,
    card: sessionCardFields(session, { sessionId: session.sessionId, home: os.homedir(), remoteDevice: remoteDeviceArg(session.host), previewUri }),
  }));
}

export interface SessionCardActionMessage {
  sessionId?: unknown;
  host?: unknown;
  action?: { type?: unknown; path?: unknown; url?: unknown; role?: unknown };
}

/** What a Fleet card click may do on the host; tests substitute these. */
export interface SessionCardEffects {
  openArtifact(filePath: string, sessionHost: string, named: boolean): Promise<void>;
  fetchTimelineFilter(role: string, sessionId: string): Promise<{ items?: unknown[]; error?: string }>;
  reveal(dirPath: string): void;
  openUrl(url: string): void;
  notify(message: string): void;
}

const hostEffects: SessionCardEffects = {
  openArtifact: openSessionArtifact,
  fetchTimelineFilter,
  reveal: (dirPath) => { void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dirPath)); },
  openUrl: openExternalUrl,
  notify: (message) => { void vscode.window.showErrorMessage(message); },
};

/**
 * A click inside a Fleet card, for the session it names (id AND host: a copied or
 * resumed id can exist on two machines). An artifact opens only when that row
 * lists it; a heavy filter loads only for a session on this machine.
 */
export async function runSessionCardAction(
  message: SessionCardActionMessage,
  sessions: readonly RemoteSession[],
  post: (message: Record<string, unknown>) => void,
  effects: SessionCardEffects = hostEffects,
): Promise<void> {
  const action = message.action;
  if (!action || typeof message.sessionId !== 'string') return;
  const sessionId = message.sessionId;
  const live = sessions.find((session) => session.sessionId === sessionId && session.host === message.host);
  const reply = (role: string, body: { items?: unknown[]; error?: string }) => post({ type: 'timelineFilter', role, sessionId, ...body });
  switch (action.type) {
    case 'openArtifact': {
      if (typeof action.path !== 'string') return;
      if (!live) { effects.notify(`Not opening ${action.path}: the session left the stream.`); return; }
      const card = sessionCardFields(live, { sessionId, home: os.homedir(), remoteDevice: remoteDeviceArg(live.host) });
      const named = card.artifacts.some((a) => a.path === action.path) || card.plan?.path === action.path;
      await effects.openArtifact(action.path, live.host, named);
      return;
    }
    case 'loadTimelineFilter': {
      const role = typeof action.role === 'string' ? action.role : '';
      if (!VERB_FILTER_ROLES.has(role)) { reply(role, { error: 'That filter is not available.' }); return; }
      if (!live) { reply(role, { error: 'The session left the stream before the filter loaded.' }); return; }
      if (remoteDeviceArg(live.host)) { reply(role, { error: 'This session is on another machine.' }); return; }
      reply(role, await effects.fetchTimelineFilter(role, sessionId));
      return;
    }
    case 'revealCwd':
      if (live && !remoteDeviceArg(live.host) && typeof action.path === 'string') effects.reveal(action.path);
      return;
    case 'openUrl':
      if (typeof action.url === 'string') effects.openUrl(action.url);
      return;
  }
}
