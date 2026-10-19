// AGI EXT's own settings: globalState['agentSettings'] with its migrations, and the
// prompt library in ~/.agents/prompts.json.

import * as vscode from 'vscode';
import * as path from 'path';
import { homedir } from 'os';
import { AgentSettings, getDefaultSettings, PromptEntry, DEFAULT_DISPLAY_PREFERENCES, DEFAULT_QUICK_LAUNCH, migrateStaleClaudeQuickLaunch, migrateLegacyQuickLaunchSlots } from '../core/settings';
import { readPromptsFromPath, writePromptsToPath } from '../core/prompts';
import * as workbench from './workbench.vscode';
import * as terminals from './terminals.vscode';
import { formatTerminalTitle, getSessionChunk } from '../core/utils';

// Data directory: ~/.agents/
const AGENTS_CONFIG_DIR = path.join(homedir(), '.agents');
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
      if (stored.display.autoLabelInTabTitles === undefined) {
        stored.display.autoLabelInTabTitles = DEFAULT_DISPLAY_PREFERENCES.autoLabelInTabTitles;
      }
      if (stored.display.showSessionIdInTitles === undefined) {
        stored.display.showSessionIdInTitles = DEFAULT_DISPLAY_PREFERENCES.showSessionIdInTitles;
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
      prompts: readPrompts(),
      editor: { markdownViewerEnabled: true },
      display: { ...DEFAULT_DISPLAY_PREFERENCES }
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

// Save settings to global state and the prompt library to its file
export async function saveSettings(context: vscode.ExtensionContext, settings: AgentSettings): Promise<void> {
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
    oldDisplay.autoLabelInTabTitles !== newDisplay.autoLabelInTabTitles ||
    oldDisplay.showSessionIdInTitles !== newDisplay.showSessionIdInTitles;

  if (!changed) return;

  // renameWithArg always targets the active terminal, so we must rename sequentially.
  // Remember what was active and restore it at the end so focus isn't disturbed.
  const previouslyActive = vscode.window.activeTerminal;

  for (const entry of terminals.getAllTerminals()) {
    if (!entry.agentConfig) continue;
    const label = entry.label || (newDisplay.autoLabelInTabTitles ? entry.autoLabel : null);
    const sessionChunk = newDisplay.showSessionIdInTitles ? getSessionChunk(entry.sessionId) : null;
    const newTitle = formatTerminalTitle({ label, stage: entry.stage, sessionChunk });
    await terminals.renameTerminal(entry.terminal, newTitle);
  }

  if (previouslyActive && previouslyActive.exitStatus === undefined) {
    previouslyActive.show(true);
  }
}
