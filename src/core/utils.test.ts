import { describe, test, expect } from 'bun:test';
import {
  parseTerminalName,
  sanitizeLabel,
  getExpandedAgentName,
  getTerminalDisplayInfo,
  formatTerminalTitle,
  isHostFallbackLabel,
  presentableLabel,
  getSessionChunk,
  extractFirstNWords,
  extractLinearTicketId,
  getPrefixFromTerminalId,
  truncateText,
  prefixToAgentType,
  CLAUDE_TITLE,
  CODEX_TITLE,
  SHELL_TITLE,
} from './utils';

const NOT_AGENT = { isAgent: false, prefix: null, label: null, sessionChunk: null };
const agent = (prefix: string, label: string | null = null, sessionChunk: string | null = null) => ({ isAgent: true, prefix, label, sessionChunk });

describe('parseTerminalName', () => {
  test('reads a chip or full name, with an optional session chunk and label', () => {
    const cases: Array<[string, unknown]> = [
      ['CC', agent('CC')],
      ['  CC  ', agent('CC')],
      ['Cursor', agent('CR')],
      ['CX - bug fix', agent('CX', 'bug fix')],
      ['Claude - feature work  ', agent('CC', 'feature work')],
      ['Claude a1b2c3d4 - task', agent('CC', 'task', 'a1b2c3d4')],
    ];
    for (const [name, expected] of cases) expect(parseTerminalName(name)).toEqual(expected);
  });

  test('accepts process-title forms from shell integration (Agents grok)', () => {
    // After `exec agents run grok`, VS Code's ${process} tab title can show
    // "Agents grok" / "agents claude"; those must still identify as agents so
    // the status bar and scanExisting re-bind the tab.
    expect(parseTerminalName('Agents grok')).toEqual(agent('GK'));
    expect(parseTerminalName('agents run kimi')).toEqual(agent('KM'));
    expect(parseTerminalName('Agents: Grok - auth')).toEqual(agent('GK', 'auth'));
    expect(parseTerminalName('Agents foobar')).toEqual(NOT_AGENT);
  });

  test('rejects non-agent shells, Gemini, partial matches and an empty label (strict mode)', () => {
    for (const name of ['bash', 'GX', 'Gemini', 'cc', 'success', 'CCTools', 'CC-label', 'CClabel', 'CC - ']) {
      expect(parseTerminalName(name)).toEqual(NOT_AGENT);
    }
  });
});

describe('small text helpers', () => {
  test('sanitizeLabel strips quotes, collapses spaces and keeps at most 5 words', () => {
    expect(sanitizeLabel('"auth    feature"')).toBe('auth feature');
    expect(sanitizeLabel('`code review`')).toBe('code review');
    expect(sanitizeLabel('one two three four five six seven')).toBe('one two three four five');
    expect(sanitizeLabel('  \t\n  ')).toBe('');
  });

  test('extractFirstNWords keeps N words, adds an ellipsis only when it cut, and reads blank as null', () => {
    expect(extractFirstNWords('Hello world how are you doing today', 5)).toBe('Hello world how are you...');
    expect(extractFirstNWords('  hello   world  ', 5)).toBe('hello world');
    expect(extractFirstNWords('one two three four five', 3)).toBe('one two three...');
    expect(extractFirstNWords('one two three four five', 5)).toBe('one two three four five');
    expect(extractFirstNWords(undefined, 5)).toBeNull();
    expect(extractFirstNWords('   ', 5)).toBeNull();
  });

  test('truncateText keeps text within the limit and ends a cut with an ellipsis', () => {
    expect(truncateText('hello', 5)).toBe('hello');
    expect(truncateText('hello world', 8)).toBe('hello...');
    expect(truncateText('abcd', 3)).toBe('...');
    expect(truncateText('', 10)).toBe('');
  });

  test('getExpandedAgentName expands a known chip and passes anything else through', () => {
    expect(getExpandedAgentName(CLAUDE_TITLE)).toBe('Claude');
    expect(getExpandedAgentName(SHELL_TITLE)).toBe('Shell');
    expect(getExpandedAgentName('GX')).toBe('GX');
    expect(getExpandedAgentName('Custom')).toBe('Custom');
  });

  test('getSessionChunk is the first 8 characters of a UUID, else null', () => {
    expect(getSessionChunk('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('a1b2c3d4');
    expect(getSessionChunk(undefined)).toBeNull();
    expect(getSessionChunk('invalid')).toBeNull();
  });
});

describe('extractLinearTicketId', () => {
  test('finds the first uppercase TEAM-123 id anywhere in the text', () => {
    expect(extractLinearTicketId('Ship launchctl fix\n\nReference: RUSH-545')).toBe('RUSH-545');
    expect(extractLinearTicketId('work on ABC123-7 please')).toBe('ABC123-7');
    expect(extractLinearTicketId('blocked by RUSH-100 and RUSH-200')).toBe('RUSH-100');
  });

  test('returns null without a well-formed id', () => {
    for (const text of ['just a regular message', '', undefined, 'rush-545', 'RUSH545', 'RUSH-']) {
      expect(extractLinearTicketId(text)).toBeNull();
    }
  });
});

describe('getTerminalDisplayInfo', () => {
  test('identifies by name, then terminalId, then icon, in that priority', () => {
    expect(getTerminalDisplayInfo({ name: 'CC - auth feature' })).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: 'auth feature',
      expandedName: 'Claude',
      statusBarText: 'Claude - auth feature',
      iconFilename: 'claude.png',
      sessionChunk: null
    });
    expect(getTerminalDisplayInfo({ name: 'auth feature', terminalId: 'CC-1735824000000-1' })).toMatchObject({ prefix: 'CC', label: 'auth feature' });
    expect(getTerminalDisplayInfo({ name: 'auth feature', iconFilename: 'claude.png' })).toMatchObject({ prefix: 'CC', label: 'auth feature' });
    expect(getTerminalDisplayInfo({ name: 'CC - explicit label', terminalId: 'CX-123', iconFilename: 'cursor.png' })).toMatchObject({ prefix: 'CC', label: 'explicit label' });
    expect(getTerminalDisplayInfo({ name: 'my task', terminalId: 'CX-123', iconFilename: 'cursor.png' })).toMatchObject({ prefix: 'CX', label: 'my task' });
    expect(getTerminalDisplayInfo({ name: '', terminalId: 'CC-123' })).toMatchObject({ isAgent: true, prefix: 'CC', label: null });
  });

  test('returns null fields for a non-agent terminal', () => {
    expect(getTerminalDisplayInfo({ name: 'bash' })).toEqual({
      isAgent: false,
      prefix: null,
      label: null,
      expandedName: null,
      statusBarText: null,
      iconFilename: null,
      sessionChunk: null
    });
  });

  test('a rescanned "CC - [host/<device>]" tab drops the host chip label', () => {
    const info = getTerminalDisplayInfo({ name: 'CC - [host/yosemite-m3]' });
    expect(info.isAgent).toBe(true);
    expect(info.label).toBeNull();
    expect(info.statusBarText).toBe('Claude');
  });
});

describe('getPrefixFromTerminalId', () => {
  test('reads the prefix, maps the old CL prefix to CC, and passes a dashless id through', () => {
    expect(getPrefixFromTerminalId('CX-123-456')).toBe('CX');
    expect(getPrefixFromTerminalId('CL-1735824000000-1')).toBe('CC');
    expect(getPrefixFromTerminalId('Claude')).toBe('Claude');
    expect(getPrefixFromTerminalId('')).toBeNull();
  });
});

describe('formatTerminalTitle', () => {
  const display = { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: false };

  test('composes chip or full name, session chunk and label as the display preferences say', () => {
    expect(formatTerminalTitle('CX', { display: { ...display, showFullAgentNames: false } })).toBe('CX');
    expect(formatTerminalTitle('CR', { label: 'auth', display })).toBe('Cursor - auth');
    expect(formatTerminalTitle('CR', { label: 'auth', display: { ...display, labelReplacesTitle: true } })).toBe('auth');
    expect(formatTerminalTitle('CR', { label: 'auth', display: { ...display, showLabelsInTitles: false } })).toBe('Cursor');
    expect(formatTerminalTitle('CC', {
      label: 'my-label',
      display: { ...display, showFullAgentNames: false, showSessionIdInTitles: true },
      sessionChunk: 'a1b2c3d4'
    })).toBe('CC a1b2c3d4 - my-label');
  });

  test('showLabelOnlyOnFocus hides the label only on an unfocused tab', () => {
    const onFocus = { ...display, showLabelOnlyOnFocus: true };
    expect(formatTerminalTitle('CC', { label: 'auth-feature', display: onFocus, isFocused: false })).toBe('Claude');
    expect(formatTerminalTitle('CC', { label: 'auth-feature', display: onFocus, isFocused: true })).toBe('Claude - auth-feature');
    expect(formatTerminalTitle('CC', { label: 'auth-feature', display: onFocus })).toBe('Claude - auth-feature');
    expect(formatTerminalTitle('CC', { label: 'auth-feature', display: { ...onFocus, labelReplacesTitle: true }, isFocused: false })).toBe('Claude');
    expect(formatTerminalTitle('CC', {
      label: 'auth-feature',
      display: { ...onFocus, showFullAgentNames: false, showSessionIdInTitles: true },
      sessionChunk: 'a1b2c3d4',
      isFocused: false
    })).toBe('CC a1b2c3d4');
    expect(formatTerminalTitle('CC', { label: 'auth-feature', display: { ...display, showLabelOnlyOnFocus: false }, isFocused: false })).toBe('Claude - auth-feature');
  });

  test('drops a bare [host/<device>] fallback label — tab falls back to the base (PHNX-3893)', () => {
    const short = { ...display, showFullAgentNames: false };
    expect(formatTerminalTitle('CC', { label: '[host/yosemite-m3]', display: short })).toBe('CC');
    // labelReplacesTitle must not leave an empty title either.
    expect(formatTerminalTitle('CC', { label: '[host/yosemite-m3]', display: { ...short, labelReplacesTitle: true } })).toBe('CC');
    expect(formatTerminalTitle('CC', { label: 'fix host resolver', display: short })).toBe('CC - fix host resolver');
  });
});

describe('isHostFallbackLabel', () => {
  test('matches only the exact [host/<device>] chip', () => {
    expect(isHostFallbackLabel('[host/yosemite-m3]')).toBe(true);
    expect(isHostFallbackLabel('  [host/zion]  ')).toBe(true);
    for (const label of ['fix host resolver', 'CC - [host/yosemite-m3]', '[host/]', '', null, undefined]) {
      expect(isHostFallbackLabel(label)).toBe(false);
    }
  });
});

describe('presentableLabel', () => {
  test('keeps a real label, stripping the CLI account decoration', () => {
    expect(presentableLabel('  auth refactor  ')).toBe('auth refactor');
    expect(presentableLabel('auth refactor <muqsit@getrush.ai>')).toBe('auth refactor');
    expect(presentableLabel('fix host resolver')).toBe('fix host resolver');
  });

  test('drops the host fallback and anything that leaves nothing behind', () => {
    for (const label of ['[host/yosemite-m3]', '<muqsit@getrush.ai>', '', null, undefined]) {
      expect(presentableLabel(label)).toBeNull();
    }
  });

  test('agrees with the tab title on what counts as a real label', () => {
    // Both label surfaces route through this function, so they cannot diverge.
    const display = { showFullAgentNames: false, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: false };
    for (const raw of ['[host/yosemite-m3]', 'auth refactor', '<acct>', 'fix host resolver']) {
      const shown = presentableLabel(raw);
      expect(formatTerminalTitle('CC', { label: raw, display })).toBe(shown ? `CC - ${shown}` : 'CC');
    }
  });
});

describe('prefixToAgentType', () => {
  test('maps canonical and config prefixes in any case to a session agent type', () => {
    for (const prefix of ['CC', 'cc', 'cl', 'CL']) expect(prefixToAgentType(prefix)).toBe('claude');
    expect(prefixToAgentType(CODEX_TITLE)).toBe('codex');
    expect(prefixToAgentType('oc')).toBe('opencode');
  });

  test('shell, Gemini, unknown and null have no session agent type', () => {
    for (const prefix of ['SH', 'GX', 'gm', 'XX', null]) expect(prefixToAgentType(prefix)).toBeNull();
  });
});
