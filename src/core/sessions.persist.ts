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
import { homedir } from 'os';
import YAML from 'yaml';
import type { ManualSessionOverride } from './remoteAutoLabel';

const AGENTS_DATA_DIR = path.join(homedir(), '.swarmify', 'agents');
const WINDOWS_DIR = path.join(AGENTS_DATA_DIR, 'windows');
// Read once per workspace to carry tabs across the upgrade, never written.
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
  recoveryAgent?: string;       // Opaque CLI harness recovered through `agents sessions resume`.
                                // Kept separate from agentType so an unpresented harness is never
                                // misidentified as a built-in after an editor reload.
  version?: string;             // Pinned agent version, if known (e.g., "2.1.113")
  createdAt: number;            // Timestamp
  agentPid?: number;            // shell pid of the terminal (liveness cross-check)
}

function windowFile(workspaceKey: string): string {
  const hash = crypto.createHash('sha256').update(workspaceKey).digest('hex').slice(0, 16);
  return path.join(WINDOWS_DIR, `${hash}.yaml`);
}

function readYaml(file: string): any {
  if (!fs.existsSync(file)) return undefined;
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) ?? undefined;
  } catch (err) {
    console.error(`[SESSIONS] Failed to read ${file}:`, err);
    return undefined;
  }
}

/**
 * The tabs this window had open. `legacyKey` is the key the pre-upgrade shared
 * file used (the first folder path); it is read only while this window has never
 * written its own file.
 */
export function getWorkspaceSessions(workspaceKey: string, legacyKey: string = workspaceKey): PersistedSession[] {
  const own = readYaml(windowFile(workspaceKey));
  if (own) return Array.isArray(own.sessions) ? own.sessions : [];
  const legacy = readYaml(LEGACY_SESSIONS_PATH);
  const sessions = legacy?.workspaces?.[legacyKey]?.sessions;
  return Array.isArray(sessions) ? sessions : [];
}

/** Replace this window's tabs. Only this window's file is touched, and a reader sees the old or new file, never a torn one. */
export function saveWorkspaceSessions(workspaceKey: string, sessions: PersistedSession[]): void {
  const file = windowFile(workspaceKey);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(WINDOWS_DIR, { recursive: true });
    fs.writeFileSync(tmp, YAML.stringify({ workspace: workspaceKey, sessions }, { indent: 2 }));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[SESSIONS] Failed to save sessions file:', err);
  }
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
