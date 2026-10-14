// Settings types and pure functions (no VS Code dependencies - testable)

// Per-agent configuration for built-in agents
interface BuiltInAgentConfig {
  login: boolean;
  instances: number;
  defaultModel?: string;
}

// Custom agent configuration
interface CustomAgentConfig {
  name: string;
  command: string;
  login: boolean;
  instances: number;
}

// Command alias for built-in agents with custom flags
// e.g., "Fast" alias for Claude with "--model claude-haiku-4-5-20251001"
interface CommandAlias {
  name: string;           // Display name (e.g., "Fast", "Max Context")
  agent: string;          // Built-in agent key: "claude" | "codex" | etc.
  flags: string;          // Additional CLI flags (e.g., "--model claude-haiku-4-5-20251001")
}

// Quick launch slot for keyboard shortcuts (Cmd+Shift+0..9)
export interface QuickLaunchSlot {
  agent: string;          // Built-in agent key: "claude" | "codex" | etc.
  version?: string;       // Pinned agents-cli version (e.g., "1.2.6"); empty = default
  mode?: 'plan' | 'edit'; // CLI --mode; omit to use agent default
  model?: string;         // Concrete model id (e.g., "claude-opus-4-7-20260115")
  modelAlias?: string;    // Agents-cli alias (e.g., "opus", "haiku") — resolved to a concrete id on first launch
  extraFlags?: string;    // Free-form CLI flags appended last (e.g., "--reasoning high")
  label?: string;         // Display label for dashboard
  // Where ⌘⇧<n> spawns this agent. Omitted or 'local' = this machine (today's
  // behavior). A registered device name = offload onto that host over SSH via
  // `agents run --device`. 'balanced' = pick the least-busy online device at
  // launch time (see balancePool).
  runOn?: string;
  // When runOn === 'balanced', restrict the candidate pool to these device
  // names. Empty/undefined = all online devices (minus the local machine).
  balancePool?: string[];
}

// Quick launch slots configuration. New shape uses `slots` keyed by digit "0".."9".
// `slot1/slot2/slot3` are legacy fields kept for backwards compat with persisted state.
export interface QuickLaunchConfig {
  slots?: Record<string, QuickLaunchSlot>;
  slot1?: QuickLaunchSlot;
  slot2?: QuickLaunchSlot;
  slot3?: QuickLaunchSlot;
}

export const QUICK_LAUNCH_SLOT_KEYS = ['0','1','2','3','4','5','6','7','8','9'] as const;
export type QuickLaunchSlotKey = typeof QUICK_LAUNCH_SLOT_KEYS[number];

export function getQuickLaunchSlot(config: QuickLaunchConfig | undefined, key: QuickLaunchSlotKey): QuickLaunchSlot | undefined {
  if (!config) return undefined;
  const direct = config.slots?.[key];
  if (direct) return direct;
  // Legacy fallback for slot1/slot2/slot3 only.
  if (key === '1') return config.slot1;
  if (key === '2') return config.slot2;
  if (key === '3') return config.slot3;
  return undefined;
}

// One-shot migration: fold legacy slot1/slot2/slot3 into the `slots` map.
export function migrateLegacyQuickLaunchSlots(config: QuickLaunchConfig): boolean {
  let changed = false;
  if (!config.slots) {
    config.slots = {};
  }
  if (config.slot1 && !config.slots['1']) { config.slots['1'] = config.slot1; changed = true; }
  if (config.slot2 && !config.slots['2']) { config.slots['2'] = config.slot2; changed = true; }
  if (config.slot3 && !config.slots['3']) { config.slots['3'] = config.slot3; changed = true; }
  if (config.slot1 || config.slot2 || config.slot3) {
    delete config.slot1;
    delete config.slot2;
    delete config.slot3;
    changed = true;
  }
  return changed;
}

// Prompt entry for saving reusable prompts
export interface PromptEntry {
  id: string;
  title: string;
  content: string;
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
  accessedAt: number;  // Last time prompt was used (for sorting by recency)
}

// Full agent settings structure
export interface AgentSettings {
  builtIn: {
    claude: BuiltInAgentConfig;
    codex: BuiltInAgentConfig;
    opencode: BuiltInAgentConfig;
    cursor: BuiltInAgentConfig;
    shell: BuiltInAgentConfig;
    antigravity: BuiltInAgentConfig;
    grok: BuiltInAgentConfig;
    kimi: BuiltInAgentConfig;
    droid: BuiltInAgentConfig;
  };
  custom: CustomAgentConfig[];
  aliases: CommandAlias[];
  quickLaunch?: QuickLaunchConfig;  // Quick launch slots for Cmd+Shift+1/2/3
  prompts: PromptEntry[];
  editor: EditorPreferences;
  display: DisplayPreferences;
  /** How Sessions cards show an open ask; the defaults when unset. */
  cards?: CardSettings;
  /** How every Merge button merges (Review rows, the session sidebar); squash when unset. */
  mergeMethod?: MergeMethod;
}

export type MergeMethod = 'squash' | 'rebase' | 'merge';
export const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'rebase', 'merge'];

/** The stored method when it is one of the three; a hand-edited value reads as unset. */
export function validMergeMethod(v: unknown): MergeMethod | undefined {
  return (MERGE_METHODS as readonly unknown[]).includes(v) ? (v as MergeMethod) : undefined;
}

interface EditorPreferences {
  markdownViewerEnabled: boolean;
}

// Display preferences for terminal titles and labels
export interface DisplayPreferences {
  showFullAgentNames: boolean;
  showLabelsInTitles: boolean;
  autoLabelInTabTitles: boolean;  // true = auto-label tab titles from first user message
  showSessionIdInTitles: boolean;
  labelReplacesTitle: boolean;  // true = label replaces title, false = append with dash
  showLabelOnlyOnFocus: boolean;  // true = hide label when terminal loses focus
}

/** Session cards in the Project panel: whether an ask shows its answers, how much
 *  of each option, and how much of the question. */
export interface CardSettings {
  asks: 'answers' | 'question' | 'off';
  options: 'titles' | 'details';
  question: 'two' | 'full';
}

export const DEFAULT_CARD_SETTINGS: CardSettings = { asks: 'answers', options: 'titles', question: 'two' };

/** The stored card settings with any value this version does not know read as its default. */
export function cardSettings(v: Partial<CardSettings> | undefined): CardSettings {
  const d = DEFAULT_CARD_SETTINGS;
  return {
    asks: v?.asks === 'question' || v?.asks === 'off' ? v.asks : d.asks,
    options: v?.options === 'details' ? 'details' : d.options,
    question: v?.question === 'full' ? 'full' : d.question,
  };
}

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  showFullAgentNames: true,
  showLabelsInTitles: true,
  autoLabelInTabTitles: true,
  showSessionIdInTitles: true,
  labelReplacesTitle: false,  // Default: append label (e.g., "Claude - label")
  showLabelOnlyOnFocus: false  // Default: always show label
};

export const DEFAULT_QUICK_LAUNCH: QuickLaunchConfig = {
  slots: {
    '1': { agent: 'claude', modelAlias: 'opus', label: 'Claude Opus' },
    '2': { agent: 'claude', modelAlias: 'haiku', label: 'Claude Haiku' },
  },
};

// Model ids shipped as hardcoded defaults in earlier extension versions.
// Map them to aliases so agents-cli can resolve the current concrete model on launch.
const STALE_CLAUDE_MODEL_TO_ALIAS: Record<string, string> = {
  'claude-opus-4-5': 'opus',
  'claude-sonnet-4-5': 'sonnet',
  'claude-haiku-4-5': 'haiku',
};

function migrateStaleSlot(slot: QuickLaunchSlot | undefined): boolean {
  if (!slot || slot.agent !== 'claude' || !slot.model) return false;
  const alias = STALE_CLAUDE_MODEL_TO_ALIAS[slot.model];
  if (!alias) return false;
  slot.model = undefined;
  slot.modelAlias = alias;
  return true;
}

export function migrateStaleClaudeQuickLaunch(quickLaunch: QuickLaunchConfig): boolean {
  let changed = false;
  if (migrateStaleSlot(quickLaunch.slot1)) changed = true;
  if (migrateStaleSlot(quickLaunch.slot2)) changed = true;
  if (migrateStaleSlot(quickLaunch.slot3)) changed = true;
  if (quickLaunch.slots) {
    for (const k of Object.keys(quickLaunch.slots)) {
      if (migrateStaleSlot(quickLaunch.slots[k])) changed = true;
    }
  }
  return changed;
}

// Default settings (pure function)
export function getDefaultSettings(): AgentSettings {
  return {
    builtIn: {
      claude: { login: false, instances: 2 },
      codex: { login: false, instances: 2 },
      opencode: { login: false, instances: 2 },
      cursor: { login: false, instances: 2 },
      shell: { login: false, instances: 1 },
      antigravity: { login: false, instances: 2 },
      grok: { login: false, instances: 2 },
      kimi: { login: false, instances: 2 },
      droid: { login: false, instances: 2 }
    },
    custom: [],
    aliases: [],
    quickLaunch: { ...DEFAULT_QUICK_LAUNCH },
    prompts: [],
    editor: { markdownViewerEnabled: true },
    display: { ...DEFAULT_DISPLAY_PREFERENCES }
  };
}

// Check if any agents have login enabled (pure function)
export function hasLoginEnabled(settings: AgentSettings): boolean {
  return (
    Object.values(settings.builtIn).some(a => a.login) ||
    settings.custom.some(a => a.login)
  );
}
