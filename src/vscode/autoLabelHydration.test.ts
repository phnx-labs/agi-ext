import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Pins the extension-host WIRING between stream facts, terminal bindings and the
 * tab-label lifecycle. The behavioral logic is unit-tested in
 * `src/core/remoteAutoLabel.test.ts` and `src/core/sessionIdHydrate.test.ts`.
 */
const extensionSource = fs.readFileSync(path.join(import.meta.dir, 'extension.ts'), 'utf8');

describe('stream-driven tab identity wiring', () => {
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
});
