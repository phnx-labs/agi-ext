/**
 * Batched session-id discovery for AGI EXT tabs.
 *
 * Reads the shared `agents sessions watch --json` projection for every tab.
 * No per-tab subprocesses or extension-owned freshness cache.
 *
 * Placement flags: uses `--device` / local only — never `--where`.
 */

import * as os from 'os';
import { normalizeHost } from './remoteSessions';
import { canonicalSessionId, isRolloutSessionStem } from './canonicalSessionId';
import { planActiveMapHydration, type HydratePlanEntry, type RemoteAutoLabelTab } from './remoteAutoLabel';
import { sessionPresentationStore } from './sessionPresentationStore';
const LOCAL_CACHE_KEY = '__local__';

export type TerminalIdSessionMap = Map<string, string>;

/**
 * Cache key for a tab's placement. Same-machine `--device <this-host>` collapses
 * to local so we do not SSH to ourselves and so local state hydrate can still run.
 */
export function activeMapCacheKey(
  host: string | undefined,
  localHostname: string = os.hostname(),
  localMachineId: string = normalizeHost(localHostname),
): string {
  if (!host?.trim()) return LOCAL_CACHE_KEY;
  const n = normalizeHost(host);
  if (!n) return LOCAL_CACHE_KEY;
  if (n === localMachineId || n === normalizeHost(localHostname)) return LOCAL_CACHE_KEY;
  // Also match bare hostname equality (yosemite-s1 vs yosemite-s1.tailnet)
  if (host === localHostname || host.startsWith(`${localHostname}.`)) return LOCAL_CACHE_KEY;
  return n;
}

export function isLocalActiveMapKey(key: string): boolean {
  return key === LOCAL_CACHE_KEY;
}

/**
 * Read terminalId → sessionId for one host (or local) from the shared stream.
 */
export async function fetchTerminalIdSessionMap(
  host: string | undefined,
  deps: {
    now?: number;
    localHostname?: string;
  } = {},
): Promise<TerminalIdSessionMap> {
  const key = activeMapCacheKey(host, deps.localHostname);
  // Pass THIS desktop as the observer so a worker session's local tab resolves via
  // its observerTerminals binding, and a remote owner's top-level terminalId is not
  // mistaken for a local one (PHNX-3939).
  const observerDevice = normalizeHost(deps.localHostname ?? os.hostname());
  return sessionPresentationStore.terminalSessionMap(
    isLocalActiveMapKey(key) ? undefined : host,
    observerDevice,
  );
}

/**
 * Resolve one tab's session id from the batched active map.
 * `terminalId` is the ext's AGENT_TERMINAL_ID (EditorTerminal.id).
 */
export async function resolveSessionIdForTerminal(
  terminalId: string | undefined,
  host: string | undefined,
  deps?: Parameters<typeof fetchTerminalIdSessionMap>[1],
): Promise<string | undefined> {
  const tid = terminalId?.trim();
  if (!tid) return undefined;
  const map = await fetchTerminalIdSessionMap(host, deps);
  return map.get(tid);
}

/**
 * Plan event-driven tab rebindings from the already-projected session stream.
 *
 * The extension calls this after accepted agent reset/upsert/remove facts. Tabs
 * are grouped by execution owner before consulting terminalSessionMap, while
 * observerDevice proves the editor-side terminal binding. This is deliberately
 * synchronous: it starts no subprocess, poller, watcher, or retry loop.
 */
export function planSessionStreamRebinds(
  tabs: RemoteAutoLabelTab[],
  observerDevice: string,
  deps: { localHostname?: string; localMachineId?: string } = {},
): HydratePlanEntry[] {
  const localHostname = deps.localHostname ?? observerDevice;
  const localMachineId = deps.localMachineId ?? normalizeHost(localHostname);
  const groups = new Map<string, RemoteAutoLabelTab[]>();
  for (const tab of tabs) {
    const key = activeMapCacheKey(tab.host, localHostname, localMachineId);
    const group = groups.get(key) ?? [];
    group.push(tab);
    groups.set(key, group);
  }

  const plan: HydratePlanEntry[] = [];
  for (const [key, group] of groups) {
    const executionHost = isLocalActiveMapKey(key) ? undefined : group[0]?.host;
    const map = sessionPresentationStore.terminalSessionMap(
      executionHost,
      normalizeHost(observerDevice),
    );
    for (const tab of group) {
      const eligibleMap = tab.manualSessionRevision === undefined ? map
        : sessionPresentationStore.terminalSessionMap(executionHost, normalizeHost(observerDevice), tab.manualSessionRevision);
      plan.push(...planActiveMapHydration(eligibleMap, [{ ...tab, manualSessionRevision: undefined }], {
        needsHydrate: needsSessionIdHydrate,
        canonical: (raw) => canonicalSessionId(raw) ?? '',
      }));
    }
  }
  return plan;
}

/**
 * Whether the tab still needs a CLI join (missing id, or a dirty rollout stem).
 */
export function needsSessionIdHydrate(sessionId: string | undefined | null): boolean {
  if (!sessionId?.trim()) return true;
  return isRolloutSessionStem(sessionId) || canonicalSessionId(sessionId) !== sessionId.trim();
}
