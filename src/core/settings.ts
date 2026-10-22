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
  /** The Project panel's Review and Issues tabs; both shown when unset. */
  tabs?: PanelTabs;
}

/** The Project panel tabs beside Sessions; with both off the tab row is the goal alone. */
export interface PanelTabs {
  prs: boolean;
  tickets: boolean;
}

export const PANEL_TABS = ['prs', 'tickets'] as const;

export function panelTabs(v: Partial<PanelTabs> | undefined): PanelTabs {
  return { prs: v?.prs !== false, tickets: v?.tickets !== false };
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

// Display preferences for terminal titles. A tab is named by its session alone; the
// logo says which harness (owner, 2026-10-19).
export interface DisplayPreferences {
  autoLabelInTabTitles: boolean;  // true = the tab takes the CLI's title once the stream has one
  showSessionIdInTitles: boolean;
}

/** Settings > Session cards > ‹ › on the pinned card: walk the tabs in order, go to
 *  the next session that needs you (and back), or draw no arrows. */
export type ArrowMode = 'tabs' | 'needs' | 'off';

/** Session cards in the Project panel: whether an ask shows its answers, how much
 *  of each option and of the question, what a click does, whether an answer waits
 *  for an Undo, and which parts each card shows (all of them down to logo and title). */
export interface CardSettings {
  asks: 'answers' | 'question' | 'off';
  options: 'titles' | 'details';
  question: 'two' | 'full';
  click: 'front' | 'show';
  answerUndo: 'off' | 'five';
  /** What the pinned card's Made row draws: one row of chips, or preview tiles. */
  made: 'chips' | 'previews';
  /** What ‹ › on the pinned card do: walk the tabs, go to the next that needs you, or nothing. */
  arrows: ArrowMode;
  /** Listed sessions as cards, or as ⌘K's compact rows (owner video, 2026-10-22 8:50 AM). */
  style: 'cards' | 'rows';
  description: boolean;
  chips: boolean;
  machine: boolean;
  age: boolean;
  stateWord: boolean;
  verdict: boolean;
  /** What the session was started with, under the title; off by default (owner video, 2026-10-19 1:32 AM). */
  firstMessage: boolean;
  /** The shell command a working agent runs, under its words; off by default (owner video, 2026-10-22 6:42 AM). */
  command: boolean;
  /** The pinned card's Activity box. */
  activity: boolean;
  /** ⇤ ⇥ beside ‹ › on the pinned card: the first and the last tab. */
  ends: boolean;
  /** Starred sessions repeated in a Favorites group under the pinned card (owner video, 2026-10-19 1:42 AM). */
  favorites: boolean;
  /** The session list under the pinned card; off leaves the front tab's card alone and ⌘K finds the rest. */
  list: boolean;
  /** Ready for review and Idle sessions with no tab here in groups of their own; off lists
   *  them in their place, after what asks and before what works (owner video, 2026-10-22 6:42 AM). */
  finishedGroups: boolean;
}

/** The parts a card can leave out, as Settings lists them. */
export const CARD_PARTS = ['description', 'command', 'chips', 'machine', 'age', 'stateWord', 'verdict', 'firstMessage', 'activity', 'ends'] as const;

/** What Sessions lists under the pinned card, as Settings > Session list toggles it. */
export const LIST_PARTS = ['list', 'favorites', 'finishedGroups'] as const;

export const DEFAULT_CARD_SETTINGS: CardSettings = {
  asks: 'question', options: 'titles', question: 'two', click: 'front', answerUndo: 'off', made: 'chips', arrows: 'tabs', style: 'cards',
  description: true, chips: true, machine: true, age: true, stateWord: false, verdict: true, firstMessage: false,
  command: false, activity: true, ends: true, favorites: true, list: true, finishedGroups: false,
};

/** The stored card settings with any value this version does not know read as its default. */
export function cardSettings(v: Partial<CardSettings> | undefined): CardSettings {
  const d = DEFAULT_CARD_SETTINGS;
  const part = (k: (typeof CARD_PARTS)[number] | (typeof LIST_PARTS)[number]) => (typeof v?.[k] === 'boolean' ? v[k] as boolean : d[k]);
  return {
    asks: v?.asks === 'answers' || v?.asks === 'question' || v?.asks === 'off' ? v.asks : d.asks,
    options: v?.options === 'details' ? 'details' : d.options,
    question: v?.question === 'full' ? 'full' : d.question,
    click: v?.click === 'show' ? 'show' : d.click,
    answerUndo: v?.answerUndo === 'five' ? 'five' : d.answerUndo,
    made: v?.made === 'previews' ? 'previews' : d.made,
    arrows: v?.arrows === 'needs' || v?.arrows === 'off' ? v.arrows : d.arrows,
    style: v?.style === 'rows' ? 'rows' : d.style,
    description: part('description'), chips: part('chips'), machine: part('machine'), age: part('age'), stateWord: part('stateWord'), verdict: part('verdict'), firstMessage: part('firstMessage'),
    command: part('command'), activity: part('activity'), ends: part('ends'),
    favorites: part('favorites'), list: part('list'), finishedGroups: part('finishedGroups'),
  };
}

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  autoLabelInTabTitles: true,
  showSessionIdInTitles: false,
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
