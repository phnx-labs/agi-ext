import { describe, expect, test } from 'bun:test';
import { planSessionTabLabelUpdate, restoredSessionTabLabels } from './sessionTabLabelSync';
import { streamTitle } from './projectPanel';

const row = (o: Partial<{ title: string; label: string; topic: string; cwd: string }>) => ({ title: '', label: '', topic: '', ...o });

describe('session tab label reconciliation', () => {
  test('the tab takes the title its card shows: the CLI title, else the label', () => {
    expect(planSessionTabLabelUpdate({}, streamTitle(row({ title: 'Fix fork across devices', label: 'old name' }))))
      .toEqual({ label: 'Fix fork across devices', clearManualLabel: false });
    expect(planSessionTabLabelUpdate({}, streamTitle(row({ label: 'Release the project', topic: 'Initial task' }))))
      .toEqual({ label: 'Release the project', clearManualLabel: false });
  });

  test('replaces a provisional /continue title when the session name arrives', () => {
    const provisional = row({ topic: '/continue /Users/muqsit/Screenshots/CleanShot.png' });
    expect(streamTitle(provisional)).toBe('');
    expect(planSessionTabLabelUpdate({ autoLabel: 'fork of Release' }, streamTitle(provisional))).toBeUndefined();
    expect(planSessionTabLabelUpdate({ autoLabel: 'fork of Release' }, streamTitle({ ...provisional, label: 'Release the project' })))
      .toEqual({ label: 'Release the project', clearManualLabel: false });
  });

  test('a name the extension kept for the tab gives way to the session title', () => {
    expect(planSessionTabLabelUpdate({ manualLabel: 'Ship blocker' }, 'Release agents-cli'))
      .toEqual({ label: 'Release agents-cli', clearManualLabel: true });
  });

  test('never adopts the CLI [host/<device>] fallback or Claude\'s folder placeholder', () => {
    expect(streamTitle(row({ label: '[host/yosemite-m3]' }))).toBe('');
    expect(streamTitle(row({ label: 'agents-cli-55', cwd: '/home/u/src/agents-cli' }))).toBe('');
    expect(streamTitle(row({ label: 'RUSH-2058', cwd: '/home/u/src/agents-cli' }))).toBe('RUSH-2058');
  });

  test('does nothing until a title exists or when the tab already shows it', () => {
    expect(planSessionTabLabelUpdate({ autoLabel: 'Initial task' }, '')).toBeUndefined();
    expect(planSessionTabLabelUpdate({ autoLabel: 'Release the project' }, 'Release the project')).toBeUndefined();
  });

  test('a tab showing the generated title cut to its 34-character cap restores as automatic, not manual', () => {
    const autoLabel = 'Please tell me what is the main progress that we have made';
    expect(restoredSessionTabLabels('Please tell me what is the main…', { autoLabel })).toEqual({ manualLabel: undefined, autoLabel });
    expect(restoredSessionTabLabels('Ship blocker', { autoLabel })).toEqual({ manualLabel: 'Ship blocker', autoLabel });
  });

  test('restores a generated title as automatic rather than manual', () => {
    expect(restoredSessionTabLabels('Release the project', {
      autoLabel: 'Release the project',
    })).toEqual({ manualLabel: undefined, autoLabel: 'Release the project' });
  });
});
