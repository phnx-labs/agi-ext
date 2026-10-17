// Pure data and lookup functions (no VS Code dependencies - testable)
// VS Code-dependent functions are in agents.vscode.ts

import {
  CLAUDE_TITLE,
  CODEX_TITLE,
  OPENCODE_TITLE,
  CURSOR_TITLE,
  SHELL_TITLE,
  ANTIGRAVITY_TITLE,
  GROK_TITLE,
  KIMI_TITLE,
  DROID_TITLE
} from './utils';
import { CLI_AGENT_META } from './agents.cli';
import type { CliAgentId } from './agents.cli';
import { shellQuote } from './shellQuote';

// Built-in agent definition (static data)
export interface BuiltInAgentDef {
  key: string;
  title: string;
  command: string;
  icon: string;
  prefix: string;
  commandId: string;
}

/**
 * The VS Code presentation overlay for each agent the extension offers a
 * spawn command for: tab title, icon asset, terminal prefix, and the
 * registered command id. What an agent IS — its id and launch binary — comes
 * from the CLI registry snapshot (agents.cli.ts, issue #741); 'shell' is the
 * one extension-only entry (a plain terminal, not a CLI agent).
 */
interface AgentPresentation {
  key: CliAgentId | 'shell';
  title: string;
  icon: string;
  prefix: string;
  commandId: string;
}

const PRESENTED_AGENTS: AgentPresentation[] = [
  { key: 'claude', title: CLAUDE_TITLE, icon: 'claude.png', prefix: 'cl', commandId: 'agents.newClaude' },
  { key: 'codex', title: CODEX_TITLE, icon: 'chatgpt.png', prefix: 'cx', commandId: 'agents.newCodex' },
  { key: 'opencode', title: OPENCODE_TITLE, icon: 'opencode.png', prefix: 'oc', commandId: 'agents.newOpenCode' },
  { key: 'cursor', title: CURSOR_TITLE, icon: 'cursor.png', prefix: 'cr', commandId: 'agents.newCursor' },
  { key: 'shell', title: SHELL_TITLE, icon: 'agents.png', prefix: 'sh', commandId: 'agents.newShell' },
  { key: 'antigravity', title: ANTIGRAVITY_TITLE, icon: 'antigravity.png', prefix: 'ag', commandId: 'agents.newAntigravity' },
  { key: 'grok', title: GROK_TITLE, icon: 'grok.png', prefix: 'gk', commandId: 'agents.newGrok' },
  { key: 'kimi', title: KIMI_TITLE, icon: 'kimi.png', prefix: 'km', commandId: 'agents.newKimi' },
  { key: 'droid', title: DROID_TITLE, icon: 'droid.png', prefix: 'dr', commandId: 'agents.newDroid' }
];

export const BUILT_IN_AGENTS: BuiltInAgentDef[] = PRESENTED_AGENTS.map((p) => ({
  key: p.key,
  title: p.title,
  // The launch binary is the CLI registry's cliCommand — e.g. antigravity's is
  // `agy`, which the old hardcoded 'antigravity' entry got wrong.
  command: p.key === 'shell' ? '' : CLI_AGENT_META[p.key].cliCommand,
  icon: p.icon,
  prefix: p.prefix,
  commandId: p.commandId,
}));

// Agents the extension deliberately no longer registers a launch command for.
// Gemini is hard-deprecated — Antigravity is the replacement — so `agents.newGemini`
// is never registered (extension.ts) and the webview must not present or fire it.
// Retained only to reject stale persisted choices from older extension versions.
const DEPRECATED_AGENT_KEYS: ReadonlySet<string> = new Set(['gemini']);

// True when `key` names an agent the extension no longer offers a launch command
// for. A webview message that tries to spawn one must be refused with a clear
// warning, not fired at an unregistered command (which throws "command not found").
export function isDeprecatedAgentKey(key: string): boolean {
  const base = key.trim().toLowerCase().split('@')[0] ?? '';
  return DEPRECATED_AGENT_KEYS.has(base);
}

// Lookup built-in agent by key (e.g., "claude", "codex")
export function getBuiltInByKey(key: string): BuiltInAgentDef | undefined {
  return BUILT_IN_AGENTS.find(a => a.key === key);
}

// Lookup built-in agent by prefix (e.g., "cl", "cx")
export function getBuiltInByPrefix(prefix: string): BuiltInAgentDef | undefined {
  return BUILT_IN_AGENTS.find(a => a.prefix === prefix);
}

// Lookup built-in agent by title (e.g., "CL", "CX")
export function getBuiltInDefByTitle(title: string): BuiltInAgentDef | undefined {
  return BUILT_IN_AGENTS.find(a => a.title === title);
}

// The harness a terminal id (`<prefix>-<ts>-<n>`, generateTerminalId) names.
// Tabs from older versions carry the title (`CC-…`) where the prefix now goes.
// A custom agent's prefix is its own lowercased name, so it is its own kind.
export function agentKindFromTerminalId(terminalId: string): string {
  const head = terminalId.split('-')[0] ?? '';
  const def = getBuiltInByPrefix(head.toLowerCase()) ?? getBuiltInDefByTitle(head.toUpperCase());
  return def?.key ?? head.toLowerCase();
}

// Dispatch "mode" the panel offers: Plan (read-only), Auto (the unattended
// default — never stops to ask), Edit (accepts edits, still asks about risky
// shell operations). What Auto means is per-harness: a smart classifier that
// auto-approves safe operations on Claude/Copilot, and approval_policy=never
// over edit's sandbox on Codex. Note the ordering is NOT "auto is stricter than
// edit" — on Codex it is edit that prompts and auto that does not. We launch
// every agent through `agents run <agent>`, which has its OWN `--mode plan|auto|
// edit` flag and translates it to each CLI's native permission posture. So the
// flag is agent-AGNOSTIC — emitting the underlying `--permission-mode` directly
// would NOT reach the CLI (agents run only forwards raw native flags after a `--`
// separator), so Plan mode would silently fail to gate. `--mode <mode>` is the
// correct, supported flag for all agents.
export type AgentLaunchMode = 'plan' | 'auto' | 'edit';

const AGENTS_RUN_MODES: readonly AgentLaunchMode[] = ['plan', 'auto', 'edit'];

// Resolve the launch flag that puts an agent into `mode`; `agents run --mode` is universal.
export function modeFlagForAgent(mode: AgentLaunchMode): string | undefined {
  return AGENTS_RUN_MODES.includes(mode) ? `--mode ${mode}` : undefined;
}

// Version/account selection strategy passed to `agents run --strategy`. Mirrors
// the agents-cli: pinned uses the configured default, balanced rotates across
// healthy accounts. The CLI ignores --strategy when an @version is pinned.
export type RunStrategy = 'pinned' | 'available' | 'balanced';

// Build the `agents run <agent> --interactive [--mode <m>] […]` shell string for
// an interactive terminal launch. `mode` defaults to `'auto'` when the caller
// does not specify one — auto is the writable-but-gated posture that lets an
// interactive agent edit files without stalling for read-only plan approval.
// Callers that need plan mode (e.g. a dispatch that explicitly wants planning)
// must pass `'plan'` explicitly. A target's `cwd` is portable input for the
// CLI's `--cwd` rewrite; `remoteCwd` is an exact path already valid on `host`.
export function buildAgentLaunchCommand(
  agentKey: string,
  sessionId: string | null,
  defaultModel?: string,
  additionalFlags?: string,
  pinnedVersion?: string,
  strategy?: RunStrategy,
  mode?: AgentLaunchMode,
  target: {
    host?: string;
    local?: boolean;
    /** Emit the trailing-@ account picker after placement resolves. */
    accountPicker?: boolean;
    /** Portable local path for CLI `--cwd`; agents-cli re-roots it on `host`. */
    cwd?: string;
    /** Exact path already resolved on `host`; emitted verbatim as `--remote-cwd`. */
    remoteCwd?: string;
    /** A defined project's slug — the CLI resolves it to a cwd itself (local or on `host`). */
    project?: string;
  } = {},
): string {
  const { host, local = false, accountPicker = false, cwd, remoteCwd, project } = target;
  if (cwd && remoteCwd) {
    throw new Error('Agent launch target cannot combine portable cwd with exact remoteCwd');
  }
  // `--project` owns the working directory end-to-end (exec.ts's resolveRunCwd
  // hard-exits on `--project` + `--cwd`/`--remote-cwd`), so keep the two exclusive
  // by construction here too rather than emitting a command the CLI will reject.
  if (project && (cwd || remoteCwd)) {
    throw new Error('Agent launch target cannot combine project with cwd or remoteCwd');
  }
  if (accountPicker && pinnedVersion) {
    throw new Error('Agent launch cannot combine an account picker with a pinned version');
  }
  if (accountPicker && strategy) {
    throw new Error('Agent launch cannot combine an account picker with an automatic strategy');
  }
  const agentSpec = accountPicker
    ? `${agentKey}@`
    : pinnedVersion
      ? `${agentKey}@${pinnedVersion}`
      : agentKey;
  let command = `agents run ${agentSpec} --interactive`;
  // Offload onto another machine over SSH — the CLI resolves the device from
  // `agents devices` and runs interactive-on-host. Emitted for ANY agent so
  // grok/kimi/droid (which launch as raw binaries locally) get host parity.
  if (host) {
    command += ` --device ${shellQuote(host)}`;
    if (remoteCwd) command += ` --remote-cwd ${shellQuote(remoteCwd)}`;
  }
  // Bare interactive runs auto-place in the CLI. A hostless version pin keeps
  // its local placement intent; an explicit host takes precedence.
  if (!host) {
    command += local || pinnedVersion ? ' --local' : ' --device auto';
  }
  // Working directory is independent of placement and version selection. Local
  // and pinned launches need it too: the terminal's inherited process.cwd() can
  // differ from the active folder (and AGENT_WORKSPACE_DIR is only metadata).
  if (cwd) command += ` --cwd ${shellQuote(cwd)}`;
  // A picked project owns the working directory on ANY target — local, picked
  // host, or --device auto — so it is emitted once here rather than duplicated
  // in each branch above.
  if (project) {
    command += ` --project ${shellQuote(project)}`;
  }
  // `auto` may resolve to Claude, which then takes the id; any other pick ignores it.
  if (sessionId && (agentKey === 'claude' || agentKey === 'auto')) {
    command += ` --session-id ${sessionId}`;
  }
  // --strategy is meaningless (and ignored by the CLI) once a version is
  // pinned, so only emit it for the unpinned, strategy-driven launches.
  if (strategy && !pinnedVersion) {
    command += ` --strategy ${strategy}`;
  }
  if (defaultModel && (!additionalFlags || !additionalFlags.includes('--model'))) {
    command += ` --model ${defaultModel}`;
  }
  // Dispatch mode -> `agents run --mode plan|auto|edit`, next to --model/--strategy.
  // Default to 'auto' when the caller has no preference — interactive AGI EXT
  // launches must start in a writable posture so the agent can edit files.
  // Skip when the caller already threaded an explicit --mode via additionalFlags
  // so we never emit it twice.
  const effectiveMode: AgentLaunchMode = mode ?? 'auto';
  const modeFlag = modeFlagForAgent(effectiveMode);
  if (modeFlag && (!additionalFlags || !additionalFlags.includes('--mode'))) {
    command += ` ${modeFlag}`;
  }
  if (additionalFlags?.trim()) {
    command += ` ${additionalFlags.trim()}`;
  }
  return command;
}

/**
 * Wrap a native-mode agent launch command so the outcome decides whether the
 * tab closes, and so a lost `--device` connection reads as recoverable rather
 * than as a crash.
 *
 * The exit codes are set by `agents run --interactive --device` and mirrored
 * from `apps/cli/src/lib/hosts/reconnect.ts` (the ext is a separate package
 * with no cross-package import — root CLAUDE.md — so the values are duplicated
 * here with the source cited; the CLI-side constants are authoritative):
 *
 * - **0** — a clean quit (the user exited the agent, or it finished). The
 *   wrapper `exit`s the shell, which closes the VS Code tab automatically —
 *   mirroring the pane-died behaviour tmux mode already has.
 * - **255 / 254** — `SSH_CONN_FAILURE` / `REMOTE_EXIT_255_REMAPPED`: the SSH
 *   link to the peer dropped and the CLI's bounded reconnect loop then gave up,
 *   or the remote run ended unexpectedly. The agent may still be alive on the
 *   peer, so the wrapper frames it as a recoverable reconnect and points at the
 *   session list — not a bare "status 255" that reads like a crash (RUSH-3125,
 *   F6). It deliberately does NOT auto-run `agents run --resume`: a dead peer
 *   pane silently resumes a COPY and loses the in-flight turn, which is a real
 *   open bug (RUSH-3139), so recovery stays a deliberate user action until that
 *   lands. The `agents ps` roster is named rather than a specific id because
 *   only the CLI knows the resolved/launch id for a non-Claude harness, and its
 *   own give-up notice already printed the exact resume line above when one
 *   applies.
 * - **any other nonzero** — a launch failure (the remote host is unreachable at
 *   start, the CLI rejects the invocation, the binary is missing). There is no
 *   session to rejoin, so the generic status line stays.
 *
 * The line ends with the command's own status, so shell integration reports a
 * failed launch as failed (the fork tab's "fork failed: …", PHNX-4387).
 *
 * In every nonzero case the interactive shell is LEFT RUNNING so the text above
 * it stays on screen for the user to read (RUSH-2593: an `exec`-replaced process
 * died on a bad remote launch and the terminal closed before anyone could see
 * why).
 *
 * Shell tabs must NOT be wrapped: the user drives them interactively and
 * keeping the parent shell alive on any exit is the expected behaviour.
 */
export function wrapNativeAgentCommand(command: string, isShell: boolean): string {
  if (!command || isShell) return command;
  const reconnectMsg =
    'Lost the connection to the remote agent — it may still be running on the peer. Reconnect from:  agents ps';
  const genericMsg = 'Agent exited with status $ec — terminal kept open so you can read the error above.';
  return (
    `${command}; ec=$?; ` +
    `if [ "$ec" -eq 0 ]; then exit 0; ` +
    `elif [ "$ec" -eq 255 ] || [ "$ec" -eq 254 ]; then echo "${reconnectMsg}"; ` +
    `else echo "${genericMsg}"; fi; (exit $ec)`
  );
}

// The launch contract (apps/ext/AGENTS.md § "Launch contract"): EVERY agent
// runner launches through `agents run <agent> --interactive --mode auto`, on
// this machine, an auto-picked host, or a picked host alike. Account selection
// is supplied by the launch target: the default and Auto routes add
// `--strategy balanced`, while only Pick Host uses the trailing `@` picker. The
// only thing that is NOT a runner is 'shell' — a plain terminal, not an agent — so
// it is the single exclusion. There is deliberately no per-harness allowlist: a
// bare, strategy-less launch (into whatever account happens to be pinned) is never
// what we want.
export function isAgentRunner(agentKey: string): boolean {
  return agentKey !== 'shell';
}

