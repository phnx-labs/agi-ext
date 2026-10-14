import { describe, it, expect } from 'bun:test';
import { assignTabs, type TabView } from './tabIndex';

const term = (label: string, terminal?: number): TabView => ({ label, isTerminal: true, ...(terminal === undefined ? {} : { terminal }) });
const file = (label: string): TabView => ({ label, isTerminal: false });

describe('assignTabs', () => {
  it('numbers each terminal by its tab position in its group, counting file tabs', () => {
    expect(assignTabs([[file('README.md'), term('CC - auth'), term('CX - ui')]], ['CX - ui', 'CC - auth'])).toEqual([3, 2]);
    expect(assignTabs([[file('a.ts'), term('CC')], [term('CX'), term('GX')]], ['CC', 'CX', 'GX'])).toEqual([2, 1, 2]);
  });

  it('gives two tabs with one label two numbers, never the same one', () => {
    expect(assignTabs([[term('CC'), term('CC')]], ['CC', 'CC'])).toEqual([1, 2]);
  });

  it('puts a tab known by identity on its own terminal, whatever the creation order', () => {
    // The second terminal was dragged to the front; the window saw it there.
    expect(assignTabs([[term('CC', 1), term('CC')]], ['CC', 'CC'])).toEqual([2, 1]);
  });

  it('leaves a panel terminal and a file tab with the same label unnumbered', () => {
    expect(assignTabs([[file('CC'), term('CX')]], ['CC', 'CX'])).toEqual([undefined, 2]);
    expect(assignTabs([], ['CC'])).toEqual([undefined]);
  });

  it('ignores a stale identity that points past the terminal list', () => {
    expect(assignTabs([[term('CC', 5)]], ['CC'])).toEqual([1]);
  });
});
