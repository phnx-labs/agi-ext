import type { SessionCliFactPayload } from '../monitor/protocol';
import { normalizeActiveSession, normalizeHost, resolveSessionHost, type RawActiveSession, type RemoteSession } from './remoteSessions';
import type { ProjectRule } from './settings';

/** Window-local projection of the canonical CLI stream; contains no lifecycle logic. */
export class SessionPresentationStore {
  private rowRevisions = new Map<string, number>();
  private revision = 0;
  get rowRevision(): number { return this.revision; }

  private rows = new Map<string, unknown>();
  private rowScopes = new Map<string, string>();
  private attention = new Map<string, unknown>();
  private attentionScopes = new Map<string, string>();
  private activity: unknown[] = [];
  private sequences = new Map<string, number>();
  private scopes = new Map<string, { status: 'available' | 'unavailable'; reason?: string }>();
  /**
   * The set of stream scopes that have delivered a `reset`. Per-scope, NOT a
   * single global flag: the elected CLI stream fans out across the fleet and
   * each device is its own scope with an independent reset on its own SSH
   * timeline (`watchFleetFeed`, agents-cli). A single boolean flipped `true` on
   * the FIRST (near-instant, in-process local) reset and then claimed the whole
   * fleet had reported — so `hasSeenReset('a-remote-box')` could never be asked,
   * and a follower could read "reset seen" for a scope it had not heard from
   * (PHNX-2735).
   */
  private resetScopes = new Set<string>();

  apply(event: SessionCliFactPayload): boolean {
    const previous = this.sequences.get(event.streamId) ?? 0;
    if (event.sequence <= previous) return false;
    this.sequences.set(event.streamId, event.sequence);
    if (event.type === 'reset' || event.type === 'agent.upsert') this.revision++;
    if (event.type === 'reset') {
      this.resetScopes.add(event.scope);
      for (const [rowKey, scope] of this.rowScopes) {
        if (scope === event.scope) {
          this.rows.delete(rowKey);
          this.rowRevisions.delete(rowKey);
          this.rowScopes.delete(rowKey);
        }
      }
      for (const row of event.agents ?? []) {
        const rowKey = this.rowKeyOf(row);
        if (rowKey) {
          this.rows.set(rowKey, row);
          this.rowRevisions.set(rowKey, this.revision);
          this.rowScopes.set(rowKey, event.scope);
        }
      }
      for (const [key, scope] of this.attentionScopes) {
        if (scope === event.scope) {
          this.attention.delete(key);
          this.attentionScopes.delete(key);
        }
      }
      for (const item of Array.isArray(event.attention) ? event.attention : []) {
        const key = this.attentionKeyOf(item);
        if (key) {
          this.attention.set(key, item);
          this.attentionScopes.set(key, event.scope);
        }
      }
    } else if (event.type === 'agent.upsert') {
      const rowKey = event.rowKey || this.rowKeyOf(event.agent);
      if (rowKey && event.agent) {
        this.rows.set(rowKey, event.agent);
        this.rowRevisions.set(rowKey, this.revision);
        this.rowScopes.set(rowKey, event.scope);
      }
    } else if (event.type === 'agent.remove' && event.rowKey) {
      this.rows.delete(event.rowKey);
      this.rowRevisions.delete(event.rowKey);
      this.rowScopes.delete(event.rowKey);
    } else if (event.type === 'attention.upsert' && event.attention && !Array.isArray(event.attention)) {
      const key = event.rowKey || this.attentionKeyOf(event.attention);
      if (key) {
        this.attention.set(key, event.attention);
        this.attentionScopes.set(key, event.scope);
      }
    } else if (event.type === 'attention.remove' && event.rowKey) {
      const previous = this.attention.get(event.rowKey);
      // DROP the resolved item from the ACTIVE attention map (matching the replay
      // path + SessionCliReplay, which delete it). Retaining a resolved copy here
      // made sessions()' per-sessionId join return the STALE resolved attention and
      // shadow a NEW open one for the same session — ask A → resolve A → ask B left
      // B unattached until a reset, and live diverged from replay. The resolution
      // is preserved as a receipt in the activity feed below.
      this.attention.delete(event.rowKey);
      this.attentionScopes.delete(event.rowKey);
      if (event.resolution) {
        const attention = previous && typeof previous === 'object' ? previous as Record<string, unknown> : {};
        const resolution = event.resolution as Record<string, unknown>;
        this.activity.push({
          type: 'attention.receipt',
          key: event.rowKey,
          sessionId: attention.sessionId,
          question: attention.question,
          source: attention.source,
          fingerprint: attention.fingerprint,
          state: typeof resolution.state === 'string' ? resolution.state : 'resolved',
          resolvedAt: resolution.resolvedAt ?? event.capturedAt,
          resolution,
        });
      }
    } else if (event.type === 'activity.append' && event.event) {
      this.activity.push(event.event);
    } else if (event.type === 'scope' && event.status) {
      this.scopes.set(event.scope, { status: event.status, ...(event.reason ? { reason: event.reason } : {}) });
    }
    return true;
  }

  sessions(): unknown[] {
    const projected = [...this.attention.values()];
    return [...this.rows.values()].map((value) => {
      if (!value || typeof value !== 'object') return value;
      const row = value as { sessionId?: unknown; id?: unknown };
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : typeof row.id === 'string' ? row.id : '';
      const attention = this.activeAttentionFor(sessionId, projected);
      return attention ? { ...row, attention } : row;
    });
  }

  /**
   * The one attention item a session's card should show: an OPEN (needs-you) item
   * wins over any non-open one, and among equals the most recently opened wins.
   * A plain `.find` by sessionId returned whichever was inserted first regardless
   * of state, so a still-present earlier item could shadow the live one — the
   * ask-A / ask-B ordering bug. Resolved items are dropped from the map on remove,
   * so this normally sees only live items; the state/recency ranking is
   * defense-in-depth for a session that legitimately has more than one open item.
   */
  private activeAttentionFor(sessionId: string, items: unknown[]): unknown | undefined {
    if (!sessionId) return undefined;
    const matches = items.filter((item) => item && typeof item === 'object'
      && (item as { sessionId?: unknown }).sessionId === sessionId);
    if (matches.length === 0) return undefined;
    if (matches.length === 1) return matches[0];
    const openedAt = (item: unknown): number => {
      const v = (item as { openedAt?: unknown }).openedAt;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; }
      return 0;
    };
    const isOpen = (item: unknown): boolean => (item as { state?: unknown }).state === 'open';
    const open = matches.filter(isOpen);
    const pool = open.length ? open : matches;
    return pool.reduce((best, cur) => (openedAt(cur) >= openedAt(best) ? cur : best));
  }
  activityEvents(): unknown[] { return [...this.activity]; }
  scope(scope: string): { status: 'available' | 'unavailable'; reason?: string } | undefined {
    return this.scopes.get(scope);
  }
  clear(): void { this.rowRevisions.clear(); this.rows.clear(); this.rowScopes.clear(); this.attention.clear(); this.attentionScopes.clear(); this.activity = []; this.sequences.clear(); this.scopes.clear(); this.resetScopes.clear(); }

  /**
   * Whether a `reset` has been observed — for one `scope` when given, or for
   * ANY scope when called bare (the "has the stream established at all" gate the
   * follower-degraded banner reads). Per-scope so a caller can ask specifically
   * whether a given device has reported yet, instead of trusting a global flag
   * that the fastest scope flips for the whole fleet (PHNX-2735).
   */
  hasSeenReset(scope?: string): boolean {
    return scope === undefined ? this.resetScopes.size > 0 : this.resetScopes.has(scope);
  }

  /**
   * The scopes still not settled out of a set the caller KNOWS to expect (its
   * online device roster, normalized the same way `watchFleetFeed` scopes a peer
   * — `normalizeHost(device.name)`). A scope is settled once it has delivered a
   * `reset` OR the stream marked it `unavailable`. This lets a merged multi-device
   * view stay "connecting" while a real, expected peer is still en route instead
   * of flipping to a confident "0 sessions" the moment the local scope resets —
   * without ever waiting on a device the roster does not list, which is what
   * bounds it against hanging "connecting" forever. Returns the pending subset so
   * the caller can decide (and surface which boxes it is waiting on).
   */
  pendingScopes(expectedScopes: readonly string[]): string[] {
    return expectedScopes.filter((scope) =>
      !this.resetScopes.has(scope) && this.scopes.get(scope)?.status !== 'unavailable');
  }

  /** Normalize the CLI stream rows for UI rendering without starting another query. */
  presentedSessions(
    localMachineId: string,
    localLabel: string,
    projectRules: ProjectRule[] = [],
    fetchedAt: number = Date.now(),
  ): RemoteSession[] {
    return this.sessions().flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const row = value as RawActiveSession & { agentType?: string; host?: string; sourceDevice?: string };
      const raw = {
        ...row,
        kind: row.kind || row.agentType || '',
      } as RawActiveSession;
      // The CLI row's `host` is the terminal APP hosting the session (codium,
      // iterm, tmux, ...), never a machine. `machine` is set only for offloaded
      // sessions; a local row's device identity rides in `sourceDevice`. Using
      // `host` here made a detached session (whose only terminal is the bare
      // tmux server) present as living on a machine called "tmux", which broke
      // every host === local filter (RUSH-2670).
      const machine = typeof raw.machine === 'string' ? raw.machine
        : typeof row.sourceDevice === 'string' ? row.sourceDevice
        : undefined;
      const host = resolveSessionHost(machine, localLabel, normalizeHost(localMachineId), localLabel);
      return [normalizeActiveSession(raw, host, fetchedAt, projectRules)];
    });
  }

  /**
   * Session identity join used by terminal hydration and fork bookkeeping:
   * `terminalId` → `sessionId`, scoped to a device.
   *
   * `executionHost` filters to rows whose OWNER (the box the agent runs on) matches.
   * `observerDevice` — THIS desktop — decides which terminalId is a valid local
   * binding (PHNX-3939): the CLI projects launcher bindings as
   * `observerTerminals: [{ device, terminalId }]`, and the owner's top-level
   * `terminalId` may be undefined by design (a worker session observed from a
   * desktop). We therefore bind:
   *   - each `observerTerminals` entry whose `device` matches `observerDevice`, and
   *   - the top-level `terminalId` ONLY when the owner IS the observer (a remote
   *     owner's top-level id has no provenance for this desktop).
   * A terminal reused for session B can briefly be claimed by both A and B while
   * the CLI projection settles. Distinct live claims are ambiguous regardless of
   * row order or start time and are omitted. Historical `previous: true` rows do
   * not claim a live terminal.
   *
   * Back-compat: with no `observerDevice`, this keeps the pre-observer behaviour
   * (bind every row's top-level terminalId under the host filter), so callers that
   * predate the observer contract — and rows the CLI has not yet enriched — are
   * unaffected.
   */
  terminalSessionMap(executionHost?: string, observerDevice?: string, afterRevision = -1): Map<string, string> {
    const wanted = normalizeHost(executionHost || '');
    const observer = normalizeHost(observerDevice || '');
    const result = new Map<string, string>();
    const ambiguous = new Set<string>();
    const revisions = new Map<string, number>();
    let rowRevision = 0;
    const bind = (terminalId: string, sessionId: string) => {
      if (!terminalId || !sessionId) return;
      const existing = result.get(terminalId);
      if (existing && existing !== sessionId) { ambiguous.add(terminalId); return; }
      result.set(terminalId, sessionId);
      revisions.set(terminalId, Math.max(revisions.get(terminalId) ?? 0, rowRevision));
    };
    for (const value of this.sessions()) {
      if (!value || typeof value !== 'object') continue;
      rowRevision = this.rowRevisions.get(this.rowKeyOf(value) ?? '') ?? 0;
      const row = value as {
        terminalId?: unknown; sessionId?: unknown; id?: unknown; machine?: unknown; sourceDevice?: unknown;
        observerTerminals?: unknown; previous?: unknown;
      };
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : typeof row.id === 'string' ? row.id : '';
      if (!sessionId) continue;
      // Historical rows are preview/resume material, never the live identity of
      // an editor tab. Keeping them in this join makes every reused terminal look
      // permanently ambiguous after A moves to Previous and B starts.
      if (row.previous === true) continue;
      const owner = normalizeHost(typeof row.machine === 'string' ? row.machine : typeof row.sourceDevice === 'string' ? row.sourceDevice : '');
      if (wanted && owner && wanted !== owner) continue;
      // Launcher bindings for THIS observer desktop (provenance-carrying).
      for (const entry of Array.isArray(row.observerTerminals) ? row.observerTerminals : []) {
        if (!entry || typeof entry !== 'object') continue;
        const dev = normalizeHost(typeof (entry as { device?: unknown }).device === 'string' ? (entry as { device?: string }).device! : '');
        const tid = typeof (entry as { terminalId?: unknown }).terminalId === 'string' ? (entry as { terminalId?: string }).terminalId! : '';
        if (observer && dev && dev === observer) bind(tid, sessionId);
      }
      // Top-level terminalId: a safe local binding only when the owner is this
      // observer (or when no observer context is supplied — legacy callers).
      const terminalId = typeof row.terminalId === 'string' ? row.terminalId : '';
      if (terminalId && (!observer || owner === observer)) bind(terminalId, sessionId);
    }
    for (const terminalId of ambiguous) result.delete(terminalId);
    for (const [terminalId, revision] of revisions) {
      if (revision <= afterRevision) result.delete(terminalId);
    }
    return result;
  }

  /**
   * Live stream row for one session id — machine + topic + label + cwd, plus
   * the session's real `version` + `account`, all from the single watch stream
   * with NO extra CLI subprocess. `--device auto` tabs never learn their host
   * at launch; this is how they recover it (and a title) once the watch stream
   * indexes the session.
   *
   * `version` and `account` are what the status bar renders as the session's
   * identity. They ride the stream (`version` per RUSH-2205, `account` per
   * RUSH-3184) so the status bar reads a broadcast row instead of spawning a
   * per-tab `agents sessions <id> --device <host> --json` — the event-pumped
   * respawn that caused the 2026-08-25 CPU incident (agi-cli#3019). Both are
   * `null` for a harness the CLI records no identity for (Kimi has neither,
   * Grok/Cursor a version but no account) or before the CLI has indexed them.
   */
  liveSession(sessionId: string): { machine: string; topic: string; label: string; cwd: string; version: string | null; account: string | null } | undefined {
    const wanted = sessionId.trim();
    if (!wanted) return undefined;
    for (const value of this.sessions()) {
      if (!value || typeof value !== 'object') continue;
      const row = value as {
        sessionId?: unknown;
        id?: unknown;
        machine?: unknown;
        sourceDevice?: unknown;
        topic?: unknown;
        prompt?: unknown;
        firstUserMessage?: unknown;
        label?: unknown;
        cwd?: unknown;
        version?: unknown;
        account?: unknown;
      };
      const id = typeof row.sessionId === 'string' ? row.sessionId
        : typeof row.id === 'string' ? row.id : '';
      if (id !== wanted) continue;
      const machine = typeof row.machine === 'string' ? row.machine
        : typeof row.sourceDevice === 'string' ? row.sourceDevice
        : '';
      const topic = typeof row.topic === 'string' ? row.topic
        : typeof row.prompt === 'string' ? row.prompt
        : typeof row.firstUserMessage === 'string' ? row.firstUserMessage
        : '';
      const label = typeof row.label === 'string' ? row.label : '';
      const cwd = typeof row.cwd === 'string' ? row.cwd : '';
      const version = typeof row.version === 'string' && row.version.trim() ? row.version.trim() : null;
      const account = typeof row.account === 'string' && row.account.trim() ? row.account.trim() : null;
      return { machine, topic, label, cwd, version, account };
    }
    return undefined;
  }

  private rowKeyOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const rowKey = (value as { rowKey?: unknown }).rowKey;
    return typeof rowKey === 'string' && rowKey ? rowKey : undefined;
  }

  private attentionKeyOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const key = (value as { key?: unknown }).key;
    return typeof key === 'string' && key ? key : undefined;
  }

}

/** Exactly one presentation store per extension host process. */
export const sessionPresentationStore = new SessionPresentationStore();
