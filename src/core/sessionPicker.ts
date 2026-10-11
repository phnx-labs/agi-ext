// "Agents: Resume Session…": the window's project sessions as picker rows, and the
// one notification every resume surface (picker, Fleet Resume, side panel ↻) shows
// for the answer `agents.resumeSession` gives. Pure; the vscode glue is
// src/vscode/resumeSession.vscode.ts.
//
// Rows come from the session stream already in the presentation store, scoped by
// the CLI's own `confirmedProject` (the Project sidebar's list, `projectSessions`).
// A row is usable with only its id, title, machine and last activity: a field the
// row does not carry is left out, never filled in.

import { preferLive, projectSessions, type SessionLike } from './projectPanel';
import type { SpawnAckStatus } from './spawn';
import { agentWords, firstLineOf, firstText, latestUserText } from '../shared/sessionText';

/** The stream-row fields the picker reads (RemoteSession satisfies it). */
export interface PickerRow {
  sessionId: string;
  host: string;
  title?: string;
  label?: string;
  topic?: string;
  lastActivityMs: number;
  confirmedProject: string | null;
  state?: string;
  phase?: SessionLike['phase'];
  liveStatus?: string;
  userTurns?: Array<{ text: string }>;
  request?: { text?: string };
  firstUserMessage?: string;
  lastResponse?: string;
  tail?: string[];
  timeline?: { steps: Array<{ text: string; source: string }> };
}

export interface ResumeItem {
  sessionId: string;
  host: string;
  title: string;
  /** Machine name to show; this machine's own name for a local row. */
  machine: string;
  /** Your last message; '' when the row has none. */
  you: string;
  /** The agent's last line; '' when the row has none. */
  agent: string;
  lastActivityMs: number;
  /** A tab in this window already shows the session. */
  open: boolean;
}

/** The sessions of these projects (every project a window folder belongs to),
 *  newest first, as picker items. */
export function resumeItems(
  rows: PickerRow[],
  projects: readonly string[],
  opts: { localHost: string; localName: string; isOpen(sessionId: string): boolean },
): ResumeItem[] {
  const live = preferLive(rows);
  const scoped = projects.flatMap((project) => projectSessions(live, project)).sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return scoped.map((r) => ({
    sessionId: r.sessionId,
    host: r.host,
    title: firstText(r.title, r.label, r.topic) || r.sessionId.slice(0, 8),
    machine: r.host === opts.localHost ? opts.localName : r.host,
    you: firstLineOf(latestUserText({ userTurns: r.userTurns, latestRequest: r.request?.text, firstUserMessage: r.firstUserMessage })),
    agent: firstLineOf(agentWords([r.lastResponse, r.tail?.[r.tail.length - 1]], r.timeline)),
    lastActivityMs: r.lastActivityMs,
    open: opts.isOpen(r.sessionId),
  }));
}

/** "now", "12m ago", "3h ago", "2d ago"; '' when unknown. */
export function ago(ms: number, now: number): string {
  if (!ms) return '';
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/** The QuickPick row: title, then machine · age · OPEN, then your and the agent's lines.
 *  VS Code matches typing against the label and the detail, so title and messages filter. */
export function pickRow(item: ResumeItem, now: number): { label: string; description: string; detail: string } {
  const description = [item.machine, ago(item.lastActivityMs, now), item.open ? 'OPEN' : ''].filter(Boolean).join(' · ');
  const detail = [item.you && `You › ${item.you}`, item.agent && `Agent › ${item.agent}`].filter(Boolean).join('   ');
  return { label: item.title, description, detail };
}

/** What `agents.resumeSession` answered. */
export interface ResumeAnswer {
  status: SpawnAckStatus;
  terminalId: string | null;
  reason: string | null;
}

/** The one notification for a resume, whichever surface asked. A window is named
 *  only when something proves it: a tab in this window (`terminalId`, named `here`
 *  when this window has a name) or the window the CLI's last line names
 *  (`→ VSCodium window "agents", new tab …`). */
export function resumeNotice(
  answer: ResumeAnswer,
  session: { title: string; machine: string },
  here: string | undefined,
): { level: 'info' | 'error'; text: string } {
  const name = `"${session.title}"${session.machine ? ` (${session.machine})` : ''}`;
  const where = answer.terminalId ? here : windowIn(answer.reason);
  if (answer.status === 'focused-existing') return { level: 'info', text: `Focused ${name}${where ? ` in ${where}` : ''}.` };
  if (answer.status === 'opened') return { level: 'info', text: `Opened ${name}${where ? ` in ${where}` : ''}.` };
  if (answer.status === 'wrong-window') {
    return { level: 'error', text: `Could not resume ${name}: ${answer.reason || 'the request reached a window that does not hold its project'}` };
  }
  return { level: 'error', text: `Could not resume ${name}: ${answer.reason || 'no reason given'}` };
}

function windowIn(reason: string | null): string | null {
  return reason?.match(/window "([^"]+)"/)?.[1] ?? null;
}
