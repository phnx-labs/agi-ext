import { capTabName } from './utils';

export interface SessionTabLabelState {
  manualLabel?: string;
  autoLabel?: string;
}

export interface SessionTabLabelUpdate {
  label: string;
  clearManualLabel: boolean;
}

export interface PersistedSessionTabLabels {
  label?: string;
  autoLabel?: string;
}

/**
 * Reconcile one editor tab with the session's one name, `streamTitle` of its
 * stream row: the tab shows what its card and the status bar show. A name the
 * extension kept for a tab (an older Agents: Label) gives way: a rename now
 * renames the session itself, so the CLI's title carries it (PHNX-4387).
 */
export function planSessionTabLabelUpdate(
  tab: SessionTabLabelState,
  title: string,
): SessionTabLabelUpdate | undefined {
  if (!title) return undefined;
  const manual = !!tab.manualLabel?.trim();
  if (!manual && tab.autoLabel?.trim() === title) return undefined;
  return { label: title, clearManualLabel: manual };
}

/** Keep automatic-label provenance when VS Code recreates a terminal widget. */
export function restoredSessionTabLabels(
  visibleLabel: string | undefined,
  persisted: PersistedSessionTabLabels | undefined,
): SessionTabLabelState {
  const autoLabel = persisted?.autoLabel?.trim() || undefined;
  const persistedManualLabel = persisted?.label?.trim() || undefined;
  const visibleManualLabel = visibleLabel?.trim();
  // The tab shows the automatic name cut to its cap, which is still that name.
  const automatic = (v: string) => !!autoLabel && (v === autoLabel || v === capTabName(autoLabel));
  const manualLabel = persistedManualLabel
    || (visibleManualLabel && !automatic(visibleManualLabel) ? visibleManualLabel : undefined);
  return { manualLabel, autoLabel };
}
