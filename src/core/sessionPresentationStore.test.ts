import { describe, expect, test } from 'bun:test';
import { SessionPresentationStore } from './sessionPresentationStore';

describe('SessionPresentationStore', () => {
  test('joins projected attention by session id and drops it (to a receipt) on resolution', () => {
    const store = new SessionPresentationStore();
    const attention = { key: 'a1', sessionId: 's1', state: 'open', fingerprint: 'fp' };
    store.apply({ v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'local', agents: [{ rowKey: 'r1', sessionId: 's1' }], attention: [attention] });
    expect(store.sessions()).toEqual([{ rowKey: 'r1', sessionId: 's1', attention }]);
    store.apply({ v: 1, type: 'attention.remove', streamId: 's', sequence: 2, capturedAt: 2, scope: 'local', rowKey: 'a1', resolution: { key: 'a1', state: 'answered' } });
    // Resolved attention is DROPPED from the live join (it lives on as a receipt),
    // so the row no longer carries a stale open/answered item (PHNX-3939).
    expect(store.sessions()).toEqual([{ rowKey: 'r1', sessionId: 's1' }]);
    expect(store.activityEvents()).toEqual([{
      type: 'attention.receipt', key: 'a1', sessionId: 's1', question: undefined,
      source: undefined, fingerprint: 'fp', state: 'answered', resolvedAt: 2,
      resolution: { key: 'a1', state: 'answered' },
    }]);
    store.apply({ v: 1, type: 'reset', streamId: 's', sequence: 3, capturedAt: 3, scope: 'local', agents: [], attention: [] });
    expect(store.sessions()).toEqual([]);
    expect(store.activityEvents()).toHaveLength(1);
  });

  test('ask A -> resolve A -> ask B: the NEW open attention attaches, not the stale one (PHNX-3939)', () => {
    const store = new SessionPresentationStore();
    const askA = { key: 'kA', sessionId: 's1', state: 'open', fingerprint: 'fpA', openedAt: '2026-09-06T00:00:00Z' };
    const askB = { key: 'kB', sessionId: 's1', state: 'open', fingerprint: 'fpB', openedAt: '2026-09-06T00:01:00Z' };
    store.apply({ v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'local', agents: [{ rowKey: 'r1', sessionId: 's1' }], attention: [] });
    store.apply({ v: 1, type: 'attention.upsert', streamId: 's', sequence: 2, capturedAt: 2, scope: 'local', rowKey: 'kA', attention: askA });
    expect((store.sessions()[0] as { attention?: unknown }).attention).toEqual(askA);
    // Resolve A, then a NEW question B arrives for the SAME session.
    store.apply({ v: 1, type: 'attention.remove', streamId: 's', sequence: 3, capturedAt: 3, scope: 'local', rowKey: 'kA', resolution: { key: 'kA', state: 'answered' } });
    store.apply({ v: 1, type: 'attention.upsert', streamId: 's', sequence: 4, capturedAt: 4, scope: 'local', rowKey: 'kB', attention: askB });
    // The card must show B (the live open question), never the resolved A.
    expect((store.sessions()[0] as { attention?: unknown }).attention).toEqual(askB);
  });

  test('among two open items for one session the most recent wins', () => {
    const store = new SessionPresentationStore();
    const older = { key: 'kA', sessionId: 's1', state: 'open', openedAt: 100 };
    const newer = { key: 'kB', sessionId: 's1', state: 'open', openedAt: 200 };
    store.apply({ v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'local', agents: [{ rowKey: 'r1', sessionId: 's1' }], attention: [older, newer] });
    expect((store.sessions()[0] as { attention?: unknown }).attention).toEqual(newer);
  });
  test('projects reset/upsert/remove without deriving lifecycle state', () => {
    const store = new SessionPresentationStore();
    store.apply({ v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'zion', agents: [{ rowKey: 'a', sourceDevice: 'zion', status: 'active' }], attention: [] });
    store.apply({ v: 1, type: 'agent.upsert', streamId: 's', sequence: 2, capturedAt: 2, scope: 'zion', rowKey: 'b', agent: { rowKey: 'b', sourceDevice: 'zion', status: 'orphaned' } });
    expect(store.sessions()).toEqual([
      { rowKey: 'a', sourceDevice: 'zion', status: 'active' },
      { rowKey: 'b', sourceDevice: 'zion', status: 'orphaned' },
    ]);
    store.apply({ v: 1, type: 'agent.remove', streamId: 's', sequence: 3, capturedAt: 3, scope: 'zion', rowKey: 'a' });
    expect(store.sessions()).toEqual([
      { rowKey: 'b', sourceDevice: 'zion', status: 'orphaned' },
    ]);
  });

  // RUSH-2670: a detached session's row has host 'tmux' (the terminal APP — the
  // bare tmux server is its only terminal) and carries its device identity in
  // sourceDevice. Mapping host into the machine slot presented the session as
  // living on a machine called "tmux", so Attach's host === local filter never
  // matched and "Agents: Attach" always reported no backgrounded agents.
  test('presents a detached local row (host: tmux) under the local label, not "tmux"', () => {
    const store = new SessionPresentationStore();
    store.apply({
      v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'zion', attention: [],
      agents: [{
        rowKey: 'bg', sessionId: '2d29e6ac-7d5b-4bcc-91d1-8efc0818dbb3', kind: 'claude',
        host: 'tmux', sourceDevice: 'zion', status: 'closed', presence: 'background', context: 'terminal',
      }],
    });
    const presented = store.presentedSessions('zion', 'this-mac');
    expect(presented).toHaveLength(1);
    expect(presented[0]?.host).toBe('this-mac');
    expect(presented[0]?.presence).toBe('background');
  });

  test('presents an offloaded row under its machine, not its terminal app', () => {
    const store = new SessionPresentationStore();
    store.apply({
      v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'zion', attention: [],
      agents: [{
        rowKey: 'r', sessionId: 'abcd1234-0000-0000-0000-000000000000', kind: 'claude',
        host: 'tmux', machine: 'yosemite-s1', sourceDevice: 'zion', status: 'running', context: 'terminal',
      }],
    });
    expect(store.presentedSessions('zion', 'this-mac')[0]?.host).toBe('yosemite-s1');
  });

  test('reports not having seen a reset until a reset event arrives', () => {
    const store = new SessionPresentationStore();
    expect(store.hasSeenReset()).toBe(false);
    store.apply({ v: 1, type: 'agent.upsert', streamId: 's', sequence: 1, capturedAt: 1, scope: 'zion', rowKey: 'a', agent: { rowKey: 'a' } });
    expect(store.hasSeenReset()).toBe(false);
    store.apply({ v: 1, type: 'reset', streamId: 's', sequence: 2, capturedAt: 2, scope: 'zion', agents: [], attention: [] });
    expect(store.hasSeenReset()).toBe(true);
    store.clear();
    expect(store.hasSeenReset()).toBe(false);
  });

  test('tracks reset per scope — one device resetting does not claim another has (PHNX-2735)', () => {
    const store = new SessionPresentationStore();
    // The near-instant local scope resets first.
    store.apply({ v: 1, type: 'reset', streamId: 'local', sequence: 1, capturedAt: 1, scope: 'zion', agents: [], attention: [] });
    // Bare hasSeenReset() is true (the stream established), but a specific remote
    // box that has NOT reported must still read false — the global-boolean bug
    // was that this returned true for every scope the moment the fastest reset.
    expect(store.hasSeenReset()).toBe(true);
    expect(store.hasSeenReset('zion')).toBe(true);
    expect(store.hasSeenReset('yosemite-s1')).toBe(false);
    // The remote scope reports later, on its own SSH timeline.
    store.apply({ v: 1, type: 'reset', streamId: 'peer', sequence: 1, capturedAt: 2, scope: 'yosemite-s1', agents: [], attention: [] });
    expect(store.hasSeenReset('yosemite-s1')).toBe(true);
    store.clear();
    expect(store.hasSeenReset('zion')).toBe(false);
  });

  test('pendingScopes waits only on expected online peers, and clears on reset or unavailable (PHNX-2735)', () => {
    const store = new SessionPresentationStore();
    const expected = ['yosemite-s0', 'yosemite-s1'];
    // Local reset only: the whole expected peer set is still pending, so a merged
    // floor stays "connecting" instead of flipping to a confident "0 sessions".
    store.apply({ v: 1, type: 'reset', streamId: 'local', sequence: 1, capturedAt: 1, scope: 'zion', agents: [], attention: [] });
    expect(store.pendingScopes(expected).sort()).toEqual(['yosemite-s0', 'yosemite-s1']);
    // One peer delivers its reset → settled; the other stays pending.
    store.apply({ v: 1, type: 'reset', streamId: 'p0', sequence: 1, capturedAt: 2, scope: 'yosemite-s0', agents: [], attention: [] });
    expect(store.pendingScopes(expected)).toEqual(['yosemite-s1']);
    // The last peer is unreachable → the stream marks it unavailable, which also
    // settles it (so this can never hang "connecting" on a box that won't answer).
    store.apply({ v: 1, type: 'scope', streamId: 'p1', sequence: 1, capturedAt: 3, scope: 'yosemite-s1', status: 'unavailable', reason: 'ssh failed' });
    expect(store.pendingScopes(expected)).toEqual([]);
  });

  test('orders each stream independently and resets only its scope', () => {
    const store = new SessionPresentationStore();
    store.apply({ v: 1, type: 'reset', streamId: 'a', sequence: 5, capturedAt: 1, scope: 'zion', agents: [{ rowKey: 'z', sourceDevice: 'zion' }], attention: [] });
    store.apply({ v: 1, type: 'reset', streamId: 'b', sequence: 1, capturedAt: 1, scope: 'yosemite-s1', agents: [{ rowKey: 'y', sourceDevice: 'yosemite-s1' }], attention: [] });
    expect(store.apply({ v: 1, type: 'attention.remove', streamId: 'a', sequence: 4, capturedAt: 2, scope: 'zion', rowKey: 'z' })).toBe(false);
    expect(store.sessions()).toEqual([{ rowKey: 'z', sourceDevice: 'zion' }, { rowKey: 'y', sourceDevice: 'yosemite-s1' }]);
  });

  test('a reset retains projected attention owned by another scope', () => {
    const store = new SessionPresentationStore();
    const remoteAttention = { key: 'remote-attention', sessionId: 'remote-session', state: 'open' };
    store.apply({ v: 1, type: 'reset', streamId: 'remote', sequence: 1, capturedAt: 1, scope: 'remote', agents: [{ rowKey: 'remote-row', sessionId: 'remote-session', sourceDevice: 'remote' }], attention: [remoteAttention] });
    store.apply({ v: 1, type: 'reset', streamId: 'local', sequence: 1, capturedAt: 2, scope: 'local', agents: [{ rowKey: 'local-row', sessionId: 'local-session', sourceDevice: 'local' }], attention: [] });
    expect(store.sessions()).toContainEqual({ rowKey: 'remote-row', sessionId: 'remote-session', sourceDevice: 'remote', attention: remoteAttention });
  });

  test('liveSession returns machine + topic for a --device auto tab that never recorded its host', () => {
    const store = new SessionPresentationStore();
    store.apply({
      v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'yosemite-s1', attention: [],
      agents: [{
        rowKey: 'r',
        sessionId: '022fe0a8-7674-402a-a5e0-248195894663',
        kind: 'claude',
        host: 'tmux',
        machine: 'yosemite-s1',
        title: 'Compact page headers',
        topic: 'Compact the PageHeader across every page',
        label: '',
        cwd: '/home/muqsit/src/github.com/muqsitnawaz/svatlas',
        sourceDevice: 'yosemite-s1',
        status: 'running',
        context: 'terminal',
      }],
    });
    expect(store.liveSession('022fe0a8-7674-402a-a5e0-248195894663')).toEqual({
      machine: 'yosemite-s1',
      title: 'Compact page headers',
      topic: 'Compact the PageHeader across every page',
      label: '',
      cwd: '/home/muqsit/src/github.com/muqsitnawaz/svatlas',
      agent: 'claude',
      version: null,
      account: null,
      accountLabel: null,
    });
    expect(store.liveSession('missing')).toBeUndefined();
  });

  // RUSH-3184: the status bar reads a session's version + account off THIS
  // broadcast row instead of spawning a per-tab by-id session read over
  // `--device <host>`. `version` rides the stream per RUSH-2205; `account` was added
  // to the CLI backfill for RUSH-3184.
  test('liveSession projects version + account off the broadcast row for the status bar', () => {
    const store = new SessionPresentationStore();
    store.apply({
      v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'yosemite-s1', attention: [],
      agents: [{
        rowKey: 'r',
        sessionId: '022fe0a8-7674-402a-a5e0-248195894663',
        kind: 'claude',
        machine: 'yosemite-s1',
        version: '2.1.207',
        account: 'muqsit@getrush.ai',
        accountLabel: 'gmail',
        sourceDevice: 'yosemite-s1',
        status: 'running',
      }],
    });
    const live = store.liveSession('022fe0a8-7674-402a-a5e0-248195894663');
    expect(live?.version).toBe('2.1.207');
    expect(live?.account).toBe('muqsit@getrush.ai');
    expect(live?.accountLabel).toBe('gmail');
  });

  // A harness the CLI records no account for (or a session the CLI has indexed a
  // version for but not yet the account) yields null, so the status bar shows the
  // version alone rather than a prior binding's leftover.
  test('liveSession yields null version/account when the row omits or blanks them', () => {
    const store = new SessionPresentationStore();
    store.apply({
      v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'local', attention: [],
      agents: [
        { rowKey: 'a', sessionId: 'grok-1', kind: 'grok', version: '1.0.0', account: '   ', sourceDevice: 'local' },
        { rowKey: 'b', sessionId: 'kimi-1', kind: 'kimi', sourceDevice: 'local' },
      ],
    });
    expect(store.liveSession('grok-1')).toMatchObject({ version: '1.0.0', account: null });
    expect(store.liveSession('kimi-1')).toMatchObject({ version: null, account: null });
  });

  describe('terminalSessionMap observer binding (PHNX-3939)', () => {
    let resetSeq = 0;
    const reset = (store: SessionPresentationStore, agents: unknown[]) =>
      store.apply({ v: 1, type: 'reset', streamId: `reset-${++resetSeq}`, sequence: 1, capturedAt: resetSeq, scope: 'local', attention: [], agents });

    test('back-compat: with no observerDevice, top-level terminalId binds under the host filter', () => {
      const store = new SessionPresentationStore();
      reset(store, [{ rowKey: 'a', sessionId: 'sid1', terminalId: 'T1', sourceDevice: 'worker' }]);
      expect(store.terminalSessionMap('worker').get('T1')).toBe('sid1');
      expect(store.terminalSessionMap().get('T1')).toBe('sid1');
    });

    test('a worker session with no top-level terminalId binds via observerTerminals for THIS desktop', () => {
      const store = new SessionPresentationStore();
      reset(store, [{
        rowKey: 'a', sessionId: 'sid1', sourceDevice: 'worker',
        observerTerminals: [{ device: 'desktop', terminalId: 'TAB1' }],
      }]);
      // The owner runs on 'worker'; the desktop observes it via TAB1.
      expect(store.terminalSessionMap('worker', 'desktop').get('TAB1')).toBe('sid1');
      // A different observer gets nothing (no binding for its device).
      expect(store.terminalSessionMap('worker', 'other-desktop').size).toBe(0);
    });

    test('a remote owner top-level terminalId is NOT a local binding when an observer is given', () => {
      const store = new SessionPresentationStore();
      reset(store, [{ rowKey: 'a', sessionId: 'sid1', terminalId: 'T1', sourceDevice: 'worker' }]);
      // owner (worker) !== observer (desktop) and no observerTerminals -> no binding.
      expect(store.terminalSessionMap(undefined, 'desktop').size).toBe(0);
      // owner === observer -> the top-level id is a safe local binding.
      reset(store, [{ rowKey: 'a', sessionId: 'sid1', terminalId: 'T1', sourceDevice: 'desktop' }]);
      expect(store.terminalSessionMap(undefined, 'desktop').get('T1')).toBe('sid1');
    });

    test('two desktops observing the same worker session each map only their own tab', () => {
      const store = new SessionPresentationStore();
      reset(store, [{
        rowKey: 'a', sessionId: 'sid1', sourceDevice: 'worker',
        observerTerminals: [{ device: 'desktopA', terminalId: 'TA' }, { device: 'desktopB', terminalId: 'TB' }],
      }]);
      const a = store.terminalSessionMap('worker', 'desktopA');
      const b = store.terminalSessionMap('worker', 'desktopB');
      expect([...a.entries()]).toEqual([['TA', 'sid1']]);
      expect([...b.entries()]).toEqual([['TB', 'sid1']]);
    });

    test('distinct live claims stay ambiguous regardless of start time or row order', () => {
      const terminal = [{ device: 'desktop', terminalId: 'TAB-ambiguous' }];
      const a = (startedAtMs: number) => ({ rowKey: 'a', sessionId: 'session-a', sourceDevice: 'worker', startedAtMs, observerTerminals: terminal });
      const b = (startedAtMs: number) => ({ rowKey: 'b', sessionId: 'session-b', sourceDevice: 'worker', startedAtMs, observerTerminals: terminal });
      for (const rows of [[a(100), b(200)], [b(200), a(100)], [a(900), b(200)], [b(200), a(900)]]) {
        const store = new SessionPresentationStore();
        reset(store, rows);
        expect(store.terminalSessionMap('worker', 'desktop').has('TAB-ambiguous')).toBe(false);
      }
    });

    test('B upsert, A remove, and historical A upsert bind only after ambiguity clears', () => {
      const store = new SessionPresentationStore();
      const terminal = [{ device: 'desktop', terminalId: 'TAB-reused' }];
      store.apply({
        v: 1, type: 'reset', streamId: 'rebind', sequence: 1, capturedAt: 100, scope: 'worker', attention: [],
        agents: [{ rowKey: 'a', sessionId: 'session-a', sourceDevice: 'worker', startedAtMs: 100, observerTerminals: terminal }],
      });
      expect(store.terminalSessionMap('worker', 'desktop').get('TAB-reused')).toBe('session-a');
      store.apply({
        v: 1, type: 'agent.upsert', streamId: 'rebind', sequence: 2, capturedAt: 200, scope: 'worker', rowKey: 'b',
        agent: { rowKey: 'b', sessionId: 'session-b', sourceDevice: 'worker', startedAtMs: 200, observerTerminals: terminal },
      });
      expect(store.terminalSessionMap('worker', 'desktop').has('TAB-reused')).toBe(false);
      store.apply({
        v: 1, type: 'agent.remove', streamId: 'rebind', sequence: 3, capturedAt: 300, scope: 'worker', rowKey: 'a',
      });
      expect(store.terminalSessionMap('worker', 'desktop').get('TAB-reused')).toBe('session-b');
      store.apply({
        v: 1, type: 'agent.upsert', streamId: 'rebind', sequence: 4, capturedAt: 400, scope: 'worker', rowKey: 'a',
        agent: { rowKey: 'a', sessionId: 'session-a', sourceDevice: 'worker', previous: true, startedAtMs: 100, observerTerminals: terminal },
      });
      expect(store.terminalSessionMap('worker', 'desktop').get('TAB-reused')).toBe('session-b');
    });

    test('reset ignores old Previous A and duplicate B rows', () => {
      const store = new SessionPresentationStore();
      reset(store, [
        { rowKey: 'a', sessionId: 'session-a', sourceDevice: 'worker', previous: true, startedAtMs: 300, observerTerminals: [{ device: 'desktop', terminalId: 'TAB-reused' }] },
        { rowKey: 'b1', sessionId: 'session-b', sourceDevice: 'worker', previous: false, startedAtMs: 200, observerTerminals: [{ device: 'desktop', terminalId: 'TAB-reused' }] },
        { rowKey: 'b2', sessionId: 'session-b', sourceDevice: 'worker', previous: false, startedAtMs: 999, observerTerminals: [{ device: 'desktop', terminalId: 'TAB-reused' }] },
      ]);
      expect(store.terminalSessionMap('worker', 'desktop').get('TAB-reused')).toBe('session-b');
    });

    test('claims remain scoped to the requested execution host', () => {
      const store = new SessionPresentationStore();
      reset(store, [
        { rowKey: 'a', sessionId: 'worker-a-session', sourceDevice: 'worker-a', startedAtMs: 100, observerTerminals: [{ device: 'desktop', terminalId: 'SAME' }] },
        { rowKey: 'b', sessionId: 'worker-b-session', sourceDevice: 'worker-b', startedAtMs: 200, observerTerminals: [{ device: 'desktop', terminalId: 'SAME' }] },
      ]);
      expect(store.terminalSessionMap('worker-a', 'desktop').get('SAME')).toBe('worker-a-session');
      expect(store.terminalSessionMap('worker-b', 'desktop').get('SAME')).toBe('worker-b-session');
    });

    test('filtering to the wrong execution host yields no binding', () => {
      const store = new SessionPresentationStore();
      reset(store, [{
        rowKey: 'a', sessionId: 'sid1', sourceDevice: 'worker',
        observerTerminals: [{ device: 'desktop', terminalId: 'TAB1' }],
      }]);
      expect(store.terminalSessionMap('some-other-host', 'desktop').size).toBe(0);
    });
  });
});

// The rows of the owner's 2026-10-19 video: 880c8e40 ran on yosemite-s0 with no zion tab
// after its reconnect; its closed twin and a session shown in a zion tab are not that.
test('runningUnshown: a live agent no tab on this machine shows, and nothing else', () => {
  const store = new SessionPresentationStore();
  store.apply({ v: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'yosemite-s0', attention: [], agents: [
    { rowKey: 'old', sessionId: '880c8e40', machine: 'yosemite-s0', pidAlive: false, previous: true },
    { rowKey: 'live', sessionId: '880c8e40', machine: 'yosemite-s0', pidAlive: true, observerTerminals: null },
    { rowKey: 'tab', sessionId: '1a54d491', machine: 'yosemite-s0', pidAlive: true, observerTerminals: [{ device: 'zion', terminalId: 'cl-1792195106138-18' }] },
    { rowKey: 'ended', sessionId: '72ef0a21', machine: 'yosemite-s0', pidAlive: false },
  ] });
  expect(store.runningUnshown('880c8e40', 'zion')).toBe('yosemite-s0');
  expect(store.runningUnshown('1a54d491', 'Zion.local')).toBeNull();
  expect(store.runningUnshown('1a54d491', 'pinnacles')).toBe('yosemite-s0');
  expect(store.runningUnshown('72ef0a21', 'zion')).toBeNull();
});
