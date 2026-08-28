import { expect, test, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guards for the acting poll timers removed under the one-scheduler
// rule (the agents-cli daemon, or a CLI command it drives, is the only
// scheduler). PR #9 (PHNX-2833) replaced the Agent Panel's 4s poll, the Fleet
// throughput 2.5s webview poll, and the Issues Panel's 60s poll with
// event-driven refreshes; those replacement paths shipped untested (PHNX-3447).
// This file pins their structure so a future change can't quietly reintroduce a
// timer or unwire the event trigger. The trailing-coalesce primitive these
// paths lean on is behaviorally covered in src/core/cachedInFlight.test.ts.

const read = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf8');

const agentPanel = read('agentPanel.vscode.ts');
const issuesPanel = read('issuesPanel.vscode.ts');
const settings = read('settings.vscode.ts');

describe('agentPanel.vscode — stream-driven, no 4s poll (PHNX-2833/PHNX-3447)', () => {
  test('no poll timer remains', () => {
    expect(agentPanel).not.toMatch(/setInterval\s*\(/);
    expect(agentPanel).not.toMatch(/this\.pollTimer/);
    expect(agentPanel).not.toMatch(/private (start|stop)Polling\s*\(/);
  });

  test('notifyAgentPanelSessionUpdate drives refreshIfVisible via trailing coalesce', () => {
    expect(agentPanel).toContain('export function notifyAgentPanelSessionUpdate()');
    // No-op when nothing is registered.
    expect(agentPanel).toMatch(/if \(!activeProvider\) return/);
    // The daemon stream fact is what schedules the redraw, coalesced.
    expect(agentPanel).toContain('coalesceTrailing(streamRefreshCoalesce, STREAM_REFRESH_KEY, () => activeProvider!.refreshIfVisible())');
  });

  test('refreshIfVisible gates on the tracked visibility flag', () => {
    expect(agentPanel).toMatch(/async refreshIfVisible\(\): Promise<void> \{\s*if \(!this\.visible\) return;/);
  });
});

describe('issuesPanel.vscode — focus-regained, no 60s poll (PHNX-2833/PHNX-3447)', () => {
  test('no poll timer remains', () => {
    expect(issuesPanel).not.toMatch(/setInterval\s*\(/);
    expect(issuesPanel).not.toMatch(/this\.pollTimer/);
    expect(issuesPanel).not.toMatch(/private (start|stop)Polling\s*\(/);
  });

  test('armFocusRefresh re-fetches on window focus regained', () => {
    expect(issuesPanel).toContain('private armFocusRefresh()');
    expect(issuesPanel).toContain('vscode.window.onDidChangeWindowState');
    expect(issuesPanel).toMatch(/if \(state\.focused\) void this\.refresh\(\)/);
  });
});

describe('settings.vscode — floor throughput pushed, not polled (PHNX-2833/PHNX-3447)', () => {
  test('the getFloorThroughput poll message handler is gone', () => {
    expect(settings).not.toContain("case 'getFloorThroughput'");
  });

  test('computeFloorThroughput sums live-terminal tokPerSec from the stream store', () => {
    expect(settings).toContain('function computeFloorThroughput()');
    expect(settings).toContain('sessionPresentationStore.presentedSessions(LOCAL_MACHINE_ID, LOCAL_LABEL)');
    expect(settings).toContain('total += s.tokPerSec');
  });

  test('pushFloorThroughput posts floorThroughputData and rides the stream refresh', () => {
    expect(settings).toContain('function pushFloorThroughput()');
    expect(settings).toContain("type: 'floorThroughputData', tokensPerSec: computeFloorThroughput()");
    // The host pushes throughput whenever the session stream changes.
    expect(settings).toMatch(/refreshFloorFromSessionStream\(\)[\s\S]*?pushFloorThroughput\(\);/);
  });

  test('window-focus-regained is forwarded to the webview only on focus GAINED (PHNX-3447/PHNX-3435)', () => {
    expect(settings).toContain('vscode.window.onDidChangeWindowState');
    // Must be CONNECTED, not just present: the `windowFocusRegained` post is
    // gated on `state.focused` inside the onDidChangeWindowState handler. An
    // inverted condition (posting on focus LOST) would refetch at the wrong time
    // and must fail this test rather than ship — the weak "both substrings exist
    // somewhere" form the review flagged could not catch that.
    expect(settings).toMatch(
      /onDidChangeWindowState\(\(state\)\s*=>\s*\{[\s\S]*?if\s*\(state\.focused\)[\s\S]*?type:\s*'windowFocusRegained'/,
    );
  });
});
