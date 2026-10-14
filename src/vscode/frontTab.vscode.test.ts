// The front tab as a terminal (PHNX-4387): both tab events feed one source, and a
// tab maps to its terminal by identity, so two tabs named "CC" stay apart.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

const { TabInputTerminal } = vscodeDouble();

type Listener = () => void;
const on: Record<'active' | 'tabs' | 'groups', Listener[]> = { active: [], tabs: [], groups: [] };
const sub = (k: keyof typeof on) => (cb: Listener) => { on[k].push(cb); return { dispose: () => { on[k] = on[k].filter((c) => c !== cb); } }; };

interface FakeTab { label: string; input: unknown }
const group: { tabs: FakeTab[]; activeTab: FakeTab | undefined } = { tabs: [], activeTab: undefined };
const win = {
  activeTerminal: undefined as unknown,
  terminals: [] as { name: string }[],
  onDidChangeActiveTerminal: sub('active'),
  tabGroups: {
    get all() { return [group]; },
    get activeTabGroup() { return group; },
    onDidChangeTabs: sub('tabs'),
    onDidChangeTabGroups: sub('groups'),
  },
};
mock.module('vscode', () => vscodeDouble({ window: win }));

const { frontTerminal, onDidChangeFrontTab, terminalTabNumbers } = await import('./frontTab.vscode');

const terminalTab = (label: string): FakeTab => ({ label, input: new TabInputTerminal() });
const emit = (k: keyof typeof on) => on[k].forEach((cb) => cb());

describe('front tab', () => {
  beforeEach(() => {
    win.activeTerminal = undefined;
    win.terminals = [];
    group.tabs = [];
    group.activeTab = undefined;
  });

  test('an editor-tab switch moves the front terminal with no active-terminal event', () => {
    const a = { name: 'CC - auth' }, b = { name: 'CX - ui' };
    win.terminals = [a, b];
    const ta = terminalTab('CC - auth'), tb = terminalTab('CX - ui');
    group.tabs = [ta, tb];
    const seen: unknown[] = [];
    const d = onDidChangeFrontTab((t) => seen.push(t));
    group.activeTab = ta; emit('tabs');
    // activeTerminal never caught up: the tab's own label still finds its terminal.
    group.activeTab = tb; emit('tabs');
    expect(seen).toEqual([a, b]);
    d.dispose();
  });

  test('two tabs with one label keep their own terminals and their own numbers', () => {
    const first = { name: 'CC' }, second = { name: 'CC' };
    win.terminals = [first, second];
    const t1 = terminalTab('CC'), t2 = terminalTab('CC');
    group.tabs = [t1, t2];
    const seen: unknown[] = [];
    const d = onDidChangeFrontTab((t) => seen.push(t));
    // The second terminal was dragged to the front tab; the window sees each in front once.
    group.activeTab = t1; win.activeTerminal = second; emit('tabs'); emit('active');
    group.activeTab = t2; win.activeTerminal = first; emit('tabs'); emit('active');
    expect(terminalTabNumbers().get(second)).toBe(1);
    expect(terminalTabNumbers().get(first)).toBe(2);
    // Back to tab 1 while activeTerminal still says `first`: the remembered pair wins.
    group.activeTab = t1; emit('tabs');
    expect(seen[seen.length - 1]).toBe(second);
    expect(frontTerminal()).toBe(second);
    d.dispose();
  });

  test('a tab that only changed its label does not move the selection back', () => {
    const a = { name: 'CC' };
    win.terminals = [a];
    const ta = terminalTab('CC');
    group.tabs = [ta];
    group.activeTab = ta;
    win.activeTerminal = a;
    let calls = 0;
    const d = onDidChangeFrontTab(() => { calls++; });
    emit('active');
    emit('tabs');
    emit('tabs');
    expect(calls).toBe(1);
    d.dispose();
  });
});
