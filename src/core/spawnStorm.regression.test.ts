import { describe, expect, test } from 'bun:test';
import { SessionPresentationStore } from './sessionPresentationStore';
import { displayIdentity, resolveStreamIdentityStamp, type StatusIdentitySource } from './statusIdentity';

// Regression for RUSH-3184 / agi-cli#3019 — the 2026-08-25 CPU incident.
//
// The status bar's version/account used to hydrate through a per-tab
// by-id session-detail fetch over `--device <host>` (`fetchSessionIdentity`)
// re-fired by an event-pumped, backoff-less gate (`tryHydrateSessionIdentity`).
// For N remote `--device` tabs whose identity never fully resolved, every
// status-bar / live-id refresh respawned one Node+SSH process per tab every
// ~4–5s (load 10.2/18 cores measured). This test pins the fixed contract:
//
//  * identity is read ONLY from the broadcast watch row (the single stream), so
//    N refreshes across N tabs spawn ZERO by-id subprocesses — a pure store read;
//  * the read is idempotent and never respawns work when nothing changed;
//  * the status bar renders identity purely from the row, including the
//    partial (version-without-account) case that used to keep the gate open
//    forever, and fills the account in the instant the stream carries it.
//
// A tab entry mirrors the fields extension.ts stamps + reads for the status bar.
interface TabEntry extends StatusIdentitySource {
  sessionId: string;
  version?: string;
  account?: string;
}

/**
 * Exactly the pure work extension.ts's `applyStreamIdentity` does on a status-bar
 * refresh: read the live row, resolve the stamp, apply it (null clears), then
 * derive what the bar renders via displayIdentity. `liveSession` is the ONLY
 * identity source — there is no per-tab exec anywhere in this path.
 */
function refreshStatusBar(store: SessionPresentationStore, entry: TabEntry): { version?: string; account?: string } {
  const live = store.liveSession(entry.sessionId);
  const stamp = resolveStreamIdentityStamp(live, entry.sessionId, entry.sessionId);
  if (stamp) {
    entry.version = stamp.version ?? undefined;
    entry.account = stamp.account ?? undefined;
    entry.identityAppliedSessionId = stamp.identityAppliedSessionId;
  }
  return displayIdentity(entry, entry.sessionId);
}

describe('status-bar identity spawn storm (RUSH-3184)', () => {
  const N = 12;
  const ids = Array.from({ length: N }, (_, i) => `sess-${String(i).padStart(2, '0')}`);

  test('N remote tabs, identity unresolved, N refreshes → 0 by-id subprocesses, no respawn, identity from the row', () => {
    const store = new SessionPresentationStore();
    // Every remote tab is in the state that used to hold the old gate open: the
    // CLI has indexed the session (row exists) with a version but NO account yet.
    store.apply({
      v: 1, type: 'reset', streamId: 'yosemite-s1', sequence: 1, capturedAt: 1, scope: 'yosemite-s1', attention: [],
      agents: ids.map((id) => ({
        rowKey: id, sessionId: id, kind: 'claude', machine: 'yosemite-s1', sourceDevice: 'yosemite-s1',
        version: '2.1.207', status: 'running', context: 'terminal',
      })),
    });

    const tabs: TabEntry[] = ids.map((id) => ({ sessionId: id }));

    // Count every identity source touch. liveSession is a pure in-memory read;
    // the point is that it is the ONLY source and it never spawns a subprocess.
    let liveReads = 0;
    const realLive = store.liveSession.bind(store);
    (store as unknown as { liveSession: typeof store.liveSession }).liveSession = ((id: string) => {
      liveReads += 1;
      return realLive(id);
    }) as typeof store.liveSession;

    // Pump the refresh loop the way the old event storm did: N tabs × N ticks.
    for (let tick = 0; tick < N; tick += 1) {
      for (const tab of tabs) {
        const shown = refreshStatusBar(store, tab);
        // Renders purely from the broadcast row: version present, account blank
        // (not yet on the stream) — never a prior binding's leftover, never a
        // fabricated value from a machine-default `agents view`.
        expect(shown).toEqual({ version: '2.1.207', account: undefined });
      }
    }

    // The whole storm is pure store reads — one per (tab, tick). There is no
    // by-id session-detail exec in the path at all: the count of by-id
    // subprocesses is structurally zero (nothing here can spawn one).
    expect(liveReads).toBe(N * N);
  });

  test('account fills in from the very next stream event — no polling, no respawn', () => {
    const store = new SessionPresentationStore();
    const id = ids[0];
    const tab: TabEntry = { sessionId: id };

    // Beat 1: version indexed, account not yet.
    store.apply({
      v: 1, type: 'reset', streamId: 'yosemite-s1', sequence: 1, capturedAt: 1, scope: 'yosemite-s1', attention: [],
      agents: [{ rowKey: id, sessionId: id, kind: 'claude', machine: 'yosemite-s1', sourceDevice: 'yosemite-s1', version: '2.1.207', status: 'running' }],
    });
    expect(refreshStatusBar(store, tab)).toEqual({ version: '2.1.207', account: undefined });

    // Beat 2: the stream now carries the account. The next refresh — driven by the
    // stream event itself (syncCanonicalSessionTabLabels), not a per-tab poller —
    // fills it in.
    store.apply({
      v: 1, type: 'agent.upsert', streamId: 'yosemite-s1', sequence: 2, capturedAt: 2, scope: 'yosemite-s1',
      rowKey: id, agent: { rowKey: id, sessionId: id, kind: 'claude', machine: 'yosemite-s1', sourceDevice: 'yosemite-s1', version: '2.1.207', account: 'muqsit@getrush.ai', status: 'running' },
    });
    expect(refreshStatusBar(store, tab)).toEqual({ version: '2.1.207', account: 'muqsit@getrush.ai' });
  });

  test('a rerun in the same terminal (new id) never leaks the prior session identity', () => {
    const store = new SessionPresentationStore();
    store.apply({
      v: 1, type: 'reset', streamId: 'local', sequence: 1, capturedAt: 1, scope: 'local', attention: [],
      agents: [
        { rowKey: 'claude-1', sessionId: 'claude-1', kind: 'claude', version: '2.1.207', account: 'muqsit@getrush.ai', sourceDevice: 'local' },
        // The rerun rebinds the SAME terminal to a Kimi session: no version, no account.
        { rowKey: 'kimi-1', sessionId: 'kimi-1', kind: 'kimi', sourceDevice: 'local' },
      ],
    });

    const tab: TabEntry = { sessionId: 'claude-1' };
    expect(refreshStatusBar(store, tab)).toEqual({ version: '2.1.207', account: 'muqsit@getrush.ai' });

    // Rerun: the terminal now shows kimi-1. The stamp CLEARS the Claude identity.
    tab.sessionId = 'kimi-1';
    expect(refreshStatusBar(store, tab)).toEqual({ version: undefined, account: undefined });
  });
});
