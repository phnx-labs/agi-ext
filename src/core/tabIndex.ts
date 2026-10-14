// Which editor tab holds which terminal, and its number — pure, no VS Code import.
//
// VS Code's terminal tab (`TabInputTerminal`) carries no reference to its
// terminal, and two terminals can share a name, so a label alone cannot tell
// their tabs apart: that gave two tabs the same number (PHNX-4387). The window
// learns a tab's terminal by identity when that tab is in front and
// `activeTerminal` is the terminal showing in it (`src/vscode/frontTab.vscode.ts`);
// this module honors those bindings first and gives each terminal one tab.

/** A single editor tab, flattened from vscode.Tab for pure resolution. */
export interface TabView {
  /** The tab's display label (the terminal name for terminal tabs). */
  label: string;
  /** True when the tab hosts a terminal (input instanceof TabInputTerminal). */
  isTerminal: boolean;
  /** Index into the terminal list of the terminal this tab is known to hold. */
  terminal?: number;
}

/**
 * Each terminal's 1-based tab position within its group, by terminal index;
 * undefined for a terminal with no editor tab (a panel terminal).
 *
 * A tab bound by identity takes its terminal first. Every other terminal tab
 * takes the first terminal of the same name that holds no tab yet, so two
 * tabs never share a terminal and a terminal never gets two numbers. The
 * number is group-relative: VS Code has no global tab number.
 */
export function assignTabs(groups: TabView[][], names: string[]): (number | undefined)[] {
  const out: (number | undefined)[] = names.map(() => undefined);
  const taken = new Set<string>();
  const claim = (t: number, g: number, i: number) => { out[t] = i + 1; taken.add(`${g}:${i}`); };
  groups.forEach((tabs, g) => tabs.forEach((tab, i) => {
    const t = tab.terminal;
    if (tab.isTerminal && t !== undefined && t >= 0 && t < names.length && out[t] === undefined) claim(t, g, i);
  }));
  groups.forEach((tabs, g) => tabs.forEach((tab, i) => {
    if (!tab.isTerminal || taken.has(`${g}:${i}`)) return;
    const t = names.findIndex((n, k) => n === tab.label && out[k] === undefined);
    if (t >= 0) claim(t, g, i);
  }));
  return out;
}
