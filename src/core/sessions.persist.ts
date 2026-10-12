// Session persistence for terminal restore across editor restarts.
//
// Each editor window owns one file, ~/.swarmify/agents/windows/<hash>.yaml, named
// by its workspace identity and replaced atomically. Every window used to
// read-modify-write one shared sessions.yaml with a plain truncate-and-write, so a
// window that read mid-write or held a stale copy rewrote every other window's
// tabs: closed tabs came back, and whole workspaces vanished.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { homedir } from 'os';
import YAML from 'yaml';
import type { ManualSessionOverride } from './remoteAutoLabel';

const AGENTS_DATA_DIR = path.join(homedir(), '.swarmify', 'agents');
const WINDOWS_DIR = path.join(AGENTS_DATA_DIR, 'windows');
// The pre-upgrade shared store: imported once per first-folder key, never written.
const LEGACY_SESSIONS_PATH = path.join(AGENTS_DATA_DIR, 'sessions.yaml');

// Persisted session data for a single terminal
export interface PersistedSession {
  manualSessionOverride?: ManualSessionOverride;
  terminalId: string;           // AGENT_TERMINAL_ID (e.g., "CL-1234567890-1")
  prefix: string;               // Agent prefix (e.g., "CL", "CX", "SH")
  sessionId?: string;           // CLI session ID for resume (e.g., Claude's session ID)
  host?: string;                // Device the agent was offloaded to (`agents run --device`); the
                                // transcript lives there, so a restored tab must keep routing
                                // its session lookups through that host.
  label?: string;               // User-set label
  autoLabel?: string;           // Harness/LLM-generated label; remains replaceable
  agentType?: string;           // Agent type key (e.g., "claude", "codex")
  recoveryAgent?: string;       // Opaque CLI harness recovered through `agents run auto --resume`.
                                // Kept separate from agentType so an unpresented harness is never
                                // misidentified as a built-in after an editor reload.
  version?: string;             // Pinned agent version, if known (e.g., "2.1.113")
  createdAt: number;            // Timestamp
  agentPid?: number;            // shell pid of the terminal (liveness cross-check)
}

function hashOf(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function windowFile(workspaceKey: string): string {
  return path.join(WINDOWS_DIR, `${hashOf(workspaceKey)}.yaml`);
}

function readYaml(file: string): any {
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) ?? undefined;
  } catch (err) {
    console.error(`[SESSIONS] Failed to read ${file}:`, err);
    return undefined;
  }
}

/**
 * The tabs this window had open. A window that has never written its own file
 * imports its slice of the pre-upgrade shared file once: it claims that file's
 * first-folder key (`legacyKey`) before reading it, so the key is read at most
 * once by one window and never again.
 */
export function getWorkspaceSessions(workspaceKey: string, legacyKey: string = workspaceKey): PersistedSession[] {
  const own = windowFile(workspaceKey);
  if (fs.existsSync(own)) {
    const sessions = readYaml(own)?.sessions;
    return Array.isArray(sessions) ? sessions : [];
  }
  if (!fs.existsSync(LEGACY_SESSIONS_PATH)) return [];
  try {
    fs.mkdirSync(WINDOWS_DIR, { recursive: true });
    fs.closeSync(fs.openSync(path.join(WINDOWS_DIR, `legacy-${hashOf(legacyKey)}.claimed`), 'wx'));
  } catch {
    return [];
  }
  const sessions = readYaml(LEGACY_SESSIONS_PATH)?.workspaces?.[legacyKey]?.sessions;
  return Array.isArray(sessions) ? sessions : [];
}

/**
 * Replace this window's file. Only this window's file is touched; the temp file
 * is flushed to disk before the rename, so a reader or a power loss sees the old
 * file or the new one, never a torn or empty one. `folders` and `pid` let other
 * windows see which projects and sessions a live window holds (liveWindows).
 */
export function saveWorkspaceSessions(
  workspaceKey: string,
  sessions: PersistedSession[],
  window: { folders?: string[]; pid?: number } = {},
): void {
  const file = windowFile(workspaceKey);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(WINDOWS_DIR, { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, YAML.stringify({ workspace: workspaceKey, folders: window.folders, pid: window.pid, sessions }, { indent: 2 }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[SESSIONS] Failed to save sessions file:', err);
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * Every other editor window whose extension host is still running: its folders
 * and the sessions its live tabs show. A window is live when its pid answers and its
 * file was written since this machine booted, so a pid reused after a reboot
 * never makes a dead window look live.
 */
export function liveWindows(selfPid: number): Array<{ folders: string[]; sessionIds: string[] }> {
  let names: string[];
  try {
    names = fs.readdirSync(WINDOWS_DIR).filter((name) => name.endsWith('.yaml'));
  } catch {
    return [];
  }
  const bootedAt = Date.now() - os.uptime() * 1000;
  const out: Array<{ folders: string[]; sessionIds: string[] }> = [];
  for (const name of names) {
    const file = path.join(WINDOWS_DIR, name);
    const data = readYaml(file);
    const pid = data?.pid;
    if (typeof pid !== 'number' || pid === selfPid || !Array.isArray(data.folders)) continue;
    try {
      if (fs.statSync(file).mtimeMs < bootedAt) continue;
      process.kill(pid, 0);
    } catch {
      continue;
    }
    const sessions: PersistedSession[] = Array.isArray(data.sessions) ? data.sessions : [];
    out.push({
      folders: data.folders,
      // Only tabs whose process runs: a window still restoring lists sessions it
      // has not reopened yet, which must not stop another window holding them.
      sessionIds: sessions
        .filter((session) => session.sessionId && typeof session.agentPid === 'number' && alive(session.agentPid))
        .map((session) => session.sessionId as string),
    });
  }
  return out;
}

/**
 * The persisted tabs to reopen: one tab per session, none for a session or
 * terminal this window already shows. A duplicate keeps its first entry and
 * takes any field that copy is missing (host, version, label) from the others.
 */
export function restorePlan(
  persisted: readonly PersistedSession[],
  live: { terminalIds: ReadonlySet<string>; sessionIds: ReadonlySet<string> },
): PersistedSession[] {
  const plan: PersistedSession[] = [];
  const bySession = new Map<string, PersistedSession>();
  for (const session of persisted) {
    if (live.terminalIds.has(session.terminalId)) continue;
    if (!session.sessionId) {
      plan.push(session);
      continue;
    }
    if (live.sessionIds.has(session.sessionId)) continue;
    const first = bySession.get(session.sessionId);
    if (!first) {
      const copy = { ...session };
      bySession.set(session.sessionId, copy);
      plan.push(copy);
      continue;
    }
    for (const [field, value] of Object.entries(session)) {
      const key = field as keyof PersistedSession;
      if (first[key] === undefined && value !== undefined && value !== null) {
        (first as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return plan;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
