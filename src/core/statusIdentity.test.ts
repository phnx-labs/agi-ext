import { describe, expect, it } from 'bun:test';
import { displayIdentity, formatAgentStatusBarText, formatAgentStatusBarTooltip, normalizeStatusEmail, resolveStreamIdentityStamp, type StatusIdentitySource } from './statusIdentity';

describe('status bar session copy presentation', () => {
  const id = '019fd129-6e9f-7082-ad08-9c22de9f1234';
  const rollout = 'rollout-2026-08-05T02-03-01-' + id;

  it('shows the compact canonical ID and keeps the full host and ID in the tooltip', () => {
    expect(formatAgentStatusBarText('Codex', '1.0', 'dev@example.com', 'Fix parser', rollout, false, 'm3'))
      .toBe('Agents: Codex 1.0 <dev@example.com> $(vm) m3 - Fix parser $(copy) 019fd129');
    expect(formatAgentStatusBarTooltip(rollout, 'yosemite-m3'))
      .toBe('Host: yosemite-m3\nSession: ' + id + '\nClick to copy session ID');
  });

  it('does not offer copying before a session ID is available', () => {
    expect(formatAgentStatusBarText('Codex', undefined, undefined, null, undefined, true))
      .toBe('Agents: Codex (tracking session)');
    expect(formatAgentStatusBarTooltip()).toBe('No session ID available');
    expect(formatAgentStatusBarTooltip(id)).not.toContain('Host:');
  });
});

describe('normalizeStatusEmail', () => {
  it('strips angle brackets and whitespace, blanks empties', () => {
    expect(normalizeStatusEmail('<tech@prix.dev>')).toBe('tech@prix.dev');
    expect(normalizeStatusEmail('  tech@prix.dev ')).toBe('tech@prix.dev');
    expect(normalizeStatusEmail('')).toBeUndefined();
    expect(normalizeStatusEmail(null)).toBeUndefined();
    expect(normalizeStatusEmail(undefined)).toBeUndefined();
  });
});

// The exact defect: a Kimi tab rendered the version + account of a DIFFERENT
// session left over in the same terminal. displayIdentity returns fields only
// when they were resolved for the session id now displayed.
describe('displayIdentity — only the current session\'s identity', () => {
  const claude: StatusIdentitySource = {
    identityAppliedSessionId: 'sess-A',
    version: '2.1.218',
    account: 'tech@prix.dev',
  };

  it('shows version + account resolved FOR the shown session', () => {
    expect(displayIdentity(claude, 'sess-A')).toEqual({ version: '2.1.218', account: 'tech@prix.dev' });
  });

  it('withholds a prior session\'s identity when the shown session differs (the Kimi bug)', () => {
    // Terminal now shows Kimi session sess-K, but the entry still carries the
    // Claude identity resolved for sess-A. Nothing must leak.
    expect(displayIdentity(claude, 'sess-K')).toEqual({});
  });

  it('withholds identity before any session id is known', () => {
    expect(displayIdentity(claude, undefined)).toEqual({});
  });

  it('withholds identity that was never applied (no identityAppliedSessionId)', () => {
    const leftover: StatusIdentitySource = { version: '2.1.218' }; // e.g. a restore-match leftover
    expect(displayIdentity(leftover, 'sess-K')).toEqual({});
  });

  it('shows a version-only harness (Grok/Cursor/Droid: version, no account)', () => {
    const grok: StatusIdentitySource = { identityAppliedSessionId: 'sess-G', version: '1.4.0' };
    expect(displayIdentity(grok, 'sess-G')).toEqual({ version: '1.4.0', account: undefined });
  });

  it('shows blank for an identity-less harness (Kimi: no version, no account) once resolved', () => {
    const kimi: StatusIdentitySource = { identityAppliedSessionId: 'sess-K' };
    expect(displayIdentity(kimi, 'sess-K')).toEqual({ version: undefined, account: undefined });
  });

  it('prefers the live version over the display-only statusVersion', () => {
    const entry: StatusIdentitySource = { identityAppliedSessionId: 's', version: '2.1.218', statusVersion: '2.0.0' };
    expect(displayIdentity(entry, 's').version).toBe('2.1.218');
  });
});

// RUSH-3184: the status bar's version/account come from the broadcast watch row
// via resolveStreamIdentityStamp, NOT a per-tab `agents sessions <id> --device
// <host> --json` respawn. The pure decision is tested here; the no-spawn
// guarantee is structural (see src/vscode/statusBarIdentity.spawnStorm.test.ts).
describe('resolveStreamIdentityStamp — identity from the broadcast row', () => {
  it('stamps the row identity authoritatively for the shown session', () => {
    expect(resolveStreamIdentityStamp({ version: '2.1.207', account: 'muqsit@getrush.ai' }, 'sess-A', 'sess-A'))
      .toEqual({ version: '2.1.207', account: 'muqsit@getrush.ai', identityAppliedSessionId: 'sess-A' });
  });

  it('carries a null field through so the stamp CLEARS a prior binding leftover', () => {
    // Grok: version, no account. Kimi: neither. Nulls must reach the tab so a
    // stale 2.1.218/account from a prior session in the same terminal is cleared.
    expect(resolveStreamIdentityStamp({ version: '1.4.0', account: null }, 'sess-G', 'sess-G'))
      .toEqual({ version: '1.4.0', account: null, identityAppliedSessionId: 'sess-G' });
    expect(resolveStreamIdentityStamp({ version: null, account: null }, 'sess-K', 'sess-K'))
      .toEqual({ version: null, account: null, identityAppliedSessionId: 'sess-K' });
  });

  it('returns null when the session is not on the stream yet (blank-until-resolved, retry next event)', () => {
    expect(resolveStreamIdentityStamp(undefined, 'sess-A', 'sess-A')).toBeNull();
  });

  it('returns null when the tab has moved on to another session (never stamp a stale id)', () => {
    expect(resolveStreamIdentityStamp({ version: '2.1.207', account: 'a@b.c' }, 'sess-OLD', 'sess-NEW')).toBeNull();
  });

  it('allows an unbound (id-less) tab to accept the stamp', () => {
    expect(resolveStreamIdentityStamp({ version: '2.1.207', account: 'a@b.c' }, 'sess-A', undefined))
      .toEqual({ version: '2.1.207', account: 'a@b.c', identityAppliedSessionId: 'sess-A' });
  });
});
