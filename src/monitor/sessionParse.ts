// Pure session-file parsing + root resolution (vscode-free).
//
// The machine-wide session watcher (#69) runs in the monitor (a plain process,
// no vscode) and must parse the same head metadata `sessionTracker` reads today
// so a follower can run the identical correlation against its own terminals.
// To keep one source of truth, the parser and the session-root helpers live
// here and BOTH the leader-side watcher and the window-local `sessionTracker`
// import them.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { createHash } from 'crypto';
type SessionAgentKind = 'claude' | 'codex' | 'gemini' | 'opencode';
import { runAgents } from '../core/agentsBin';

const LINE_CAP = 100;

interface ParseResult {
  forkedFromId?: string;
  codexCwd?: string;
  geminiProjectHash?: string;
  geminiSessionId?: string;
  opencodeDirectory?: string;
  opencodeSessionId?: string;
}

function homeDir(): string {
  return os.homedir();
}

/**
 * Session id derived from a transcript path. Codex files are
 * `rollout-<ts>-<uuid>.jsonl` — return the UUID only (matches the CLI and
 * Codex `/status`). Claude and other `<uuid>.jsonl` files pass through.
 */
export function sessionIdFromFile(file: string): string {
  const base = path.basename(file).replace(/\.jsonl$/, '');
  // Inline the UUID extract so this module stays free of core/ imports that
  // pull node-heavy deps into the monitor process graph.
  const m = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0];
  return base;
}

export function workspaceHash(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex');
}

// --- Session roots (machine-wide, not workspace-keyed) --------------------

export type AgentRootKind = SessionAgentKind | 'cursor' | 'antigravity' | 'grok' | 'kimi' | 'droid';

let cachedClaudeRoots: string[] | undefined;

/** ~/.claude/projects plus every installed version's projects dir (cached). */
function claudeProjectRoots(): string[] {
  if (cachedClaudeRoots) return cachedClaudeRoots;
  const home = homeDir();
  const roots = [path.join(home, '.claude', 'projects')];
  const versionsDir = path.join(home, '.agents', '.history', 'versions', 'claude');
  if (fs.existsSync(versionsDir)) {
    try {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        roots.push(path.join(versionsDir, entry.name, 'home', '.claude', 'projects'));
      }
    } catch {
      /* ignore */
    }
  }
  cachedClaudeRoots = roots;
  return roots;
}

/** The top-level session roots for an agent (used by fast-path + locate). */
export function agentSessionRoots(agentKey: AgentRootKind): string[] {
  const home = homeDir();
  switch (agentKey) {
    case 'claude':
      return claudeProjectRoots();
    case 'codex':
      return [path.join(home, '.codex', 'sessions')];
    case 'gemini':
      return [path.join(home, '.gemini', 'tmp')];
    case 'opencode':
      return [path.join(home, '.local', 'share', 'opencode', 'storage', 'message')];
    case 'cursor':
      return [path.join(home, '.cursor', 'chats')];
    // Monitor cannot parse these transcripts yet (see watcherRootsFromCli).
    // Return empty so locate/fast-path no-ops rather than type-error.
    case 'antigravity':
    case 'grok':
    case 'kimi':
    case 'droid':
      return [];
  }
}

interface WatcherRoot {
  root: string;
  agentType: SessionAgentKind;
}

/**
 * The set of roots the machine-wide watcher recursively watches — one entry
 * per (root, agentType). The watcher mounts exactly one fs.watch per root.
 * This is the degraded path for a machine without agents-cli; the watcher
 * normally configures itself from watcherRootsFromCli() below.
 */
function watcherRoots(): WatcherRoot[] {
  const home = homeDir();
  const roots: WatcherRoot[] = [];
  for (const root of claudeProjectRoots()) roots.push({ root, agentType: 'claude' });
  roots.push({ root: path.join(home, '.codex', 'sessions'), agentType: 'codex' });
  roots.push({ root: path.join(home, '.gemini', 'tmp'), agentType: 'gemini' });
  roots.push({
    root: path.join(home, '.local', 'share', 'opencode', 'storage', 'session'),
    agentType: 'opencode',
  });
  return roots;
}

/** One `agents sessions --roots --json` entry (the CLI's SessionRoots shape). */
interface CliSessionRootsEntry {
  agent?: string;
  dirs?: unknown[];
}
