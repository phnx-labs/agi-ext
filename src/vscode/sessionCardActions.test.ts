import { describe, expect, mock, test } from 'bun:test';
import * as os from 'os';
import { vscodeDouble } from '../testing/vscodeDouble';
import { normalizeActiveSession, type RawActiveSession } from '../core/remoteSessions';

mock.module('vscode', () => vscodeDouble({ window: {} }));

const { runSessionCardAction } = await import('./sessionCardActions');

const HOME = os.homedir();
const row = (sessionId: string, host: string, artifact: string) => normalizeActiveSession({
  kind: 'claude', sessionId, status: 'idle', cwd: `${HOME}/src/atlas`,
  artifacts: [{ path: artifact, basename: artifact.split('/').pop(), bucket: 'artifacts' }],
} as RawActiveSession, host, 0);

/** The same session id on two machines (a copied/resumed transcript), plus a local one. */
const SESSIONS = [
  row('dup', 'yosemite-m2', '/home/u/a/m2.png'),
  row('dup', 'yosemite-m6', '/home/u/a/m6.png'),
  row('local', 'this-mac', `${HOME}/src/atlas/shot.png`),
];

function harness() {
  const calls: unknown[][] = [];
  const posted: Record<string, unknown>[] = [];
  const effects = {
    openArtifact: async (...args: unknown[]) => { calls.push(['open', ...args]); },
    fetchTimelineFilter: async (role: string, sessionId: string) => { calls.push(['filter', role, sessionId]); return { items: [{ text: 'checking' }] }; },
    reveal: (p: string) => { calls.push(['reveal', p]); },
    openUrl: (u: string) => { calls.push(['url', u]); },
    notify: (m: string) => { calls.push(['notify', m]); },
  };
  const run = (message: Record<string, unknown>) => runSessionCardAction(message, SESSIONS, (m) => posted.push(m), effects);
  return { calls, posted, run };
}

describe('runSessionCardAction', () => {
  test('targets the row by session id AND host, and says whether that row names the file', async () => {
    const h = harness();
    await h.run({ sessionId: 'dup', host: 'yosemite-m6', action: { type: 'openArtifact', path: '/home/u/a/m6.png' } });
    await h.run({ sessionId: 'dup', host: 'yosemite-m6', action: { type: 'openArtifact', path: '/home/u/a/m2.png' } });
    expect(h.calls).toEqual([
      ['open', '/home/u/a/m6.png', 'yosemite-m6', true],
      // m2's file is not named by the m6 row: the copy guard refuses it downstream.
      ['open', '/home/u/a/m2.png', 'yosemite-m6', false],
    ]);
  });

  test('a session that left the stream opens nothing and says so', async () => {
    const h = harness();
    await h.run({ sessionId: 'dup', host: 'yosemite-m9', action: { type: 'openArtifact', path: '/home/u/a/m2.png' } });
    expect(h.calls).toEqual([['notify', 'Not opening /home/u/a/m2.png: the session left the stream.']]);
  });

  test('heavy filters: only known roles, only a session on this machine, answered to that session', async () => {
    const h = harness();
    await h.run({ sessionId: 'local', host: 'this-mac', action: { type: 'loadTimelineFilter', role: 'rm -rf' } });
    await h.run({ sessionId: 'dup', host: 'yosemite-m2', action: { type: 'loadTimelineFilter', role: 'tools' } });
    await h.run({ sessionId: 'gone', host: 'this-mac', action: { type: 'loadTimelineFilter', role: 'tools' } });
    await h.run({ sessionId: 'local', host: 'this-mac', action: { type: 'loadTimelineFilter', role: 'assistant' } });
    expect(h.calls).toEqual([['filter', 'assistant', 'local']]);
    expect(h.posted).toEqual([
      { type: 'timelineFilter', role: 'rm -rf', sessionId: 'local', error: 'That filter is not available.' },
      { type: 'timelineFilter', role: 'tools', sessionId: 'dup', error: 'This session is on another machine.' },
      { type: 'timelineFilter', role: 'tools', sessionId: 'gone', error: 'The session left the stream before the filter loaded.' },
      { type: 'timelineFilter', role: 'assistant', sessionId: 'local', items: [{ text: 'checking' }] },
    ]);
  });

  test('reveal is local only; a message without a session id does nothing', async () => {
    const h = harness();
    await h.run({ sessionId: 'dup', host: 'yosemite-m2', action: { type: 'revealCwd', path: '/home/u/a' } });
    await h.run({ sessionId: 'local', host: 'this-mac', action: { type: 'revealCwd', path: `${HOME}/src/atlas` } });
    await h.run({ host: 'this-mac', action: { type: 'openUrl', url: 'https://x' } });
    expect(h.calls).toEqual([['reveal', `${HOME}/src/atlas`]]);
  });
});
