// The Project panel's Settings tab: AGI EXT's own preferences, read from and written
// to `agentSettings` (globalState) and the default/second agent titles. Nothing here
// talks to the CLI; devices, accounts and projects live in `agents` and the AGI Menu.

import { escapeHtml } from './projectPanel';
import { BUILT_IN_AGENTS } from './agents';
import { CLI_AGENT_META, type CliAgentId } from './agents.cli';
import { DEFAULT_NOTIFICATION_SETTINGS, getQuickLaunchSlot, type AgentSettings, type DisplayPreferences, type QuickLaunchSlotKey } from './settings';

const DISPLAY_ROWS: { key: keyof DisplayPreferences; label: string; sub: string }[] = [
  { key: 'showLabelsInTitles', label: 'Labels in titles', sub: 'The tab title shows the session label' },
  { key: 'autoLabelInTabTitles', label: 'Auto labels', sub: 'Use the CLI title once the stream has one' },
  { key: 'labelReplacesTitle', label: 'Replace base title', sub: 'The label replaces “CC -” instead of following it' },
  { key: 'showLabelOnlyOnFocus', label: 'Hide labels off focus', sub: 'Background tabs show only the agent' },
  { key: 'showFullAgentNames', label: 'Full agent names', sub: '“Claude” instead of “CC”' },
  { key: 'showSessionIdInTitles', label: 'Session id', sub: 'Append the short id to the title' },
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
  if (key === 'notifications.enabled' && typeof value === 'boolean') {
    return { ...settings, notifications: { ...notifications(settings), enabled: value } };
  }
  if (key === 'notifications.style' && (value === 'native' || value === 'vscode')) {
    return { ...settings, notifications: { ...notifications(settings), style: value } };
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

function notifications(s: AgentSettings): NonNullable<AgentSettings['notifications']> {
  return s.notifications ?? DEFAULT_NOTIFICATION_SETTINGS;
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
  const alerts = notifications(s);
  return `<div class="settings">
  <div class="sh">Session titles</div>
  ${DISPLAY_ROWS.map((r) => toggle(`display.${r.key}`, r.label, r.sub, display?.[r.key] === true)).join('')}
  <div class="sh">Shortcuts</div>
  <div class="krow">${kbd('A')}<span>New agent <small>CLI picks</small></span><span class="auto">Auto</span></div>
  <div class="krow"><span></span><span>Default agent <small>tickets, splits</small></span>${picker('defaultAgent', byTitle, m.defaultAgentTitle, 'Default agent')}</div>
  <div class="krow">${kbd('B')}<span>Second agent</span>${picker('secondaryAgent', byTitle, m.secondaryAgentTitle, 'Second agent')}</div>
  ${SLOTS.map(slot).join('')}
  <div class="sh">Reader and alerts</div>
  ${toggle('editor.markdownViewerEnabled', 'Open .md and .html in Reader', 'The Reader editor for Markdown and HTML', s.editor?.markdownViewerEnabled ?? true)}
  ${toggle('notifications.enabled', 'Approval alerts', 'Notify when a session in this window needs you', alerts.enabled)}
  <label class="srow"><span><b>Alert style</b></span>${picker('notifications.style', [{ value: 'native', label: 'Native OS' }, { value: 'vscode', label: 'Editor toast' }], alerts.style, 'Alert style')}</label>
  <p class="foot">Devices, accounts and projects live in the <code>agents</code> CLI and the AGI Menu.</p>
</div>`;
}
