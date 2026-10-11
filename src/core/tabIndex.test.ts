import { describe, it, expect } from 'bun:test';
import { resolveTabIndex, revivedDeadTerminalTabs, type TabView } from './tabIndex';

const term = (label: string): TabView => ({ label, isTerminal: true });
const file = (label: string): TabView => ({ label, isTerminal: false });

describe('resolveTabIndex', () => {
  it('returns the 1-based position of the matching terminal tab within its group', () => {
    const groups = [[file('README.md'), term('CC - auth'), term('CX - ui')]];
    expect(resolveTabIndex(groups, 'CC - auth')).toBe(2);
    expect(resolveTabIndex(groups, 'CX - ui')).toBe(3);
  });

  it('indexes relative to the tab position, counting non-terminal tabs', () => {
    // The file tab at index 0 still shifts the terminal to tab 2.
    expect(resolveTabIndex([[file('index.ts'), term('CC')]], 'CC')).toBe(1 + 1);
  });

  it('resolves per-group, scanning groups in order', () => {
    const groups = [[file('a.ts'), term('CC')], [term('CX'), term('GX')]];
    expect(resolveTabIndex(groups, 'CC')).toBe(2); // group 0, position 2
    expect(resolveTabIndex(groups, 'CX')).toBe(1); // group 1, position 1
    expect(resolveTabIndex(groups, 'GX')).toBe(2); // group 1, position 2
  });

  it('ignores non-terminal tabs even when their label matches', () => {
    expect(resolveTabIndex([[file('CC'), term('CX')]], 'CC')).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveTabIndex([[term('CC')]], 'nope')).toBeUndefined();
    expect(resolveTabIndex([], 'CC')).toBeUndefined();
    expect(resolveTabIndex([[]], 'CC')).toBeUndefined();
  });

  it('returns undefined for an empty terminal name', () => {
    expect(resolveTabIndex([[term('')]], '')).toBeUndefined();
  });

  it('takes the first match within a group when labels are ambiguous', () => {
    expect(resolveTabIndex([[term('CC'), term('CC')]], 'CC')).toBe(1);
  });
});

describe('revivedDeadTerminalTabs', () => {
  const dead = '03c9c75324d09eecbef0224f5d8b155e';
  const tab = (label: string, isTerminal: boolean, hasInput = true) => ({ label, isTerminal, hasInput });

  it('finds the "could not be opened" terminal tabs a crash revived, in every group', () => {
    expect(revivedDeadTerminalTabs([
      [tab('AGI EXT', false), tab(dead, true), tab('Claude 8d05c00f - real a1', true)],
      [tab('5e0f59dc738aac894eab53bd08d18fd7', false, false)],
    ], new Set(['Claude 8d05c00f - real a1']))).toEqual([[0, 1], [1, 0]]);
  });

  it('never touches a live terminal, a file, or a terminal with an ordinary name', () => {
    expect(revivedDeadTerminalTabs([
      [tab(dead, true), tab('zsh', true), tab('deadbeefdeadbeefdeadbeefdeadbeef.ts', false), tab('0123456789abcdef0123456789abcdef', false)],
    ], new Set([dead]))).toEqual([]);
  });
});
