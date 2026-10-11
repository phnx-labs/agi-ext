// "Agents: Resume Session…" and the one resume action behind it, the Fleet Resume
// button and the side panel ↻: `agents.resumeSession` focuses this window's tab or
// has the CLI open the live agent in the window that owns the project, and the
// answer becomes one VSCodium notification. Nothing is printed into a tab.

import * as os from 'os';
import * as vscode from 'vscode';
import { runAgentsArgs } from '../core/agentsBin';
import { parseProjectDetection } from '../core/projectPanel';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import { pickRow, resumeItems, resumeNotice, type ResumeAnswer, type ResumeItem } from '../core/sessionPicker';
import { sessionStreamDemand } from '../monitor/sessionDemand';
import { streamReadiness } from './deviceHealth.vscode';
import { LOCAL_LABEL, LOCAL_MACHINE_ID } from './remoteSessions.vscode';
import * as terminals from './terminals.vscode';

const LOCAL_NAME = os.hostname().split('.')[0] ?? LOCAL_LABEL;

/** A resume target as every surface knows it: id, owning machine, and its title. */
export interface ResumeTarget {
  sessionId: string;
  host: string;
  title: string;
}

/** Resume one session and say where it went. The only resume path in the editor. */
export async function resumeAndNotify(target: ResumeTarget): Promise<void> {
  const machine = target.host === LOCAL_LABEL ? LOCAL_NAME : target.host;
  let answer: ResumeAnswer;
  try {
    answer = await vscode.commands.executeCommand<ResumeAnswer | undefined>('agents.resumeSession', target.sessionId, target.host)
      ?? { status: 'failed', terminalId: null, reason: 'agents.resumeSession gave no answer' };
  } catch (e) {
    answer = { status: 'failed', terminalId: null, reason: e instanceof Error ? e.message : String(e) };
  }
  const notice = resumeNotice(answer, { title: target.title || target.sessionId.slice(0, 8), machine }, vscode.workspace.name);
  if (notice.level === 'info') void vscode.window.showInformationMessage(notice.text);
  else void vscode.window.showErrorMessage(notice.text);
}

interface PickItem extends vscode.QuickPickItem {
  session: ResumeItem;
}

let redraw: (() => void) | undefined;

/** The stream changed; an open picker redraws from memory (no subprocess).
 *  @public loaded with require('./resumeSession.vscode') in extension.ts, which knip cannot see */
export function notifyResumePickerUpdate(): void {
  redraw?.();
}

/** Each workspace folder's agents project, found once per folder per window (the
 *  CLI's `projects status --path`, the Project sidebar's detection). */
const folderProjects = new Map<string, Promise<string | null>>();

function folderProject(folder: string): Promise<string | null> {
  let found = folderProjects.get(folder);
  if (!found) {
    found = runAgentsArgs(['projects', 'status', '--path', folder, '--json'], { timeout: 30_000 })
      .then(({ stdout }) => parseProjectDetection(stdout)?.name ?? null);
    folderProjects.set(folder, found);
    // Keep only a found project; a failure or "no project" is asked again next time.
    found.then((name) => { if (!name) folderProjects.delete(folder); }, () => folderProjects.delete(folder));
  }
  return found;
}

/** The projects of every folder this window holds: a multi-root window lists them all. */
async function windowProjects(): Promise<string[]> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const names = await Promise.all(folders.map(folderProject));
  return [...new Set(names.filter((n): n is string => !!n))];
}

/** `Agents: Resume Session…`: this window's projects' sessions on every machine.
 *  @public loaded with require('./resumeSession.vscode') in extension.ts, which knip cannot see */
export async function showResumePicker(): Promise<void> {
  const quickPick = vscode.window.createQuickPick<PickItem>();
  quickPick.title = 'Agents: Resume Session';
  quickPick.placeholder = 'Finding this window\'s projects…';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.busy = true;
  sessionStreamDemand.setResumePickerOpen(true);
  quickPick.show();

  let projects: string[] | null = null;
  const draw = () => {
    if (!projects) return;
    const items = resumeItems(sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL), projects, {
      localHost: LOCAL_LABEL,
      localName: LOCAL_NAME,
      isOpen: (id) => !!terminals.getBySessionId(id),
    });
    const now = Date.now();
    const active = quickPick.activeItems[0]?.session.sessionId;
    quickPick.items = items.map((session) => ({ ...pickRow(session, now), session }));
    const keep = quickPick.items.find((i) => i.session.sessionId === active);
    if (keep) quickPick.activeItems = [keep];
    // Until every machine the stream dials has reported, the list is partial: say
    // so instead of presenting this machine's rows (or none) as the whole answer.
    const { established, pending } = streamReadiness(LOCAL_MACHINE_ID);
    const label = projects.join(', ');
    if (!established || pending.length) {
      quickPick.busy = true;
      quickPick.placeholder = `${label}: loading machines${pending.length ? ` (${pending.join(', ')})` : ''}…`;
      return;
    }
    quickPick.busy = false;
    quickPick.placeholder = items.length
      ? `${label}: ${items.length} session${items.length === 1 ? '' : 's'}. Type to filter by title or message`
      : `No ${label} sessions on any machine`;
  };

  const chosen = await new Promise<ResumeItem | undefined>((resolve) => {
    let accepted = false;
    quickPick.onDidAccept(() => {
      const picked = quickPick.selectedItems[0]?.session;
      if (!picked) return;
      accepted = true;
      resolve(picked);
      quickPick.hide();
    });
    quickPick.onDidHide(() => { if (!accepted) resolve(undefined); });
    redraw = draw;
    windowProjects().then((found) => {
      if (!found.length) {
        quickPick.busy = false;
        quickPick.placeholder = 'No folder in this window belongs to an agents project.';
        return;
      }
      projects = found;
      draw();
    }, (e) => {
      quickPick.busy = false;
      quickPick.placeholder = `Could not find this window's projects: ${e instanceof Error ? e.message : String(e)}`;
    });
  });
  redraw = undefined;
  sessionStreamDemand.setResumePickerOpen(false);
  quickPick.dispose();
  if (chosen) await resumeAndNotify({ sessionId: chosen.sessionId, host: chosen.host, title: chosen.title });
}
