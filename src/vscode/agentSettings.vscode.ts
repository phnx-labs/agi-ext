// AGI EXT's own settings: globalState['agentSettings'] with its migrations, and the
// prompt library in ~/.agents/prompts.json.

import * as vscode from 'vscode';
import * as path from 'path';
import { homedir } from 'os';
import { AgentSettings, getDefaultSettings, ALL_SWARM_AGENTS, PromptEntry, DEFAULT_DISPLAY_PREFERENCES, DEFAULT_NOTIFICATION_SETTINGS, DEFAULT_TASK_SOURCE_SETTINGS, DEFAULT_QUICK_LAUNCH, migrateStaleClaudeQuickLaunch, migrateLegacyQuickLaunchSlots } from '../core/settings';
import { readPromptsFromPath, writePromptsToPath } from '../core/prompts';
import { writeSwarmConfig } from './settingsActions';
import * as workbench from './workbench.vscode';
import * as terminals from './terminals.vscode';
import { formatTerminalTitle, getSessionChunk, parseTerminalName } from '../core/utils';

// Data directory: ~/.agents/
const AGENTS_CONFIG_DIR = path.join(homedir(), '.agents');
const AGENTS_CONFIG_PATH = path.join(AGENTS_CONFIG_DIR, 'config.json');
const PROMPTS_PATH = path.join(AGENTS_CONFIG_DIR, 'prompts.json');

// Read prompts from YAML file (persists across extension uninstall)
export function readPrompts(): PromptEntry[] {
  const { prompts, usedDefaults } = readPromptsFromPath(PROMPTS_PATH);
  if (usedDefaults) {
    // Save defaults to file for next time
    writePrompts(prompts);
  }
  return prompts;
}

// Write prompts to YAML file
export function writePrompts(prompts: PromptEntry[]): void {
  writePromptsToPath(PROMPTS_PATH, prompts);
}

// Load settings from global state, with migration from old format
export function getSettings(context: vscode.ExtensionContext): AgentSettings {
  const stored = context.globalState.get<AgentSettings>('agentSettings');
  if (stored) {
    // Migrate: add swarmEnabledAgents if missing or filter out old agents
    if (!stored.swarmEnabledAgents) {
      stored.swarmEnabledAgents = [...ALL_SWARM_AGENTS];
      context.globalState.update('agentSettings', stored);
    } else {
      // Filter to only include supported agents (claude, codex)
      const filtered = stored.swarmEnabledAgents.filter(a => ALL_SWARM_AGENTS.includes(a));
      if (filtered.length !== stored.swarmEnabledAgents.length) {
        stored.swarmEnabledAgents = filtered.length > 0 ? filtered : [...ALL_SWARM_AGENTS];
        context.globalState.update('agentSettings', stored);
      }
    }
    if (!stored.builtIn.opencode) {
      stored.builtIn.opencode = { login: false, instances: 2 };
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add display preferences
    if (!stored.display) {
      stored.display = { ...DEFAULT_DISPLAY_PREFERENCES };
      context.globalState.update('agentSettings', stored);
    } else {
      // Backfill any missing keys
      if (stored.display.showFullAgentNames === undefined) {
        stored.display.showFullAgentNames = DEFAULT_DISPLAY_PREFERENCES.showFullAgentNames;
      }
      if (stored.display.showLabelsInTitles === undefined) {
        stored.display.showLabelsInTitles = DEFAULT_DISPLAY_PREFERENCES.showLabelsInTitles;
      }
      if (stored.display.autoLabelInTabTitles === undefined) {
        stored.display.autoLabelInTabTitles = DEFAULT_DISPLAY_PREFERENCES.autoLabelInTabTitles;
      }
      if (stored.display.showSessionIdInTitles === undefined) {
        stored.display.showSessionIdInTitles = DEFAULT_DISPLAY_PREFERENCES.showSessionIdInTitles;
      }
      if (stored.display.labelReplacesTitle === undefined) {
        stored.display.labelReplacesTitle = DEFAULT_DISPLAY_PREFERENCES.labelReplacesTitle;
      }
      if (stored.display.showLabelOnlyOnFocus === undefined) {
        stored.display.showLabelOnlyOnFocus = DEFAULT_DISPLAY_PREFERENCES.showLabelOnlyOnFocus;
      }
      context.globalState.update('agentSettings', stored);
    }
    if (!stored.notifications) {
      stored.notifications = { ...DEFAULT_NOTIFICATION_SETTINGS };
      context.globalState.update('agentSettings', stored);
    } else {
      if (stored.notifications.enabled === undefined) {
        stored.notifications.enabled = DEFAULT_NOTIFICATION_SETTINGS.enabled;
      }
      if (!stored.notifications.style) {
        stored.notifications.style = DEFAULT_NOTIFICATION_SETTINGS.style;
      }
      if (!stored.notifications.enabledAgents || stored.notifications.enabledAgents.length === 0) {
        stored.notifications.enabledAgents = [...DEFAULT_NOTIFICATION_SETTINGS.enabledAgents];
      }
      context.globalState.update('agentSettings', stored);
    }
    if (!stored.editor) {
      stored.editor = { markdownViewerEnabled: true };
      context.globalState.update('agentSettings', stored);
    } else if (stored.editor.markdownViewerEnabled === undefined) {
      stored.editor.markdownViewerEnabled = true;
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: load prompts from file (persists across uninstall)
    if (!stored.prompts || stored.prompts.length === 0) {
      stored.prompts = readPrompts();
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add aliases array if missing
    if (!stored.aliases) {
      stored.aliases = [];
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add welcome screen setting if missing (default: enabled)
    if (stored.showWelcomeScreen === undefined) {
      stored.showWelcomeScreen = true;
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add task sources if missing
    if (!stored.taskSources) {
      stored.taskSources = { ...DEFAULT_TASK_SOURCE_SETTINGS };
      context.globalState.update('agentSettings', stored);
    } else if (stored.taskSources.githubAssignedOnly === undefined) {
      stored.taskSources.githubAssignedOnly = DEFAULT_TASK_SOURCE_SETTINGS.githubAssignedOnly;
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add custom agents if missing
    if (!stored.custom) {
      stored.custom = [];
      context.globalState.update('agentSettings', stored);
    }
    // Migrate: add quick launch if missing
    if (!stored.quickLaunch) {
      stored.quickLaunch = { ...DEFAULT_QUICK_LAUNCH };
      context.globalState.update('agentSettings', stored);
    } else {
      const staleChanged = migrateStaleClaudeQuickLaunch(stored.quickLaunch);
      const legacyChanged = migrateLegacyQuickLaunchSlots(stored.quickLaunch);
      if (staleChanged || legacyChanged) {
        context.globalState.update('agentSettings', stored);
      }
    }
    return stored;
  }

  // Migrate from old settings if they exist
  const config = vscode.workspace.getConfiguration('agents');
  const claudeCount = config.get<number>('claudeCount');
  const autoStart = config.get<boolean>('autoStart', false);

  if (claudeCount !== undefined) {
    // Old settings exist, migrate them
    const migrated: AgentSettings = {
      builtIn: {
        claude: { login: autoStart, instances: config.get<number>('claudeCount', 2) },
        codex: { login: autoStart, instances: config.get<number>('codexCount', 2) },
        opencode: { login: autoStart, instances: 2 },
        cursor: { login: autoStart, instances: config.get<number>('cursorCount', 2) },
        shell: { login: false, instances: 1 },
        antigravity: { login: false, instances: 2 },
        grok: { login: false, instances: 2 },
        kimi: { login: false, instances: 2 },
        droid: { login: false, instances: 2 }
      },
      custom: (config.get<{ title: string; command: string; count: number }[]>('customAgents', []) || []).map(a => ({
        name: a.title,
        command: a.command,
        login: false,
        instances: a.count
      })),
      aliases: [],
      swarmEnabledAgents: [...ALL_SWARM_AGENTS],
      prompts: readPrompts(),
      editor: { markdownViewerEnabled: true },
      display: { ...DEFAULT_DISPLAY_PREFERENCES },
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
      showWelcomeScreen: true,
      taskSources: { ...DEFAULT_TASK_SOURCE_SETTINGS }
    };
    context.globalState.update('agentSettings', migrated);
    return migrated;
  }

  return getDefaultSettings();
}

export function getDefaultModel(
  context: vscode.ExtensionContext,
  agentType: keyof AgentSettings['builtIn']
): string | undefined {
  const settings = getSettings(context);
  return settings.builtIn[agentType]?.defaultModel;
}

// Save settings to global state and write configs to files
export async function saveSettings(context: vscode.ExtensionContext, settings: AgentSettings): Promise<void> {
  try {
    writeSwarmConfig(AGENTS_CONFIG_PATH, settings.swarmEnabledAgents);
  } catch (error) {
    void vscode.window.showErrorMessage(`Settings were not saved. Could not update ${AGENTS_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  await context.globalState.update('agentSettings', settings);
  // Sync prompts to file for persistence across uninstall
  if (settings.prompts) {
    writePrompts(settings.prompts);
  }
  await workbench.setMarkdownEditorAssociation(settings.editor?.markdownViewerEnabled ?? true);
}

/** Retitle open agent tabs when a title preference changed. */
export async function maybeUpdateTerminalTitles(oldSettings: AgentSettings, newSettings: AgentSettings): Promise<void> {
  const oldDisplay = oldSettings.display ?? DEFAULT_DISPLAY_PREFERENCES;
  const newDisplay = newSettings.display ?? DEFAULT_DISPLAY_PREFERENCES;

  const changed =
    oldDisplay.showFullAgentNames !== newDisplay.showFullAgentNames ||
    oldDisplay.showLabelsInTitles !== newDisplay.showLabelsInTitles ||
    oldDisplay.autoLabelInTabTitles !== newDisplay.autoLabelInTabTitles ||
    oldDisplay.showSessionIdInTitles !== newDisplay.showSessionIdInTitles ||
    oldDisplay.labelReplacesTitle !== newDisplay.labelReplacesTitle;

  if (!changed) return;

  // renameWithArg always targets the active terminal, so we must rename sequentially.
  // Remember what was active and restore it at the end so focus isn't disturbed.
  const previouslyActive = vscode.window.activeTerminal;

  for (const entry of terminals.getAllTerminals()) {
    const prefix = entry.agentConfig?.title || parseTerminalName(entry.terminal.name).prefix;
    if (!prefix) continue;

    const label = newDisplay.showLabelsInTitles
      ? (entry.label || (newDisplay.autoLabelInTabTitles ? entry.autoLabel : null))
      : null;
    const sessionChunk = newDisplay.showSessionIdInTitles ? getSessionChunk(entry.sessionId) : null;
    const newTitle = formatTerminalTitle(prefix, {
      label,
      display: newDisplay,
      sessionChunk: sessionChunk || null
    });
    await terminals.renameTerminal(entry.terminal, newTitle);
  }

  if (previouslyActive && previouslyActive.exitStatus === undefined) {
    previouslyActive.show(true);
  }
}
