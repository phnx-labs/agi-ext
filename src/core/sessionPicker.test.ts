import { describe, expect, test } from 'bun:test';
import { ago, pickRow, resumeItems, resumeNotice, type PickerRow } from './sessionPicker';

const NOW = Date.parse('2026-10-11T09:00:00Z');
const row = (over: Partial<PickerRow>): PickerRow => ({
  sessionId: 'b64b7320-58de-412c-88ab-1cf46e3d4f20',
  host: 'yosemite-m2',
  lastActivityMs: NOW - 5 * 60_000,
  confirmedProject: 'svatlas',
  ...over,
});
const opts = (open: string[] = []) => ({ localHost: 'this-mac', localName: 'zion', isOpen: (id: string) => open.includes(id) });

describe('resumeItems', () => {
  test("lists this project's sessions on every machine, newest first, one row per session", () => {
    const items = resumeItems([
      row({ sessionId: 'old', title: 'Old one', lastActivityMs: NOW - 3 * 3600_000 }),
      row({ sessionId: 'other-project', confirmedProject: 'agents', title: 'Not ours' }),
      row({ sessionId: 'local', host: 'this-mac', title: 'On this Mac', lastActivityMs: NOW - 60_000 }),
      // A previous twin of a live session: the live row wins.
      row({ sessionId: 'live', title: 'Ended copy', state: 'inactive', lastActivityMs: NOW - 120_000 }),
      row({ sessionId: 'live', title: 'Live copy', lastActivityMs: NOW - 120_000 }),
    ], 'svatlas', opts(['live']));
    expect(items.map((i) => [i.sessionId, i.title, i.machine, i.open])).toEqual([
      ['local', 'On this Mac', 'zion', false],
      ['live', 'Live copy', 'yosemite-m2', true],
      ['old', 'Old one', 'yosemite-m2', false],
    ]);
  });

  test('your latest message and the agent\'s last line come from the row; missing ones stay empty', () => {
    const [full] = resumeItems([row({
      title: 'SV Atlas proof-of-value signals',
      userTurns: [{ text: 'first ask' }, { text: 'Please add my id to the owner list.\nsecond line' }],
      lastResponse: 'The merge guard now accepts your approvals.\nDetails follow.',
    })], 'svatlas', opts());
    expect(full).toMatchObject({ you: 'Please add my id to the owner list.', agent: 'The merge guard now accepts your approvals.' });

    const [bare] = resumeItems([row({ title: undefined, label: undefined, topic: undefined })], 'svatlas', opts());
    expect(bare).toMatchObject({ title: 'b64b7320', you: '', agent: '' });

    const [fromTimeline] = resumeItems([row({
      timeline: { steps: [{ text: 'Ran 3 commands', source: 'derived' }, { text: 'Pulled 12 commits.', source: 'narration' }] },
    })], 'svatlas', opts());
    expect(fromTimeline!.agent).toBe('Pulled 12 commits.');
  });
});

describe('pickRow', () => {
  test('title, then machine · age · OPEN, then You and Agent lines; empty parts are left out', () => {
    const [item] = resumeItems([row({ title: 'Merge guard', userTurns: [{ text: 'Ship it?' }], lastResponse: 'Shipped.' })], 'svatlas', opts(['b64b7320-58de-412c-88ab-1cf46e3d4f20']));
    expect(pickRow(item!, NOW)).toEqual({ label: 'Merge guard', description: 'yosemite-m2 · 5m ago · OPEN', detail: 'You › Ship it?   Agent › Shipped.' });
    const [bare] = resumeItems([row({ title: 'Bare' })], 'svatlas', opts());
    expect(pickRow(bare!, NOW)).toEqual({ label: 'Bare', description: 'yosemite-m2 · 5m ago', detail: '' });
  });

  test('ago', () => {
    expect(ago(0, NOW)).toBe('');
    expect(ago(NOW - 10_000, NOW)).toBe('now');
    expect(ago(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
    expect(ago(NOW - 3 * 86400_000, NOW)).toBe('3d ago');
  });
});

describe('resumeNotice', () => {
  const s = { title: 'SV Atlas proof-of-value signals', machine: 'yosemite-m2' };
  test('opened: names the window from the CLI\'s last line', () => {
    expect(resumeNotice({ status: 'opened', terminalId: null, reason: '→ VSCodium window "svatlas", new tab "CC - SV Atlas"' }, s, 'agents'))
      .toEqual({ level: 'info', text: 'Opened "SV Atlas proof-of-value signals" (yosemite-m2) in svatlas.' });
  });
  test('focused: this window when the tab is here, else the window the CLI names', () => {
    expect(resumeNotice({ status: 'focused-existing', terminalId: 'CL-1', reason: null }, s, 'svatlas').text)
      .toBe('Focused "SV Atlas proof-of-value signals" (yosemite-m2) in svatlas.');
    expect(resumeNotice({ status: 'focused-existing', terminalId: null, reason: 'Already open → focused tab "CC - SV" in window "agents"' }, s, 'svatlas').text)
      .toBe('Focused "SV Atlas proof-of-value signals" (yosemite-m2) in agents.');
  });
  test('failed: the CLI\'s reason, as an error; never "Opened"', () => {
    const n = resumeNotice({ status: 'failed', terminalId: null, reason: "Can't open 0db3f95b: VSCodium didn't confirm a tab within 10s." }, s, 'svatlas');
    expect(n.level).toBe('error');
    expect(n.text).toBe(`Could not resume "SV Atlas proof-of-value signals" (yosemite-m2): Can't open 0db3f95b: VSCodium didn't confirm a tab within 10s.`);
  });
});
