// The Project panel's Settings tab: AGI EXT's own preferences, read from and written
// to `agentSettings` (globalState) and the default/second agent titles. Nothing here
// talks to the CLI; devices, accounts and projects live in `agents` and the AGI Menu.

import { escapeHtml } from './projectPanel';
import { BUILT_IN_AGENTS } from './agents';
import { CLI_AGENT_META, type CliAgentId } from './agents.cli';
import { cardSettings, getQuickLaunchSlot, MERGE_METHODS, type AgentSettings, type CardSettings, type DisplayPreferences, type QuickLaunchSlotKey } from './settings';

const DISPLAY_ROWS: { key: keyof DisplayPreferences; label: string; sub: string }[] = [
  { key: 'showLabelsInTitles', label: 'Labels in titles', sub: 'The tab title shows the session label' },
  { key: 'autoLabelInTabTitles', label: 'Auto labels', sub: 'Use the CLI title once the stream has one' },
  { key: 'labelReplacesTitle', label: 'Replace base title', sub: 'The label replaces “CC -” instead of following it' },
  { key: 'showLabelOnlyOnFocus', label: 'Hide labels off focus', sub: 'Background tabs show only the agent' },
  { key: 'showFullAgentNames', label: 'Full agent names', sub: '“Claude” instead of “CC”' },
  { key: 'showSessionIdInTitles', label: 'Session id', sub: 'Append the short id to the title' },
];

/** The Session cards pickers: each key, its words, and its choices in order. */
const CARD_ROWS: { key: keyof CardSettings; label: string; sub: string; options: { value: string; label: string }[] }[] = [
  { key: 'asks', label: 'Asks on cards', sub: 'Off leaves only the “Asks · 46m” pill', options: [{ value: 'answers', label: 'With answers' }, { value: 'question', label: 'Question only' }, { value: 'off', label: 'Off' }] },
  { key: 'options', label: 'Answer options', sub: 'Each option’s description shows on hover either way', options: [{ value: 'titles', label: 'Titles only' }, { value: 'details', label: 'Titles and details' }] },
  { key: 'question', label: 'Question text', sub: 'The full question is on hover either way', options: [{ value: 'two', label: 'Two lines' }, { value: 'full', label: 'Full' }] },
];

const SLOTS: QuickLaunchSlotKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** The agents a shortcut can launch, as the pickers list them. */
export const PICKABLE_AGENTS = BUILT_IN_AGENTS.filter((a) => a.key !== 'shell')
  .map((a) => ({ key: a.key, title: a.title, name: CLI_AGENT_META[a.key as CliAgentId]?.name ?? a.key }));

export interface PanelSettingsModel {
  settings: AgentSettings;
  /** `agents.defaultAgentTitle` / `agents.secondaryAgentTitle` ("CC", "CX", …). */
  defaultAgentTitle: string;
  secondaryAgentTitle: string;
  /** "⌘⇧" on macOS, "Ctrl+Shift+" elsewhere. */
  modifier: string;
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
  return `<div class="settings">
  <div class="sh">Session titles</div>
  ${DISPLAY_ROWS.map((r) => toggle(`display.${r.key}`, r.label, r.sub, display?.[r.key] === true)).join('')}
  <div class="sh">Shortcuts</div>
  <div class="krow">${kbd('A')}<span>New agent <small>CLI picks</small></span><span class="auto">Auto</span></div>
  <div class="krow"><span></span><span>Default agent <small>tickets, splits</small></span>${picker('defaultAgent', byTitle, m.defaultAgentTitle, 'Default agent')}</div>
  <div class="krow">${kbd('B')}<span>Second agent</span>${picker('secondaryAgent', byTitle, m.secondaryAgentTitle, 'Second agent')}</div>
  ${SLOTS.map(slot).join('')}
  <div class="sh">Pull requests</div>
  <label class="srow"><span><b>Merge with</b><small>One click on Merge uses this; a repository that does not allow it uses one it allows</small></span>${picker('mergeMethod', [{ value: 'squash', label: 'Squash' }, { value: 'rebase', label: 'Rebase' }, { value: 'merge', label: 'Merge commit' }], s.mergeMethod ?? 'squash', 'Merge with')}</label>
  <div class="sh">Session cards</div>
  ${CARD_ROWS.map((r) => `<label class="srow"><span><b>${escapeHtml(r.label)}</b><small>${escapeHtml(r.sub)}</small></span>${picker(`cards.${r.key}`, r.options, cards[r.key], r.label)}</label>`).join('')}
  <div class="sh">Reader</div>
  ${toggle('editor.markdownViewerEnabled', 'Open .md and .html in Reader', 'The Reader editor for Markdown and HTML', s.editor?.markdownViewerEnabled ?? true)}
  <p class="foot">Banners for asks, with their reminders, come from the AGI Menu. Devices, accounts and projects live in the <code>agents</code> CLI and the AGI Menu.</p>
</div>`;
}
