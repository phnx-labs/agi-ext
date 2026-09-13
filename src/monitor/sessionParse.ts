// Session-root resolution (vscode-free).
//
// The leader-side readiness detector runs in the monitor (a plain process, no
// vscode) and resolves which session-root directories an agent's transcripts
// live under, so it can scan for a newly created session file without a
// full-text parser. The CLI's stream row remains the only source of session
// facts; this is purely the filesystem layout lookup the detector needs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type SessionAgentKind = 'claude' | 'codex' | 'opencode';

function homeDir(): string {
  return os.homedir();
}

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

/** The top-level session roots for an agent (used by the detector's locate). */
export function agentSessionRoots(agentKey: AgentRootKind): string[] {
  const home = homeDir();
  switch (agentKey) {
    case 'claude':
      return claudeProjectRoots();
    case 'codex':
      return [path.join(home, '.codex', 'sessions')];
    case 'opencode':
      return [path.join(home, '.local', 'share', 'opencode', 'storage', 'message')];
    case 'cursor':
      return [path.join(home, '.cursor', 'chats')];
    // Monitor cannot parse these transcripts yet.
    // Return empty so locate no-ops rather than type-error.
    case 'antigravity':
    case 'grok':
    case 'kimi':
    case 'droid':
      return [];
  }
}
