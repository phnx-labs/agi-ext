/**
 * Approval alerts (RUSH-2039): a session with a tab in this window that starts
 * needing you pages once per wait. Driven by the session stream (extension.ts
 * calls this on every applied fact), gated on `notifications.enabled`, and drawn
 * in the style the user picked: an OS notification or an editor toast with a
 * "Focus terminal" action.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as terminals from './terminals.vscode';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import { sessionStateOf } from '../shared/sessionState';
import type { NotificationSettings } from '../core/settings';
import { LOCAL_LABEL, LOCAL_MACHINE_ID } from './remoteSessions.vscode';
import { detectNewlyWaiting, formatWaitingMessage, type NewlyWaiting } from '../core/waitingNotifier';

// Session ids that needed you at the previous fact: the edge-detection state.
let waitingSessions = new Set<string>();

const FOCUS_ACTION = 'Focus terminal';

/** Called on each applied stream fact. Edges are tracked while alerts are off too,
 *  so turning them on does not page for sessions already waiting. The settings are
 *  read only when a session starts waiting, not on every fact.
 *  @public loaded with require('./waitingNotifier.vscode') in extension.ts, which knip cannot see */
export function notifyNewlyWaiting(readPrefs: () => NotificationSettings | undefined): void {
  const rows = sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL)
    .filter((r) => terminals.getBySessionId(r.sessionId))
    .map((r) => ({ sessionId: r.sessionId, agentType: r.agentType, label: r.title || r.label || null, waitingForInput: sessionStateOf(r) === 'asks' }));
  const { newlyWaiting, nextWaiting } = detectNewlyWaiting(waitingSessions, rows);
  waitingSessions = nextWaiting;
  if (newlyWaiting.length === 0) return;
  const prefs = readPrefs();
  if (!prefs?.enabled) return;
  for (const s of newlyWaiting) alert(s, prefs.style);
}

function alert(s: NewlyWaiting, style: NotificationSettings['style']): void {
  const message = formatWaitingMessage(s);
  if (style === 'native' && process.platform === 'darwin') {
    execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "AGI EXT"', '-e', 'end run', message], () => undefined);
    return;
  }
  if (style === 'native' && process.platform === 'linux') {
    execFile('notify-send', ['AGI EXT', message], () => undefined);
    return;
  }
  void vscode.window.showInformationMessage(message, FOCUS_ACTION).then((choice) => {
    if (choice !== FOCUS_ACTION) return;
    terminals.getBySessionId(s.sessionId)?.terminal.show(true);
  });
}
