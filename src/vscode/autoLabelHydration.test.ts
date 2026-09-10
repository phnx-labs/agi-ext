import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * RUSH-2411: a picked-host Codex launches idless, so its auto-label lifecycle was
 * never armed — the tab kept the bare `CX` chip after its canonical UUID resolved
 * via remote hydration. The behavioral logic is unit-tested in
 * `src/core/remoteAutoLabel.test.ts`; this file pins the extension-host WIRING
 * that connects that logic to the real terminal registry, the same way
 * `forkCommands.test.ts` pins the fork command wiring. Break any of these and the
 * fix silently reverts to bare-CX.
 */
const factoryRoot = path.resolve(import.meta.dir, '../..');
const extensionSource = fs.readFileSync(path.join(factoryRoot, 'src/vscode/extension.ts'), 'utf8');

describe('RUSH-2411 auto-label-after-remote-hydration wiring', () => {
  test('the canonical id transition arms the auto-label lifecycle', () => {
    // Inside applyHydratedSessionId, gaining/correcting the id must arm labeling —
    // the remote counterpart to the local SessionStart watcher (onSessionChanged).
    expect(extensionSource).toContain('armLabelingAfterHydration(terminal, entry);');
    // And armLabelingAfterHydration re-uses the ONE poller entry point.
    expect(extensionSource).toMatch(
      /function armLabelingAfterHydration[\s\S]*?startAutoLabelPollerForTerminal\(terminal, extensionContext\)/,
    );
  });

  test('an idless picked-host runner arms a bounded fast poller at launch', () => {
    // Only Claude's id is minted up front; a picked-host Codex is idless, so it
    // must still arm the poller (fast) to resolve its id + label without a
    // refocus. This now lives in registerAgentTerminal, the one sequence BOTH
    // creation paths share.
    expect(extensionSource).toMatch(
      /else if \(host && resumeKey\)[\s\S]*?startAutoLabelPollerForTerminal\(terminal, context, \{ fast: true \}\)/,
    );
  });

  test('every agent-terminal creation path goes through the shared registration', () => {
    // #2534 regressed New <Agent> tabs by open-coding createTerminal in
    // launchAgent and dropping registration: no icon, no chip, no
    // AGENT_TERMINAL_ID, and therefore no session id, no label poller, no
    // persistence across reload, and a dead Copy-Session-Id/Resume/Fork surface.
    // Both creation paths must delegate to the one helper so they cannot drift
    // apart again.
    expect(extensionSource).toMatch(/async function registerAgentTerminal\(/);
    const launchAgentBody = extensionSource.slice(
      extensionSource.indexOf('async function launchAgent('),
    );
    expect(launchAgentBody.slice(0, launchAgentBody.indexOf('\n}'))).toMatch(
      /await registerAgentTerminal\(terminal, context, \{/,
    );
  });

  test('the poller drives id-hydration then labeling via the tested core helper', () => {
    // The remote-idless branch of the poller resolves the id (and host siblings)
    // from the shared active map and labels — one tick, no per-tab SSH stream.
    expect(extensionSource).toMatch(
      /needsSessionIdHydrate\(cur\.sessionId\)[\s\S]*?hydrateRemoteTabTick\(cur\.id, cur\.host, remoteAutoLabelHooks\(labelsEnabled\)\)/,
    );
  });

  test('the focus-path join stamps + arms this tab and every host sibling', () => {
    // tryHydrateLiveSessionId's active-map join builds a plan over all host tabs
    // and applies it through applyHydratedSessionId (which arms labeling), so a
    // hydrated sibling enters labeling too.
    expect(extensionSource).toContain('planActiveMapHydration(');
    expect(extensionSource).toMatch(
      /for \(const step of plan\)[\s\S]*?applyHydratedSessionId\(t\.terminal, t, stampPrefix, step\.canonicalId\)/,
    );
  });

  test('the shared per-host active-map fetch is the id source (no per-tab SSH poll)', () => {
    // remoteAutoLabelHooks.fetchMap funnels through the coalesced per-host cache,
    // and the host-aware `agents sessions <id> --device` stays the LABEL source.
    expect(extensionSource).toMatch(/fetchMap:\s*\(host\)\s*=>\s*fetchTerminalIdSessionMap\(host\)/);
    expect(extensionSource).toMatch(/fetchLabel:[\s\S]*?fetchAndSetAutoLabel\(t\.terminal, t\)/);
  });

  test('session lookups use --device, never the retired --host flag', () => {
    const vscodeSource = fs.readFileSync(path.join(import.meta.dir, 'remoteSessions.vscode.ts'), 'utf8');
    // The per-tab identity fetch (`['sessions', sessionId, '--device', host, '--json']`)
    // was deleted with the RUSH-3184 side channel; the remaining LABEL-source
    // lookup still targets the owning box with --device (never the retired --host).
    expect(vscodeSource).toMatch(/args\.push\('--device', host\)/);
    expect(vscodeSource).not.toMatch(/\['sessions', sessionId, '--host'/);
    expect(extensionSource).toContain('sessionPresentationStore.liveSession');
    expect(extensionSource).toContain('isDerivedSessionName(rawLabel, live.cwd)');
    expect(extensionSource).not.toContain("live.label.includes(' ')");
  });
});

describe('RUSH-2430 clean-but-stale session id reconciliation', () => {
  test('a clean UUID does not bypass the authoritative live-id paths', () => {
    const start = extensionSource.indexOf('async function tryHydrateLiveSessionId(');
    const cleanUuidGuard = extensionSource.indexOf(
      'if (entry.sessionId && !needsSessionIdHydrate(entry.sessionId))',
      start,
    );
    const authoritativeMap = extensionSource.indexOf('const map = await fetchTerminalIdSessionMap(entry.host);', start);
    expect(start).toBeGreaterThan(-1);
    expect(cleanUuidGuard).toBeGreaterThan(start);
    expect(authoritativeMap).toBeGreaterThan(start);

    const beforeAuthoritativeLookup = extensionSource.slice(cleanUuidGuard, authoritativeMap);
    expect(beforeAuthoritativeLookup).toContain(
      'if (entry.sessionId && !needsSessionIdHydrate(entry.sessionId))',
    );
    expect(beforeAuthoritativeLookup).not.toContain('return;');
  });

  test('focus hydration has one stream identity source and no local state-file race', () => {
    const start = extensionSource.indexOf('async function tryHydrateLiveSessionId(');
    const end = extensionSource.indexOf('\nfunction updateStatusBarForTerminal(', start);
    const hydrate = extensionSource.slice(start, end);
    expect(hydrate).toContain('fetchTerminalIdSessionMap(entry.host)');
    expect(hydrate).not.toContain('liveSessionIdForShell');
    expect(extensionSource).not.toContain("from '../core/liveSession'");
  });

  test('picked-host identity hydration runs when automatic tab labels are disabled', () => {
    const start = extensionSource.indexOf('async function armAutoLabelPoller(');
    const remoteIdless = extensionSource.indexOf('const remoteIdless =', start);
    const labelsEnabled = extensionSource.indexOf('const labelsEnabled = display.autoLabelInTabTitles;', start);
    const disabledGuard = extensionSource.indexOf('if (!labelsEnabled && !remoteIdless) return;', start);
    const hydrate = extensionSource.indexOf('hydrateRemoteTabTick(', start);
    const status = extensionSource.indexOf('updateStatusBarForTerminal(terminal, context.extensionPath);', hydrate);
    expect(remoteIdless).toBeGreaterThan(start);
    expect(labelsEnabled).toBeGreaterThan(remoteIdless);
    expect(disabledGuard).toBeGreaterThan(labelsEnabled);
    expect(hydrate).toBeGreaterThan(disabledGuard);
    expect(status).toBeGreaterThan(hydrate);
  });

  test('accepted stream facts reconcile terminal bindings before status/sidebar consumers refresh', () => {
    const handler = extensionSource.slice(extensionSource.indexOf('const factSub = follower.onMonitorEvent'));
    const apply = handler.indexOf('sessionPresentationStore.apply(event.payload)');
    const rebind = handler.indexOf('syncTerminalSessionBindingsFromStream()');
    const sidebar = handler.indexOf('notifyAgentPanelSessionUpdate()');
    expect(apply).toBeGreaterThan(-1);
    expect(rebind).toBeGreaterThan(apply);
    expect(sidebar).toBeGreaterThan(rebind);
  });

  test('stream-driven rebinding does not arm the side-channel label poller', () => {
    const start = extensionSource.indexOf('function syncTerminalSessionBindingsFromStream()');
    const end = extensionSource.indexOf('\n}\n', start);
    const rebind = extensionSource.slice(start, end);
    expect(rebind).toContain('planSessionStreamRebinds(');
    expect(rebind).toContain('{ armLabeling: false }');
    expect(rebind).not.toContain('armLabelingAfterHydration(');
    expect(rebind).not.toContain('startAutoLabelPollerForTerminal(');
  });
});
