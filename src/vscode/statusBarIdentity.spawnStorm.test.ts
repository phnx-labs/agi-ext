import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Structural guard for RUSH-3184 / agi-cli#3019 — the per-tab identity side
// channel that caused the 2026-08-25 CPU incident must stay deleted. The status
// bar reads identity from the broadcast watch row (SessionPresentationStore),
// never a per-tab `agents sessions <id> --device <host> --json` respawn. See
// AGENTS.md rule #1 (project fields over the stream, no side-channel fetch) and
// rule #3 (the extension must never own a per-tab fetch loop). The behavioral
// contract is in src/core/spawnStorm.regression.test.ts.
const extensionSource = readFileSync(join(import.meta.dir, 'extension.ts'), 'utf8');
const remoteSessionsSource = readFileSync(join(import.meta.dir, 'remoteSessions.vscode.ts'), 'utf8');

describe('status-bar identity side channel stays deleted (RUSH-3184)', () => {
  // Assert against real CODE patterns (definitions/calls/imports), not prose —
  // the replacement comments deliberately name the deleted symbols for context.
  test('extension.ts no longer defines, calls, or imports the per-tab identity side channel', () => {
    // The event-pumped fetch gate is gone (definition + both call sites).
    expect(extensionSource).not.toContain('function tryHydrateSessionIdentity');
    expect(extensionSource).not.toContain('tryHydrateSessionIdentity(');
    // The per-tab fetch is no longer imported or invoked here.
    expect(extensionSource).not.toContain('fetchSessionIdentity(');
    expect(extensionSource).not.toMatch(/import[^;]*\bfetchSessionIdentity\b[^;]*from/);
    // The in-flight coalescer is fully removed.
    expect(extensionSource).not.toContain('statusIdentityInFlight');
    // The retry gate that required both fields and re-fired on every pump is gone.
    expect(extensionSource).not.toContain('identitySessionId');
  });

  test('the status-bar update stamps identity from the stream, not a subprocess', () => {
    const fn = extensionSource.slice(
      extensionSource.indexOf('function updateStatusBarForTerminal'),
      extensionSource.indexOf('function relabelActiveTerminal'),
    );
    // Reads the broadcast row via the pure stream stamp…
    expect(fn).toContain('applyStreamIdentity');
    // …and never spawns a per-tab identity fetch.
    expect(fn).not.toContain('fetchSessionIdentity(');
    expect(fn).not.toContain('execFile');
  });

  test('applyStreamIdentity resolves identity from the presentation store only', () => {
    const fn = extensionSource.slice(
      extensionSource.indexOf('function applyStreamIdentity'),
      extensionSource.indexOf('const liveSessionInFlight'),
    );
    expect(fn).toContain('sessionPresentationStore.liveSession');
    expect(fn).toContain('resolveStreamIdentityStamp');
    expect(fn).not.toContain('await'); // synchronous: no subprocess, no I/O
    expect(fn).not.toContain('execFile');
  });

  test('remoteSessions.vscode.ts no longer exports a per-tab identity fetch', () => {
    expect(remoteSessionsSource).not.toContain('export async function fetchSessionIdentity');
    expect(remoteSessionsSource).not.toContain("'--device', host, '--json'");
  });
});
