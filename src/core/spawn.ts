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

/** The nonce of a /spawn query even when the request itself is unusable, so the window can still answer. */
export function spawnNonce(query: string): string | undefined {
  try {
    const obj = JSON.parse(Buffer.from(new URLSearchParams(query).get('p') ?? '', 'base64url').toString('utf8'));
    return typeof obj?.nonce === 'string' && NONCE.test(obj.nonce) ? obj.nonce : undefined;
  } catch {
    return undefined;
  }
}

// The ack a window writes for a /spawn request that carried a nonce. The CLI
// polls ~/.swarmify/agents/spawn-acks/<nonce>.json instead of reporting
// `codium --open-url` as success. Fixture both sides test against:
// src/core/testdata/spawn-ack.json.
//   opened           this window started the tab's process (pid set)
//   focused-existing this window already had a live tab for sessionId; it was focused
//   wrong-window     this window's folders do not contain `project`; nothing opened
//   failed           nothing opened: the request named no project, no harness
//                    matched, or the tab's process never started (`reason` says which)
// A window speaks only for its own tabs: wrong-window says nothing about which
// window, if any, holds the session.
export type SpawnAckStatus = 'opened' | 'focused-existing' | 'wrong-window' | 'failed';

export interface SpawnAck {
  nonce: string;
  status: SpawnAckStatus;
  windowFolders: string[];
  workspaceName: string | null;
  terminalId: string | null;
  title: string | null;
  sessionId: string | null;
  pid: number | null;
  reason: string | null;
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
  try {
    fs.writeFileSync(tmp, JSON.stringify(ack));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/**
 * What this window does with a spawn request: refuse a project outside its
 * folders, or one a live window holds through a deeper folder (a window on
 * ~/src must not take ~/src/app from the window on ~/src/app), focus its own
 * live tab for the session, or open a new one. A request that names no project
 * is refused: without it a window cannot tell whether the tab belongs to it.
 */
export function decideSpawn(input: {
  project?: string;
  windowFolders: readonly string[];
  otherWindows?: readonly (readonly string[])[];
  liveTerminalId?: string;
}): 'no-project' | 'wrong-window' | 'focus' | 'open' {
  if (!input.project) return 'no-project';
  const mine = deepestMatch(input.windowFolders, input.project);
  if (mine < 0) return 'wrong-window';
  const theirs = Math.max(-1, ...(input.otherWindows ?? []).map((folders) => deepestMatch(folders, input.project!)));
  if (theirs > mine) return 'wrong-window';
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

/**
 * The answer `agents.resumeSession` returns when the session has no tab in the
 * calling window: the CLI's `sessions resume <id> --vscodium` raised the window
 * that owns the project, sent it a /spawn, and waited for that window's ack. Its
 * exit code says whether a tab is showing the session; its last line says where.
 */
export function cliResumeOutcome(exitOk: boolean, output: string): { status: SpawnAckStatus; reason: string | null } {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? null;
  // A failure's reason is what went wrong, not the CLI's "run this in a terminal"
  // hint: the editor surfaces it and never asks anyone to type a session id.
  const told = lines.filter((line) => !/^Resume it in this terminal\b/i.test(line));
  const reason = told[told.length - 1] ?? last ?? 'resume failed with no output';
  // The CLI reports a /spawn that reached a window not holding the project as a
  // failure naming that window ("… which does not hold <project>; nothing was opened").
  if (!exitOk) return { status: /\bwhich does not hold\b/.test(reason) ? 'wrong-window' : 'failed', reason };
  return { status: lines.some((line) => line.startsWith('Already open')) ? 'focused-existing' : 'opened', reason: last };
}

/**
 * `agents.resumeSession`: show this session. A tab already showing it in this
 * window is focused; otherwise the CLI's `sessions resume <id> --vscodium` opens
 * it in the window that owns its project, which runs decideSpawn there.
 */
export async function resumeSessionTab(
  sessionId: string,
  deps: {
    liveTab(sessionId: string): Promise<{ terminalId: string; focus(): void } | undefined>;
    /** `device` is the machine that owns the session, absent for this machine. */
    runResume(sessionId: string, device: string | undefined): Promise<{ ok: boolean; output: string }>;
  },
  device?: string,
): Promise<{ status: SpawnAckStatus; terminalId: string | null; reason: string | null }> {
  if (!sessionId) return { status: 'failed', terminalId: null, reason: 'no session id' };
  const live = await deps.liveTab(sessionId);
  if (live) {
    live.focus();
    return { status: 'focused-existing', terminalId: live.terminalId, reason: null };
  }
  const { ok, output } = await deps.runResume(sessionId, device);
  return { ...cliResumeOutcome(ok, output), terminalId: null };
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
