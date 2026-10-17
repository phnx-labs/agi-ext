import * as vscode from 'vscode';
import { BUILT_IN_AGENTS, getBuiltInByKey, getBuiltInDefByTitle, getBuiltInByPrefix, isAgentRunner, AgentLaunchMode, RunStrategy, buildAgentLaunchCommand, wrapNativeAgentCommand, isDeprecatedAgentKey } from '../core/agents';
import { shellQuote } from '../core/shellQuote';
import { readManagedProjects } from '../core/managedProjects';
import { cliResumeOutcome, decideSpawn, projectWindowResume, resumeSessionTab, spawnNonce, parseSpawnRequest, resolveSpawnSurface, SpawnAck, SpawnRequest, writeSpawnAck } from '../core/spawn';
import {
  buildNewAgentLaunchCommand,
  buildTabLaunchCommand,
  harnessLaunchRegistrations,
  resolveLaunchTarget,
  type NewAgentLaunchOpts,
} from '../core/launchTarget';
import {
  AgentConfig,
  buildIconPath,
  createAgentConfig,
  getBuiltInByTitle
} from './agents.vscode';
import * as claudemd from './claudemd.vscode';
import { AgentsMarkdownEditorProvider } from './customEditor';
import { AgentsHtmlReaderProvider } from './htmlReader';
import * as git from './git.vscode';
import { AgentSettings, hasLoginEnabled, PromptEntry, QUICK_LAUNCH_SLOT_KEYS, getQuickLaunchSlot, QuickLaunchSlot, QuickLaunchSlotKey } from '../core/settings';
import { listRegisteredDevices, getRegisteredDevicesCache } from './deviceHealth.vscode';
import { deviceBadge } from '../core/deviceName';
import { normalizeHost } from '../core/remoteSessions';
import * as settingsStore from './agentSettings.vscode';
import * as swarm from './swarm.vscode';
import * as terminals from './terminals.vscode';
import { LOCAL_LABEL, LOCAL_MACHINE_ID, remoteDeviceArg } from './remoteSessions.vscode';
import { sessionPresentationStore } from '../core/sessionPresentationStore';
import {
  planSessionTabLabelUpdate,
} from '../core/sessionTabLabelSync';
import { runRecapHeadless, isRecapSupported } from './recap.vscode';
import { buildAgentTerminalEnv } from '../core/terminals';
import { buildResumeInput } from '../core/resumeInBest';
import { runStaggered, RESTORE_MAX_CONCURRENCY, RESTORE_STAGGER_MS } from '../core/restoreThrottle';
import * as os from 'os';
import * as fsSync from 'fs';
import { randomUUID } from 'crypto';
import * as workbench from './workbench.vscode';
import { ensureSymlinksOnWorkspaceOpen, createSymlinksCodebaseWide } from './agentlinks.vscode';
import {
  initWorkspaceConfig,
  getActiveWorkspaceFolder,
  watchConfigFile,
  watchUserConfig,
} from './swarmifyConfig.vscode';
import {
  CLAUDE_TITLE,
  CODEX_TITLE,
  getExpandedAgentName,
  getTerminalDisplayInfo,
  parseTerminalName,
  sanitizeLabel,
  formatTerminalTitle,
  presentableLabel,
  getSessionChunk,
  truncateText,
  formatRelativeTime,
  TerminalIdentificationOptions,
  prefixToAgentType,
  SessionAgentType
} from '../core/utils';
import * as path from 'path';
import { spawn } from 'child_process';
import { DEFAULT_DISPLAY_PREFERENCES } from '../core/settings';
import * as readiness from './terminalReadiness';
import { resolveAlias, isAgentInstalled } from '../core/agentModels';
import { buildForkSessionRequest, forkCommand, forkFailed, forkTabLabel } from '../core/forkSession';
import { handleForkPickHost, registerForkPickHostCommand } from './forkCommands.vscode';
import { frontTerminal } from './frontTab.vscode';
import { streamTitle } from '../core/projectPanel';
import {
  buildSessionBrowserRows,
  cleanSessionTopic,
  formatSessionWhen,
  type BrowsableSession,
  type SessionBrowserSessionRow,
} from '../core/sessionBrowser';
import {
  handleForkPickedSession,
  loadBrowsableSessions,
  registerForkPickSessionCommand,
  runSessionBrowserPicker,
} from './sessionBrowser.vscode';
import { buildHarnessOptions } from '../core/resumeTarget';
import { fetchAgentInventories } from '../core/agentInventory';
import { resolveAgentsBin, AgentsBinNotFoundError } from '../core/agentsBin';

const AGENTS_CLI_INSTALL_CMD = 'npm install -g @phnx-labs/agents-cli';
let agentsCliPromptShown = false;

async function ensureAgentsCliInstalled(): Promise<void> {
  try {
    await resolveAgentsBin();
  } catch (err) {
    if (!(err instanceof AgentsBinNotFoundError) || agentsCliPromptShown) return;
    agentsCliPromptShown = true;
    const choice = await vscode.window.showInformationMessage(
      'Swarmify needs the agents CLI. Install it now?',
      { modal: false },
      'Install',
      'Later',
    );
    if (choice === 'Install') {
      const term = vscode.window.createTerminal({ name: 'Install agents-cli' });
      term.show();
      term.sendText(AGENTS_CLI_INSTALL_CMD);
    }
  }
}
import { agentTabShell, supportsPrewarming, inTabResumeCommand, exitSequenceFor } from '../core/prewarm';
import { liveWindows, restorePlan } from '../core/sessions.persist';
import { generateClaudeSessionId, listOpencodeSessions } from '../core/prewarm.simple';
import { canonicalSessionId } from '../core/canonicalSessionId';
import {
  activeMapCacheKey,
  isLocalActiveMapKey,
  needsSessionIdHydrate,
  fetchTerminalIdSessionMap,
  planSessionStreamRebinds,
} from '../core/sessionIdHydrate';
import {
  hydrateRemoteTabTick,
  planActiveMapHydration,
  type RemoteAutoLabelHooks,
} from '../core/remoteAutoLabel';
import { displayIdentity, formatAgentStatusBarText, formatAgentStatusBarTooltip, resolveStreamIdentityStamp } from '../core/statusIdentity';
import { getSessionPathBySessionId, getSessionPreviewInfo, getOpenCodeSessionPreviewInfo, getCursorSessionPreviewInfo } from './sessions.vscode';
import * as handoff from '../core/handoff';
import { decodeInjectQuery, selectInjectTarget } from '../core/inject';
import { runMonitorHostOnLeader } from '../monitor/host';

// Settings types are now imported from ./settings
// Settings functions are in ./agentSettings.vscode

let agentStatusBarItem: vscode.StatusBarItem | undefined;
let defaultAgentTitle: string = CLAUDE_TITLE;
let secondaryAgentTitle: string = CODEX_TITLE;

// BUILT_IN_AGENTS is now imported from ./agents

// Prompts helpers (file-based storage at ~/.swarmify/agents/prompts.yaml)
function getPrompts(): PromptEntry[] {
  return settingsStore.readPrompts();
}

function savePrompts(prompts: PromptEntry[]): void {
  settingsStore.writePrompts(prompts);
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function getDisplayPrefs(context: vscode.ExtensionContext) {
  return settingsStore.getSettings(context).display || DEFAULT_DISPLAY_PREFERENCES;
}

function buildTerminalTitle(
  prefix: string,
  label: string | undefined | null,
  context: vscode.ExtensionContext,
  sessionId?: string | null,
  isFocused?: boolean
): string {
  const display = getDisplayPrefs(context);
  const sessionChunk = display.showSessionIdInTitles ? getSessionChunk(sessionId || undefined) : null;
  return formatTerminalTitle(prefix, { label: label || undefined, display, sessionChunk, isFocused });
}

// PATH augmented with the agents shim dirs — the extension-host PATH can omit them,
// so a bare `agents` spawn would fail to resolve. Shared by the detached spawns below.
function agentsSpawnEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extraPath = [
    path.join(home, '.agents/.cache/shims'),
    path.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].join(':');
  return { ...process.env, PATH: `${extraPath}:${process.env.PATH ?? ''}` };
}

// Send the active agent terminal to the background: `agents ps detach <id>`
// stops its interactive process and continues it headless, then we close the tab.
// When the active terminal isn't an agent, fall back to a picker over the live agent tabs.
async function detachAgentToBackground(): Promise<void> {
  const active = vscode.window.activeTerminal;
  let sessionId: string | undefined;
  let target: vscode.Terminal | undefined;
  if (active && terminals.isAgentTerminal(active) && terminals.getSessionId(active)) {
    sessionId = terminals.getSessionId(active);
    target = active;
  } else {
    const candidates = vscode.window.terminals.filter(
      (t) => terminals.isAgentTerminal(t) && terminals.getSessionId(t),
    );
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('No live agent terminal to send to the background.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map((t) => ({
        label: `${terminals.getAgentType(t) ?? 'agent'} ${(terminals.getSessionId(t) ?? '').slice(0, 8)}`,
        detail: t.name,
        terminal: t,
      })),
      { placeHolder: 'Send which agent to the background?' },
    );
    if (!pick) return;
    sessionId = terminals.getSessionId(pick.terminal);
    target = pick.terminal;
  }
  if (!sessionId) {
    void vscode.window.showWarningMessage('That agent has no resolved session id yet — try again once it has started.');
    return;
  }
  const child = spawn('agents', ['ps', 'detach', sessionId], {
    detached: true,
    stdio: 'ignore',
    env: agentsSpawnEnv(),
  });
  child.unref();
  target?.dispose();
  void vscode.window.showInformationMessage(
    `Sent ${sessionId.slice(0, 8)} to the background — running headless. Bring it back with “Agents: Attach”.`,
  );
}

// Bring a backgrounded/parked agent to the foreground: pick from the CLI's
// active-session list (presence background/parked) and reopen it as a registered
// editor tab via the shared resume helper, so it resumes its real session there.
async function attachAgentFromBackground(): Promise<void> {
  const sessions = sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL)
    .filter((session) => session.host === LOCAL_LABEL);
  const backgrounded = sessions.filter((s) => s.presence === 'background' || s.presence === 'parked');
  if (backgrounded.length === 0) {
    void vscode.window.showInformationMessage('No backgrounded agents to bring forward. Send one back with “Agents: Detach”.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    backgrounded.map((s) => ({
      label: `${s.agentType || 'agent'} ${(s.sessionId || '').slice(0, 8)}`,
      description: s.presence,
      detail: s.topic || s.label,
      sessionId: s.sessionId,
    })),
    { placeHolder: 'Bring which agent to the foreground?' },
  );
  if (!pick?.sessionId) return;
  if (!extensionContext) return;
  await openAgentSessionTerminal(extensionContext, {
    id: pick.sessionId,
    shortId: pick.sessionId.slice(0, 8),
    agent: backgrounded.find((session) => session.sessionId === pick.sessionId)?.agentType || '',
  });
}

// --- Fleet-aware launch: routing belongs to agents-cli -----------------------
const BALANCED_HOST = 'balanced';

async function resolveSlotHost(slot: QuickLaunchSlot): Promise<string | undefined> {
  const target = slot.runOn?.trim();
  if (!target || target === 'local') return undefined;
  if (target === BALANCED_HOST) return 'auto';
  const devices = await listRegisteredDevices();
  const device = devices.find(row => normalizeHost(row.name) === normalizeHost(target));
  if (!device) {
    vscode.window.showWarningMessage(`Launch host "${target}" is not a registered device.`);
    return undefined;
  }
  return device.name;
}

async function pickLaunchHost(title = 'Run on…'): Promise<{ host?: string; cancelled: boolean }> {
  const devices = await listRegisteredDevices();
  const picked = await vscode.window.showQuickPick([
    { label: '$(vm) This Mac', description: 'Run locally', host: undefined as string | undefined },
    ...devices.map(device => ({
      label: `${device.online ? '$(radio-tower)' : '$(circle-slash)'} ${device.name}`,
      description: device.online ? 'online' : 'offline',
      host: device.name as string | undefined,
    })),
  ], { title, placeHolder: title });
  return picked ? { host: picked.host, cancelled: false } : { cancelled: true };
}

/**
 * The project quickpick behind `New <Harness> (Pick Project)`. It reuses the one
 * `agents projects list --json` consumer (readManagedProjects) rather than
 * re-shelling the CLI, and returns the picked project's slug — which launchAgent
 * threads through as `--project <slug>` so agents-cli owns the cwd on the
 * auto-picked worker. A `cancelled` return aborts the launch; an empty project
 * list surfaces a message and cancels rather than opening an agent with nowhere
 * to land.
 */
async function pickProjectSlug(): Promise<{ slug?: string; cancelled: boolean }> {
  let projects: Awaited<ReturnType<typeof readManagedProjects>>;
  try {
    projects = await readManagedProjects();
  } catch (e) {
    vscode.window.showErrorMessage(
      `Couldn't load your projects: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { cancelled: true };
  }
  if (projects.length === 0) {
    vscode.window.showInformationMessage('No projects defined yet. Define one with `agents projects add <name>`, then try again.');
    return { cancelled: true };
  }
  const picked = await vscode.window.showQuickPick(
    projects.map(project => ({
      label: `$(folder) ${project.name}`,
      description: project.description || project.repoSlug || '',
      slug: project.id,
    })),
    { title: 'Land the agent in project…', placeHolder: 'Pick a project (runs on an auto-selected worker)' },
  );
  return picked ? { slug: picked.slug, cancelled: false } : { cancelled: true };
}

// --- The one launch engine --------------------------------------------------
// Every "New agent" command routes through launchAgent. The command is just a
// route: it fills in whichever of {agentKey, host} the user pinned, and the
// engine resolves the rest. Only the Pick Host variant asks agents-cli to show
// the chosen device's account/version picker; the per-harness default and the
// (Auto) variant both use balanced rotation and never prompt.
/**
 * Everything a freshly created agent terminal needs beyond `createTerminal`.
 *
 * This is the half that #2534 dropped from `launchAgent`: registration is what
 * makes a tab visible to Copy Session ID / Resume / Handoff / Fork, and what
 * schedules the persistence that restores it after a window reload. It lives in
 * one place so the two creation paths cannot drift again.
 */
async function registerAgentTerminal(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext,
  args: {
    terminalId: string;
    agentConfig: Omit<AgentConfig, 'count'>;
    agentKey?: string;
    recoveryAgent?: string;
    sessionId?: string | null;
    host?: string | null;
    pinnedVersion?: string | null;
  }
): Promise<void> {
  const { terminalId, agentConfig, agentKey, recoveryAgent, sessionId, host, pinnedVersion } = args;
  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);

  const resumeKey = agentKey ? agentKeyFromSession(agentKey) : null;
  if (resumeKey) {
    terminals.setAgentType(terminal, resumeKey);
  }
  if (recoveryAgent) {
    terminals.setRecoveryAgent(terminal, recoveryAgent);
  }
  // Stamp the host BEFORE the label poller starts: the poller reads the entry
  // to decide whether to look the session up locally or over `--device`.
  if (host) {
    terminals.setHost(terminal, host);
  }
  if (sessionId) {
    terminals.setSessionId(terminal, sessionId);
    if (resumeKey) {
      startAutoLabelPollerForTerminal(terminal, context);
    }
  } else if (host && resumeKey) {
    // Idless remote runner: only Claude's id is minted up front, so a
    // picked-host Codex launches with none and the local SessionStart watcher
    // never fires for it. The poller resolves the canonical id from the shared
    // per-host active map instead (RUSH-2411).
    startAutoLabelPollerForTerminal(terminal, context, { fast: true });
  }
  if (pinnedVersion) {
    terminals.setVersion(terminal, pinnedVersion);
  }
}

async function launchAgent(context: vscode.ExtensionContext, opts: NewAgentLaunchOpts = {}): Promise<void> {
  let host = opts.host;
  if (opts.pickHost) {
    const picked = await pickLaunchHost('New agent — run on…');
    if (picked.cancelled) return;
    host = picked.host;
  }
  // (Pick Project): the only prompt is the project quickpick — no host prompt.
  // A cancel (or an empty/failed project list) aborts the launch entirely.
  let pickedProjectSlug: string | undefined;
  if (opts.pickProject) {
    const picked = await pickProjectSlug();
    if (picked.cancelled) return;
    pickedProjectSlug = picked.slug;
  }
  const automatic = !opts.agentKey;
  const cwd = getActiveWorkspaceFolder()?.uri.fsPath;
  const builtIn = opts.agentKey ? getBuiltInByKey(opts.agentKey) : undefined;

  // An automatic launch has no harness yet — the CLI picks it — but the tab must
  // still be a tracked terminal, so it registers against the `shell` def and
  // shell adoption upgrades the entry once the runner announces itself. That is
  // the same fallback spawnCommandTerminal uses. Registering only when the agent
  // is known would leave `agents.newAgent` (the flagship command) unregistered
  // and, worse, silently unreadied: sendCommandWhenReady rejects without a
  // readiness registration and the launch line gets typed into a prompt-less
  // shell.
  const def = builtIn ?? getBuiltInByKey('shell');
  if (!def) return;
  const agentConfig = createAgentConfig(
    context.extensionPath, def.title, def.command, def.icon, def.prefix,
  );

  const defaultModel = builtIn
    ? settingsStore.getDefaultModel(context, builtIn.key as Parameters<typeof settingsStore.getDefaultModel>[1])
    : undefined;
  // `--project` owns the working directory end-to-end, so only an explicit
  // (Pick Project) choice may supply it. `projects view <cwd>` is a containment
  // attribution lookup, not a launch decision: at a shared monorepo root more
  // than one child project can match, and converting that result to --project
  // discards the exact workspace cwd and lands in the child's defaultPath.
  const projectSlug = pickedProjectSlug;
  // "Local" must cover BOTH an explicit `local: true` (the per-harness New X
  // commands) and a Pick Host prompt the user answered with "This Mac", which
  // returns no host. Passing plain `opts.local` there leaves it undefined, the
  // builder's `local = false` default fires `--device auto`, and a deliberate
  // This-Mac pick silently dispatches to another box.
  //
  // Everything else means "choose a machine for me", which is what
  // `--device auto` is for, so it must NOT be treated as local. Device choice
  // stays with the CLI rather than being scored here, per the thin-client contract.
  const isLocal = opts.local === true || (opts.pickHost === true && !host);
  // Mint Claude's session id up front, exactly as openSingleAgent does (see the
  // docblock there). Without it launchAgent emitted no `--session-id`, so a LOCAL
  // New Claude — the flagship `agents.newClaude` command — armed neither auto-label
  // branch in registerAgentTerminal (no sessionId, no host) and the tab kept its bare
  // prefix until something else hydrated it (PHNX-2553). Id-minting now lives on both
  // creation paths so they cannot drift again.
  const sessionId = opts.agentKey === 'claude' ? generateClaudeSessionId() : undefined;
  const command = buildNewAgentLaunchCommand(
    { ...opts, host, local: isLocal },
    { defaultModel, projectSlug, cwd, sessionId },
  );

  // Tab identity must be established AT createTerminal: iconPath and name are
  // frozen there (no setter), and AGENT_TERMINAL_ID is the join key the CLI's
  // `sessions --active` rows carry back — without it the status bar can never
  // resolve a session id. Shell adoption cannot repair any of it later; it only
  // rewrites the internal registry, never the live terminal.
  const terminalId = terminals.nextId(agentConfig.prefix);
  // Registering an automatic launch under the `shell` def is a REGISTRY choice
  // (adoption re-keys it later); it does not make the tab a user shell. Only a
  // real `New Shell` is one. Conflating the two would declare
  // `scrubSensitive: false` / `kind: 'shell'` on a tab that is about to run an
  // agent, which is the opposite of the policy in core/terminals.ts.
  const isUserShell = opts.agentKey === 'shell';
  const terminal = vscode.window.createTerminal({
    name: automatic ? 'Agents Auto' : buildTerminalTitle(agentConfig.title, undefined, context, sessionId ?? null),
    iconPath: agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    env: buildAgentTerminalEnv(terminalId, sessionId, cwd, undefined, {
      scrubSensitive: !isUserShell,
      kind: isUserShell ? 'shell' : 'agent',
    }),
    isTransient: true,
  });
  terminal.show(false);
  await registerAgentTerminal(terminal, context, {
    terminalId,
    agentConfig,
    agentKey: opts.agentKey,
    sessionId,
    host,
  });
  // The harness is unknown until the runner starts, so let adoption re-key the
  // entry to the real agent the CLI picked.
  if (automatic) armShellAdoptionForTerminal(terminal, context);
  await sendCommandWhenReady(terminal, command);
  if (opts.agentKey) {
    // Arm agentReady detection, the process-state probe (matching openSingleAgent).
    readiness.armAgentReady(terminal);
  }
}

// Terminal readiness detection moved to src/vscode/terminalReadiness.ts.
// All spawn/resume flows now call readiness.waitFor(t, 'promptReady') instead.

/**
 * Detect OpenCode session ID after spawn by comparing session lists.
 * OpenCode creates its own session IDs (ses_xxx format) internally.
 * This runs asynchronously and updates the terminal entry when found.
 */
async function detectOpencodeSessionId(
  terminal: vscode.Terminal,
  cwd: string,
  sessionsBefore: string[],
  context: vscode.ExtensionContext
): Promise<void> {
  // Wait for OpenCode to start and create a session
  await new Promise(resolve => setTimeout(resolve, 3000));

  const sessionsAfter = await listOpencodeSessions(cwd);
  if (!sessionsAfter || sessionsAfter.length === 0) {
    console.log(`[PREWARM] OpenCode: No sessions found after spawn`);
    return;
  }

  // Find new session (in sessionsAfter but not in sessionsBefore)
  const beforeSet = new Set(sessionsBefore);
  const newSessions = sessionsAfter.filter(id => !beforeSet.has(id));

  let sessionId: string | null = null;
  if (newSessions.length === 1) {
    sessionId = newSessions[0];
  } else if (newSessions.length > 1) {
    // Multiple new sessions - take the first one (most recent based on list order)
    sessionId = newSessions[0];
  } else {
    // No new sessions - take the most recent from after list
    sessionId = sessionsAfter[0];
  }

  if (sessionId) {
    console.log(`[PREWARM] OpenCode detected session ID: ${sessionId}`);
    terminals.setSessionId(terminal, sessionId);
    terminals.setAgentType(terminal, 'opencode');
    // Update terminal title to include session ID
    updateStatusBarForTerminal(terminal, context.extensionPath);
    startAutoLabelPollerForTerminal(terminal, context);
  }
}

async function updateTerminalTitleOnFocus(
  newTerminal: vscode.Terminal | undefined,
  context: vscode.ExtensionContext
): Promise<void> {
  const display = getDisplayPrefs(context);

  // Only update titles if showLabelOnlyOnFocus is enabled
  if (!display.showLabelOnlyOnFocus) {
    return;
  }

  // Update the newly focused terminal's title (with label)
  if (newTerminal) {
    const entry = terminals.getByTerminal(newTerminal);
    if (entry?.agentConfig) {
      const newTitle = buildTerminalTitle(
        entry.agentConfig.prefix,
        entry.label,
        context,
        entry.sessionId,
        true  // isFocused = true
      );
      await terminals.renameTerminal(newTerminal, newTitle);
    }
  }

  // NOTE: we deliberately do NOT rename the previously-focused tab here. Renaming
  // a tab that is no longer active would require focusing it (renameWithArg only
  // hits the active terminal), which steals focus back to a tab the user just
  // left — the self-sustaining hop of #3019. The tab that lost focus keeps its
  // current title; the newly-focused tab (renamed above, while it is active) is
  // the only one we touch.
}

interface PromptQuickPickItem extends vscode.QuickPickItem {
  entry?: PromptEntry;
  isAddNew?: boolean;
}

async function showPrompts(): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('No active terminal');
    return;
  }

  const parsed = parseTerminalName(terminal.name);
  if (!parsed.isAgent) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  const prompts = getPrompts();

  // Sort: favorites first, then by accessedAt descending (most recently used first)
  const sorted = [...prompts].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return b.accessedAt - a.accessedAt;
  });

  const quickPick = vscode.window.createQuickPick<PromptQuickPickItem>();
  quickPick.placeholder = 'Search prompts...';
  quickPick.matchOnDescription = true;

  const buildItems = (): PromptQuickPickItem[] => {
    const items: PromptQuickPickItem[] = sorted.map(entry => ({
      label: `${entry.isFavorite ? '$(star-full) ' : ''}${entry.title}`,
      description: truncateText(entry.content, 50),
      detail: entry.content,
      entry,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon(entry.isFavorite ? 'star-full' : 'star-empty'),
          tooltip: entry.isFavorite ? 'Remove from favorites' : 'Add to favorites'
        },
        {
          iconPath: new vscode.ThemeIcon('trash'),
          tooltip: 'Delete prompt'
        }
      ]
    }));

    items.push({
      label: '$(add) Add new prompt',
      isAddNew: true
    });

    return items;
  };

  quickPick.items = buildItems();

  quickPick.onDidTriggerItemButton(async (e) => {
    const item = e.item;
    if (!item.entry) return;

    const buttonIndex = (quickPick.items.find(i => i.entry?.id === item.entry?.id) as PromptQuickPickItem)
      ?.buttons?.indexOf(e.button);

    if (buttonIndex === 0) {
      // Toggle favorite
      item.entry.isFavorite = !item.entry.isFavorite;
      item.entry.updatedAt = Date.now();
      savePrompts(prompts);
      // Re-sort and rebuild items
      sorted.sort((a, b) => {
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
        return b.accessedAt - a.accessedAt;
      });
      quickPick.items = buildItems();
    } else if (buttonIndex === 1) {
      // Delete
      const idx = prompts.findIndex(p => p.id === item.entry?.id);
      if (idx !== -1) {
        prompts.splice(idx, 1);
        const sortedIdx = sorted.findIndex(p => p.id === item.entry?.id);
        if (sortedIdx !== -1) sorted.splice(sortedIdx, 1);
        savePrompts(prompts);
        quickPick.items = buildItems();
      }
    }
  });

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected) return;

    quickPick.hide();

    if (selected.isAddNew) {
      // Add new prompt flow
      const title = await vscode.window.showInputBox({
        prompt: 'Prompt title',
        placeHolder: 'e.g., Debug Helper'
      });
      if (!title) return;

      const content = await vscode.window.showInputBox({
        prompt: 'Prompt content',
        placeHolder: 'Enter the prompt text...'
      });
      if (!content) return;

      const now = Date.now();
      const newEntry: PromptEntry = {
        id: generateId(),
        title,
        content,
        isFavorite: false,
        createdAt: now,
        updatedAt: now,
        accessedAt: now
      };

      prompts.push(newEntry);
      savePrompts(prompts);
      vscode.window.showInformationMessage(`Added "${title}" to Prompts`);
    } else if (selected.entry) {
      // Update accessedAt and paste to terminal (no auto-execute)
      selected.entry.accessedAt = Date.now();
      savePrompts(prompts);
      terminal.sendText(selected.entry.content, false);
      terminal.show();
    }
  });

  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

function getAgentsToOpen(context: vscode.ExtensionContext): AgentConfig[] {
  const agentSettings = settingsStore.getSettings(context);
  const extensionPath = context.extensionPath;
  const agents: AgentConfig[] = [];

  // Built-in agents
  for (const def of BUILT_IN_AGENTS) {
    const config = agentSettings.builtIn[def.key as keyof AgentSettings['builtIn']];
    if (config.login && config.instances > 0) {
      agents.push({ ...createAgentConfig(extensionPath, def.title, def.command, def.icon, def.prefix), count: config.instances });
    }
  }

  // Custom agents
  for (const custom of agentSettings.custom) {
    if (custom.login && custom.instances > 0) {
      agents.push({
        ...createAgentConfig(extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase()),
        count: custom.instances
      });
    }
  }

  return agents;
}

// getBuiltInByTitle is now imported from ./agents.vscode

interface AgentTerminalInfo {
  isAgent: boolean;
  prefix: string | null;
  label: string | null;
  iconPath: vscode.IconPath | null;
}

/**
 * Extract identification options from a VS Code terminal.
 */
function extractTerminalIdentificationOptions(terminal: vscode.Terminal): TerminalIdentificationOptions {
  const opts = terminal.creationOptions as vscode.TerminalOptions;
  const env = opts?.env;
  const terminalId = env ? env['AGENT_TERMINAL_ID'] : undefined;

  // Extract icon filename from iconPath
  let iconFilename: string | null = null;
  if (opts?.iconPath) {
    const icon: any = opts.iconPath;
    if (icon instanceof vscode.Uri) {
      iconFilename = path.basename(icon.fsPath);
    } else if (icon && typeof icon === 'object') {
      // Handle { light: Uri; dark: Uri } shape
      const candidate = icon.light ?? icon.dark ?? icon;
      if (candidate instanceof vscode.Uri || (candidate && typeof candidate.fsPath === 'string')) {
        iconFilename = path.basename(candidate.fsPath);
      }
    }
  }

  return {
    name: terminal.name,
    terminalId: terminalId as string | undefined,
    iconFilename
  };
}

function identifyAgentTerminal(terminal: vscode.Terminal, extensionPath: string): AgentTerminalInfo {
  // First check terminals module state
  const entry = terminals.getByTerminal(terminal);
  if (entry && entry.agentConfig) {
    return {
      isAgent: true,
      prefix: entry.agentConfig.title,
      label: entry.label ?? null,
      iconPath: buildIconPath(entry.agentConfig.title, extensionPath)
    };
  }

  // Fall back to central identification function with all available inputs
  const identOpts = extractTerminalIdentificationOptions(terminal);
  const info = getTerminalDisplayInfo(identOpts);
  if (info.isAgent && info.prefix) {
    return {
      isAgent: true,
      prefix: info.prefix,
      label: info.label,
      iconPath: buildIconPath(info.prefix, extensionPath)
    };
  }

  return { isAgent: false, prefix: null, label: null, iconPath: null };
}

function getAgentConfigFromTerminal(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext
): Omit<AgentConfig, 'count'> | null {
  const info = identifyAgentTerminal(terminal, context.extensionPath);

  if (!info.isAgent || !info.prefix) {
    // Check custom agents by name
    const terminalName = terminal.name.trim();
    const agentSettings = settingsStore.getSettings(context);
    for (const custom of agentSettings.custom) {
      if (terminalName === custom.name || terminalName.startsWith(`${custom.name} - `)) {
        return createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase());
      }
    }
    return null;
  }

  // Check built-in agents
  const builtIn = getBuiltInDefByTitle(info.prefix);
  if (builtIn) {
    return createAgentConfig(context.extensionPath, builtIn.title, builtIn.command, builtIn.icon, builtIn.prefix);
  }

  // Check custom agents
  const agentSettings = settingsStore.getSettings(context);
  for (const custom of agentSettings.custom) {
    if (info.prefix === custom.name) {
      return createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase());
    }
  }

  return null;
}

// Settings functions are now in ./agentSettings.vscode

// scanExistingEditorTerminals is now terminals.scanExisting()

// Infer agent config from terminal name for scan
function inferAgentConfigFromName(name: string, extensionPath: string, knownPrefix?: string | null): Omit<AgentConfig, 'count'> | null {
  // Build identification options - when called from scanExisting, we may have a knownPrefix
  const identOpts: TerminalIdentificationOptions = { name };
  // If we have a knownPrefix from the env var extraction, we can reconstruct a terminalId pattern
  // to trigger the terminalId fallback strategy
  if (knownPrefix) {
    identOpts.terminalId = `${knownPrefix}-0`; // Fake ID just to trigger the strategy
  }

  const info = getTerminalDisplayInfo(identOpts);
  if (!info.isAgent || !info.prefix) return null;

  const def = getBuiltInDefByTitle(info.prefix);
  if (def) {
    return createAgentConfig(extensionPath, def.title, def.command, def.icon, def.prefix);
  }
  return null;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('Cursor Agents extension is now active');

  // Store context for deactivate
  extensionContext = context;

  // Prompt to install agents-cli if missing. Don't block activation —
  // resolveAgentsBin runs in the background; if it throws AgentsBinNotFoundError
  // we surface a notification with a one-click installer.
  void ensureAgentsCliInstalled();

  // Initialize terminal readiness event tracking (shell integration + close cleanup)
  readiness.initReadiness(context);

  // Cross-window live-terminal registry: every VS Code window publishes its
  // agent terminals to ~/.agents/.cache/terminals/live-terminals.json, which
  // agents-cli reads to find the tab showing a session.
  initTerminalRegistry(context);

  // Elect exactly one "monitor" owner across all open IDE windows (epic #64,
  // foundation #65). The winner will own the heavy global probes/watches in
  // later migration issues; for now it just holds a renewable lease so the rest
  // of the stack can gate on isLeader(). Re-elects automatically on takeover.
  initMonitorLeader(context);

  // Monitor runtime (#67): the leader runs the broadcast host; EVERY window runs
  // a thin follower that reports its terminal tuples to the monitor and resolves
  // broadcast facts back to its own terminals. Migrations #68-71 move the heavy
  // probes/watchers/panel behind this gate; they are NOT moved here.
  initMonitorHost(context);
  initMonitorFollower(context);

  // Activity-bar sidebar that always reflects the currently focused agent
  // terminal: title, version, label, cwd, PLAN.md, and any teams running in
  // this directory. Lazy-resolves when the user clicks the activity-bar icon.
  const { registerAgentPanel } = require('./agentPanel.vscode') as typeof import('./agentPanel.vscode');
  registerAgentPanel(context);

  // Left-sidebar Project container: Overview, Sessions, Pull requests, Tickets for
  // the workspace's project (PHNX-4289). Reads run on reveal; Sessions redraws from
  // the store on stream facts.
  const { registerProjectPanel } = require('./projectPanel.vscode') as typeof import('./projectPanel.vscode');
  registerProjectPanel(context);

  // The Lead, docked: ⌥Space overlay, status-bar last update, the Lead tab.
  const { registerLead } = require('./lead.vscode') as typeof import('./lead.vscode');
  registerLead(context);

  // Create status bar item for showing active terminal status bar label
  agentStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  agentStatusBarItem.text = 'Agents';
  agentStatusBarItem.command = 'agents.sessionId';
  agentStatusBarItem.tooltip = undefined;
  agentStatusBarItem.show();
  context.subscriptions.push(agentStatusBarItem);

  // Scan existing terminals in the editor area to register any agent terminals
  // Then restore persisted sessions with proper icons/titles
  terminals.scanExisting(
    (name, knownPrefix) => inferAgentConfigFromName(name, context.extensionPath, knownPrefix),
    context,
    (terminal) => startAutoLabelPollerForTerminal(terminal, context)
  )
    .then(() => restoreAgentTerminals(context))
    .then(() => {
      // Adopt any SH terminals that are already running an agent CLI
      // (e.g. user launched claude before reload).
      for (const entry of terminals.getAllTerminals()) {
        if (entry.agentConfig?.prefix === 'sh') {
          armShellAdoptionForTerminal(entry.terminal, context);
        }
      }
    })
    .catch(err => {
      console.error('[EXTENSION] Error scanning/restoring terminals:', err);
    });

  // Register terminals that appear after activation (e.g., restored sessions)
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(async (terminal) => {
      // Already tracked?
      if (terminals.getByTerminal(terminal)) {
        return;
      }

      // Use central identification with all available inputs
      const identOpts = extractTerminalIdentificationOptions(terminal);
      const info = getTerminalDisplayInfo(identOpts);
      if (!info.isAgent || !info.prefix) {
        return;
      }

      const agentConfig = inferAgentConfigFromName(terminal.name, context.extensionPath, info.prefix);
      if (!agentConfig) {
        return;
      }

      const id = identOpts.terminalId || terminals.nextId(info.prefix);
      let pid: number | undefined;
      try {
        pid = await terminal.processId;
      } catch {
        // ignore
      }

      terminals.register(terminal, id, agentConfig, pid, context, info.label || undefined);
      readiness.registerTerminal(terminal, { restored: true });

      const agentType = prefixToAgentType(info.prefix);
      if (agentType) {
        // Register the agent type even when sessionId is missing so
        // sessionTracker can adopt a fresh session file later.
        terminals.setAgentType(terminal, agentType);
      }

      const persisted = terminals.loadPersistedSessions().find((session) => session.terminalId === id);
      const restoredId = terminals.restoredSessionId(identOpts.sessionId, persisted);
      if (restoredId !== undefined) {
        terminals.setSessionId(terminal, restoredId);
        if (agentType) {
          startAutoLabelPollerForTerminal(terminal, context);
        }
      }

      const restoredEntry = terminals.getByTerminal(terminal);
      if (restoredEntry) restoredEntry.manualSessionOverride = persisted?.manualSessionOverride;

      if (info.prefix === 'SH') {
        armShellAdoptionForTerminal(terminal, context);
      }
    })
  );

  // Ensure CLAUDE.md has Swarm instructions if Swarm is enabled
  claudemd.ensureSwarmInstructions();

  // Ensure symlinks exist for workspaces with .agents config
  for (const folder of vscode.workspace.workspaceFolders || []) {
    ensureSymlinksOnWorkspaceOpen(folder).catch(err => {
      console.error('[agents] Error ensuring symlinks:', err);
    });
  }

  // Watch for .agents config changes
  watchConfigFile(context, (workspaceFolder) => {
    ensureSymlinksOnWorkspaceOpen(workspaceFolder).catch(err => {
      console.error('[agents] Error ensuring symlinks on config change:', err);
    });
  });

  // Watch for user-level .agents config changes
  watchUserConfig(context, () => {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      ensureSymlinksOnWorkspaceOpen(folder).catch(err => {
        console.error('[agents] Error ensuring symlinks on user config change:', err);
      });
    }
  });

  // Register URI handler for notification callbacks
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const params = new URLSearchParams(uri.query);

        if (uri.path === '/lead') {
          // vscode://swarmify.swarm-ext/lead: the Lead tab (FastWispr's "Open conversation").
          await vscode.commands.executeCommand('agents.lead.open');
        } else if (uri.path === '/focus') {
          const terminalId = params.get('terminalId');
          const entry = terminalId ? terminals.getById(terminalId) : undefined;
          if (entry) {
            entry.terminal.show();
          }
        } else if (uri.path === '/inject') {
          // External nudge: an outside process (agents-cli) delivers text into a
          // live integrated terminal by session id. Payload is base64url-JSON in
          // the single `p` query param. Malformed input logs + returns, never throws.
          const payload = decodeInjectQuery(uri.query);
          if (!payload) {
            console.warn('[INJECT] Ignoring malformed inject URI (bad or missing `p` payload)');
            return;
          }

          const all = terminals.getAllTerminals();
          const target = selectInjectTarget(all, payload.terminalId);
          if (!target) {
            const known = all.map((t) => t.sessionId).filter(Boolean).join(', ');
            console.warn(
              `[INJECT] No live terminal for id ${payload.terminalId}. Active sessions: ${known}`
            );
            return;
          }

          try {
            if (payload.enter === false) {
              // Text only, no submit.
              target.terminal.sendText(payload.text, false);
            } else if (payload.combined) {
              // Single write with the carriage return appended.
              target.terminal.sendText(payload.text + '\r', false);
            } else {
              // Ink-safe default: two writes so Claude's TUI sees Enter alone.
              target.terminal.sendText(payload.text, false);
              target.terminal.sendText('\r', false);
            }
            console.log(
              `[INJECT] Delivered to ${target.id} (session ${target.sessionId ?? 'unknown'}): "${payload.text.slice(0, 80)}${payload.text.length > 80 ? '…' : ''}"`
            );
          } catch (err) {
            console.error(
              `[INJECT] Failed to deliver to ${target.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        // /spawn — open an agent terminal in an editor tab running the supplied
        // command (e.g. `claude --resume <id>`). Used by the agents-cli terminal
        // engine's `vscodium-agent` backend to resume sessions into this editor.
        if (uri.path === '/spawn') {
          const req = parseSpawnRequest(uri.query);
          if (req) {
            await spawnCommandTerminal(context, req);
          } else {
            const nonce = spawnNonce(uri.query);
            if (nonce) {
              try {
                writeSpawnAck({
                  nonce, status: 'failed', windowFolders: terminals.windowFolders(),
                  workspaceName: vscode.workspace.name ?? null, terminalId: null, title: null,
                  sessionId: null, pid: null, reason: 'the request has no command to run', at: Date.now(),
                });
              } catch (err) {
                console.error('[SPAWN] Failed to write ack', err);
              }
            }
          }
        }
      }
    })
  );

  // Register custom markdown + HTML readers
  try {
    context.subscriptions.push(
      AgentsMarkdownEditorProvider.register(context)
    );
  } catch (error) {
    // Editor already registered (hot reload) - continue activation
    console.log('Custom markdown editor already registered, continuing...');
  }
  try {
    context.subscriptions.push(AgentsHtmlReaderProvider.register(context));
  } catch (error) {
    console.log('Custom HTML reader already registered, continuing...');
  }

  try {
    const currentSettings = settingsStore.getSettings(context);
    await workbench.setMarkdownEditorAssociation(
      currentSettings.editor?.markdownViewerEnabled ?? true
    );
  } catch (error) {
    console.error('Failed to apply markdown editor association:', error);
  }

  // Load cached default agents if set
  const storedDefault = context.globalState.get<string>('agents.defaultAgentTitle');
  if (storedDefault) {
    defaultAgentTitle = storedDefault;
  }
  const storedSecondary = context.globalState.get<string>('agents.secondaryAgentTitle');
  if (storedSecondary) {
    secondaryAgentTitle = storedSecondary;
  } else {
    secondaryAgentTitle = CODEX_TITLE;
    context.globalState.update('agents.secondaryAgentTitle', CODEX_TITLE);
  }

  // Set initial context keys and subscribe to config changes
  await updateContextKeys(context);
  updateActiveAgentContextKey(vscode.window.activeTerminal, context.extensionPath);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('agents')) {
        await updateContextKeys(context);
      }
    })
  );

  // Run lightweight first-setup if needed
  await maybeRunFirstSetup(context);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.open', () => openAgentTerminals(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.openAgent', () => goToTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.cycleNextTerminal', () => cycleAgentTerminal(1))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.cyclePrevTerminal', () => cycleAgentTerminal(-1))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.reopenLastSession', () => reopenLastClosedSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.detach', () => detachAgentToBackground())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.attach', () => attachAgentFromBackground())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.settings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:agents');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgent', () => launchAgent(context, {}))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newSecondaryAgent', async () => {
      const targetTitle = secondaryAgentTitle || defaultAgentTitle;
      const targetDef = getBuiltInDefByTitle(targetTitle);
      let agentConfig: Omit<AgentConfig, 'count'> | null = getBuiltInByTitle(context.extensionPath, targetTitle);
      if (targetDef?.key && !(await isAgentInstalled(targetDef.key))) {
        agentConfig = null;
      }
      if (!agentConfig) {
        agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      }
      if (agentConfig) {
        openSingleAgent(context, agentConfig);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgentHSplit', async () => {
      // Create horizontal split (new editor group below current)
      await vscode.commands.executeCommand('workbench.action.splitEditorDown');

      // Open default agent in the new (active) group
      const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      if (agentConfig) {
        openSingleAgent(context, agentConfig);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgentVSplit', async () => {
      // Create vertical split (new editor group to the side)
      await vscode.commands.executeCommand('workbench.action.splitEditor');

      // Open default agent in the new (active) group
      const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
      if (agentConfig) {
        openSingleAgent(context, agentConfig);
      }
    })
  );

  // Persist the primary/secondary agent titles the Project panel's Settings tab
  // picks (projectPanel.vscode.ts), and getDefaultAgent/getSecondaryAgent read them back
  // from the SAME globalState keys — so each command MUST write both the
  // module-level variable (so an in-window launch sees the change without a
  // reload) and globalState under the exact key the reads use. Without these
  // registrations the webview fired an unregistered command → "command not
  // found" toast, and the slot title never changed (PHNX-3249).
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setDefaultAgentTitle', async (title?: string) => {
      if (typeof title !== 'string' || !title.trim()) return;
      defaultAgentTitle = title;
      await context.globalState.update('agents.defaultAgentTitle', title);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setSecondaryAgentTitle', async (title?: string) => {
      if (typeof title !== 'string' || !title.trim()) return;
      secondaryAgentTitle = title;
      await context.globalState.update('agents.secondaryAgentTitle', title);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setTitle', () => renameFrontSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.clear', () => clearActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.reload', () => reloadActiveTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.autogit', git.generateCommitMessage)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.prompts', showPrompts)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setupClaude', () => swarm.setupSwarmIntegrationForAgent('claude', context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setupCodex', () => swarm.setupSwarmIntegrationForAgent('codex', context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.enableReader', async () => {
      const current = settingsStore.getSettings(context);
      const next: AgentSettings = {
        ...current,
        editor: { ...(current.editor ?? { markdownViewerEnabled: true }), markdownViewerEnabled: true }
      };
      await settingsStore.saveSettings(context, next);
      vscode.window.showInformationMessage(
        'Agents Reader enabled. .md opens in the Notion-style editor; .html opens as a rendered preview.'
      );
      await updateContextKeys(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.disableReader', async () => {
      const current = settingsStore.getSettings(context);
      const next: AgentSettings = {
        ...current,
        editor: { ...(current.editor ?? { markdownViewerEnabled: true }), markdownViewerEnabled: false }
      };
      await settingsStore.saveSettings(context, next);
      vscode.window.showInformationMessage(
        'Agents Reader disabled. .md and .html open in the default text editor.'
      );
      await updateContextKeys(context);
    })
  );


  context.subscriptions.push(
    vscode.commands.registerCommand('agents.askAnotherAgent', () => askAnotherAgentFromTerminal(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.spawnWithPrompt', async (args?: { agent?: string; prompt?: string }) => {
      await spawnWithPrompt(context, args);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.spawnWithContext', async () => {
      await spawnWithContext(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.forkCurrentSession', () => forkCurrentSession(context))
  );

  context.subscriptions.push(registerForkPickHostCommand(
    vscode.commands.registerCommand,
    () => forkCurrentSession(context, { pickHost: true }),
  ));

  context.subscriptions.push(
    registerForkPickSessionCommand(vscode.commands.registerCommand, () => forkPickedSession(context))
  );

  // Now an alias of Fork: the `agents fork` verb is always recap-seeded,
  // so there is no separate non-recap fork. Kept as a distinct command because the
  // user actively invokes Fork (Recap).
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.forkRecap', () => forkCurrentSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.handoff', () => handoffToAgent(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.closeWithRecap', () => closeActiveAgentWithRecap(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.continueInNew', () => continueInNewSession(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.continueFromSelection', () => continueFromSelection(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.sessionTrace', () => copySessionTrace(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.setSessionId', async (args?: { terminalId?: string }) => {
      const entry = await terminals.promptSessionId(args);
      if (!entry) return;
      applyHydratedSessionId(entry.terminal, entry, entry.agentConfig?.prefix ?? '', entry.sessionId!, { armLabeling: false });
      const { notifyAgentPanelSessionUpdate } = require('./agentPanel.vscode') as typeof import('./agentPanel.vscode');
      notifyAgentPanelSessionUpdate();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.sessionId', () => copySessionId())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.resumeSessionPick', () => {
      const { showResumePicker } = require('./resumeSession.vscode') as typeof import('./resumeSession.vscode');
      return showResumePicker();
    })
  );

  // One entry point for "show me this session" (side panel, Project panel): focus this
  // window's live tab, else let the CLI open it in the window that owns its
  // project, which applies the same /spawn decision. Returns the ack result.
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.resumeSession', (sessionId: string) => resumeSessionTab(canonicalSessionId(sessionId ?? '') ?? '', {
      liveTab: async (id) => {
        const { live, dead } = await terminals.sessionTabs(id);
        // Tabs the agent left (dead shells) close before anything new opens.
        if (!live) terminals.closeTabs(dead);
        return live && { terminalId: live.id, focus: () => live.terminal.show() };
      },
      runResume: (id) => {
        const live = sessionPresentationStore.liveSession(id);
        return resumeInProjectWindow({ id, agent: live?.agent ?? '', cwd: live?.cwd ?? '', remote: !!remoteDeviceArg(live?.machine) });
      },
    }))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.resumePickHost', () => resumeCurrentPickHost(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agents.resumePickHarness', () => resumeCurrentPickHarness(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agents.resumeCurrentInBestProfile',
      () => resumeCurrentInBestProfile(context)
    )
  );

  // Agents: Init - create .agents config and symlinks
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.init', async () => {
      const workspaceFolder = getActiveWorkspaceFolder();
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
        return;
      }

      // Create/open .agents config
      const config = await initWorkspaceConfig(workspaceFolder);
      if (!config) {
        return;
      }

      // Create symlinks codebase-wide
      const { created, errors } = await createSymlinksCodebaseWide(workspaceFolder, config);

      if (errors.length > 0) {
        vscode.window.showWarningMessage(`Created ${created} symlink(s), but ${errors.length} failed.`);
        console.error('[agents] Symlink errors:', errors);
      } else if (created > 0) {
        vscode.window.showInformationMessage(`Created ${created} symlink(s) in workspace.`);
      } else {
        vscode.window.showInformationMessage('.agents config ready. No new symlinks needed.');
      }
    })
  );

  /** The configured default target for the bare `New <Harness>` commands. */
  const defaultLaunchTarget = () =>
    resolveLaunchTarget(vscode.workspace.getConfiguration('agents').get<string>('launch.defaultTarget'));

  // Per-harness launch commands — every one is a thin route into launchAgent.
  // For each non-shell agent:
  //   New <Harness>                 -> configured device target + balanced account/version
  //   New <Harness> (Pick Host)     -> device picker, then balanced account on it
  //   New <Harness> (Auto)          -> automatic device + balanced account/version
  //   New <Harness> (Pick Project)  -> project quickpick, then automatic device + balanced
  //   New <Harness> (Pick Account)  -> account picker (trailing `@`) on --device auto —
  //                                    the orthogonal twin of Pick Host. Per-harness only:
  //                                    `run auto@` has no concrete harness to pick an
  //                                    account for and the CLI refuses it, so there is no
  //                                    generic device-agnostic Pick Account below.
  for (const def of BUILT_IN_AGENTS) {
    if (def.key === 'shell') {
      // Shell is a plain terminal — no balancing, no host offload.
      context.subscriptions.push(
        vscode.commands.registerCommand(def.commandId, () => {
          const agentConfig = getBuiltInByTitle(context.extensionPath, def.title);
          if (agentConfig) openSingleAgent(context, agentConfig);
        })
      );
      continue;
    }
    if (isDeprecatedAgentKey(def.key)) {
      // Deprecated harness (gemini → Antigravity). Don't register launch
      // commands for it, but keep session parsing/watching intact. The same
      // DEPRECATED_AGENT_KEYS set gates the webview spawn/execute guards and the
      // command allowlist, so a deprecation can't be enforced here and leak there.
      continue;
    }
    // Where a bare `New <Harness>` runs is read at press time, so a settings
    // change applies without reloading the window. Registration and final
    // command construction are pure/tested in core/launchTarget.ts.
    for (const registration of harnessLaunchRegistrations(def.key, def.commandId, defaultLaunchTarget)) {
      context.subscriptions.push(
        vscode.commands.registerCommand(registration.commandId, () =>
          launchAgent(context, registration.launchOptions())),
      );
    }
  }

  // Generic device-first launch: pick the HOST, then the harness is auto-picked
  // from what's available + has headroom on that host, with balanced rotation.
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAgentPickHost', () => launchAgent(context, { pickHost: true }))
  );

  // Dynamically register custom agent commands
  const customAgentSettings = settingsStore.getSettings(context);
  for (const custom of customAgentSettings.custom) {
    const commandId = `agents.new${custom.name.replace(/[^a-zA-Z0-9]/g, '')}`;
    const agentConfig = createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase());

    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, () => {
        openSingleAgent(context, agentConfig);
      })
    );

    console.log(`Registered custom agent command: ${commandId} for ${custom.name}`);
  }

  // Register the "New (Alias)" command - shows a QuickPick of all configured aliases
  context.subscriptions.push(
    vscode.commands.registerCommand('agents.newAlias', async () => {
      const currentSettings = settingsStore.getSettings(context);
      const aliases = currentSettings.aliases || [];

      if (aliases.length === 0) {
        vscode.window.showInformationMessage('No aliases configured.');
        return;
      }

      // Build QuickPick items
      const items = aliases.map(alias => {
        const builtInDef = getBuiltInByKey(alias.agent);
        const agentName = builtInDef ? getExpandedAgentName(builtInDef.prefix) : alias.agent;
        return {
          label: `${agentName} (${alias.name})`,
          description: alias.flags,
          alias
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an alias to launch'
      });

      if (selected) {
        const builtInDef = getBuiltInByKey(selected.alias.agent);
        if (builtInDef) {
          const agentConfig = getBuiltInByTitle(context.extensionPath, builtInDef.title);
          if (agentConfig) {
            openSingleAgent(context, agentConfig, selected.alias.flags);
          }
        }
      }
    })
  );

  // Dynamically register command aliases
  // Aliases let users define shortcuts like "Agents: New Claude (Fast)" with custom flags
  const aliases = customAgentSettings.aliases || [];
  for (const alias of aliases) {
    // Get the built-in agent this alias is for
    const builtInDef = getBuiltInByKey(alias.agent);
    if (!builtInDef) {
      console.warn(`Alias "${alias.name}" references unknown agent: ${alias.agent}`);
      continue;
    }

    // Create command ID: agents.alias.Fast, agents.alias.MaxContext, etc.
    const commandId = `agents.alias.${alias.name.replace(/[^a-zA-Z0-9]/g, '')}`;
    const agentConfig = getBuiltInByTitle(context.extensionPath, builtInDef.title);

    if (agentConfig) {
      context.subscriptions.push(
        vscode.commands.registerCommand(commandId, () => {
          openSingleAgent(context, agentConfig, alias.flags);
        })
      );

      console.log(`Registered alias command: ${commandId} -> ${alias.agent} with flags: ${alias.flags}`);
    }
  }

  // Register quick launch commands (Cmd+Shift+0..9). Always register all ten so
  // keybindings stay valid even before the user assigns a slot — unassigned
  // shortcuts silently no-op.
  // Launch a configured slot. `forceHostPick` (⌘⌥⇧n) overrides the slot's baked
  // Run-on target with an interactive host pick for this one launch.
  const launchQuickSlot = async (digit: QuickLaunchSlotKey, forceHostPick: boolean) => {
    // Re-read settings on every press so newly saved slots take effect
    // without reloading the window.
    const fresh = settingsStore.getSettings(context);
    const slot: QuickLaunchSlot | undefined = getQuickLaunchSlot(fresh.quickLaunch, digit);
    if (!slot) return;

    const builtInDef = getBuiltInByKey(slot.agent);
    if (!builtInDef) return;

    const agentConfig = getBuiltInByTitle(context.extensionPath, builtInDef.title);
    if (!agentConfig) return;

    let modelId = slot.model;
    if (!modelId && slot.modelAlias) {
      modelId = (await resolveAlias(slot.agent, slot.modelAlias)) ?? undefined;
    }

    const parts: string[] = [];
    if (modelId) parts.push(`--model ${modelId}`);
    if (slot.mode) parts.push(`--mode ${slot.mode}`);
    if (slot.extraFlags && slot.extraFlags.trim()) parts.push(slot.extraFlags.trim());
    const flags = parts.length ? parts.join(' ') : undefined;

    let host: string | undefined;
    if (forceHostPick) {
      const picked = await pickLaunchHost(`Run ${slot.label || builtInDef.title} on…`);
      if (picked.cancelled) return;
      host = picked.host;
    } else {
      host = await resolveSlotHost(slot);
    }

    openSingleAgent(context, agentConfig, flags, slot.version || undefined, undefined, host);
  };

  for (const digit of QUICK_LAUNCH_SLOT_KEYS) {
    // ⌘⇧n — fire the slot on its baked Run-on target.
    context.subscriptions.push(
      vscode.commands.registerCommand(`agents.quickLaunch${digit}`, () => launchQuickSlot(digit, false)),
    );
    // ⌘⌥⇧n — fire the slot but pick the host this once.
    context.subscriptions.push(
      vscode.commands.registerCommand(`agents.quickLaunch${digit}PickHost`, () => launchQuickSlot(digit, true)),
    );
  }

  // Single terminal-close handler: normal teardown when the agent exits.
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      void (async () => {
        const entry = terminals.getByTerminal(terminal);

        // Capture session info before unregistering (for reopen).
        // Capture session info before unregistering (for reopen).
        if (entry?.agentConfig && entry.sessionId) {
          terminals.pushClosedSession({
            terminalId: entry.id,
            prefix: entry.agentConfig.prefix,
            sessionId: entry.sessionId,
            host: entry.host,
            label: entry.label,
            agentType: entry.agentType,
            version: entry.version,
            account: entry.account || entry.statusAccount || undefined,
            agentConfig: entry.agentConfig,
            closedAt: Date.now()
          });
        }

        // A tab closed by anything but the window going away leaves the restore
        // store now, before the remote stop below (up to 20s over ssh) can be cut
        // short by a crash. A window shutdown keeps it so deactivate persists it.
        const reason = terminal.exitStatus?.reason;
        if (reason !== vscode.TerminalExitReason.Shutdown) {
          terminals.unregister(terminal);
        }

        // #5b: a genuine user close (Cmd+W) tears the agent + its mux down so a
        // still-running (idle) session isn't orphaned. A window RELOAD or a
        // programmatic close is NOT a user close — restore re-registers the
        // session, and killing it would break crash-restore — so the CLI stop
        // fires only for `terminal.exitStatus.reason === User` (see
        // maybeTearDownAgentOnClose). The CLI owns the teardown; the extension
        // just wires the user-close event to `agents ps stop`.
        if (entry?.agentConfig) {
          await readiness.maybeTearDownAgentOnClose({
            reason,
            sessionId: entry.sessionId,
            host: entry.host,
            stop: async (id, o) => {
              const { runAgentsArgs } = await import('../core/agentsBin');
              await runAgentsArgs(['ps', 'stop', id, ...(o.local ? ['--local'] : [])], { timeout: 20_000 })
                .catch((err) => console.error('[TERMINALS] ps stop on close failed', err));
            },
          });
        }

        updateActiveAgentContextKey(vscode.window.activeTerminal, context.extensionPath);
      })();
    })
  );

  // Update status bar when active terminal changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      updateActiveAgentContextKey(terminal, context.extensionPath);
      if (!agentStatusBarItem) return;

      if (!terminal) {
        agentStatusBarItem.text = 'Agents';
        agentStatusBarItem.tooltip = undefined;
        return;
      }

      // Check if this is an agent terminal and scroll to bottom
      const agentInfo = identifyAgentTerminal(terminal, context.extensionPath);
      if (agentInfo.isAgent) {
        vscode.commands.executeCommand('workbench.action.terminal.scrollToBottom');

        // Try to fetch label on focus if not already set (immediate update instead of 5-min poller)
        tryFetchLabelOnFocus(terminal, context);
      }

      updateStatusBarForTerminal(terminal, context.extensionPath);

      // Apply any title that resolved while this tab was in the background. It is
      // now the active terminal, so this renames without stealing focus.
      void terminals.applyPendingTitle(terminal);

      // Update terminal titles based on focus state (for showLabelOnlyOnFocus feature)
      updateTerminalTitleOnFocus(terminal, context);
    })
  );

  // Update status bar when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!agentStatusBarItem) return;

      if (editor) {
        // Switching to a real text editor - reset status bar
        agentStatusBarItem.text = 'Agents';
        agentStatusBarItem.tooltip = undefined;
      } else {
        // editor is undefined - could be switching to a terminal tab
        // Check if active tab is a terminal and update status bar accordingly
        const activeGroup = vscode.window.tabGroups.activeTabGroup;
        const activeTab = activeGroup?.activeTab;

        if (activeTab?.input instanceof vscode.TabInputTerminal) {
          const matchedTerminal = frontTerminal();
          if (matchedTerminal) {
            updateStatusBarForTerminal(matchedTerminal, context.extensionPath);
            return;
          }
        }
      }
    })
  );

  // Listen for tab changes to catch editor-area terminal switches
  // (onDidChangeActiveTerminal doesn't fire reliably for terminal editor tabs)
  // Debounced because onDidChangeTabs fires in rapid bursts during workspace restore,
  // tab drag, etc. — each fire used to trigger a full session-file read.
  let tabChangeTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (!agentStatusBarItem) return;
      if (tabChangeTimer) clearTimeout(tabChangeTimer);
      tabChangeTimer = setTimeout(() => {
        tabChangeTimer = undefined;
        const activeGroup = vscode.window.tabGroups.activeTabGroup;
        const activeTab = activeGroup?.activeTab;

        if (!activeTab || !(activeTab.input instanceof vscode.TabInputTerminal)) {
          return;
        }

        const matchedTerminal = frontTerminal();
        if (!matchedTerminal) return;

        tryFetchLabelOnFocus(matchedTerminal, context);
        updateStatusBarForTerminal(matchedTerminal, context.extensionPath);
        void terminals.applyPendingTitle(matchedTerminal);
        updateTerminalTitleOnFocus(matchedTerminal, context);
      }, 120);
    })
  );
  context.subscriptions.push({
    dispose: () => {
      if (tabChangeTimer) clearTimeout(tabChangeTimer);
    },
  });

  // Auto-open terminals on startup if any agents have login enabled
  const startupSettings = settingsStore.getSettings(context);
  if (hasLoginEnabled(startupSettings)) {
    setTimeout(() => openAgentTerminals(context), 1000);
  }
}

async function sendCommandWhenReady(
  terminal: vscode.Terminal,
  command: string,
): Promise<void> {
  const t0 = Date.now();
  const elapsed = () => `t+${Date.now() - t0}ms`;
  console.log(`[SEND-CMD] ${elapsed()} waiting for promptReady`);
  try {
    await readiness.waitFor(terminal, 'promptReady');
    console.log(`[SEND-CMD] ${elapsed()} promptReady fired, sending`);
  } catch (err) {
    console.warn(`[SEND-CMD] ${elapsed()} promptReady wait failed: ${err}. Sending anyway.`);
  }
  terminal.sendText(command);
  console.log(`[SEND-CMD] ${elapsed()} sendText returned`);
}

async function openSingleAgent(
  context: vscode.ExtensionContext,
  agentConfig: Omit<AgentConfig, 'count'>,
  additionalFlags?: string,
  pinnedVersion?: string,
  strategy?: RunStrategy,
  host?: string
) {
  // A host target ('local'/undefined = this machine) always routes through
  // `agents run <agent> --device <device>` so the CLI does the SSH offload —
  // including agents that launch as raw binaries locally.
  const targetHost = host && host !== 'local' ? host : undefined;

  // Build command with default model if configured
  const builtInDef = getBuiltInDefByTitle(agentConfig.title);
  const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;
  const defaultModel = agentKey && (!additionalFlags || !additionalFlags.includes('--model'))
    ? settingsStore.getDefaultModel(context, agentKey)
    : undefined;

  // Handle session ID for supported agent types
  const workspaceFolder = getActiveWorkspaceFolder()?.uri.fsPath || process.cwd();

  const terminalId = terminals.nextId(agentConfig.prefix);
  const cwd = workspaceFolder;

  let sessionId: string | null = null;

  // Track OpenCode sessions before spawn to detect new one
  let opencodeSessionsBefore: string[] | null = null;
  if (agentKey === 'opencode') {
    opencodeSessionsBefore = await listOpencodeSessions(cwd);
  }

  // Mint Claude's session id up front for LOCAL and REMOTE alike. The id is
  // what every downstream surface keys off: the status bar, the auto-label
  // poller that fills in the tab title, and Session Resume / Trace / Fork.
  // A host run used to skip it and let the remote coin its own id, which left
  // remote tabs stuck on the bare agent prefix with an empty status bar and no
  // way to resume them by id. `agents run --device` accepts a caller-supplied
  // `--session-id` and pins the remote session to it (hosts/run-target.ts
  // resolveHostSessionId), so the id we generate here is the id the remote
  // session actually uses.
  if (agentKey === 'claude') {
    sessionId = generateClaudeSessionId();
    console.log(`[SESSION] Claude using on-demand session ID: ${sessionId}${targetHost ? ` (host ${targetHost})` : ''}`);
  }
  // Ordinary launches preserve the exact workspace. Choosing a managed
  // project's defaultPath is reserved for the explicit Pick Project flow in
  // launchAgent; this launch path has no project picker.
  const command = buildTabLaunchCommand(agentKey, {
    cwd,
    host: targetHost,
    sessionId,
    defaultModel,
    additionalFlags,
    pinnedVersion,
    strategy,
  }) ?? agentConfig.command;

  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const title = buildTerminalTitle(agentConfig.title, undefined, context, sessionId);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: editorLocation,
    name: title,
    env: buildAgentTerminalEnv(terminalId, sessionId, cwd, undefined, { scrubSensitive: agentKey !== 'shell', kind: agentKey === 'shell' ? 'shell' : 'agent' }),
    cwd,
    isTransient: true
  });

  // Track + poll any known harness, not just the prewarm five (#1747).
  await registerAgentTerminal(terminal, context, {
    terminalId,
    agentConfig,
    agentKey,
    sessionId,
    host: targetHost,
    pinnedVersion,
  });

  if (command) {
    // wrapNativeAgentCommand exits the shell (closing the tab) on a clean exit,
    // frames a dropped --device link as a recoverable reconnect (RUSH-3125 F6),
    // and otherwise leaves the tab open with a readable status line on a launch
    // failure (RUSH-2593). No-op for shell tabs.
    await sendCommandWhenReady(terminal, wrapNativeAgentCommand(command, agentKey === 'shell'));
    readiness.armAgentReady(terminal);
  }

  if (agentKey === 'shell') {
    armShellAdoptionForTerminal(terminal, context);
  }

  // OpenCode: Detect session ID asynchronously after spawn
  if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
    detectOpencodeSessionId(terminal, cwd, opencodeSessionsBefore, context);
  }
}

// Tracks the most recent /spawn terminal so a follow-up split lands beside it
// (the engine's two-per-tab packing: tab, then split, then tab, …).
let lastSpawnedTerminal: vscode.Terminal | undefined;

// The parent terminal for a split: the last /spawn terminal if it is still
// open, else the active terminal, else none (caller falls back to a new tab).
function aliveSpawnParent(): vscode.Terminal | undefined {
  if (lastSpawnedTerminal && vscode.window.terminals.includes(lastSpawnedTerminal)) {
    return lastSpawnedTerminal;
  }
  return vscode.window.activeTerminal ?? undefined;
}

// Open an editor-tab terminal running an arbitrary command (the /spawn verb).
//
// Prefer an explicit agent from the spawn payload (`agents run --resume
// --terminal vscodium-agent`), then fall back to sniffing the command line for a local
// resume like `claude --resume <id>` / `agents run grok …`. Only when neither
// yields a harness do we open as SH + shell-adoption — that path cannot set the
// icon later (VS Code tab icons are immutable) and cannot promote remote
// attaches whose local tree is just `ssh … tmux attach` (#2478).
//
// When req.split is set, the terminal splits beside the previous /spawn pane
// instead of opening a new tab.
async function spawnCommandTerminal(
  context: vscode.ExtensionContext,
  req: SpawnRequest
): Promise<void> {
  const result = await placeSpawnRequest(context, req);
  if (!req.nonce) return;
  try {
    writeSpawnAck({ nonce: req.nonce, ...result });
  } catch (err) {
    console.error('[SPAWN] Failed to write ack', err);
  }
}

type SpawnResult = Omit<SpawnAck, 'nonce'>;

async function placeSpawnRequest(
  context: vscode.ExtensionContext,
  req: SpawnRequest
): Promise<SpawnResult> {
  const detectedKey =
    (req.agent && getBuiltInByKey(req.agent) ? req.agent : null) ||
    readiness.detectAgentKeyFromArgs(req.command) ||
    null;
  const def = (detectedKey && getBuiltInByKey(detectedKey)) || getBuiltInByKey('shell');
  const sessionId =
    req.sessionId || readiness.extractSessionIdFromArgs(req.command) || null;
  const windowFolders = terminals.windowFolders();
  const result = (
    status: SpawnAck['status'],
    tab: { terminalId?: string; title?: string; pid?: number } = {},
    reason: string | null = null,
  ): SpawnResult => ({
    status,
    windowFolders,
    workspaceName: vscode.workspace.name ?? null,
    terminalId: tab.terminalId ?? null,
    title: tab.title ?? null,
    sessionId,
    pid: tab.pid ?? null,
    reason,
    at: Date.now(),
  });
  if (!def) return result('failed', {}, 'no harness matches this request');
  const { live, dead } = sessionId ? await terminals.sessionTabs(sessionId) : { live: undefined, dead: [] };
  const decision = decideSpawn({
    project: req.project,
    windowFolders,
    otherWindows: req.project ? liveWindows(process.pid).map((w) => w.folders) : [],
    liveTerminalId: live?.id,
  });
  if (decision === 'no-project') return result('failed', {}, 'the request names no project, so no window can claim it');
  if (decision === 'wrong-window') return result('wrong-window');
  if (decision === 'focus' && live) {
    live.terminal.show();
    return result('focused-existing', { terminalId: live.id, title: live.terminal.name, pid: live.pid });
  }
  terminals.closeTabs(dead);

  const agentConfig = createAgentConfig(
    context.extensionPath,
    def.title,
    def.command,
    def.icon,
    def.prefix
  );

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const cwd = req.cwd || workspaceFolder;
  const terminalId = terminals.nextId(agentConfig.prefix);
  const title =
    req.title?.trim() ||
    buildTerminalTitle(agentConfig.title, undefined, context, sessionId);

  const parent = req.split ? aliveSpawnParent() : undefined;
  const surface = resolveSpawnSurface({
    wantsSplit: !!req.split,
    hasParent: !!parent,
  });

  const isShell = def.key === 'shell';
  const env = buildAgentTerminalEnv(terminalId, sessionId, cwd, undefined, {
    scrubSensitive: !isShell,
    kind: isShell ? 'shell' : 'agent',
  });

  const location: vscode.TerminalEditorLocationOptions | vscode.TerminalSplitLocationOptions =
    surface === 'native-split' && parent
      ? { parentTerminal: parent }
      : { viewColumn: vscode.ViewColumn.Active, preserveFocus: false };

  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location,
    name: title,
    env,
    cwd,
    isTransient: true,
    ...agentTabShell(req.command, process.env.SHELL),
  });

  const { pid } = await terminals.processIdWithin(terminal);
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);
  if (pid === undefined) return result('failed', { terminalId, title }, "the tab's shell did not start within 10s");
  const resumeKey = !isShell && detectedKey ? agentKeyFromSession(detectedKey) : null;
  if (resumeKey) {
    terminals.setAgentType(terminal, resumeKey);
    if (sessionId) {
      terminals.setSessionId(terminal, sessionId);
      startAutoLabelPollerForTerminal(terminal, context);
    }
  } else if (isShell || !detectedKey) {
    armShellAdoptionForTerminal(terminal, context);
  }
  if (vscode.window.activeTerminal === terminal) {
    updateStatusBarForTerminal(terminal, context.extensionPath);
  }
  terminal.show();
  lastSpawnedTerminal = terminal;
  return result('opened', { terminalId, title, pid });
}

// Opens the session in the window that owns its project; that window decides the /spawn.
async function resumeInProjectWindow(session: { id: string; agent: string; cwd: string; remote: boolean }): Promise<{ ok: boolean; output: string }> {
  const plan = projectWindowResume(session, terminals.windowFolders());
  if ('error' in plan) return { ok: false, output: plan.error };
  const { runAgentsArgs } = await import('../core/agentsBin');
  try {
    const { stdout, stderr } = await runAgentsArgs(plan.args, { cwd: plan.cwd, timeout: 60_000 });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}` };
  }
}


async function askAnotherAgentFromTerminal(context: vscode.ExtensionContext) {
  const clipboardText = (await vscode.env.clipboard.readText()).trim();
  if (!clipboardText) {
    vscode.window.showInformationMessage(
      'Copy the line first (Cmd+C), then press Cmd+Shift+K or right-click and choose "Start Task".'
    );
    return;
  }

  const preview = clipboardText.length > 80
    ? `${clipboardText.slice(0, 80).replace(/\s+/g, ' ')}...`
    : clipboardText.replace(/\s+/g, ' ');

  const question = await vscode.window.showInputBox({
    prompt: `Start a task with context: ${preview}`,
    placeHolder: 'What should the agent do?'
  });
  if (question === undefined || !question.trim()) return;

  const sourceTerminal = vscode.window.activeTerminal;
  const sourceEntry = sourceTerminal ? terminals.getByTerminal(sourceTerminal) : undefined;
  const sourceAgent = sourceEntry?.agentConfig
    ? getExpandedAgentName(sourceEntry.agentConfig.prefix)
    : undefined;
  const sourceSessionId = sourceEntry?.sessionId;
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  let sourceSummary: string | null = null;
  if (sourceSessionId) {
    sourceSummary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Loading source session summary…' },
      () => handoff.getSessionSummaryViaAgentsCli(sourceSessionId, workspacePath)
    );
  }

  const contextLines: string[] = [];
  if (sourceAgent) contextLines.push(`source-agent: ${sourceAgent}`);
  if (sourceSessionId) contextLines.push(`source-session-id: ${sourceSessionId}`);
  if (workspacePath) contextLines.push(`workspace: ${workspacePath}`);
  contextLines.push('selected-text:');
  contextLines.push(clipboardText);
  if (sourceSummary) {
    contextLines.push('');
    contextLines.push('source-session-summary:');
    contextLines.push(sourceSummary);
  }

  const message = `<context>\n${contextLines.join('\n')}\n</context>\n\n${question.trim()}`;
  const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
  if (agentConfig) {
    await openSingleAgentWithQueue(context, agentConfig, [message]);
  }
}

async function handoffToAgent(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;

  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal to handoff from');
    return;
  }

  const terminalEntry = terminals.getByTerminal(activeTerminal);

  if (!terminalEntry || !terminalEntry.agentConfig) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  const fromAgent = getExpandedAgentName(terminalEntry.agentConfig.prefix);
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  let messages: handoff.HandoffMessage[] = [];
  let planInfo: { path: string; content: string } | null = null;

  if (terminalEntry.sessionId && terminalEntry.agentType) {
    const agentType = terminalEntry.agentType as 'claude' | 'codex';

    messages = await handoff.getSessionMessagesViaAgentsCli(terminalEntry.sessionId, 10, workspacePath);

    if (agentType === 'claude') {
      planInfo = await handoff.findRecentClaudePlan();
    }
  }

  if (messages.length === 0 && !planInfo && terminalEntry.agentType !== 'opencode') {
    vscode.window.showInformationMessage('No session history available for handoff');
    return;
  }

  interface AgentQuickPickItem extends vscode.QuickPickItem {
    agentKey: string;
    agentConfig: Omit<AgentConfig, 'count'>;
  }

  const agentItems: AgentQuickPickItem[] = [];

  for (const def of BUILT_IN_AGENTS) {
    if (def.key === 'shell') continue;
    if (def.title === terminalEntry.agentConfig.title) continue;

    const config = getBuiltInByTitle(context.extensionPath, def.title);
    if (!config) continue;

    const expandedName = getExpandedAgentName(def.prefix);
    agentItems.push({
      label: expandedName,
      description: def.key.toUpperCase(),
      agentKey: def.key,
      agentConfig: config
    });
  }

  const customAgentSettings = settingsStore.getSettings(context);
  for (const custom of customAgentSettings.custom) {
    if (custom.name === terminalEntry.agentConfig.title) continue;

    agentItems.push({
      label: custom.name,
      description: 'Custom',
      agentKey: custom.name.toLowerCase(),
      agentConfig: createAgentConfig(context.extensionPath, custom.name, custom.command, 'agents.png', custom.name.toLowerCase())
    });
  }

  if (agentItems.length === 0) {
    vscode.window.showInformationMessage('No other agents available for handoff');
    return;
  }

  const selectedAgent = await vscode.window.showQuickPick(agentItems, {
    placeHolder: `Handoff from ${fromAgent} to...`,
    matchOnDescription: true
  });

  if (!selectedAgent) return;

  const handoffContext: handoff.HandoffContext = {
    fromAgent,
    messages,
    planContent: planInfo?.content,
    planPath: planInfo?.path
  };

  const prompt = handoff.formatHandoffPrompt(handoffContext);

  await openSingleAgentWithQueue(context, selectedAgent.agentConfig, [prompt]);
}

async function continueInNewSession(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;

  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal to continue from');
    return;
  }

  const terminalEntry = terminals.getByTerminal(activeTerminal);

  if (!terminalEntry || !terminalEntry.agentConfig) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!terminalEntry.sessionId || !terminalEntry.agentType) {
    vscode.window.showInformationMessage('No session data available to continue from');
    return;
  }

  const [messages, toolStats] = await Promise.all([
    handoff.getSessionMessagesViaAgentsCli(terminalEntry.sessionId, 999, workspacePath),
    handoff.getSessionToolStatsViaAgentsCli(terminalEntry.sessionId, workspacePath)
  ]);

  const originalTask = messages.find(m => m.role === 'user')?.content ?? null;
  const lastResponse = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? null;

  if (!originalTask && !lastResponse) {
    vscode.window.showInformationMessage('No session history available to continue from');
    return;
  }

  const continueCtx: handoff.ContinueContext = {
    originalTask,
    lastResponse,
    recentFiles: toolStats.recentFiles,
    toolCalls: toolStats.toolCalls,
    filesEdited: toolStats.filesEdited,
    filesRead: toolStats.filesRead
  };

  const prompt = handoff.formatContinuePrompt(continueCtx);

  await openSingleAgentWithQueue(context, terminalEntry.agentConfig, [prompt]);
}

async function readSelectionForContinue(): Promise<string> {
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    return editor.document.getText(editor.selection).trim();
  }
  // No public API exposes terminal selection text — the only path is to copy
  // it to the system clipboard, read, and restore. The two readText calls
  // bracketing copySelection can race on macOS in practice (clipboard write
  // is normally awaited but is not strictly ordered with the next read), so
  // treat any non-empty change as the selection and otherwise restore.
  if (vscode.window.activeTerminal) {
    const original = await vscode.env.clipboard.readText();
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    const fromTerminal = (await vscode.env.clipboard.readText()).trim();
    if (fromTerminal && fromTerminal !== original.trim()) {
      // Restore the user's prior clipboard — they didn't ask to lose it.
      await vscode.env.clipboard.writeText(original);
      return fromTerminal;
    }
    await vscode.env.clipboard.writeText(original);
  }
  return (await vscode.env.clipboard.readText()).trim();
}

async function continueFromSelection(context: vscode.ExtensionContext) {
  const selection = await readSelectionForContinue();
  if (!selection) {
    vscode.window.showInformationMessage(
      'Select a session ID (in editor or terminal) or copy it first, then press Cmd+Shift+C.'
    );
    return;
  }

  const agentConfig = getBuiltInByTitle(context.extensionPath, defaultAgentTitle);
  if (!agentConfig) {
    vscode.window.showErrorMessage(`No agent config for default "${defaultAgentTitle}"`);
    return;
  }

  vscode.window.setStatusBarMessage(`Continuing session ${selection.slice(0, 8)}…`, 3000);
  await openSingleAgentWithQueue(context, agentConfig, [`/continue ${selection}`]);
}

interface CliSessionItem {
  id: string;
  shortId: string;
  agent: 'claude' | 'codex' | 'opencode' | 'openclaw' | 'cursor';
  timestamp: string;
  version?: string;
  account?: string;
  project?: string;
  cwd?: string;
  filePath?: string;
  topic?: string;
  messageCount?: number;
  tokenCount?: number;
}

/**
 * The recent-transcript listing. `sessions` takes the query as a positional
 * argument and has no `list` subcommand — passing one made commander treat the
 * word "list" as a search term, which matched nothing and left every picker in
 * the extension reporting "No sessions found".
 */
async function listSessionsViaCli(limit = 30): Promise<CliSessionItem[]> {
  const { runCliArgs } = await import('../core/agentsBin');
  const { stdout } = await runCliArgs('sessions', ['--all', '--json', '--no-interactive', '--limit', String(limit)], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed as CliSessionItem[];
}

/**
 * The live counterpart of {@link listSessionsViaCli}: which sessions have a
 * process running right now, and — via `viewingIn` — whether anyone is looking
 * at it. Bare (no `--local`) so a session stranded on another fleet box shows up
 * too; those resume over SSH.
 */
// formatSessionWhen and cleanSessionTopic moved to ../core/sessionBrowser (pure,
// unit-tested) and are imported at the top of this file; the fork picker and the
// resume picker both call the shared implementations.

interface SessionPickerOptions {
  title: string;
  placeholder: string;
  pinShortId?: string | null;
  pinLabel?: string;
}

async function pickSession(opts: SessionPickerOptions): Promise<CliSessionItem | null> {
  let sessions: CliSessionItem[];
  try {
    sessions = await listSessionsViaCli(30);
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      vscode.window.showInformationMessage('agents CLI not found. Install with: npm i -g @swarmify/agents-cli');
    } else {
      vscode.window.showInformationMessage(`Failed to list sessions: ${msg.slice(0, 120)}`);
    }
    return null;
  }

  if (sessions.length === 0) {
    vscode.window.showInformationMessage('No sessions found');
    return null;
  }

  if (opts.pinShortId) {
    const idx = sessions.findIndex(s => s.shortId === opts.pinShortId || s.id === opts.pinShortId);
    if (idx > 0) {
      const [pinned] = sessions.splice(idx, 1);
      sessions.unshift(pinned);
    }
  }

  interface SessionQuickPickItem extends vscode.QuickPickItem {
    session: CliSessionItem;
  }

  const items: SessionQuickPickItem[] = sessions.map((s, idx) => {
    const agentLabel = s.version ? `${s.agent}@${s.version}` : s.agent;
    const when = formatSessionWhen(s.timestamp);
    const topic = cleanSessionTopic(s.topic);
    const isPinned = idx === 0 && opts.pinShortId &&
      (s.shortId === opts.pinShortId || s.id === opts.pinShortId);
    const pinTag = isPinned && opts.pinLabel ? `$(pinned) ${opts.pinLabel} · ` : '';
    return {
      label: `${pinTag}${s.shortId}  ${topic}`,
      description: `${agentLabel} · ${when}${s.account ? ` · ${s.account}` : ''}`,
      detail: `${s.project || '-'}${s.cwd ? `  ${s.cwd}` : ''}`,
      session: s,
    };
  });

  const picked = await vscode.window.showQuickPick<SessionQuickPickItem>(items, {
    title: opts.title,
    placeHolder: opts.placeholder,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return picked?.session ?? null;
}

async function copySessionTrace(_context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;
  const terminalEntry = activeTerminal ? terminals.getByTerminal(activeTerminal) : null;
  const currentSessionId = terminalEntry?.sessionId ?? null;
  const currentShortId = currentSessionId ? currentSessionId.slice(0, 8) : null;

  const session = await pickSession({
    title: 'Agents: Session Trace',
    placeholder: 'Pick a session to copy its trace to clipboard',
    pinShortId: currentShortId,
    pinLabel: 'Current',
  });
  if (!session) return;

  const { runCliArgs } = await import('../core/agentsBin');
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  try {
    const { stdout } = await runCliArgs('sessions', ['trace', session.id], {
      maxBuffer: 10 * 1024 * 1024,
      cwd: workspacePath,
    });

    const lines = stdout.split('\n');
    const headerEnd = lines.findIndex(l => l.startsWith('# '));
    const trace = headerEnd >= 0 ? lines.slice(headerEnd).join('\n') : stdout;

    const agentLabel = session.version ? `${session.agent}@${session.version}` : session.agent;
    const header = [
      `## Session`,
      `- Agent: ${agentLabel}`,
      `- Session ID: ${session.id}`,
      session.cwd ? `- Directory: ${session.cwd}` : '',
      session.account ? `- Account: ${session.account}` : '',
    ].filter(Boolean).join('\n');

    const fullTrace = `${header}\n\n${trace}`;
    await vscode.env.clipboard.writeText(fullTrace);
    vscode.window.setStatusBarMessage(`Session trace copied (${session.shortId})`, 3000);
  } catch (err: any) {
    const msg = err?.message || 'Unknown error';
    vscode.window.showInformationMessage(`Failed to get session trace: ${msg.slice(0, 120)}`);
  }
}

async function copySessionId() {
  const activeTerminal = vscode.window.activeTerminal;

  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal');
    return;
  }

  const terminalEntry = terminals.getByTerminal(activeTerminal);

  if (!terminalEntry || !terminalEntry.agentConfig) {
    vscode.window.showInformationMessage('Active terminal is not an agent terminal');
    return;
  }

  // Prefer a freshly hydrated CLI id (terminalId join / local state) over a
  // spawn-time stamp. Offloaded tabs use the batched --active map; local tabs
  // can also read the SessionStart state file.
  await tryHydrateLiveSessionId(activeTerminal, terminalEntry.agentConfig.prefix || '');
  const refreshed = terminals.getByTerminal(activeTerminal);
  const sessionId = canonicalSessionId(refreshed?.sessionId || terminalEntry.sessionId);

  if (!sessionId) {
    vscode.window.showInformationMessage('No session ID available');
    return;
  }

  await vscode.env.clipboard.writeText(sessionId);
  vscode.window.setStatusBarMessage(`Session ID copied: ${sessionId.slice(0, 8)}...`, 3000);
}

/**
 * The agent key a session resumes under, for the PICKER paths (`Agents: Resume`
 * and `Agents: Session Resume`). Every harness AGI EXT presents can be resumed
 * here — the five prewarm agents through their native flag, the rest through
 * the CLI's strict resume (see inTabResumeCommand) — so the gate is
 * membership in the agent registry, not the prewarm subset. `shell` is excluded:
 * a shell tab has no conversation to resume.
 *
 * The OTHER resume surfaces — `restoreAgentTerminals` (reload), the reopen-last
 * command, and reload-active-terminal — now gate on this same registry check
 * rather than `supportsPrewarming`, so grok/kimi/droid/antigravity come back
 * through those too (#1747); reload falls back to a generic exit sequence for
 * agents without a PREWARM_CONFIGS entry.
 */
function agentKeyFromSession(agent: string): SessionAgentType | null {
  if (!agent || agent === 'shell') return null;
  return BUILT_IN_AGENTS.some(a => a.key === agent) ? (agent as SessionAgentType) : null;
}

const RECOVERY_AGENT_PREFIX = 'rx';

function recoveryAgentTitle(agent: string): string {
  return agent.trim().replace(/[^A-Za-z0-9._-]+/g, ' ').slice(0, 24) || 'Agent';
}

/** One resumed session, opened as its own editor tab wearing that agent's icon. */
export async function openAgentSessionTerminal(
  context: vscode.ExtensionContext,
  session: { id: string; shortId: string; agent: string; version?: string; account?: string; cwd?: string; host?: string; terminalId?: string },
  // When set, the tab runs THIS command instead of `inTabResumeCommand`, here,
  // without the placement check: the PREVIOUS band's recovery and migration.
  resumeCommandOverride?: string,
): Promise<boolean> {
  // Same placement as /spawn: a session this window shows is focused, and one
  // whose project belongs to another window opens there through the CLI.
  if (!resumeCommandOverride) {
    const { live, dead } = await terminals.sessionTabs(session.id);
    if (live) {
      live.terminal.show();
      return true;
    }
    terminals.closeTabs(dead);
    if (session.cwd && decideSpawn({
      project: session.cwd,
      windowFolders: terminals.windowFolders(),
      otherWindows: liveWindows(process.pid).map((w) => w.folders),
    }) === 'wrong-window') {
      const { ok, output } = await resumeInProjectWindow({ id: session.id, agent: session.agent, cwd: session.cwd, remote: !!remoteDeviceArg(session.host) });
      const { reason } = cliResumeOutcome(ok, output);
      if (!ok) void vscode.window.showWarningMessage(`Session ${session.shortId}: ${reason}`);
      return ok;
    }
  }
  const agentKey = agentKeyFromSession(session.agent);
  // Ordinary picker/reload paths still require a presented built-in. A canonical
  // recovery command is different: the CLI owns the recorded harness and may
  // support one (for example Muse) that AGI EXT does not offer as a New-agent
  // button. Give that command a generic Agents-decorated editor terminal instead
  // of rendering a Resume button that dies before createTerminal.
  if (!agentKey && !resumeCommandOverride) {
    vscode.window.showInformationMessage(`Cannot resume sessions of type ${session.agent || 'unknown'}`);
    return false;
  }

  const builtIn = agentKey ? BUILT_IN_AGENTS.find(a => a.key === agentKey) : undefined;
  if (!builtIn && !resumeCommandOverride) {
    vscode.window.showInformationMessage(`No built-in agent config for ${agentKey}`);
    return false;
  }

  const recoveryTitle = recoveryAgentTitle(session.agent);
  const agentConfig = builtIn
    ? createAgentConfig(context.extensionPath, builtIn.title, builtIn.command, builtIn.icon, builtIn.prefix)
    : createAgentConfig(context.extensionPath, recoveryTitle, 'agents', 'agents.png', RECOVERY_AGENT_PREFIX);

  // The tab starts in the session's own directory when it has one here.
  const workspacePath = session.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const resumeCmd = resumeCommandOverride ?? inTabResumeCommand(session.id);

  const terminalId = session.terminalId || terminals.nextId(agentConfig.prefix);
  const title = buildTerminalTitle(agentConfig.title, undefined, context, session.id);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    name: title,
    cwd: session.cwd,
    env: buildAgentTerminalEnv(terminalId, session.id, workspacePath, session.version),
    isTransient: true,
    ...agentTabShell(resumeCmd, process.env.SHELL),
  });

  await registerAgentTerminal(terminal, context, {
    terminalId,
    agentConfig,
    agentKey: agentKey || undefined,
    recoveryAgent: agentKey ? undefined : session.agent,
    sessionId: session.id,
    host: session.host,
    pinnedVersion: session.version,
  });
  // Show the editor-tab terminal immediately. Readiness can take seconds (or time
  // out on a broken shell integration); hiding the tab behind that await made a
  // successful Resume click look like a complete no-op.
  terminal.show();
  if (session.account) {
    terminals.setAccount(terminal, session.account);
  }
  readiness.armAgentReady(terminal);

  try {
    await readiness.waitFor(terminal, 'agentReady');
    return true;
  } catch (err) {
    console.warn(`[READINESS] resumed session did not become ready: ${err}`);
    vscode.window.showInformationMessage(`Session ${session.shortId} did not become ready; its terminal remains open with the CLI result.`);
    return false;
  }
}

/**
 * `Agents: Resume in Best Profile` — reopen the ACTIVE tab's session via
 * `agents run auto`: the CLI resolves host (affinity) → harness (cross-harness
 * headroom) → account (balanced) and fails loud in the fresh terminal when
 * nothing is healthy. Same launch→ready→/continue flow as the Pick-Harness
 * resume (launchResumeTerminal). Fork-style: the original tab is left running.
 */
async function resumeCurrentInBestProfile(context: vscode.ExtensionContext) {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal');
    return;
  }
  const terminalEntry = terminals.getByTerminal(activeTerminal);
  if (!terminalEntry?.sessionId) {
    vscode.window.showInformationMessage('Active terminal has no session to resume');
    return;
  }
  const agentKey = terminalEntry.agentType
    || prefixToAgentType(terminalEntry.agentConfig?.prefix ?? null);
  if (!agentKey || !supportsPrewarming(agentKey)) {
    return;
  }
  const builtIn = BUILT_IN_AGENTS.find(a => a.key === agentKey);
  if (!builtIn) {
    vscode.window.showInformationMessage(`No built-in agent config for ${agentKey}`);
    return;
  }

  // `--session-id` pins the NEW session id; the CLI honors it only when it
  // picks claude (claude-only flag) and ignores it otherwise. A tab already on a
  // device resumes there; any other lets the CLI place it (`--device auto`, which
  // a bare `agents run auto` also means). The harness is
  // unknown at spawn: stamp the outgoing harness as the prior (the session
  // feed's read-back corrects it).
  const newSessionId = randomUUID();
  const host = terminalEntry.host;
  await launchResumeTerminal(context, {
    builtIn,
    stampAgentKey: agentKey,
    runAgentKey: 'auto',
    runSessionId: newSessionId,
    runHost: host ?? 'auto',
    newSessionId,
    oldSessionId: terminalEntry.sessionId,
    host,
    statusMessage: `Resumed via agents run auto${host ? ` on ${host}` : ''} · ${newSessionId.slice(0, 8)}`,
  });
}

/**
 * The active terminal's tracked entry for the resume-current commands, with
 * the two "nothing to resume" toasts already handled. Requires a session id:
 * without one there is no transcript to point the new tab at.
 */
function activeSessionTerminalEntry(): terminals.EditorTerminal | undefined {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showInformationMessage('No active terminal');
    return undefined;
  }
  const entry = terminals.getByTerminal(activeTerminal);
  if (!entry?.sessionId) {
    vscode.window.showInformationMessage('Active terminal has no session to resume');
    return undefined;
  }
  return entry;
}

/**
 * `Agents: Resume (Pick Host)` — reopen the ACTIVE tab's session on another
 * device. Only the host changes: the harness and its pinned version stay, so
 * the host picker is the one decision the user makes. Transcripts sync
 * fleet-wide, so `agents run --device <picked> --resume <id>` picks the session
 * up wherever it lands (see inTabResumeCommand).
 *
 * Deliberate divergence from the batch path: no `cwd` is passed, so the new
 * tab opens in the current workspace rather than the session's own directory.
 * EditorTerminal doesn't track a cwd, and the session's directory may not
 * exist on the picked device anyway — a cross-host move can't promise it.
 */
async function resumeCurrentPickHost(context: vscode.ExtensionContext) {
  const entry = activeSessionTerminalEntry();
  if (!entry) return;
  const agentKey = entry.agentType || prefixToAgentType(entry.agentConfig?.prefix ?? null);
  if (!agentKey || !agentKeyFromSession(agentKey)) {
    vscode.window.showInformationMessage(`Cannot resume sessions of type ${agentKey || 'unknown'}`);
    return;
  }
  const currentHost = entry.host ?? 'this Mac';
  const pick = await pickLaunchHost(`Resume ${agentKey} on… (currently: ${currentHost})`);
  if (pick.cancelled) return;
  const sessionId = entry.sessionId!;
  const opened = await openAgentSessionTerminal(context, {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: agentKey,
    version: entry.version ?? entry.statusVersion,
    account: entry.account,
    host: pick.host,
  });
  if (opened) {
    vscode.window.setStatusBarMessage(
      `Resuming ${agentKey} on ${pick.host ?? 'this Mac'} · ${sessionId.slice(0, 8)}`,
      4000,
    );
  }
}

/**
 * `Agents: Resume (Pick Harness)` — reopen the ACTIVE tab's session in a
 * different harness on the SAME device. Native `--resume` only works inside
 * the harness that wrote the transcript, so the new harness gets the old
 * session through the universal continue replay (buildResumeInput → the agent
 * loads the transcript via `sessions <id> --markdown` and keeps working).
 */
async function resumeCurrentPickHarness(context: vscode.ExtensionContext) {
  const entry = activeSessionTerminalEntry();
  if (!entry) return;
  const currentAgent = entry.agentType || prefixToAgentType(entry.agentConfig?.prefix ?? null);
  // Signed-in counts are a LOCAL read; for an offloaded tab this box can't see
  // the device's installs, so the list falls back to the unranked full set and
  // the launch fails loud on the device if the harness is missing there.
  const inventories = entry.host
    ? {}
    : await fetchAgentInventories(BUILT_IN_AGENTS.filter((a) => a.key !== 'shell').map((a) => a.key));
  const options = buildHarnessOptions(BUILT_IN_AGENTS, inventories, currentAgent ?? undefined);
  if (options.length === 0) {
    vscode.window.showInformationMessage('No other harness to resume in');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    options.map((o) => ({
      label: o.title,
      description: o.agent,
      detail: o.signedInCount > 0
        ? `${o.signedInCount} signed-in version${o.signedInCount === 1 ? '' : 's'}${o.healthyCount > 0 ? ` · ${o.healthyCount} with usage` : ''}`
        : undefined,
      option: o,
    })),
    {
      title: `Resume in…${currentAgent ? ` (from ${currentAgent})` : ''}`,
      placeHolder: 'Pick the harness to continue this session in',
      matchOnDescription: true,
    },
  );
  if (!picked) return;
  await launchResumeInHarness(context, {
    agentKey: picked.option.agent,
    host: entry.host,
    oldSessionId: entry.sessionId!,
  });
}

/** Everything the shared resume launch needs to open and arm the fresh tab. */
interface ResumeLaunchPlan {
  /** Built-in agent whose icon/prefix/title the fresh tab borrows. */
  builtIn: (typeof BUILT_IN_AGENTS)[number];
  /** Harness stamped on the terminal entry at spawn. */
  stampAgentKey: string;
  /** What `agents run` launches: a harness, or `auto` for the CLI to pick one. */
  runAgentKey: string;
  /** The new session's id, when the launch can pin it up front. */
  runSessionId: string | null;
  /** Where it runs: a device, `auto`, or this machine when absent. */
  runHost?: string;
  newSessionId: string;
  oldSessionId: string;
  host?: string;
  statusMessage: string;
}

/**
 * Open a fresh tab, send the plan's launch command once the prompt is ready,
 * then feed it the OLD session through the universal continue replay once the
 * TUI is live. Shared by `Agents: Resume (Pick Harness)` and `Agents: Resume
 * in Best Profile`.
 *
 * Fork-style contract: the original tab is left running. Non-claude targets
 * reuse the old session id (only Claude can pin a fresh one up front), so two
 * live processes can share one transcript — same contract as `Agents: Fork`.
 */
async function launchResumeTerminal(
  context: vscode.ExtensionContext,
  plan: ResumeLaunchPlan,
): Promise<void> {
  const agentConfig = createAgentConfig(
    context.extensionPath,
    plan.builtIn.title,
    plan.builtIn.command,
    plan.builtIn.icon,
    plan.builtIn.prefix,
  );
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  const terminalId = terminals.nextId(plan.builtIn.prefix);
  const title = buildTerminalTitle(agentConfig.title, undefined, context, plan.newSessionId);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    name: title,
    env: buildAgentTerminalEnv(terminalId, plan.newSessionId, workspacePath),
    isTransient: true,
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  readiness.registerTerminal(terminal);
  terminals.setSessionId(terminal, plan.newSessionId);
  terminals.setAgentType(terminal, plan.stampAgentKey as SessionAgentType);
  if (plan.host) terminals.setHost(terminal, plan.host);
  startAutoLabelPollerForTerminal(terminal, context);

  // Always inline the central continue.md: it works in ANY harness, and we
  // can't know whether the target version's home has the /continue slash
  // command synced (for a remote host we can't even check from here).
  let centralContinueMdBody: string | null = null;
  try {
    centralContinueMdBody = fsSync.readFileSync(
      path.join(os.homedir(), '.agents-system', 'commands', 'continue.md'),
      'utf-8',
    );
  } catch {
    centralContinueMdBody = null;
  }
  const resumeInput = buildResumeInput(plan.oldSessionId, false, centralContinueMdBody);

  try {
    await readiness.waitFor(terminal, 'promptReady');
  } catch (err) {
    console.warn(`[RESUME] promptReady wait FAILED: ${err} — sending launch anyway`);
  }
  terminal.sendText(buildAgentLaunchCommand(
    plan.runAgentKey, plan.runSessionId, undefined, undefined, undefined, undefined, undefined,
    { host: plan.runHost, local: !plan.runHost, cwd: workspacePath },
  ));
  readiness.armAgentReady(terminal);
  terminal.show();

  // Type the payload, then Enter as a separate keystroke — Claude's Ink TUI
  // needs the explicit `\r`, and multi-line input swallows a same-tick one.
  const submitToTui = () => {
    terminal.sendText(resumeInput, false);
    setTimeout(() => terminal.sendText('\r', false), 300);
  };
  readiness.waitFor(terminal, 'agentReady').then(submitToTui).catch((err) => {
    console.error(`[RESUME] agentReady wait FAILED: ${err}`);
    vscode.window.showErrorMessage('Failed to resume: agent did not become ready.');
  });

  vscode.window.setStatusBarMessage(plan.statusMessage, 5000);
}

/**
 * `Agents: Resume (Pick Harness)` launch: `agents run <harness> --interactive`
 * (balanced rotation picks the account — the user is switching harness, not
 * account), on the session's device when offloaded.
 */
async function launchResumeInHarness(
  context: vscode.ExtensionContext,
  opts: { agentKey: string; host?: string; oldSessionId: string },
): Promise<void> {
  const builtIn = BUILT_IN_AGENTS.find((a) => a.key === opts.agentKey);
  if (!builtIn) {
    vscode.window.showInformationMessage(`No built-in agent config for ${opts.agentKey}`);
    return;
  }
  // Only Claude can pin its new session id up front (--session-id); other
  // harnesses reuse the old id.
  const newSessionId = opts.agentKey === 'claude' ? randomUUID() : opts.oldSessionId;
  await launchResumeTerminal(context, {
    builtIn,
    stampAgentKey: opts.agentKey,
    runAgentKey: opts.agentKey,
    runSessionId: opts.agentKey === 'claude' ? newSessionId : null,
    runHost: opts.host,
    newSessionId,
    oldSessionId: opts.oldSessionId,
    host: opts.host,
    statusMessage: `Resuming in ${opts.agentKey}${opts.host ? ` on ${opts.host}` : ''} · ${opts.oldSessionId.slice(0, 8)}`,
  });
}

interface TerminalQuickPickItem extends vscode.QuickPickItem {
  terminal: vscode.Terminal;
  lastActivityMs?: number;
}

async function getSessionPreviewForEntry(
  entry: terminals.EditorTerminal,
  workspacePath?: string
): Promise<{ firstUserMessage?: string; lastUserMessage?: string; lastActivityMs?: number; messageCount: number } | null> {
  if (!entry.sessionId) return null;
  const agentType = entry.agentType || prefixToAgentType(entry.agentConfig?.prefix ?? null);
  if (!agentType) return null;

  const sessionPath = await getSessionPathBySessionId(
    entry.sessionId,
    agentType,
    workspacePath
  );
  if (!sessionPath) return null;

  if (agentType === 'opencode') {
    return await getOpenCodeSessionPreviewInfo(sessionPath);
  }
  if (agentType === 'cursor') {
    return await getCursorSessionPreviewInfo(sessionPath);
  }
  return await getSessionPreviewInfo(sessionPath);
}

function cycleAgentTerminal(direction: 1 | -1) {
  const agentEntries = terminals.getAllTerminals().filter(e => e.agentConfig);
  if (agentEntries.length === 0) return;

  const active = vscode.window.activeTerminal;
  const currentIdx = active ? agentEntries.findIndex(e => e.terminal === active) : -1;
  const startIdx = currentIdx === -1 ? (direction === 1 ? -1 : 0) : currentIdx;
  const nextIdx = (startIdx + direction + agentEntries.length) % agentEntries.length;

  agentEntries[nextIdx].terminal.show();
}

async function goToTerminal(context: vscode.ExtensionContext) {
  const allEntries = terminals.getAllTerminals();
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const items: TerminalQuickPickItem[] = [];
  const previewPromises: Array<{ itemIndex: number; entry: terminals.EditorTerminal; promise: Promise<{ firstUserMessage?: string; lastUserMessage?: string; lastActivityMs?: number; messageCount: number } | null> }> = [];

  const extensionPath = context.extensionPath;

  for (const entry of allEntries) {
    if (!entry.agentConfig) continue;

    const effectiveTitle = liveTitle(entry.sessionId) || entry.autoLabel || 'Untitled';
    const itemIndex = items.length;

    items.push({
      label: effectiveTitle,
      description: '',
      detail: '',
      iconPath: buildIconPath(entry.agentConfig.title, extensionPath) ?? undefined,
      terminal: entry.terminal
    });

    if (entry.sessionId) {
      previewPromises.push({
        itemIndex,
        entry,
        promise: getSessionPreviewForEntry(entry, workspacePath)
      });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage('No agent terminals open');
    return;
  }

  const previewResults = await Promise.all(previewPromises.map(p => p.promise));
  for (let i = 0; i < previewPromises.length; i++) {
    const previewPromise = previewPromises[i];
    const entry = previewPromise.entry;
    const idx = previewPromise.itemIndex;
    const info = previewResults[i];
    if (info) {
      if (info.lastActivityMs) {
        const diffMs = Date.now() - info.lastActivityMs;
        items[idx].description = diffMs < 60_000 ? 'Just now' : formatRelativeTime(info.lastActivityMs);
        items[idx].lastActivityMs = info.lastActivityMs;
      }

      const parts: string[] = [];
      if (info.firstUserMessage) parts.push(truncateText(info.firstUserMessage, 80));
      if (info.messageCount > 0) parts.push(`(${info.messageCount})`);
      items[idx].detail = parts.join(' ');
    }
  }

  items.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));

  const maxLabelLen = items.reduce((m, i) => Math.max(m, i.label.length), 0);
  const targetLen = maxLabelLen + 6;
  for (const item of items) {
    if (item.description) {
      const padCount = Math.max(1, targetLen - item.label.length);
      item.label = item.label + '\u00a0'.repeat(padCount);
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Go to terminal',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (selected) {
    selected.terminal.show();
  }
}

export async function openSingleAgentWithQueue(
  context: vscode.ExtensionContext,
  agentConfig: Omit<AgentConfig, 'count'>,
  messages: string[],
  // `cwd` starts the local terminal and, for an ordinary `host` launch, is sent
  // as portable `--cwd` for agents-cli to re-root. `remoteCwd` is already exact
  // on `host` and is reserved for a picked historical session.
  // `viewColumn` places the new tab: `Active` (the default) takes over the
  // current group, `Beside` splits so the launch sits next to what spawned it.
  opts?: { cwd?: string; remoteCwd?: string; mode?: AgentLaunchMode; sessionId?: string; strategy?: RunStrategy; host?: string; local?: boolean; viewColumn?: vscode.ViewColumn }
): Promise<{ terminalId: string; sessionId: string | null }> {
  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: opts?.viewColumn ?? vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const workspaceFolder = getActiveWorkspaceFolder()?.uri.fsPath || process.cwd();
  const terminalId = terminals.nextId(agentConfig.prefix);
  // An explicit cwd (task dispatch resolved the task's repo to a local clone)
  // pins the terminal there; otherwise use the workspace folder.
  const cwd = opts?.cwd ?? workspaceFolder;

  // Determine agent key and handle session ID
  const builtInDef = getBuiltInByPrefix(agentConfig.prefix);
  const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;
  const defaultModel = agentKey ? settingsStore.getDefaultModel(context, agentKey) : undefined;

  let command = agentConfig.command;
  let sessionId: string | null = null;
  let opencodeSessionsBefore: string[] | null = null;

  if (agentKey === 'opencode') {
    opencodeSessionsBefore = await listOpencodeSessions(cwd);
  }

  // Route every agent runner through `agents run <agent> --interactive` so
  // `--strategy balanced --mode auto` applies uniformly (shell is the only
  // non-runner). Claude gets a pre-generated session id for the resume flow; other
  // agents discover their session post-spawn. opts?.mode defaults to 'auto'
  // (writable-but-gated) inside buildAgentLaunchCommand when no mode is supplied.
  const targetHost = opts?.host && opts.host !== 'local' ? opts.host : undefined;
  if (agentKey && isAgentRunner(agentKey)) {
    if (agentKey === 'claude') {
      // Claude: generate session ID at open time; others are discovered post-spawn.
      // A caller (dispatch) may pre-supply the id so it can watch that exact
      // session file for a plan / completion afterwards.
      sessionId = opts?.sessionId ?? generateClaudeSessionId();
      command = buildAgentLaunchCommand(agentKey, sessionId, defaultModel, undefined, undefined, opts?.strategy, opts?.mode, {
        host: targetHost,
        local: opts?.local,
        cwd: opts?.remoteCwd ? undefined : cwd,
        remoteCwd: opts?.remoteCwd,
      });
    } else {
      command = buildAgentLaunchCommand(agentKey, null, defaultModel, undefined, undefined, opts?.strategy, opts?.mode, {
        host: targetHost,
        local: opts?.local,
        cwd: opts?.remoteCwd ? undefined : cwd,
        remoteCwd: opts?.remoteCwd,
      });
    }
  }

  const title = buildTerminalTitle(agentConfig.title, undefined, context, sessionId);
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: editorLocation,
    name: title,
    env: buildAgentTerminalEnv(terminalId, sessionId, cwd),
    cwd,
    isTransient: true
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  if (targetHost) terminals.setHost(terminal, targetHost);
  readiness.registerTerminal(terminal);

  // Track session ID and agent type. Any known harness is tracked, not just the
  // prewarm five (#1747) — this feeds the persistence path that restore/reopen
  // read, so grok/kimi/droid/antigravity tabs must be tracked here too or they
  // have nothing to come back to.
  const resumeKey = agentKey ? agentKeyFromSession(agentKey) : null;
  if (resumeKey) {
    // Set agent type unconditionally so the sessionTracker fs watcher can adopt
    // a session id when the CLI writes a fresh rollout/jsonl (Codex 0.124+
    // dropped session id from the TUI banner so this is the only signal).
    terminals.setAgentType(terminal, resumeKey);
    if (sessionId) {
      terminals.setSessionId(terminal, sessionId);
    }
  }

  // Pull focus from the webview so the terminal tab becomes the visible one.
  terminal.show(false);

  // Queue messages
  for (const msg of messages) {
    terminals.queueMessage(terminal, msg);
  }

  if (command) {
    // Always an agent-terminal here, never a shell tab (isShell is always
    // false). wrapNativeAgentCommand closes the tab on a clean exit, frames a
    // dropped --device link as a recoverable reconnect (RUSH-3125 F6), and
    // otherwise keeps it open with a readable status line on a launch failure
    // (RUSH-2593).
    await sendCommandWhenReady(terminal, wrapNativeAgentCommand(command, false));
  }

  // Arm agentReady detection (process-state probe).
  readiness.armAgentReady(terminal);

  if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
    detectOpencodeSessionId(terminal, cwd, opencodeSessionsBefore, context);
  }

  // Flush queued messages once the agent is ready to accept input.
  // Ink TUIs (Claude) watch for `\r` as Enter; `sendText(text, true)` appends
  // `\n` which types into the input but does NOT submit. See the resume flow
  // around line 2086 for the same workaround.
  // 45s hard-timeout fallback: if agentReady never fires (agent exits early,
  // slow machine), we still attempt delivery so the user sees the prompt.
  const AGENT_READY_FALLBACK_MS = 45_000;
  const flushQueued = () => {
    const queued = terminals.flushQueue(terminal);
    queued.forEach((msg, i) => {
      setTimeout(() => {
        terminal.sendText(msg, false);
        // Multi-line prompts go over the pty as a bracketed paste; a \r sent
        // in the same tick gets consumed as paste content and the input never
        // submits. Let the TUI finish ingesting the paste before Enter.
        setTimeout(() => terminal.sendText('\r', false), 300);
      }, i * 700);
    });
  };
  const fallbackHandle = setTimeout(flushQueued, AGENT_READY_FALLBACK_MS);
  readiness.waitFor(terminal, 'agentReady').then(() => {
    clearTimeout(fallbackHandle);
    flushQueued();
  }).catch(() => {
    // waitFor rejects on timeout — fallback handle already scheduled
  });

  return { terminalId, sessionId };
}

async function openAgentTerminals(context: vscode.ExtensionContext) {
  const agents = getAgentsToOpen(context);

  if (agents.length === 0) {
    vscode.window.showInformationMessage('No agents configured to open on login. Use "Agents" to configure.');
    return;
  }

  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  let totalCount = 0;

  for (const agent of agents) {
    for (let i = 0; i < agent.count; i++) {
      // Generate ID first for env var
      const terminalId = terminals.nextId(agent.prefix);

      // Determine agent key and handle session ID
      const builtInDef = getBuiltInByPrefix(agent.prefix);
      const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;
      const defaultModel = agentKey ? settingsStore.getDefaultModel(context, agentKey) : undefined;

      let sessionId: string | null = null;
      let opencodeSessionsBefore: string[] | null = null;

      if (agentKey === 'opencode') {
        opencodeSessionsBefore = await listOpencodeSessions(cwd);
      }

      if (agentKey === 'claude') {
        // Claude: generate session ID at open time; others are discovered post-spawn.
        sessionId = generateClaudeSessionId();
        console.log(`[SESSION] Auto-open Claude with session ID: ${sessionId}`);
      }
      const command = buildTabLaunchCommand(agentKey, { cwd, sessionId, defaultModel }) ?? agent.command;

      const title = buildTerminalTitle(agent.title, undefined, context, sessionId);

      const terminal = vscode.window.createTerminal({
        iconPath: agent.iconPath,
        location: editorLocation,
        name: title,
        env: buildAgentTerminalEnv(terminalId, sessionId, cwd),
        isTransient: true
      });

      const pid = await terminal.processId;
      terminals.register(terminal, terminalId, agent, pid, context);
      readiness.registerTerminal(terminal);

      // Track session ID for any known harness, not just the prewarm five (#1747):
      // this path also starts the label poller that hydrates the live session id,
      // so a grok/kimi/droid/antigravity tab needs it too to be resumable.
      const resumeKey = agentKey ? agentKeyFromSession(agentKey) : null;
      if (resumeKey) {
        // Set agent type unconditionally so sessionTracker fs watcher can adopt
        // a session id from the CLI's rollout file (Codex 0.124+ banner has none).
        terminals.setAgentType(terminal, resumeKey);
        if (sessionId) {
          terminals.setSessionId(terminal, sessionId);
        }
        startAutoLabelPollerForTerminal(terminal, context);
      }

      if (command) {
        try {
          await readiness.waitFor(terminal, 'promptReady');
        } catch (err) {
          console.warn(`[READINESS] promptReady wait failed: ${err}`);
        }
        if (terminal.shellIntegration) {
          terminal.shellIntegration.executeCommand(command);
        } else {
          terminal.sendText(command);
        }
        readiness.armAgentReady(terminal);
      }
      if (agentKey === 'opencode' && opencodeSessionsBefore !== null) {
        detectOpencodeSessionId(terminal, cwd, opencodeSessionsBefore, context);
      }
      totalCount++;
    }
  }

  if (totalCount > 0) {
    vscode.window.showInformationMessage(`Opened ${totalCount} agent terminal${totalCount > 1 ? 's' : ''}`);
  }
}

function isLocalDeviceName(name: string): boolean {
  return isLocalActiveMapKey(activeMapCacheKey(name));
}

/** The session's one name from its stream row (`streamTitle`): what its card and
 *  the status bar show. undefined until the stream knows one. */
function liveTitle(sessionId: string | undefined): string | undefined {
  const live = sessionId ? sessionPresentationStore.liveSession(sessionId) : undefined;
  return (live && streamTitle(live)) || undefined;
}

/** Put the session's stream title on the tab entry; the tab title follows it. */
async function fetchAndSetAutoLabel(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
): Promise<string | undefined> {
  const sessionId = entry.sessionId;
  if (!sessionId) return entry.autoLabel;

  // `--device auto` never records which box the CLI picked. The watch stream
  // does: stamp the machine so every later lookup (resume, identity) routes to
  // the transcript's owner instead of scanning this laptop.
  if (!entry.host) {
    const live = sessionPresentationStore.liveSession(sessionId);
    if (live?.machine && !isLocalDeviceName(live.machine)) terminals.setHost(terminal, live.machine);
  }

  const title = liveTitle(sessionId);
  if (title) terminals.setAutoLabel(terminal, title);
  return title ?? entry.autoLabel;
}

/**
 * Apply harness-owned names from the canonical fleet stream to editor tabs.
 * The stream is already elected once per editor process; this is presentation
 * reconciliation only, never another query or lifecycle loop.
 */
async function syncCanonicalSessionTabLabels(context: vscode.ExtensionContext): Promise<void> {
  const display = getDisplayPrefs(context);
  if (!display.autoLabelInTabTitles) return;

  for (const entry of terminals.getAllTerminals()) {
    if (!entry.sessionId || !entry.agentConfig) continue;
    const live = sessionPresentationStore.liveSession(entry.sessionId);
    if (!live) continue;
    const update = planSessionTabLabelUpdate({
      manualLabel: entry.label,
      autoLabel: entry.autoLabel,
    }, streamTitle(live));
    if (!update) continue;

    if (update.clearManualLabel) {
      await terminals.setLabel(entry.terminal, undefined, context);
    }
    terminals.setAutoLabel(entry.terminal, update.label);

    // Renaming briefly activates a terminal. Apply immediately only to the tab
    // the user is already viewing; an inactive tab stores the new autoLabel and
    // the existing focus handler renders it when that tab is next selected.
    if (vscode.window.activeTerminal !== entry.terminal) continue;
    updateStatusBarForTerminal(entry.terminal, context.extensionPath);
    if (display.showLabelsInTitles) {
      const newTitle = buildTerminalTitle(
        entry.agentConfig.title,
        update.label,
        context,
        entry.sessionId,
      );
      await terminals.renameTerminal(entry.terminal, newTitle);
    }
  }
}

// A remote tab that launches idless (picked-host Codex) needs its session id
// resolved before it can be labeled. Poll the shared per-host active map fast at
// first so the id lands within seconds of launch (the remote session indexes
// within a few seconds); the poller's own backoff then stretches the interval,
// and it stops entirely once a label is set.
const REMOTE_HYDRATE_POLL_MS = 3_000;

interface AutoLabelPollerOpts {
  /** Poll fast initially — used for idless remote tabs racing the remote index. */
  fast?: boolean;
}

function startAutoLabelPollerForTerminal(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext,
  opts: AutoLabelPollerOpts = {},
): void {
  void armAutoLabelPoller(terminal, context, opts);
}

/**
 * Build the pure-core hooks that let the auto-label poller resolve an idless
 * remote tab's canonical id from the shared per-host active map and then run the
 * host-aware label path. `onHydrated` funnels through applyHydratedSessionId, so
 * the id transition arms labeling for the polled tab and every host sibling
 * exactly as the local SessionStart watcher does.
 */
function remoteAutoLabelHooks(labelsEnabled = true): RemoteAutoLabelHooks {
  return {
    fetchMap: (host) => fetchTerminalIdSessionMap(host),
    needsHydrate: needsSessionIdHydrate,
    canonical: (raw) => canonicalSessionId(raw) ?? '',
    siblings: () => terminals.getAllTerminals().filter((t) => needsSessionIdHydrate(t.sessionId)).map((t) => ({
      id: t.id,
      host: t.host,
      sessionId: t.sessionId,
      manualSessionOverride: t.manualSessionOverride,
    })),
    onHydrated: (tabId, canonicalId) => {
      const t = terminals.getById(tabId);
      if (!t) return;
      applyHydratedSessionId(t.terminal, t, t.agentConfig?.prefix ?? '', canonicalId);
    },
    currentSessionId: (tabId) => terminals.getById(tabId)?.sessionId,
    fetchLabel: async (tabId) => {
      if (!labelsEnabled) return undefined;
      const t = terminals.getById(tabId);
      if (!t) return undefined;
      return fetchAndSetAutoLabel(t.terminal, t);
    },
  };
}

/**
 * Arm the auto-label lifecycle for a tab the moment it gains a canonical session
 * id — the remote-hydration counterpart to the local SessionStart watcher's
 * onSessionChanged. Idempotent (the underlying poller no-ops when one is already
 * running or a real label exists), so it is safe to call on every id transition.
 */
function armLabelingAfterHydration(terminal: vscode.Terminal, entry: terminals.EditorTerminal): void {
  if (!entry.agentType || !extensionContext) return;
  startAutoLabelPollerForTerminal(terminal, extensionContext);
}

async function armAutoLabelPoller(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext,
  opts: AutoLabelPollerOpts = {},
): Promise<void> {
  const entry = terminals.getByTerminal(terminal);
  if (!entry || !entry.agentType) return;
  // A tab needs an id before it can be labeled. Local tabs already have one
  // (minted up front / resolved by the SessionStart watcher). A remote offload
  // may still be idless right after launch — its session is not indexed yet — so
  // the poller resolves the id first from the shared per-host active map, exactly
  // as the local watcher resolves it from the state file before arming.
  const remoteIdless = !!entry.host && needsSessionIdHydrate(entry.sessionId);
  if (!entry.sessionId && !remoteIdless) return;
  const display = getDisplayPrefs(context);
  const labelsEnabled = display.autoLabelInTabTitles;
  // Session identity is required by the status bar, table, fork, and resume
  // surfaces. It must hydrate even when optional automatic tab labels are off.
  if (!labelsEnabled && !remoteIdless) return;

  if ((entry.label || entry.autoLabel) && !remoteIdless) return;

  const intervalMs = opts.fast ? REMOTE_HYDRATE_POLL_MS : undefined;
  terminals.startAutoLabelPoller(terminal, async () => {
    const cur = terminals.getByTerminal(terminal);
    if (!cur) return;

    let autoLabel: string | undefined;
    if (cur.host && needsSessionIdHydrate(cur.sessionId)) {
      // Still idless remote: resolve the id (and host siblings') from the shared
      // active map, then label — bare CX -> canonical UUID -> topic title in one
      // tick, no refocus. The fetch is coalesced per host, so N tabs never open N
      // SSH streams.
      const res = await hydrateRemoteTabTick(cur.id, cur.host, remoteAutoLabelHooks(labelsEnabled));
      autoLabel = res.label;
      if (res.hydratedIds.includes(cur.id) && vscode.window.activeTerminal === terminal) {
        updateStatusBarForTerminal(terminal, context.extensionPath);
      }
      if (!labelsEnabled && res.hydratedIds.includes(cur.id)) {
        terminals.stopAutoLabelPoller(terminal);
        return;
      }
    } else {
      if (!labelsEnabled) {
        terminals.stopAutoLabelPoller(terminal);
        return;
      }
      autoLabel = await fetchAndSetAutoLabel(terminal, cur);
    }

    if (!autoLabel || vscode.window.activeTerminal !== terminal) return;
    updateStatusBarForTerminal(terminal, context.extensionPath);
    // Refresh the tab title too, not just the status bar — otherwise a label
    // that resolves while you're sitting on the tab never shows until the next
    // focus change. Renaming briefly activates the terminal, so this is gated
    // on the terminal already being active (same focus-safe guard as
    // tryFetchLabelOnFocus).
    const display = getDisplayPrefs(context);
    if (display.showLabelsInTitles && display.autoLabelInTabTitles && cur.agentConfig) {
      const newTitle = buildTerminalTitle(
        cur.agentConfig.title,
        autoLabel,
        context,
        cur.sessionId
      );
      await terminals.renameTerminal(terminal, newTitle);
    }
  }, intervalMs);
}

// Arm shell-adoption on an SH terminal: poll its descendant process tree for
// a known agent CLI (claude/codex/cursor/opencode). On detection,
// re-register the entry as the detected agent so the sidebar, session
// tracker, label generation, autogit, and recap all treat it as that agent.
// The VS Code tab icon is immutable so it keeps the SH chip — internal
// state and downstream display only.
function armShellAdoptionForTerminal(terminal: vscode.Terminal, context: vscode.ExtensionContext): void {
  const entry = terminals.getByTerminal(terminal);
  if (!entry) {
    readiness.adoptionLog(`armShellAdoptionForTerminal: "${terminal.name}" not in terminals registry — skipping`);
    return;
  }
  if (entry.agentConfig?.prefix !== 'sh') {
    readiness.adoptionLog(`armShellAdoptionForTerminal: "${terminal.name}" prefix=${entry.agentConfig?.prefix}, not 'sh' — skipping`);
    return;
  }

  readiness.adoptionLog(`armShellAdoptionForTerminal: calling readiness.armShellAdoption for "${terminal.name}" (id=${entry.id})`);

  readiness.armShellAdoption(terminal, ({ agentKey, sessionId }) => {
    readiness.adoptionLog(`armShellAdoptionForTerminal callback: agentKey=${agentKey} sessionId=${sessionId} terminal="${terminal.name}"`);
    const def = getBuiltInByKey(agentKey);
    if (!def) {
      readiness.adoptionLog(`armShellAdoptionForTerminal callback: no built-in def for "${agentKey}" — aborting`);
      console.warn(`[ADOPT] No built-in def for agent key "${agentKey}"`);
      return;
    }
    const newConfig = createAgentConfig(
      context.extensionPath,
      def.title,
      def.command,
      def.icon,
      def.prefix
    );
    const adopted = terminals.adoptShellAsAgent(terminal, newConfig, agentKey, sessionId);
    readiness.adoptionLog(`armShellAdoptionForTerminal callback: adoptShellAsAgent returned ${adopted}`);
    if (!adopted) return;
    if (sessionId && supportsPrewarming(agentKey)) {
      startAutoLabelPollerForTerminal(terminal, context);
    }
    if (vscode.window.activeTerminal === terminal) {
      updateStatusBarForTerminal(terminal, context.extensionPath);
    }
  });
}

/**
 * Try to fetch and set the auto-label when terminal gains focus.
 * This provides immediate label update instead of waiting for the 5-minute poller.
 * Also updates the terminal tab title if showLabelsInTitles is enabled.
 */
async function tryFetchLabelOnFocus(
  terminal: vscode.Terminal,
  context: vscode.ExtensionContext
): Promise<void> {
  const entry = terminals.getByTerminal(terminal);
  if (!entry) return;

  // Need sessionId and agentType to fetch label
  if (!entry.sessionId || !entry.agentType) return;

  // A label fetched while this tab was unfocused is already on the entry, but
  // the title update is gated on `activeTerminal === terminal` — so focusing
  // later used to no-op and leave the bare agent chip forever.
  const existing = entry.label || entry.autoLabel;
  const autoLabel = existing ?? await fetchAndSetAutoLabel(terminal, entry);
  if (!autoLabel) return;

  // Update status bar
  updateStatusBarForTerminal(terminal, context.extensionPath);

  // Update terminal tab title if showLabelsInTitles is enabled.
  // Bail when the user has navigated away during the async LLM fetch — the
  // rename has to briefly activate this terminal, which switches the visible
  // editor tab. The label is already stored on the entry, so the next time
  // this terminal gets focus the title picks it up.
  const display = getDisplayPrefs(context);
  if (
    display.showLabelsInTitles &&
    display.autoLabelInTabTitles &&
    entry.agentConfig &&
    vscode.window.activeTerminal === terminal
  ) {
    const newTitle = buildTerminalTitle(
      entry.agentConfig.title,
      autoLabel,
      context,
      entry.sessionId
    );
    await terminals.renameTerminal(terminal, newTitle);
  }
}


// The host badge for the status bar: the tab's executing device (entry.host,
// stamped from the stream's `machine`), shortened against the known-device
// roster so a shared fleet stem collapses (`yosemite-m3` → `m3`). Returns null
// for a local session — nothing to show. Reads only the synchronous roster
// cache the ext already holds; no new fetch (thin-client rule). PHNX-3893.
function remoteHostBadge(host: string | null | undefined): string | null {
  if (!host || isLocalDeviceName(host)) return null;
  return deviceBadge(host, (getRegisteredDevicesCache() ?? []).map((d) => d.name));
}

function renderAgentStatusBar(...args: Parameters<typeof formatAgentStatusBarText>): void {
  if (!agentStatusBarItem) return;
  const host = args[6];
  const badge = remoteHostBadge(host);
  args[6] = badge;
  agentStatusBarItem.text = formatAgentStatusBarText(...args);
  agentStatusBarItem.tooltip = formatAgentStatusBarTooltip(args[4], badge ? host : null);
}

// Identity comes only from the pushed stream: the former per-tab fetch caused
// the 2026-08-25 CPU incident (RUSH-3184, agi-cli#3019).
function applyStreamIdentity(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
  sessionId: string,
): void {
  const live = sessionPresentationStore.liveSession(sessionId);
  const stamp = resolveStreamIdentityStamp(live, sessionId, entry.sessionId);
  // Not yet indexed on the stream, or the tab has moved on to another session:
  // leave it untouched (blank-until-resolved beats a prior binding's leftover).
  // The next stream event retries.
  if (!stamp) return;
  // Apply AUTHORITATIVELY, clearing a field the session does not carry. A
  // Kimi/Grok row has no account (and Kimi no version), so a value left over from
  // a prior binding in this terminal (e.g. a stale 2.1.218) must be cleared, not
  // preserved. setVersion/setAccount treat null as "clear".
  if ((entry.version ?? undefined) !== (stamp.version ?? undefined)) {
    terminals.setVersion(terminal, stamp.version);
  }
  if ((entry.account ?? undefined) !== (stamp.account ?? undefined)) {
    terminals.setAccount(terminal, stamp.account);
  }
  // displayIdentity gates the status bar on this marker, so it shows only the
  // current session's identity — even when a field is null (Grok has a version
  // but no account) — and withholds a prior binding's leftover.
  entry.identityAppliedSessionId = stamp.identityAppliedSessionId;
}

const liveSessionInFlight = new Set<string>();

/**
 * Stamp a resolved session id on the tab, refresh identity + status bar.
 * Id is always stored in canonical form (UUID, not a rollout-… stem).
 */
function applyHydratedSessionId(
  terminal: vscode.Terminal,
  entry: terminals.EditorTerminal,
  prefix: string,
  rawId: string,
  options: { armLabeling?: boolean } = {},
): void {
  const liveId = canonicalSessionId(rawId);
  if (!liveId) return;
  if (entry.sessionId !== liveId) {
    terminals.setSessionId(terminal, liveId);
    // `--device auto` never knew the machine at launch. The watch stream does.
    const live = sessionPresentationStore.liveSession(liveId);
    if (!entry.host && live?.machine && !isLocalDeviceName(live.machine)) {
      terminals.setHost(terminal, live.machine);
    }
    // Focus/poller hydration arms the auto-label lifecycle — the same transition
    // the local SessionStart watcher performs via onSessionChanged. Stream-driven
    // rebinding opts out because it must not create a side-channel session poll.
    // Idempotent: startAutoLabelPoller no-ops when a poller is already running or
    // a real label already exists (RUSH-2411).
    if (options.armLabeling !== false) {
      armLabelingAfterHydration(terminal, entry);
    }
  }
  applyStreamIdentity(terminal, entry, liveId);
  if (!agentStatusBarItem || vscode.window.activeTerminal !== terminal) return;
  const displayLabel = presentableLabel(liveTitle(liveId) ?? entry.autoLabel);
  const { version, account } = displayIdentity(entry, liveId);
  renderAgentStatusBar(
    getExpandedAgentName(prefix),
    version,
    account,
    displayLabel,
    liveId,
    entry.agentType === 'codex',
    entry.host,
  );
}

/**
 * Reconcile every tracked editor tab against the canonical session stream.
 *
 * This runs only when a pushed stream fact is accepted. It is the missing
 * event-driven half of tryHydrateLiveSessionId: reusing an already-focused
 * terminal for session B produces no VS Code focus event, so the old A binding
 * otherwise survives until an unrelated refocus. Grouping by execution host
 * preserves the owner boundary, while terminalSessionMap applies the observer
 * boundary and rejects genuinely ambiguous claims.
 */
function syncTerminalSessionBindingsFromStream(): void {
  const plan = planSessionStreamRebinds(
    terminals.getAllTerminals()
      .filter((entry) => !!entry.agentConfig)
      .map((entry) => ({ id: entry.id, host: entry.host, sessionId: entry.sessionId, manualSessionOverride: entry.manualSessionOverride })),
    LOCAL_MACHINE_ID,
  );
  for (const step of plan) {
    const entry = terminals.getById(step.id);
    if (!entry) continue;
    // A stream-driven A -> B correction must stay purely event-driven. In
    // particular it must not arm the legacy label poller, whose label source is
    // a side-channel session fetch. Stream identity/labels refresh below.
    applyHydratedSessionId(
      entry.terminal,
      entry,
      entry.agentConfig?.prefix ?? '',
      step.canonicalId,
      { armLabeling: false },
    );
  }
}

/**
 * Resolve the live session id for a tab without per-tab polling thrash.
 *
 * Reads the shared CLI session projection joined on AGENT_TERMINAL_ID. The
 * stream is the only identity source for local and offloaded tabs; an awaited
 * local state-file read must not race a pushed A -> B rebind.
 *
 * Failures leave the id unmapped (blank bar), never invent a wrong id.
 */
async function tryHydrateLiveSessionId(
  terminal: vscode.Terminal,
  prefix: string
): Promise<void> {
  const entry = terminals.getByTerminal(terminal);
  if (!entry || entry.manualSessionOverride !== undefined) return;
  const inflightKey = entry.id || `live:${terminal.name}`;
  if (liveSessionInFlight.has(inflightKey)) return;
  liveSessionInFlight.add(inflightKey);

  try {
    // Normalize display metadata locally. Established bindings are reconciled
    // only by syncTerminalSessionBindingsFromStream on accepted row facts.
    if (entry.sessionId && !needsSessionIdHydrate(entry.sessionId)) {
      const cleaned = canonicalSessionId(entry.sessionId);
      if (cleaned && cleaned !== entry.sessionId) {
        applyHydratedSessionId(terminal, entry, prefix, cleaned);
      }
    }

    // Read the existing stream projection for unresolved host siblings.
    const map = await fetchTerminalIdSessionMap(entry.host);
    const hostTabs = terminals.getAllTerminals()
      .filter((t) => (t.host ?? '') === (entry.host ?? '') && needsSessionIdHydrate(t.sessionId));
    const plan = planActiveMapHydration(
      map,
      hostTabs.map((t) => ({ id: t.id, host: t.host, sessionId: t.sessionId, manualSessionOverride: t.manualSessionOverride })),
      { needsHydrate: needsSessionIdHydrate, canonical: (raw) => canonicalSessionId(raw) ?? '' },
    );
    for (const step of plan) {
      const t = terminals.getById(step.id);
      if (!t) continue;
      const stampPrefix = t.terminal === terminal ? prefix : (t.agentConfig?.prefix ?? prefix);
      applyHydratedSessionId(t.terminal, t, stampPrefix, step.canonicalId);
    }
    if (plan.some((step) => step.id === entry.id)) {
      return;
    }

    // Still missing: show tracking hint for Codex-style agents if any.
    if (
      agentStatusBarItem &&
      vscode.window.activeTerminal === terminal &&
      needsSessionIdHydrate(entry.sessionId)
    ) {
      const displayLabel = presentableLabel(liveTitle(entry.sessionId) ?? entry.autoLabel);
      const { version, account } = displayIdentity(entry, entry.sessionId);
      renderAgentStatusBar(
        getExpandedAgentName(prefix),
        version,
        account,
        displayLabel,
        entry.sessionId,
        entry.agentType === 'codex' || entry.agentType === 'grok',
        entry.host,
      );
    }
  } finally {
    liveSessionInFlight.delete(inflightKey);
  }
}

function updateStatusBarForTerminal(terminal: vscode.Terminal, extensionPath: string) {
  if (!agentStatusBarItem) return;

  const entry = terminals.getByTerminal(terminal);
  const info = identifyAgentTerminal(terminal, extensionPath);

  // If this is an agent terminal, show model/account/session metadata.
  // Format: "Agents: Claude 2.1.118 <user@example.com> - <session title> (uuid)"
  if (info.isAgent && info.prefix) {
    const expandedName = getExpandedAgentName(info.prefix);
    const sessionId = entry?.sessionId;

    // When we already know the session id (e.g. an offloaded --device tab, where the
    // live-id lookup below can't reach the remote box), stamp its real
    // version/account from the broadcast watch row BEFORE rendering the bar, so the
    // identity shows immediately from the stream projection. No side-channel spawn:
    // this is the single-stream read that replaced the per-tab by-id session
    // fetch (RUSH-3184). We deliberately do NOT fall back to `agents view` machine
    // defaults when there is no id — that showed a version and account unrelated to
    // the running session (the reported bug).
    if (entry && sessionId) {
      applyStreamIdentity(terminal, entry, sessionId);
    }

    // Show status bar with the current (now stream-stamped) identity.
    // The session's one name, as its tab and card show it (PHNX-4387).
    const displayLabel = presentableLabel(liveTitle(sessionId) ?? entry?.autoLabel);
    const { version, account } = displayIdentity(entry, sessionId);
    renderAgentStatusBar(
      expandedName,
      version,
      account,
      displayLabel,
      sessionId,
      entry?.agentType === 'codex',
      entry?.host,
    );

    // Read the shared stream projection to hydrate an as-yet unidentified tab.
    void tryHydrateLiveSessionId(terminal, info.prefix);

    return;
  }

  // Not an agent terminal - show "Terminal" for regular shells
  agentStatusBarItem.text = 'Agents: Terminal';
  agentStatusBarItem.tooltip = undefined;
}

/**
 * Agents: Rename Session. Renames the session itself, never only the tab: Claude's
 * own `/rename` writes the name into its transcript, the CLI indexes it as the
 * session's label, and the stream brings it back to the tab, the card and the
 * status bar (PHNX-4387). agents-cli has no rename verb, and the other harnesses
 * have no rename the CLI reads, so the command says so instead of faking a name.
 */
async function renameFrontSession(context: vscode.ExtensionContext): Promise<void> {
  const terminal = frontTerminal();
  const info = terminal ? identifyAgentTerminal(terminal, context.extensionPath) : undefined;
  if (!terminal || !info?.isAgent) {
    vscode.window.showInformationMessage('Rename needs an agent tab in front.');
    return;
  }
  if (info.prefix !== CLAUDE_TITLE) {
    vscode.window.showInformationMessage(`${getExpandedAgentName(info.prefix ?? '')} has no rename the CLI reads, so its name comes from the session.`);
    return;
  }
  const entry = terminals.getByTerminal(terminal);
  const input = await vscode.window.showInputBox({
    prompt: 'Rename this session (Claude /rename)',
    value: liveTitle(entry?.sessionId) ?? entry?.autoLabel ?? '',
  });
  const name = sanitizeLabel(input?.trim() ?? '');
  if (!name) return;
  terminal.sendText(`/rename ${name}`, true);
}

async function clearActiveTerminal(context: vscode.ExtensionContext) {
  try {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      vscode.window.showErrorMessage('No active terminal to clear.');
      return;
    }

    const agentConfig = getAgentConfigFromTerminal(terminal, context);
    if (!agentConfig) {
      vscode.window.showErrorMessage('Could not identify agent type from active terminal.');
      return;
    }

    // Get agent type info for session handling
    const builtInDef = getBuiltInDefByTitle(agentConfig.title);
    const agentKey = builtInDef?.key as keyof AgentSettings['builtIn'] | undefined;

    // 1. Terminate current agent (Ctrl+C twice)
    terminal.show();
    await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
      text: '\u0003'
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
      text: '\u0003'
    });

    // Wait for the agent to release the pty and the shell prompt to reappear
    readiness.resetAfterAgentExit(terminal);
    try {
      await readiness.waitFor(terminal, 'promptReady');
    } catch (err) {
      console.warn(`[READINESS] promptReady wait after agent exit failed: ${err}`);
    }

    try {
      // 2. Generate the session id; the shell keeps its terminal identity.
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      const defaultModel = agentKey ? settingsStore.getDefaultModel(context, agentKey) : undefined;
      // Claude: generate UUID on-demand
      const newSessionId = agentKey === 'claude' ? generateClaudeSessionId() : null;
      // The relaunch stays where the tab runs: this machine, or the device it was offloaded to.
      const command = buildTabLaunchCommand(agentKey, {
        cwd,
        host: terminals.getByTerminal(terminal)?.host,
        sessionId: newSessionId,
        defaultModel,
      }) ?? agentConfig.command;

      // 4. Set new session/agent type
      if (agentKey && supportsPrewarming(agentKey)) {
        terminals.setAgentType(terminal, agentKey);
      }
      terminals.setSessionId(terminal, newSessionId ?? '', true);

      // 5. Clear labels and start fresh poller
      await terminals.setLabel(terminal, undefined, context);
      terminals.setAutoLabel(terminal, undefined);
      startAutoLabelPollerForTerminal(terminal, context);

      // 6. Unpin terminal
      await vscode.commands.executeCommand('workbench.action.unpinEditor');

      // 7. Update title with new session ID chunk
      const newTitle = buildTerminalTitle(agentConfig.title, null, context, newSessionId);
      await terminals.renameTerminal(terminal, newTitle);

      // 8. Restart agent with new session
      terminal.sendText('clear && ' + command);
      readiness.armAgentReady(terminal);

      // 9. Update status bar
      updateStatusBarForTerminal(terminal, context.extensionPath);

      const agentNum = terminals.getByTerminal(terminal)?.id.split('-').pop() || '';
      const numSuffix = agentNum ? ` agent # ${agentNum}` : ' agent';
      vscode.window.showInformationMessage(`Cleared ${getExpandedAgentName(agentConfig.title)}${numSuffix} (new session)`);
    } catch (sendError) {
      vscode.window.showWarningMessage('Terminal may have been closed. Please open a new agent terminal.');
    }
  } catch (error) {
    console.error('Error clearing terminal:', error);
    vscode.window.showErrorMessage(`Failed to clear terminal: ${error}`);
  }
}

async function reloadActiveTerminal(context: vscode.ExtensionContext) {
  try {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      vscode.window.showErrorMessage('No active terminal to reload.');
      return;
    }

    const entry = terminals.getByTerminal(terminal);
    if (!entry || !entry.agentConfig) {
      vscode.window.showErrorMessage('Active terminal is not an agent terminal.');
      return;
    }

    const agentConfig = entry.agentConfig;
    if (agentConfig.prefix) {
      await tryHydrateLiveSessionId(terminal, agentConfig.prefix);
    }
    const sessionId = entry.sessionId;
    const agentType = entry.agentType;

    if (!sessionId || !agentType) {
      vscode.window.showErrorMessage('This terminal does not have session tracking enabled. Reload requires a session ID.');
      return;
    }

    // Any known harness with a transcript can reload, not just the prewarm five —
    // `agents run --resume` resumes grok/kimi/droid/antigravity too (#1747). Only
    // a shell / unknown tab has nothing to reload.
    if (!agentKeyFromSession(agentType)) {
      vscode.window.showErrorMessage('This agent type does not support session reload.');
      return;
    }

    // Let the agent exit cleanly (prewarm agents have tuned exit keys, the rest
    // Ctrl+C twice), then replace the tab: a new tab whose own process is the
    // resume, so no command is typed above the agent.
    terminal.show();
    for (const seq of exitSequenceFor(agentType)) {
      await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: seq });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Reopen only once the old agent is gone, or the new tab's resume meets the
    // still-running process.
    if (!(await terminals.waitForAgentExit(entry))) {
      vscode.window.showWarningMessage(`The agent in this tab is still running after its exit keys, so it was not reloaded (no second copy opened).`);
      return;
    }
    terminals.unregister(terminal);
    terminal.dispose();
    await openAgentSessionTerminal(context, {
      id: sessionId,
      shortId: sessionId.slice(0, 8),
      agent: agentType,
      version: entry.version,
      account: entry.account,
      host: entry.host,
    });
  } catch (error) {
    console.error('Error reloading terminal:', error);
    vscode.window.showErrorMessage(`Failed to reload terminal: ${error}`);
  }
}

async function updateContextKeys(context: vscode.ExtensionContext): Promise<void> {
  const readerEnabled = settingsStore.getSettings(context).editor?.markdownViewerEnabled ?? true;
  await vscode.commands.executeCommand('setContext', 'agents.readerEnabled', readerEnabled);
}

function updateActiveAgentContextKey(
  terminal: vscode.Terminal | undefined,
  extensionPath: string
): void {
  const isAgent = !!terminal && identifyAgentTerminal(terminal, extensionPath).isAgent;
  vscode.commands.executeCommand('setContext', 'agents.activeIsAgent', isAgent);
}

async function closeActiveAgentWithRecap(context: vscode.ExtensionContext): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    await vscode.commands.executeCommand('workbench.action.terminal.kill');
    return;
  }

  const entry = terminals.getByTerminal(terminal);
  if (entry?.agentConfig?.prefix) {
    await tryHydrateLiveSessionId(terminal, entry.agentConfig.prefix);
  }
  const agentType = entry?.agentType;
  const sessionId = entry?.sessionId;
  const version = entry?.version;
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Not an agent terminal, or missing info we need — fall back to default close.
  if (!entry?.agentConfig || !sessionId || !agentType || !workspacePath || !isRecapSupported(agentType)) {
    await vscode.commands.executeCommand('workbench.action.terminal.kill');
    return;
  }

  // Launch the headless recap before disposing so the JSONL has stabilized.
  // We await up to the spawn() so we know the child has the file handle;
  // child.unref() inside runRecapHeadless means it survives this function.
  try {
    await runRecapHeadless({
      sessionId,
      agentType,
      version,
      workspacePath,
      extensionPath: context.extensionPath,
    });
  } catch (err) {
    console.warn('[recap] runRecapHeadless failed', err);
  }

  try {
    terminal.dispose();
  } catch (err) {
    console.warn('[recap] terminal.dispose() failed', err);
  }
}

async function maybeRunFirstSetup(context: vscode.ExtensionContext, force = false): Promise<void> {
  const already = context.globalState.get<boolean>('agents.setupComplete', false);
  if (already && !force) {
    const stored = context.globalState.get<string>('agents.defaultAgentTitle');
    if (stored) {
      defaultAgentTitle = stored;
    }
    const storedSecondary = context.globalState.get<string>('agents.secondaryAgentTitle');
    if (storedSecondary) {
      secondaryAgentTitle = storedSecondary;
    }
    return;
  }

  // Set default agents on first setup
  defaultAgentTitle = CLAUDE_TITLE;
  secondaryAgentTitle = CODEX_TITLE;
  await context.globalState.update('agents.defaultAgentTitle', CLAUDE_TITLE);
  await context.globalState.update('agents.secondaryAgentTitle', CODEX_TITLE);

  // Ensure swarm MCP + command is enabled for the detected default agent only
  try {
    const def = getBuiltInDefByTitle(defaultAgentTitle);
    const cliAgent = def && ['claude', 'codex'].includes(def.key) ? def.key as swarm.AgentCli : undefined;
    if (cliAgent) {
      const status = await swarm.getSwarmStatus();
      const agentStatus = status.agents[cliAgent];
      if (agentStatus.cliAvailable && (!agentStatus.mcpEnabled || !agentStatus.commandInstalled)) {
        await swarm.setupSwarmIntegrationForAgent(cliAgent, context);
      }
    }
  } catch {
    // Non-fatal; user can rerun setup
  }

  await context.globalState.update('agents.setupComplete', true);
  vscode.window.showInformationMessage(`Agents setup completed. Default agent: ${defaultAgentTitle}.`);
}

// Git functions are now in ./git.vscode

async function spawnWithPrompt(
  context: vscode.ExtensionContext,
  args?: { agent?: string; prompt?: string }
): Promise<void> {
  let agentKey: string | undefined = args?.agent;
  let prompt: string | undefined = args?.prompt;

  if (!agentKey) {
    const items = BUILT_IN_AGENTS.map(a => ({ label: a.title, description: a.key }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Pick agent type' });
    if (!picked) return;
    agentKey = picked.description!;
  }

  if (prompt === undefined) {
    prompt = await vscode.window.showInputBox({ prompt: 'Prompt to send to the new agent' });
    if (prompt === undefined) return;
  }
  if (!prompt.trim()) return;

  const def = getBuiltInByKey(agentKey);
  if (!def) {
    vscode.window.showErrorMessage(`Unknown agent: ${agentKey}`);
    return;
  }

  const agentConfig = createAgentConfig(context.extensionPath, def.title, def.command, def.icon, def.prefix);
  await openSingleAgentWithQueue(context, agentConfig, [prompt]);
}

async function spawnWithContext(context: vscode.ExtensionContext): Promise<void> {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showErrorMessage('No active terminal to continue from.');
    return;
  }

  const entryBefore = terminals.getByTerminal(activeTerminal);
  if (entryBefore?.agentConfig?.prefix) {
    await tryHydrateLiveSessionId(activeTerminal, entryBefore.agentConfig.prefix);
  }

  const entry = terminals.getByTerminal(activeTerminal);
  if (!entry?.sessionId) {
    vscode.window.showErrorMessage('No session ID found for the active terminal.');
    return;
  }

  if (!entry.agentConfig) {
    vscode.window.showErrorMessage('Active terminal is not an agent terminal.');
    return;
  }

  await openSingleAgentWithQueue(context, entry.agentConfig, [`/continue ${entry.sessionId}`]);
}

/**
 * `Agents: Fork` — a sibling of the tab you are sitting in, same harness, same
 * transcript, on the machine the session already lives on.
 *
 * `Agents: Fork (Pick Host)` (`pickHost: true`) is the same fork with one extra
 * step: you choose the device first, and the sibling starts THERE. Everything
 * else is deliberately held constant — the harness is the source's harness, and
 * the account still rotates through `--strategy balanced` — so the only variable
 * is the machine. The pair is recorded as a fork edge so the Recap ledger can
 * show parent and fork side by side once they finish.
 */
/**
 * Open a TRACKED editor terminal that runs an arbitrary agent command — the fork
 * verb (`agents fork <id> [--device <host>]`). The tracked terminal's
 * AGENT_TERMINAL_ID env propagates into the verb's `agents run` child (the verb
 * inherits the env), so the sibling session publishes under this terminalId and
 * lineage / restore / stream tracking keep working. Mirrors the tracked-terminal
 * setup in openSingleAgentWithQueue — including arming agentReady — minus the
 * message queue and the up-front session id, which the fork verb mints itself.
 */
async function openForkTerminal(
  context: vscode.ExtensionContext,
  agentConfig: Omit<AgentConfig, 'count'>,
  command: string,
  opts: { forkHost?: string; viewColumn?: vscode.ViewColumn; sourceTitle: string },
): Promise<void> {
  // Named after its source before it starts; the fork's own title replaces it
  // once the stream has one, and a failed fork verb says so (PHNX-4387).
  const label = forkTabLabel(opts.sourceTitle);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const terminalId = terminals.nextId(agentConfig.prefix);
  const builtInDef = getBuiltInByPrefix(agentConfig.prefix);
  const agentKey = builtInDef?.key;

  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: { viewColumn: opts.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: false },
    name: buildTerminalTitle(agentConfig.title, label, context, null),
    env: buildAgentTerminalEnv(terminalId, null, workspaceFolder),
    isTransient: true,
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);
  terminals.setAutoLabel(terminal, label);
  const watch = [
    vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.terminal !== terminal || !forkFailed(e.execution.commandLine.value, e.exitCode)) return;
      const failed = forkTabLabel(opts.sourceTitle, true);
      terminals.setAutoLabel(terminal, failed);
      void terminals.renameTerminal(terminal, buildTerminalTitle(agentConfig.title, failed, context, null));
    }),
    vscode.window.onDidCloseTerminal((t) => { if (t === terminal) watch.forEach((d) => d.dispose()); }),
  ];
  // Stamp the host so the label poller / remote id resolution reads the sibling
  // from that box's active feed rather than looking it up locally.
  if (opts.forkHost) terminals.setHost(terminal, opts.forkHost);
  readiness.registerTerminal(terminal);
  // Arm agentReady like the launcher this mirrors.
  readiness.armAgentReady(terminal);

  const resumeKey = agentKey ? agentKeyFromSession(agentKey) : null;
  if (resumeKey) terminals.setAgentType(terminal, resumeKey);

  terminal.show(false);
  await sendCommandWhenReady(terminal, wrapNativeAgentCommand(command, false));
}

async function forkCurrentSession(
  context: vscode.ExtensionContext,
  opts: { pickHost?: boolean } = {},
): Promise<void> {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    vscode.window.showErrorMessage('No active terminal to fork.');
    return;
  }

  const entryBefore = terminals.getByTerminal(activeTerminal);
  if (entryBefore?.agentConfig?.prefix) {
    await tryHydrateLiveSessionId(activeTerminal, entryBefore.agentConfig.prefix);
  }

  const entry = terminals.getByTerminal(activeTerminal);
  if (!entry?.agentConfig) {
    vscode.window.showErrorMessage('Active terminal is not an agent terminal.');
    return;
  }

  const source = {
    sessionId: entry.sessionId,
    agentKey: entry.agentType ?? prefixToAgentType(entry.agentConfig.prefix) ?? undefined,
    // Where the TRANSCRIPT is. A moved fork has to read it from here, wherever
    // it ends up running.
    host: entry.host,
    localHost: LOCAL_MACHINE_ID,
  };

  const sourceTitle = liveTitle(entry.sessionId) ?? entry.autoLabel ?? shortSessionId(entry.sessionId ?? '');

  if (opts.pickHost) {
    await handleForkPickHost({
      source,
      pickHost: async (agentKey) => {
        const harness = getBuiltInByKey(agentKey)?.title ?? agentKey;
        return pickLaunchHost(`Fork this ${harness} session — run on…`);
      },
      openFork: async ({ command, host, viewColumn }) => openForkTerminal(
        context,
        entry.agentConfig!,
        command,
        { forkHost: host, viewColumn, sourceTitle },
      ),
      showRejection: showForkRejection,
      // Open the fork as a normal full tab in the active group, not a side
      // split — it is a fresh session, not a pane to sit beside its parent.
      viewColumn: vscode.ViewColumn.Active,
    });
    return;
  }

  // The standard command keeps the source session on its own host.
  const request = buildForkSessionRequest(source);
  if (!request.ok) {
    showForkRejection(request.reason);
    return;
  }

  // Fork identity/copy semantics belong to agents-cli — the verb resolves the
  // source cross-fleet and launches a recap-seeded same-harness sibling. The
  // extension only opens the tracked terminal that presents the command and
  // whose AGENT_TERMINAL_ID the verb's child inherits for lineage tracking.
  await openForkTerminal(context, entry.agentConfig, forkCommand(request.sessionId, request.host), {
    forkHost: request.host,
    viewColumn: vscode.ViewColumn.Active,
    sourceTitle,
  });
  vscode.window.setStatusBarMessage(`Forking ${shortSessionId(request.sessionId)} through agents-cli`, 5000);
}

function showForkRejection(reason: 'no_session' | 'no_agent'): void {
  vscode.window.showErrorMessage(
    reason === 'no_session'
      ? 'No session ID found for the active terminal.'
      : 'No agent harness found for the active terminal.',
  );
}

/** First segment of a session id — enough to recognize it, short enough for a status line. */
function shortSessionId(sessionId: string): string {
  return sessionId.split('-')[0] ?? sessionId;
}

// --- The session browser (Agents: Fork (Pick Session)) ----------------------
// `Agents: Fork` forks the tab you are sitting in. This is the other half: browse
// every recent transcript — on this machine, or on any fleet device you switch to
// — and fork the one you pick. A row's machine is where its fork runs, so picking
// a session that lives on `yosemite-s0` starts the sibling agent THERE (over
// `agents run --device`), where its transcript actually is.

/** Rows requested from the one device currently shown in the browser. Enough to
 *  reach yesterday's work without turning the picker into a scroll marathon. */
const SESSION_BROWSER_LIMIT = 60;

/**
 * Recent transcripts for the browser: `sessions --all --json`. Bare, this is the
 * local index (fast, no SSH). With `device`, `--host <device>` reads that box's
 * index over SSH and answers with the identical row shape — which is why one
 * parser serves both.
 */
async function listBrowsableSessions(
  device?: string,
  currentSessionId?: string | null,
  currentSessionDevice?: string,
): Promise<BrowsableSession[]> {
  const { runCliArgs } = await import('../core/agentsBin');
  return loadBrowsableSessions((args, options) => runCliArgs('sessions', args, options), {
    device,
    localMachine: LOCAL_MACHINE_ID,
    limit: SESSION_BROWSER_LIMIT,
    currentSessionId,
    currentSessionDevice,
    quote: shellQuote,
  });
}

interface SessionBrowserItem extends vscode.QuickPickItem {
  row?: SessionBrowserSessionRow;
}

function toBrowserItems(rows: ReturnType<typeof buildSessionBrowserRows>): SessionBrowserItem[] {
  return rows.map((row) =>
    row.kind === 'group'
      ? { label: row.label, kind: vscode.QuickPickItemKind.Separator }
      : {
          label: row.label,
          description: row.description,
          detail: row.detail,
          row,
        },
  );
}

/** Which machine's sessions the browser is listing. `undefined` = this one. */
async function pickBrowseDevice(context: vscode.ExtensionContext, current: string | undefined): Promise<{ device?: string; cancelled: boolean }> {
  void context;
  const devices = await listRegisteredDevices();
  const items: (vscode.QuickPickItem & { deviceId?: string })[] = [
    {
      label: '$(vm) This machine',
      description: LOCAL_MACHINE_ID,
      picked: !current,
    },
    ...devices
      .filter(d => normalizeHost(d.name) !== LOCAL_MACHINE_ID)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
      .map(d => ({
        label: `${d.online ? '$(radio-tower)' : '$(circle-slash)'} ${d.name}`,
        description: d.online ? 'online' : 'offline',
        deviceId: normalizeHost(d.name),
      })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Browse sessions on…',
    placeHolder: 'Pick the machine whose sessions to browse',
  });
  if (!picked) return { cancelled: true };
  return { device: picked.deviceId, cancelled: false };
}

/**
 * The browser itself. One QuickPick that reloads in place when you switch device,
 * so the flow stays "open → filter → pick" instead of a wizard. Returns the row
 * the user chose, or null when they dismissed it.
 */
async function pickSessionToFork(
  context: vscode.ExtensionContext,
  currentSessionId: string | null,
  currentSessionDevice?: string,
): Promise<SessionBrowserSessionRow | null> {
  const quickPick = vscode.window.createQuickPick<SessionBrowserItem>();
  const switchDevice: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('server-environment'),
    tooltip: 'Browse another device…',
  };
  const reload: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('refresh'),
    tooltip: 'Reload sessions',
  };
  quickPick.placeholder = 'Pick a session to fork — filter by topic, project, harness or id';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.buttons = [switchDevice, reload];

  try {
    return await runSessionBrowserPicker({
      quickPick,
      title: 'Agents: Fork (Pick Session)',
      switchButton: switchDevice,
      reloadButton: reload,
      localMachine: LOCAL_MACHINE_ID,
      loadItems: async device => {
        const sessions = await listBrowsableSessions(device, currentSessionId, currentSessionDevice);
        const rows = buildSessionBrowserRows(sessions, {
          localMachine: LOCAL_MACHINE_ID,
          browsedMachine: device,
          currentSessionId,
        });
        return toBrowserItems(rows);
      },
      chooseDevice: current => pickBrowseDevice(context, current),
      emptyItem: device => ({ label: `No sessions found on ${device ?? LOCAL_MACHINE_ID}`, alwaysShow: true }),
      errorItem: message => ({ label: `$(error) Could not list sessions: ${message.slice(0, 120)}`, alwaysShow: true }),
    });
  } finally {
    quickPick.dispose();
  }
}

/** Browse sessions once, then fork the selected session. */
async function forkPickedSession(context: vscode.ExtensionContext): Promise<void> {
  await handleForkPickedSession({
    localMachine: LOCAL_MACHINE_ID,
    currentSession: () => {
      const activeTerminal = vscode.window.activeTerminal;
      const entry = activeTerminal ? terminals.getByTerminal(activeTerminal) : null;
      return { sessionId: entry?.sessionId ?? null, device: entry?.host };
    },
    pickSession: (sessionId, device) => pickSessionToFork(context, sessionId, device),
    showError: message => { void vscode.window.showErrorMessage(message); },
    resolveAgentConfig: agentKey => {
      const builtIn = BUILT_IN_AGENTS.find(a => a.key === agentKey);
      return builtIn ? createAgentConfig(
        context.extensionPath,
        builtIn.title,
        builtIn.command,
        builtIn.icon,
        builtIn.prefix,
      ) : undefined;
    },
    launchQueued: async (agentConfig, request) => {
      await openSingleAgentWithQueue(context, agentConfig, [request.prompt], request);
    },
    showStatus: message => { void vscode.window.setStatusBarMessage(message, 3000); },
  });
}

// Store context reference for deactivate
let extensionContext: vscode.ExtensionContext | undefined;

// Restore agent terminals from persisted sessions
// Called after scanExisting() on activation
async function restoreAgentTerminals(context: vscode.ExtensionContext): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;

  // scanExisting snapshotted the store; read the snapshot, not the file, which
  // the scan's own registers may already have rewritten.
  const persisted = terminals.pendingRestore();
  if (persisted.length === 0) return;

  // One tab per session, and none for a tab scanExisting already adopted.
  // One tab per session across windows too: a session another live window
  // already shows is not reopened here.
  const tracked = terminals.getAllTerminals();
  const toRestore = restorePlan(persisted, {
    terminalIds: new Set(tracked.map((e) => e.id)),
    sessionIds: new Set([
      ...tracked.map((e) => e.sessionId).filter((id): id is string => Boolean(id)),
      ...liveWindows(process.pid).flatMap((w) => w.sessionIds),
    ]),
  });
  terminals.setRestoring(toRestore);
  if (toRestore.length === 0) {
    terminals.persistNow();
    return;
  }

  // Recreate terminals with proper properties.
  // Note: With isTransient: true, VS Code won't auto-restore terminals,
  // so we don't need to close "broken" restores - we're the only restore path.
  //
  // RUSH-2477: bound the restore. A crash-restart reopens every persisted tab at
  // once, and firing one resume per tab with no cap or stagger is a thundering
  // herd — N tabs became N near-simultaneous resume processes within seconds of
  // boot, which is what overwhelmed the resume path (DB-lock crash, boot-time
  // fleet fan-out). `runStaggered` restores at most RESTORE_MAX_CONCURRENCY at a
  // time, each start after the first spaced by RESTORE_STAGGER_MS.
  const restoreOne = async (session: typeof toRestore[number]): Promise<void> => {
    // Handle shell separately (no built-in def)
    let agentConfig: Omit<import('./agents.vscode').AgentConfig, 'count'>;
    let displayTitle: string;

    const isOpaqueRecovery = session.prefix.toLowerCase() === RECOVERY_AGENT_PREFIX && Boolean(session.recoveryAgent);
    if (session.prefix.toLowerCase() === 'sh') {
      agentConfig = createAgentConfig(context.extensionPath, 'SH', '', 'agents.png', 'sh');
      displayTitle = 'SH';
    } else if (isOpaqueRecovery) {
      displayTitle = recoveryAgentTitle(session.recoveryAgent!);
      agentConfig = createAgentConfig(
        context.extensionPath,
        displayTitle,
        'agents',
        'agents.png',
        RECOVERY_AGENT_PREFIX,
      );
    } else {
      const def = getBuiltInByPrefix(session.prefix);
      if (!def) {
        console.log(`[RESTORE] Unknown prefix: ${session.prefix}, skipping`);
        return;
      }
      agentConfig = createAgentConfig(context.extensionPath, def.title, def.command, def.icon, def.prefix);
      displayTitle = def.title;
    }

    const titleLabel = session.label || session.autoLabel;
    const title = buildTerminalTitle(displayTitle, titleLabel, context, session.sessionId || null);
    // The tab's process is the CLI's in-place resume, so the tab becomes the live agent.
    const restoredAgentKey = session.agentType ? agentKeyFromSession(session.agentType) : null;
    const resumeCmd = session.sessionId && (session.recoveryAgent || restoredAgentKey)
      ? inTabResumeCommand(session.sessionId)
      : null;

    const terminal = vscode.window.createTerminal({
      iconPath: agentConfig.iconPath,
      location: { viewColumn: vscode.ViewColumn.Active },
      name: title,
      env: buildAgentTerminalEnv(session.terminalId, session.sessionId || null, workspacePath, session.version, { scrubSensitive: session.prefix.toLowerCase() !== 'sh', kind: session.prefix.toLowerCase() === 'sh' ? 'shell' : 'agent' }),
      isTransient: true,
      // Restore runs as the window opens, before the workbench can open a terminal
      // in an editor: an editor opened then is resolved as a text file and shows
      // "The editor could not be opened". Create it hidden and show it once its
      // process runs, when the terminal editor is ready.
      hideFromUser: true,
      ...(resumeCmd ? agentTabShell(resumeCmd, process.env.SHELL) : {}),
    });

    const { pid } = await terminals.processIdWithin(terminal);
    terminal.show(true);
    // Carry the tab's original creation time across the reload — the agent it is
    // being restored onto is older than this widget (see register's createdAt).
    terminals.register(terminal, session.terminalId, agentConfig, pid, context, session.label, session.createdAt);
    if (session.autoLabel) terminals.setAutoLabel(terminal, session.autoLabel);
    readiness.registerTerminal(terminal);

    // Preserve the version pin across reloads. The env var above is belt; this
    // is suspenders — without it, `resumeCurrentInBestProfile`'s "already on
    // usable version" short-circuit sees `terminalEntry.version === undefined`
    // and falls through to the full profile switch.
    if (session.version) {
      terminals.setVersion(terminal, session.version);
    }

    if (session.prefix.toLowerCase() === 'sh') {
      armShellAdoptionForTerminal(terminal, context);
    }

    if (session.sessionId !== undefined) terminals.setSessionId(terminal, session.sessionId);
    // The device survives every restore, not only one that resumes below, or the
    // next persist writes the tab back without it.
    if (session.host) terminals.setHost(terminal, session.host);
    const restoredEntry = terminals.getByTerminal(terminal);
    if (restoredEntry) restoredEntry.manualSessionOverride = session.manualSessionOverride;

    // Restore session tracking metadata if present
    if (session.sessionId && (session.agentType || session.recoveryAgent)) {
      if (session.agentType) {
        terminals.setAgentType(terminal, session.agentType as SessionAgentType);
      } else if (session.recoveryAgent) {
        terminals.setRecoveryAgent(terminal, session.recoveryAgent);
      }
      if (session.agentType) {
        startAutoLabelPollerForTerminal(terminal, context);
      }

      if (resumeCmd && restoredAgentKey) {
        readiness.armAgentReady(terminal);
      }
    }
  };

  try {
    await runStaggered(toRestore, restoreOne, {
      concurrency: RESTORE_MAX_CONCURRENCY,
      staggerMs: RESTORE_STAGGER_MS,
    });
  } finally {
    terminals.setRestoring([]);
  }

  // The store is this window's live tabs: rewrite it now so a duplicate or a tab
  // that failed to restore is gone, and a crash right after restore loses nothing.
  terminals.persistNow();
  console.log(`[RESTORE] Restored ${toRestore.length} agent terminal(s)`);
}

async function reopenLastClosedSession(context: vscode.ExtensionContext): Promise<void> {
  const closed = terminals.popClosedSession();
  if (!closed) {
    vscode.window.showInformationMessage('No recently closed sessions to reopen.');
    return;
  }

  if (!closed.agentConfig || !closed.sessionId) {
    vscode.window.showInformationMessage('Last closed session has no resumable session.');
    return;
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const title = buildTerminalTitle(
    closed.agentConfig.title,
    closed.label,
    context,
    closed.sessionId
  );

  const terminalId = terminals.nextId(closed.prefix);
  const resumeCmd = closed.agentType && agentKeyFromSession(closed.agentType) ? inTabResumeCommand(closed.sessionId) : null;
  const terminal = vscode.window.createTerminal({
    iconPath: closed.agentConfig.iconPath,
    location: { viewColumn: vscode.ViewColumn.Active },
    name: title,
    env: buildAgentTerminalEnv(terminalId, closed.sessionId, workspacePath, closed.version),
    isTransient: true,
    ...(resumeCmd ? agentTabShell(resumeCmd, process.env.SHELL) : {}),
  });

  const { pid } = await terminals.processIdWithin(terminal);
  terminals.register(terminal, terminalId, closed.agentConfig, pid, context, closed.label);
  readiness.registerTerminal(terminal);

  if (closed.sessionId && closed.agentType) {
    terminals.setSessionId(terminal, closed.sessionId);
    terminals.setAgentType(terminal, closed.agentType);
    if (closed.version) {
      terminals.setVersion(terminal, closed.version);
    }
    if (closed.account) {
      terminals.setAccount(terminal, closed.account);
    }
    // Stamp the host before the poller starts so a reopened offloaded tab keeps
    // resolving its label (and its resume) on the machine that owns it.
    if (closed.host) {
      terminals.setHost(terminal, closed.host);
    }
    startAutoLabelPollerForTerminal(terminal, context);

    // Any known harness reopens, not just the prewarm five (#1747).
    if (resumeCmd) {
      readiness.armAgentReady(terminal);
    }
  }

  terminal.show();
  console.log(`[REOPEN] Reopened session: ${closed.sessionId} (${closed.agentType})`);
}

function initTerminalRegistry(context: vscode.ExtensionContext): void {
  // Lazy import to avoid loading the registry before activate() fires.
  const registry = require('./terminalRegistry.vscode') as typeof import('./terminalRegistry.vscode');
  let timer: NodeJS.Timeout | undefined;
  const publish = async () => {
    try {
      const snap = await registry.snapshotOwnTerminals();
      await registry.publishLiveTerminals(snap);
    } catch { /* best effort */ }
  };
  // Trailing-edge debounce: a flurry of terminal-state changes (each of which
  // awaits processId + does a registry file read/write) coalesces into a
  // single publish instead of N.
  let debounceTimer: NodeJS.Timeout | undefined;
  const schedulePublish = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = undefined; void publish(); }, 300);
  };
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => schedulePublish()),
    vscode.window.onDidCloseTerminal(() => schedulePublish()),
    vscode.window.onDidChangeTerminalState(() => schedulePublish()),
    terminals.onSessionBindingChanged(() => schedulePublish()),
    { dispose: () => { if (debounceTimer) clearTimeout(debounceTimer); } },
  );
  // Long keepalive: publish() itself skips the disk write when nothing
  // changed and the keepalive window isn't due, so this interval is just a
  // safety net. Kept under STALE_WINDOW_MS (10 min) so peers don't prune us.
  timer = setInterval(publish, 60_000);
  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); } });
  void publish();
}

function initMonitorLeader(context: vscode.ExtensionContext): void {
  // Lazy import to keep activation lean and avoid loading the elector early.
  const leader = require('../monitor/leader') as typeof import('../monitor/leader');
  const { computeWindowId } = require('../core/windowId') as typeof import('../core/windowId');
  // process.pid is per-extension-host, so a window reload yields a fresh
  // windowId and leadership is re-elected rather than silently continued.
  const selfId = computeWindowId(vscode.env.sessionId, process.pid);
  leader.electLeader({ selfId, pid: process.pid });
  // Graceful handoff: drop the lease on dispose so a peer takes over at once
  // instead of waiting out the TTL.
  context.subscriptions.push({ dispose: () => leader.disposeLeader() });
}

// Run the monitor host (the broadcast server) ONLY while this window is the
// elected leader (#67). The gate starts it on leadership gain, retries a failed
// bind, and disposes it on loss; the next leader binds the same socket and
// followers auto-reconnect. This is also the seam the migration issues (#68-71) wrap
// their heavy starters in — they are intentionally NOT moved here.
function initMonitorHost(context: vscode.ExtensionContext): void {
  // detectors enables the centralized readiness probes (#68) on the leader only.
  // The session stream is the single demand-gated `agents feed watch` producer
  // (PHNX-3939): it spawns only while a window reports sessionDemand and is torn
  // down when none do, without the always-on CPU/ssh load e0f4831 removed.
  context.subscriptions.push(runMonitorHostOnLeader({ detectors: {}, sessionStream: { enabled: true } }));
}

// The always-on per-window follower (#67). It connects to the monitor, reports
// this window's terminal tuples over the broadcast request channel, and
// resolves broadcast facts back to this window's own `vscode.Terminal` via the
// window-local `editorTerminals` map (never moved out of this window). The
// live-terminals.json write (initTerminalRegistry) stays as the disconnected-case
// fallback — reportTuples is a no-op until the connection is up.
function initMonitorFollower(context: vscode.ExtensionContext): void {
  const { MonitorFollower } = require('../monitor/follower') as typeof import('../monitor/follower');
  const { computeWindowId } = require('../core/windowId') as typeof import('../core/windowId');
  type TerminalTuple = import('../monitor/protocol').TerminalTuple;

  const windowId = computeWindowId(vscode.env.sessionId, process.pid);

  // Resolve a broadcast pid/sessionId back to THIS window's terminal, scanning
  // only the window-local registry (stays per-window per epic #64).
  const resolver = (key: { pid?: number | null; sessionId?: string | null }):
    | vscode.Terminal
    | undefined => {
    for (const entry of terminals.getAllTerminals()) {
      if (key.pid != null && entry.pid === key.pid) return entry.terminal;
      if (key.sessionId && entry.sessionId === key.sessionId) return entry.terminal;
    }
    return undefined;
  };

  const collectTuples = (): TerminalTuple[] => {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    return terminals
      .getAllTerminals()
      .filter((e) => e.terminal.exitStatus === undefined && e.agentConfig)
      .map((e) => ({
        windowId,
        terminalId: e.id,
        pid: e.pid ?? null,
        sessionId: e.sessionId ?? null,
        workspacePath,
        agentType: e.agentType ?? null,
      }));
  };

  const { sessionStreamDemand } = require('../monitor/sessionDemand') as typeof import('../monitor/sessionDemand');

  let follower: InstanceType<typeof MonitorFollower<vscode.Terminal>>;
  const report = () => {
    const tuples = collectTuples();
    // A tracked agent terminal with no sessionId yet needs the stream to attribute
    // it (PHNX-3939) — that counts as demand even with no panel open.
    sessionStreamDemand.setUnresolvedTuples(tuples.some((t) => t.agentType != null && t.sessionId == null));
    if (follower?.connected) void follower.reportTuples(tuples, sessionStreamDemand.demand);
  };
  // A visibility flip (dashboard/sidebar) changes demand between terminal events,
  // so re-report the moment the net value flips — that is what starts/stops the
  // leader's producer promptly instead of on the 60s heartbeat.
  const demandSub = sessionStreamDemand.onChange(() => report());
  context.subscriptions.push({ dispose: demandSub });

  follower = new MonitorFollower<vscode.Terminal>({
    windowId,
    resolver,
    // Report as soon as the connection (re)establishes, then on terminal events.
    // On loss, restart local readiness probing so nothing stalls (#68 fallback).
    clientOptions: {
      onStateChange: (s) => {
        if (s === 'connected') report();
        else if (s === 'disconnected' || s === 'closed') readiness.onMonitorDisconnected();
      },
    },
  });

  // Migration wiring (#68, #69): the leader runs the probes/watchers once and
  // broadcasts facts; this window resolves them to its own terminals. The gate
  // predicates make terminalReadiness / sessionTracker suppress their local
  // probing while connected and fall back when not.
  const connected = () => follower.connected;
  readiness.setMonitorConnectivity(connected);
  readiness.setMonitorArmSink({
    armAgent: (pid) => { void follower.armAgent(pid); },
    armShellAdoption: (pid) => { void follower.armShellAdoption(pid); },
  });

  const proto = require('../monitor/protocol') as typeof import('../monitor/protocol');
  const factSub = follower.onMonitorEvent((event) => {
    if (proto.isReadinessFact(event)) {
      readiness.ingestReadinessFact(event.payload.pid, event.payload.event);
    } else if (proto.isShellAdoptionFact(event)) {
      const p = event.payload;
      readiness.ingestShellAdoptionFact(p.pid, {
        agentKey: p.agentKey as readiness.ShellAdoptionInfo['agentKey'],
        sessionId: p.sessionId,
        childPid: p.childPid,
      });
    } else if (proto.isSessionCliFact(event)) {
      if (sessionPresentationStore.apply(event.payload)) {
        if (
          event.payload.type === 'reset' ||
          event.payload.type === 'agent.upsert' ||
          event.payload.type === 'agent.remove'
        ) {
          // Rebind A -> B before either visible consumer reads the registry. The
          // terminal tab itself never changed focus, so no VS Code event can do it.
          // Activity/attention facts cannot change identity and skip this scan.
          syncTerminalSessionBindingsFromStream();
        }
        void syncCanonicalSessionTabLabels(context);
        const { notifyAgentPanelSessionUpdate } = require('./agentPanel.vscode') as typeof import('./agentPanel.vscode');
        notifyAgentPanelSessionUpdate();
        const { notifyProjectPanelSessionUpdate } = require('./projectPanel.vscode') as typeof import('./projectPanel.vscode');
        notifyProjectPanelSessionUpdate();
        const { notifyResumePickerUpdate } = require('./resumeSession.vscode') as typeof import('./resumeSession.vscode');
        notifyResumePickerUpdate();
      }
    }
  });
  context.subscriptions.push({ dispose: factSub });

  follower.start();

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => report()),
    vscode.window.onDidCloseTerminal(() => report()),
    vscode.window.onDidChangeTerminalState(() => report()),
  );
  const timer = setInterval(report, 60_000);
  (timer as { unref?: () => void })?.unref?.();
  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      follower.stop();
    },
  });
}

export async function deactivate(): Promise<void> {
  if (extensionContext) {
    // Persist open agent terminals for restore on next launch (immediate, not debounced)
    terminals.persistNow();
  }

  // Release the monitor lease — but only AFTER the leader's async disposers finish
  // (the demand-gated producer is stopped and its child reaped, PHNX-3939). Awaiting
  // disposeLeader() keeps the lease held until then, so a replacement window can't
  // elect itself and spawn a second `agents feed watch` while ours is still exiting.
  try {
    const leader = require('../monitor/leader') as typeof import('../monitor/leader');
    await leader.disposeLeader();
  } catch (err) {
    console.error('[MONITOR] leader disposal failed during deactivate:', err);
  }

  // Clear internal tracking (don't dispose terminals - let VS Code handle them)
  terminals.clear();
}
