// The Project panel's Settings tab: AGI EXT's own preferences, read from and written
// to `agentSettings` (globalState) and the default/second agent titles, plus the
// Devices section, which shows `agents devices list --json` and writes through
// `agents devices`. The CLI decides placement; this only draws its verdict.

import { escapeHtml } from '../shared/sessionCards';
import { BUILT_IN_AGENTS } from './agents';
import { CLI_AGENT_META, type CliAgentId } from './agents.cli';
import { CARD_PARTS, cardSettings, LIST_PARTS, getQuickLaunchSlot, MERGE_METHODS, PANEL_HEADER, panelHeader, type AgentSettings, type CardSettings, type DisplayPreferences, type QuickLaunchSlotKey } from './settings';

const HEADER_ROWS: { key: (typeof PANEL_HEADER)[number]; label: string; sub: string }[] = [
  { key: 'lead', label: 'Lead', sub: 'Ask or tell this project\u2019s Lead' },
  { key: 'prs', label: 'Review', sub: 'Pull requests waiting on review or merge' },
  { key: 'tickets', label: 'Issues', sub: 'The project\u2019s Linear tickets' },
  { key: 'search', label: 'Search', sub: '\u2318K opens it either way' },
  { key: 'sort', label: 'View, filter and sort', sub: 'Also in \u22ef' },
  { key: 'pick', label: 'Switch Project', sub: 'Also in \u22ef' },
];

const DISPLAY_ROWS: { key: keyof DisplayPreferences; label: string; sub: string }[] = [
  { key: 'autoLabelInTabTitles', label: 'Auto labels', sub: 'Use the CLI title once the stream has one' },
  { key: 'showSessionIdInTitles', label: 'Session id', sub: 'The short id before the session name' },
];

/** The Session cards pickers: each key, its words, and its choices in order. */
const CARD_ROWS: { key: Exclude<keyof CardSettings, (typeof CARD_PARTS)[number] | (typeof LIST_PARTS)[number]>; label: string; sub: string; options: { value: string; label: string }[] }[] = [
  { key: 'click', label: 'Card click', sub: 'What a click on a session card does', options: [{ value: 'front', label: 'Show it and bring its tab forward' }, { value: 'show', label: 'Only show it in the sidebar' }] },
  { key: 'answerUndo', label: 'Undo before an answer is sent', sub: 'An answer from the list never changes the tab in front; Off sends it at once', options: [{ value: 'off', label: 'Off: send at once' }, { value: 'five', label: '5 seconds' }] },
  { key: 'made', label: 'What it made', sub: 'PRs, tickets and files, on the pinned card and in the Active Session sidebar', options: [{ value: 'chips', label: 'Chips in one row' }, { value: 'previews', label: 'Previews' }] },
  { key: 'asks', label: 'Asks on listed cards', sub: 'The pinned card always has the answers; a listed ask keeps the Lead’s ★ draft; Off leaves only the card and its wait', options: [{ value: 'answers', label: 'With answers' }, { value: 'question', label: 'Question only' }, { value: 'off', label: 'Off' }] },
  { key: 'options', label: 'Answer options', sub: 'Each option’s description shows on hover either way', options: [{ value: 'titles', label: 'Titles only' }, { value: 'details', label: 'Titles and details' }] },
  { key: 'question', label: 'Question text', sub: 'The full question is on hover either way', options: [{ value: 'two', label: 'Two lines' }, { value: 'full', label: 'Full' }] },
];

/** What a card shows; turning everything off leaves the harness logo and the title. */
const CARD_PART_ROWS: Record<(typeof CARD_PARTS)[number], { label: string; sub: string }> = {
  description: { label: 'Description', sub: 'The agent’s latest words, or what it asks' },
  command: { label: 'Command', sub: 'The shell command a working agent runs, under its words' },
  chips: { label: 'PRs, tickets, folders', sub: 'One row that scrolls sideways' },
  previews: { label: 'Image previews', sub: 'What you attached and what the agent made, three at most' },
  machine: { label: 'Host', sub: 'Where the agent runs' },
  age: { label: 'Age', sub: 'Since the last activity, or how long an ask has waited' },
  state: { label: 'State', sub: 'Asks, Blocked, Running or Idle beside the age; hover names any background work' },
  verdict: { label: 'Done verdict', sub: 'A finished turn shows ✓ Done or Not done beside its title' },
  firstMessage: { label: 'First message', sub: 'What the session was started with, when its title says something else' },
  activity: { label: 'Activity on the pinned card', sub: 'Its steps with their times, in a box that scrolls' },
};

/** What Sessions lists under the pinned card. */
const LIST_PART_ROWS: Record<(typeof LIST_PARTS)[number], { label: string; sub: string }> = {
  list: { label: 'Show the session list', sub: 'Off leaves only the front tab’s card and its ask; ⌘K finds every other session' },
  favorites: { label: 'Favorites group', sub: 'Sessions you starred (click an agent’s logo), on top as well as in their own group' },
  finishedGroups: { label: 'Ready for review and Idle groups', sub: 'Finished sessions with no tab here in groups of their own; off lists them in their place, after what asks' },
};

const SLOTS: QuickLaunchSlotKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** The agents a shortcut can launch, as the pickers list them. */
export const PICKABLE_AGENTS = BUILT_IN_AGENTS.filter((a) => a.key !== 'shell')
  .map((a) => ({ key: a.key, title: a.title, name: CLI_AGENT_META[a.key as CliAgentId]?.name ?? a.key }));

/** One row of `agents devices list --json`, as the Devices section draws it. */
export interface SettingsDevice {
  name: string;
  role?: string;
  description?: string;
  enabled: boolean;
  preferred: boolean;
  /** The CLI's reason `--device auto` passes this device over, or null when it may pick it. */
  autoSkip: string | null;
  diskFreeBytes?: number;
  memFreeBytes?: number;
  memTotalBytes?: number;
  loadPercent?: number;
}

/** The Devices section: rows once read, or the read's error. */
export type DevicesState = { rows: SettingsDevice[] } | { error: string } | null;

interface DeviceListEntry {
  name: string;
  role?: string;
  description?: string;
  autoSkip?: string | null;
  config?: { autoLaunchEnabled?: boolean; autoLaunchPreferred?: boolean };
  health?: { reachable?: boolean; diskFreeBytes?: number; memFreeBytes?: number; memTotalBytes?: number; loadPercent?: number };
}

export function parseSettingsDevices(stdout: string): SettingsDevice[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error('agents devices list --json: expected a JSON array');
  const entries = parsed as DeviceListEntry[];
  if (entries.some((d) => !('autoSkip' in d))) {
    throw new Error('This agents-cli does not report placement reasons yet. Run `agents upgrade`.');
  }
  return entries.map((d) => {
    const live = d.health?.reachable === true ? d.health : undefined;
    return {
      name: d.name,
      role: d.role,
      description: d.description,
      enabled: d.config?.autoLaunchEnabled !== false,
      preferred: d.config?.autoLaunchPreferred === true,
      autoSkip: d.autoSkip ?? null,
      diskFreeBytes: live?.diskFreeBytes,
      memFreeBytes: live?.memFreeBytes,
      memTotalBytes: live?.memTotalBytes,
      loadPercent: live?.loadPercent,
    };
  });
}

/** The one `agents` argv a Devices checkbox or star runs. */
export function deviceSettingArgv(name: string, field: 'enabled' | 'preferred', on: boolean): string[] {
  if (field === 'enabled') return ['devices', on ? 'enable' : 'disable', name];
  return on
    ? ['devices', 'config', name, 'auto-launch.preferred', 'on']
    : ['devices', 'config', name, 'auto-launch.preferred', '--unset'];
}

const SKIP_WORDS: Record<string, string> = {
  off: 'off',
  unreachable: 'unreachable',
  loaded: 'loaded',
  'disk-low': 'disk low',
};

/** Out of the pool by role, whatever its checkbox says: folded into one line, not drawn as a row. */
const FIXED_SKIPS = new Set(['personal', 'desktop', 'not-a-worker']);

function bytes(n: number | undefined): string {
  if (n === undefined) return '—';
  const g = n / 1024 ** 3;
  if (g >= 1000) return `${(g / 1024).toFixed(1).replace(/\.0$/, '')}T`;
  if (g < 1) return `${Math.round(n / 1024 ** 2)}M`;
  return `${Math.round(g)}G`;
}

function deviceRow(d: SettingsDevice): string {
  const skip = d.autoSkip === null ? '' : `<span class="dskip${d.autoSkip === 'off' ? ' quiet' : ''}">${escapeHtml(SKIP_WORDS[d.autoSkip] ?? d.autoSkip)}</span>`;
  const disk = d.diskFreeBytes === undefined ? '' : `<span class="${d.autoSkip === 'disk-low' ? 'dfull' : d.diskFreeBytes < 50 * 1024 ** 3 ? 'dlow' : ''}">${bytes(d.diskFreeBytes)} free</span>`;
  const stats = [
    disk,
    d.memTotalBytes === undefined ? '' : `${bytes(d.memFreeBytes)} of ${bytes(d.memTotalBytes)} RAM free`,
    d.loadPercent === undefined ? '' : `load ${Math.round(d.loadPercent)}%`,
    d.description ? escapeHtml(d.description) : '',
  ].filter(Boolean).join(' · ');
  const name = escapeHtml(d.name);
  return `<div class="drow${d.autoSkip ? ' out' : ''}" data-key="${name}">`
    + `<input type="checkbox" data-device="${name}"${d.enabled ? ' checked' : ''} aria-label="Let Auto place agents on ${name}">`
    + `<span class="dname"><b>${name}</b>${skip}<small>${stats || '—'}</small></span>`
    + `<button class="dstar" data-star="${name}" aria-pressed="${d.preferred}" title="${d.preferred ? 'Preferred: Auto ranks it first' : 'Prefer this device'}">${d.preferred ? '★' : '☆'}</button>`
    + '</div>';
}

function renderDevicesSection(state: DevicesState): string {
  const head = '<h3 class="st">Devices <span class="shsub">where Auto places agents</span></h3>';
  if (state === null) return `${head}<p class="foot">Reading devices…</p>`;
  if ('error' in state) return `${head}<p class="foot err">${escapeHtml(state.error)}</p>`;
  const folded = (skip: string) => state.rows.filter((d) => d.autoSkip === skip).map((d) => escapeHtml(d.name)).sort();
  const rank = (d: SettingsDevice) => (d.autoSkip === null ? (d.preferred ? 0 : 1) : 2);
  const shown = state.rows
    .filter((d) => d.autoSkip !== 'offline' && !(d.autoSkip && FIXED_SKIPS.has(d.autoSkip)))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const lines = [
    ['Personal, never auto', folded('personal')],
    ['Desktop, never auto', folded('desktop')],
    ['Not workers', folded('not-a-worker')],
    ['Offline', folded('offline')],
  ].filter(([, names]) => names.length).map(([label, names]) => `<div class="doff">${label}: ${(names as string[]).join(', ')}</div>`);
  return head
    + shown.map(deviceRow).join('')
    + lines.join('')
    + '<p class="foot">Checked devices may be picked by <code>--device auto</code>; ★ ranks a device first. Both sync to every machine through <code>agents devices</code>.</p>';
}

export interface PanelSettingsModel {
  settings: AgentSettings;
  devices: DevicesState;
  /** `agents.defaultAgentTitle` / `agents.secondaryAgentTitle` ("CC", "CX", …). */
  defaultAgentTitle: string;
  secondaryAgentTitle: string;
  /** "⌘⇧" on macOS, "Ctrl+Shift+" elsewhere. */
  modifier: string;
  /** `agents.lead.speak`, a VS Code setting shared by every window. */
  leadSpeak: boolean;
  /** Real cards drawn with these settings (`renderCardPreview`), under A card shows. */
  preview?: string;
  /** The session list's View and Sort, this workspace's own (the ⇅ menu's same two choices). */
  list: { view: string; sort: string; group: string; ended: string; sections: string; ordered: boolean };
}

/** Apply one Settings-tab change to the stored settings; null for a key or value it does not know. */
export function applyPanelSetting(settings: AgentSettings, key: string, value: unknown): AgentSettings | null {
  const [group, field] = key.split('.');
  if (group === 'display' && DISPLAY_ROWS.some((r) => r.key === field) && typeof value === 'boolean') {
    return { ...settings, display: { ...settings.display, [field]: value } };
  }
  const card = CARD_ROWS.find((r) => group === 'cards' && r.key === field);
  if (card && card.options.some((o) => o.value === value)) {
    return { ...settings, cards: { ...cardSettings(settings.cards), [card.key]: value } };
  }
  if (group === 'cards' && ([...CARD_PARTS, ...LIST_PARTS] as readonly string[]).includes(field) && typeof value === 'boolean') {
    return { ...settings, cards: { ...cardSettings(settings.cards), [field]: value } };
  }
  if (group === 'header' && (PANEL_HEADER as readonly string[]).includes(field) && typeof value === 'boolean') {
    return { ...settings, header: { ...panelHeader(settings.header), [field]: value } };
  }
  if (key === 'pages.click' && (value === 'same' || value === 'new')) {
    return { ...settings, pages: { click: value } };
  }
  if (key === 'mergeMethod' && typeof value === 'string' && (MERGE_METHODS as readonly string[]).includes(value)) {
    return { ...settings, mergeMethod: value as AgentSettings['mergeMethod'] };
  }
  if (group === 'quickLaunch' && (SLOTS as string[]).includes(field) && typeof value === 'string') {
    const slots = { ...(settings.quickLaunch?.slots ?? {}) };
    if (value === '') delete slots[field];
    else if (PICKABLE_AGENTS.some((a) => a.key === value)) {
      // A new agent starts the slot fresh: a model or flags chosen for another agent do not carry over.
      if (slots[field]?.agent !== value) slots[field] = { agent: value };
    } else return null;
    return { ...settings, quickLaunch: { ...settings.quickLaunch, slots } };
  }
  return null;
}

function toggle(key: string, label: string, sub: string, on: boolean): string {
  return `<label class="srow"><span><b>${escapeHtml(label)}</b><small>${escapeHtml(sub)}</small></span><input type="checkbox" data-setting="${key}"${on ? ' checked' : ''}></label>`;
}

function picker(key: string, options: { value: string; label: string }[], selected: string, label: string): string {
  return `<select data-setting="${key}" aria-label="${escapeHtml(label)}">${options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
}

export function renderPanelSettings(m: PanelSettingsModel): string {
  const s = m.settings;
  const display = s.display;
  const byTitle = PICKABLE_AGENTS.map((a) => ({ value: a.title, label: a.name }));
  const byKey = [{ value: '', label: '—' }, ...PICKABLE_AGENTS.map((a) => ({ value: a.key, label: a.name }))];
  const kbd = (k: string) => `<kbd>${escapeHtml(m.modifier + k)}</kbd>`;
  const slot = (k: QuickLaunchSlotKey) => {
    const q = getQuickLaunchSlot(s.quickLaunch, k);
    const model = q?.modelAlias || q?.model || '';
    return `<div class="krow">${kbd(k)}<span>Quick launch ${k}${model ? ` <small>${escapeHtml(model)}</small>` : ''}</span>${picker(`quickLaunch.${k}`, byKey, q?.agent ?? '', `Quick launch ${k}`)}</div>`;
  };
  const cards = cardSettings(s.cards);
  const row = (label: string, sub: string, control: string) => `<label class="srow"><span><b>${escapeHtml(label)}</b><small>${escapeHtml(sub)}</small></span>${control}</label>`;
  const part = (title: string, id: string, body: string) => `<section class="sset" id="${id}"><h3 class="st">${escapeHtml(title)}</h3>${body}</section>`;
  const listToggle = (k: (typeof LIST_PARTS)[number]) => toggle(`cards.${k}`, LIST_PART_ROWS[k].label, LIST_PART_ROWS[k].sub, cards[k]);
  const SECTIONS = [['set-sessions', 'Sessions'], ['set-cards', 'Cards'], ['set-header', 'Header'], ['set-keys', 'Shortcuts'], ['set-more', 'More'], ['set-devices', 'Devices']];
  return `<div class="settings">
  <nav class="sjump" aria-label="Settings sections">${SECTIONS.map(([id, name]) => `<button data-jump="${id}">${name}</button>`).join('')}</nav>
  <div class="srow"><span><b>Refresh</b><small>Read issues, review, goals and devices again; sessions are already live</small></span><button class="rbtn" data-refresh>Refresh</button></div>
  ${part('Sessions', 'set-sessions', `
  <div class="sh">The list</div>
  ${listToggle('list')}
  ${row('View', 'Compact: a listed card is its title, the agent\'s latest line and what it made', picker('list.view', [{ value: 'default', label: 'Default' }, { value: 'compact', label: 'Compact' }], m.list.view, 'View'))}
  ${row('Sort', 'Sessions that ask always lead', picker('list.sort', [{ value: 'tab', label: 'Tab order' }, { value: 'last', label: 'Last active' }, { value: 'newest', label: 'Newest' }, { value: 'name', label: 'Name' }], m.list.sort, 'Sort'))}
  <div class="sh">Sections</div>
  ${row('Group', 'By topic: what each session is about, as agents-cli names it', picker('list.group', [{ value: 'topic', label: 'By topic' }, { value: 'place', label: 'By where it runs' }], m.list.group, 'Group'))}
  ${row('Order', 'Needs you first: a section with a session that asks moves to the top', picker('list.sections', [{ value: 'needs', label: 'Needs you first' }, { value: 'order', label: 'Your order' }], m.list.sections, 'Order'))}
  ${listToggle('favorites')}
  ${listToggle('finishedGroups')}
  ${row('Ended sessions', 'The most recent ones, as the last section; ⌘K finds every one', picker('list.ended', [{ value: 'off', label: 'Off' }, { value: '10', label: 'Last 10' }, { value: '25', label: 'Last 25' }, { value: 'all', label: 'All' }], m.list.ended, 'Ended sessions'))}
  <div class="srow"><span><b>Section order</b><small>${m.list.ordered ? 'Your order, from ↑ ↓ on a section\'s header' : 'Move a section with ↑ ↓ on its header'}</small></span>${m.list.ordered ? '<button class="rbtn" data-reset-order>Reset</button>' : ''}</div>
  <div class="sh">Titles</div>
  ${DISPLAY_ROWS.map((r) => toggle(`display.${r.key}`, r.label, r.sub, display?.[r.key] === true)).join('')}`)}
  ${part('Cards', 'set-cards', `<div class="cardset">
  <div class="sh">Clicks and answers</div>
  ${CARD_ROWS.map((r) => row(r.label, r.sub, picker(`cards.${r.key}`, r.options, cards[r.key], r.label))).join('')}
  <div class="sh">A card shows <span class="shsub">all off: logo and title on one line</span></div>
  ${CARD_PARTS.map((k) => toggle(`cards.${k}`, CARD_PART_ROWS[k].label, CARD_PART_ROWS[k].sub, cards[k])).join('')}
  ${m.preview ?? ''}
  </div>`)}
  ${part('Header', 'set-header', `<div class="sh">Buttons <span class="shsub">Sessions, ⚙ and ⋯ are always there</span></div>
  ${HEADER_ROWS.map((r) => toggle(`header.${r.key}`, r.label, r.sub, panelHeader(s.header)[r.key])).join('')}`)}
  ${part('Shortcuts', 'set-keys', `
  <div class="krow">${kbd('A')}<span>New agent <small>CLI picks</small></span><span class="auto">Auto</span></div>
  <div class="krow"><span></span><span>Default agent <small>tickets, splits</small></span>${picker('defaultAgent', byTitle, m.defaultAgentTitle, 'Default agent')}</div>
  <div class="krow"><span></span><span>Second agent <small>Assign a shortcut in Keyboard Shortcuts</small></span>${picker('secondaryAgent', byTitle, m.secondaryAgentTitle, 'Second agent')}</div>
  ${SLOTS.map(slot).join('')}`)}
  ${part('Pull requests, pages and more', 'set-more', `
  ${row('Merge with', 'One click on Merge uses this; a repository that does not allow it uses one it allows', picker('mergeMethod', [{ value: 'squash', label: 'Squash' }, { value: 'rebase', label: 'Rebase' }, { value: 'merge', label: 'Merge commit' }], s.mergeMethod ?? 'squash', 'Merge with'))}
  <label class="srow"><span><b>A page opens in</b><small>${kbd('B')} opens your pages; ${m.modifier.startsWith('⌘') ? '⌘' : 'Ctrl'}-click does the other</small></span>${picker('pages.click', [{ value: 'same', label: 'This tab' }, { value: 'new', label: 'A new tab' }], s.pages?.click ?? 'same', 'A page opens in')}</label>
  ${toggle('editor.markdownViewerEnabled', 'Open .md and .html in Reader', 'The Reader editor for Markdown and HTML', s.editor?.markdownViewerEnabled ?? true)}
  ${toggle('lead.speak', 'Lead reads answers aloud', 'The Lead speaks each answer on this machine as it arrives', m.leadSpeak)}`)}
  <section class="sset" id="set-devices">${renderDevicesSection(m.devices)}</section>
  <p class="foot">Banners for asks, with their reminders, come from the AGI Menu. Accounts and projects live in the <code>agents</code> CLI and the AGI Menu.</p>
</div>`;
}
