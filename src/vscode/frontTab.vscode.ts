// The tab in front, as a terminal, and each terminal's tab number.
//
// `onDidChangeActiveTerminal` does not fire reliably when you switch between
// terminal tabs in the editor area, so the sidebars missed the front tab
// (PHNX-4387). Both events feed one source here. A terminal tab carries no
// reference to its terminal, and two terminals can share a name, so the window
// remembers which terminal it saw in which tab. When the active terminal
// changes and has the front tab's label, that terminal is the one showing: the
// pair is recorded, replacing any other claim on that tab. A tab event may come
// before `activeTerminal` catches up, so there a remembered pair wins.

import * as vscode from 'vscode';
import { assignTabs } from '../core/tabIndex';

const tabOf = new Map<vscode.Terminal, vscode.Tab>();

function bind(terminal: vscode.Terminal, tab: vscode.Tab): void {
  for (const [t, held] of tabOf) if (held === tab && t !== terminal) tabOf.delete(t);
  tabOf.set(terminal, tab);
}

function heldBy(tab: vscode.Tab): vscode.Terminal | undefined {
  const open = new Set(vscode.window.terminals);
  for (const [t, held] of tabOf) {
    if (!open.has(t)) tabOf.delete(t);
    else if (held === tab) return t;
  }
  return undefined;
}

function frontTab(): vscode.Tab | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  return tab && tab.input instanceof vscode.TabInputTerminal ? tab : undefined;
}

function resolveFront(activeChanged: boolean): vscode.Terminal | undefined {
  const active = vscode.window.activeTerminal;
  const tab = frontTab();
  if (!tab) return active;
  const matches = !!active && active.name === tab.label;
  if (matches && activeChanged) { bind(active!, tab); return active; }
  const held = heldBy(tab);
  if (held) return held;
  if (matches) { bind(active!, tab); return active; }
  const named = vscode.window.terminals.filter((t) => t.name === tab.label);
  return named.length === 1 ? named[0] : active;
}

/** The terminal in the front tab of the active editor group; with a file in
 *  front, or no editor terminal at all, the last focused terminal. */
export function frontTerminal(): vscode.Terminal | undefined {
  return resolveFront(false);
}

/** Each terminal's 1-based position within its editor group; absent for a panel terminal. */
export function terminalTabNumbers(): Map<vscode.Terminal, number> {
  const all = vscode.window.terminals;
  const groups = vscode.window.tabGroups.all.map((g) => g.tabs.map((tab) => {
    const held = heldBy(tab);
    const at = held ? all.indexOf(held) : -1;
    return { label: tab.label, isTerminal: tab.input instanceof vscode.TabInputTerminal, ...(at >= 0 ? { terminal: at } : {}) };
  }));
  const numbers = assignTabs(groups, all.map((t) => t.name));
  const out = new Map<vscode.Terminal, number>();
  all.forEach((t, i) => { const n = numbers[i]; if (n !== undefined) out.set(t, n); });
  return out;
}

/** Calls `listener` when the tab in front or its terminal changes, from either
 *  event. A tab that only changed its label or state does not call it, so a
 *  Project panel selection is not taken back while you stay on one tab. */
export function onDidChangeFrontTab(listener: (terminal: vscode.Terminal | undefined) => void): vscode.Disposable {
  let last: { tab: vscode.Tab | undefined; terminal: vscode.Terminal | undefined } | undefined;
  const fire = (activeChanged: boolean) => {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const terminal = resolveFront(activeChanged);
    if (last && last.tab === tab && last.terminal === terminal) return;
    last = { tab, terminal };
    listener(terminal);
  };
  const subs = [
    vscode.window.onDidChangeActiveTerminal(() => fire(true)),
    vscode.window.tabGroups.onDidChangeTabs(() => fire(false)),
    vscode.window.tabGroups.onDidChangeTabGroups(() => fire(false)),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
