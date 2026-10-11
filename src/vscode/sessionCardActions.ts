// What a click on a session's artifact or heavy timeline filter does on the host,
// for the Active Session sidebar and the Project panel alike.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgents } from '../core/agentsBin';
import { shellQuote } from '../core/shellQuote';
import { isInside } from '../core/displayPath';
import { sessionCardFields } from '../core/sessionCardFields';
import type { RemoteSession } from '../core/remoteSessions';
import { remoteDeviceArg } from './remoteSessions.vscode';

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

/**
 * Open an artifact of a Project panel session, for the session it names (id AND
 * host: a copied or resumed id can exist on two machines). `named` tells the
 * remote copy whether that row lists the path.
 */
export async function openListedArtifact(
  sessionId: string,
  host: string | undefined,
  filePath: string,
  sessions: readonly RemoteSession[],
  open: typeof openSessionArtifact = openSessionArtifact,
): Promise<void> {
  const live = sessions.find((session) => session.sessionId === sessionId && session.host === host);
  if (!live) {
    void vscode.window.showErrorMessage(`Not opening ${filePath}: the session left the stream.`);
    return;
  }
  const card = sessionCardFields(live, { sessionId, home: os.homedir(), remoteDevice: remoteDeviceArg(live.host) });
  const named = card.artifacts.some((a) => a.path === filePath) || card.plan?.path === filePath;
  await open(filePath, live.host, named);
}
