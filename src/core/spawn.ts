// Pure parsing for the `…/spawn?…` URI verb (no VS Code dependencies - testable).
// The VS Code glue that turns a SpawnRequest into an editor-tab terminal lives
// in vscode/extension.ts (spawnCommandTerminal).

import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { isHostFallbackLabel, parseTerminalName } from './utils';

type SpawnSplit = 'right' | 'down';

export interface SpawnRequest {
  // Exact command line to run in the spawned terminal (e.g. "claude --resume <id>").
  command: string;
  // Working directory; falls back to the workspace root when absent.
  cwd?: string;
  // When set, split beside the previously spawned pane instead of a new tab.
  split?: SpawnSplit;
  /**
   * Harness id (claude/codex/grok/…) when the caller already knows it.
   * Required for remote attach commands (`ssh … tmux attach`) where the local
   * process tree has no agent binary to sniff — without this the tab stays a
   * generic SH shell with the wrong icon (#2478).
   */
  agent?: string;
  /** Canonical session id to stamp on the terminal for resume/status-bar. */
  sessionId?: string;
  /** Optional pre-baked tab title; otherwise the extension formats from agent. */
  title?: string;
  /** Names the ack file the window writes (spawnAckPath); no nonce, no ack. */
  nonce?: string;
  /** Local folder the tab belongs to; only a window whose folders contain it opens the tab. */
  project?: string;
}

// Parse the query of a `…/spawn?p=<payload>` URI into a spawn request. The
// payload is base64url-encoded JSON in a single `p` param: VS Code percent-decodes
// uri.query once before we see it, so a command/cwd containing `&` or `=` would be
// mis-split by a multi-param query. base64url ([A-Za-z0-9_-]) survives that decode
// untouched. Returns null when there is no command to run. `split` is honoured
// only for the two supported directions; any other value is dropped, not trusted.
export function parseSpawnRequest(query: string): SpawnRequest | null {
  const p = new URLSearchParams(query).get('p');
  if (!p) return null;
  let obj: any;
  try {
    obj = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const command = typeof obj?.command === 'string' ? obj.command.trim() : '';
  if (!command) return null;
  const cwd = typeof obj?.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : undefined;
  const split: SpawnSplit | undefined =
    obj?.split === 'right' || obj?.split === 'down' ? obj.split : undefined;
  const agent = typeof obj?.agent === 'string' && obj.agent.trim() ? obj.agent.trim().toLowerCase() : undefined;
  const sessionId =
    typeof obj?.sessionId === 'string' && obj.sessionId.trim() ? obj.sessionId.trim() : undefined;
  const rawTitle = typeof obj?.title === 'string' ? obj.title.trim() : undefined;
  const title = rawTitle && !isHostFallbackLabel(rawTitle)
    && !isHostFallbackLabel(parseTerminalName(rawTitle).label) ? rawTitle : undefined;
  const nonce = typeof obj?.nonce === 'string' && NONCE.test(obj.nonce) ? obj.nonce : undefined;
  const project = typeof obj?.project === 'string' && obj.project.trim() ? obj.project.trim() : undefined;
  return { command, cwd, split, agent, sessionId, title, nonce, project };
}

// The ack a window writes for a /spawn request that carried a nonce. The CLI
// polls ~/.swarmify/agents/spawn-acks/<nonce>.json instead of reporting
// `codium --open-url` as success. Fixture both sides test against:
// src/core/testdata/spawn-ack.json.
//   opened           this window started the tab's process (pid set)
//   focused-existing this window already had a live tab for sessionId; it was focused
//   wrong-window     this window's folders do not contain `project`; nothing opened
//   failed           this window tried to open the tab and its process never started
// A window speaks only for its own tabs: wrong-window says nothing about which
// window, if any, holds the session.
type SpawnAckStatus = 'opened' | 'focused-existing' | 'wrong-window' | 'failed';

export interface SpawnAck {
  nonce: string;
  status: SpawnAckStatus;
  windowFolders: string[];
  workspaceName: string | null;
  terminalId: string | null;
  title: string | null;
  sessionId: string | null;
  pid: number | null;
  at: number;
}

const NONCE = /^[A-Za-z0-9_-]{1,128}$/;

export function spawnAckPath(nonce: string): string {
  if (!NONCE.test(nonce)) throw new Error(`invalid spawn nonce: ${nonce}`);
  return path.join(homedir(), '.swarmify', 'agents', 'spawn-acks', `${nonce}.json`);
}

/** Written whole or not at all, so a polling CLI never reads half an ack. */
export function writeSpawnAck(ack: SpawnAck): void {
  const file = spawnAckPath(ack.nonce);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ack));
  fs.renameSync(tmp, file);
}

/**
 * What this window does with a spawn request: refuse a project outside its
 * folders, or one a live window holds through a deeper folder (a window on
 * ~/src must not take ~/src/app from the window on ~/src/app), focus its own
 * live tab for the session, or open a new one. A request without `project` (a
 * CLI from before this contract) opens where it landed.
 */
export function decideSpawn(input: {
  project?: string;
  windowFolders: readonly string[];
  otherWindows?: readonly (readonly string[])[];
  liveTerminalId?: string;
}): 'wrong-window' | 'focus' | 'open' {
  if (input.project) {
    const mine = deepestMatch(input.windowFolders, input.project);
    if (mine < 0) return 'wrong-window';
    const theirs = Math.max(-1, ...(input.otherWindows ?? []).map((folders) => deepestMatch(folders, input.project!)));
    if (theirs > mine) return 'wrong-window';
  }
  return input.liveTerminalId ? 'focus' : 'open';
}

// Depth (path length) of the deepest folder containing target, or -1.
function deepestMatch(folders: readonly string[], target: string): number {
  const t = canonicalPath(target);
  let best = -1;
  for (const folder of folders) {
    const f = canonicalPath(folder);
    const rel = path.relative(f, t);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) best = Math.max(best, f.length);
  }
  return best;
}

// Symlinks resolved; lower-cased on macOS and Windows, whose default volumes
// compare names without case.
function canonicalPath(p: string): string {
  let real: string;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    real = path.resolve(p);
  }
  return process.platform === 'darwin' || process.platform === 'win32' ? real.toLowerCase() : real;
}

// Which surface a spawn request lands on.
//   native-split — split the parent VS Code terminal
//   native-tab   — new editor tab backed by a plain VS Code terminal
export type SpawnSurface = 'native-split' | 'native-tab';

export interface SpawnSurfaceInput {
  // The request asked to split beside the previously spawned pane.
  wantsSplit: boolean;
  // A previously spawned pane is still alive to split from.
  hasParent: boolean;
}

// Pick the surface for a spawn request. Pure so the matrix is testable without
// the VS Code API; the glue in spawnCommandTerminal just executes the choice.
//
// AGI EXT no longer spawns tmux-backed terminals at the extension level, so a
// split always means a native VS Code terminal split.
export function resolveSpawnSurface(input: SpawnSurfaceInput): SpawnSurface {
  const splitting = input.wantsSplit && input.hasParent;
  return splitting ? 'native-split' : 'native-tab';
}
