// Shared cross-window registry of live agent terminals.
//
// Each VS Code / Codium / Cursor window runs its own extension host, so
// `vscode.window.terminals` only tells us what's open in THIS window. The
// CLI needs to see every agent across every IDE window. We solve that
// by having each extension host write its own terminals to a shared JSON
// file; readers merge entries and filter out ones whose pid is dead.
//
// File: ~/.agents/.cache/terminals/live-terminals.json
// Shape: { <windowId>: { at: ISO, entries: LiveTerminal[] } }
//   - Writer owns its windowId slice. Reads are merges of all slices.
//   - Stale entries (pid dead) are filtered at read time, not pruned. The
//     owning window prunes on its own terminal close/exit events.
//   - A peer slice whose `at` is older than 10 minutes is dropped whatever
//     its pids say: terminals outlive a window reload, which mints a fresh
//     windowId, so pid liveness cannot tell an abandoned slice from a live one.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { computeWindowId } from '../core/windowId';
import { terminalTabNumbers } from './frontTab.vscode';
import { resolveStartedAtMs } from '../core/processStartTime';
import { agentKindFromTerminalId } from '../core/agents';
import { getById } from './terminals.vscode';

const REGISTRY_DIR = path.join(os.homedir(), '.agents', '.cache', 'terminals');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'live-terminals.json');
const LEGACY_REGISTRY_FILE = path.join(os.homedir(), '.agents', 'swarmify', 'live-terminals.json');
const STALE_WINDOW_MS = 10 * 60_000;
// Force a write at least this often even when our slice is unchanged, so
// peers don't prune us (peer prune trigger: `at` older than STALE_WINDOW_MS).
const KEEPALIVE_FORCE_MS = 4 * 60_000;

interface LiveTerminal {
  // Only Claude's id is minted at launch; other harnesses pick theirs after
  // they start, and the CLI joins those tabs by terminalId.
  sessionId?: string;
  terminalId?: string;
  pid: number;
  kind: string;              // 'claude' | 'codex' | ...
  cwd?: string | null;
  startedAtMs: number;
  // Richer tracking so the CLI can address + display this terminal precisely.
  // DATA CONTRACT with the CLI (src/lib/session): field names are load-bearing.
  tabIndex?: number;         // 1-based editor-tab index within its group ("Codium tab N").
}

interface RegistryFile {
  [windowId: string]: { at: string; entries: LiveTerminal[] };
}

let ownWindowId: string | undefined;
function getOwnWindowId(): string {
  if (ownWindowId) return ownWindowId;
  // VSCodium strips telemetry and replaces vscode.env.sessionId with the
  // literal "someValue.sessionId" for every window — sessionId alone collides
  // across windows. process.pid is per-extension-host so it disambiguates.
  ownWindowId = computeWindowId(vscode.env.sessionId, process.pid);
  return ownWindowId;
}

async function readRegistryAsync(): Promise<RegistryFile> {
  try {
    const raw = await fs.promises.readFile(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    try {
      const raw = await fs.promises.readFile(LEGACY_REGISTRY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}

async function writeRegistryAsync(reg: RegistryFile): Promise<void> {
  try {
    await fs.promises.mkdir(REGISTRY_DIR, { recursive: true });
    const tmp = `${REGISTRY_FILE}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, JSON.stringify(reg, null, 2));
    await fs.promises.rename(tmp, REGISTRY_FILE);
  } catch {
    /* best effort */
  }
}

let lastPublishedHash: string | undefined;
let lastPublishedAtMs = 0;

function hashEntries(entries: LiveTerminal[]): string {
  // Stable hash of the slice content. The `at` timestamp is excluded — it
  // changes every call and would make every hash unique.
  const stable = entries
    .map((e) => `${e.terminalId ?? ''}|${e.sessionId ?? ''}|${e.pid}|${e.kind}|${e.cwd ?? ''}|${e.tabIndex ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(stable).digest('hex');
}

// Publish this window's live terminals. Skips the disk write when our slice
// is unchanged AND a keepalive isn't due — the previous implementation did
// a sync read+write of the whole registry on every terminal event AND on a
// 15s interval, blocking the extension-host thread for no information gain.
/** @public called through the dynamic import in extension.ts, which knip cannot see */
export async function publishLiveTerminals(terminals: LiveTerminal[]): Promise<void> {
  const hash = hashEntries(terminals);
  const now = Date.now();
  const unchanged = hash === lastPublishedHash;
  const keepaliveDue = now - lastPublishedAtMs >= KEEPALIVE_FORCE_MS;
  if (unchanged && !keepaliveDue) return;

  const reg = await readRegistryAsync();
  reg[getOwnWindowId()] = {
    at: new Date().toISOString(),
    entries: terminals,
  };
  // Drop peer slices that stopped their keepalive.
  const cutoff = now - STALE_WINDOW_MS;
  for (const [winId, slice] of Object.entries(reg)) {
    if (winId === getOwnWindowId()) continue;
    const at = Date.parse(slice?.at ?? '');
    if (!(at > cutoff)) delete reg[winId];
  }
  await writeRegistryAsync(reg);
  lastPublishedHash = hash;
  lastPublishedAtMs = now;
}

// Scan vscode.window.terminals and build a LiveTerminal array for this window.
// Returns [] if no agent terminals are open here.
/** @public called through the dynamic import in extension.ts, which knip cannot see */
export async function snapshotOwnTerminals(): Promise<LiveTerminal[]> {
  const out: LiveTerminal[] = [];
  const tabNumbers = terminalTabNumbers();
  for (const t of vscode.window.terminals) {
    if (t.exitStatus !== undefined) continue;
    const opts = t.creationOptions as vscode.TerminalOptions;
    const env = opts?.env as Record<string, string | undefined> | undefined;
    const tid = env?.AGENT_TERMINAL_ID;
    if (!tid) continue;
    const pid = await t.processId;
    if (!pid) continue;
    const tabIndex = tabNumbers.get(t);
    out.push({
      // The bound id, not the launch env: Codex/Grok mint theirs after launch and a tab can be rebound.
      sessionId: getById(tid)?.sessionId || undefined,
      terminalId: tid,
      pid,
      kind: agentKindFromTerminalId(tid),
      cwd: env?.AGENT_WORKSPACE_DIR ?? null,
      startedAtMs: await resolveStartedAtMs(pid),
      tabIndex,
    });
  }
  return out;
}

