// "Agents: Resume Session…" and the one resume action behind it, the Fleet Resume
// button and the side panel ↻: `agents.resumeSession` focuses this window's tab or
// has the CLI open the live agent in the window that owns the project, and the
// answer becomes one VSCodium notification. Nothing is printed into a tab.

import * as os from 'os';
import * as vscode from 'vscode';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import { pickRow, resumeItems, resumeNotice, type ResumeAnswer, type ResumeItem } from '../core/sessionPicker';
import { sessionStreamDemand } from '../monitor/sessionDemand';
import { windowProject } from './projectPanel.vscode';
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
  const here = vscode.workspace.name ?? 'this window';
  const notice = resumeNotice(answer, { title: target.title || target.sessionId.slice(0, 8), machine }, here);
  if (notice.level === 'info') void vscode.window.showInformationMessage(notice.text);
  else if (notice.level === 'warning') void vscode.window.showWarningMessage(notice.text);
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

/** `Agents: Resume Session…`: this window's project sessions on every machine.
 *  @public loaded with require('./resumeSession.vscode') in extension.ts, which knip cannot see */
export async function showResumePicker(): Promise<void> {
  const quickPick = vscode.window.createQuickPick<PickItem>();
  quickPick.title = 'Agents: Resume Session';
  quickPick.placeholder = 'Type to filter by title or message';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.busy = true;
  sessionStreamDemand.setResumePickerOpen(true);
  quickPick.show();

  let project: string | null = null;
  const draw = () => {
    if (!project) return;
    if (!sessionPresentationStore.hasSeenReset()) {
      quickPick.busy = true;
      quickPick.placeholder = 'Waiting for the session stream…';
      return;
    }
    const items = resumeItems(sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL), project, {
      localHost: LOCAL_LABEL,
      localName: LOCAL_NAME,
      isOpen: (id) => !!terminals.getBySessionId(id),
    });
    const now = Date.now();
    const active = quickPick.activeItems[0]?.session.sessionId;
    quickPick.items = items.map((session) => ({ ...pickRow(session, now), session }));
    const keep = quickPick.items.find((i) => i.session.sessionId === active);
    if (keep) quickPick.activeItems = [keep];
    quickPick.busy = false;
    quickPick.placeholder = items.length
      ? `${project}: ${items.length} session${items.length === 1 ? '' : 's'}. Type to filter by title or message`
      : `No ${project} sessions on the stream yet`;
  };

  const chosen = await new Promise<ResumeItem | undefined>((resolve) => {
    let accepted = false;
    quickPick.onDidAccept(() => {
      accepted = true;
      resolve(quickPick.selectedItems[0]?.session);
      quickPick.hide();
    });
    quickPick.onDidHide(() => { if (!accepted) resolve(undefined); });
    redraw = draw;
    windowProject().then((p) => {
      if (!p) {
        quickPick.busy = false;
        quickPick.placeholder = 'This folder is not in an agents project. Pick one with "Agents: Project: Switch Project".';
        return;
      }
      project = p.name;
      draw();
    }, (e) => {
      quickPick.busy = false;
      quickPick.placeholder = `Could not find this folder's project: ${e instanceof Error ? e.message : String(e)}`;
    });
  });
  redraw = undefined;
  sessionStreamDemand.setResumePickerOpen(false);
  quickPick.dispose();
  if (chosen) await resumeAndNotify({ sessionId: chosen.sessionId, host: chosen.host, title: chosen.title });
}
