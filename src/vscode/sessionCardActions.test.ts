import { describe, expect, mock, test } from 'bun:test';
import * as os from 'os';
import { vscodeDouble } from '../testing/vscodeDouble';
import { normalizeActiveSession, type RawActiveSession } from '../core/remoteSessions';

const errors: string[] = [];
mock.module('vscode', () => vscodeDouble({ window: { showErrorMessage: async (m: string) => { errors.push(m); } } }));

const { openListedArtifact } = await import('./sessionCardActions');

const HOME = os.homedir();
const row = (sessionId: string, host: string, artifact: string) => normalizeActiveSession({
  kind: 'claude', sessionId, status: 'idle', cwd: `${HOME}/src/atlas`,
  artifacts: [{ path: artifact, basename: artifact.split('/').pop(), bucket: 'artifacts' }],
} as RawActiveSession, host, 0);

/** The same session id on two machines (a copied/resumed transcript). */
const SESSIONS = [
  row('dup', 'yosemite-m2', '/home/u/a/m2.png'),
  row('dup', 'yosemite-m6', '/home/u/a/m6.png'),
];

describe('openListedArtifact', () => {
  test('targets the row by session id AND host, and says whether that row names the file', async () => {
    const calls: unknown[][] = [];
    const open = async (...args: unknown[]) => { calls.push(args); };
    await openListedArtifact('dup', 'yosemite-m6', '/home/u/a/m6.png', SESSIONS, open);
    await openListedArtifact('dup', 'yosemite-m6', '/home/u/a/m2.png', SESSIONS, open);
    await openListedArtifact('dup', 'yosemite-m9', '/home/u/a/m2.png', SESSIONS, open);
    expect(calls).toEqual([
      ['/home/u/a/m6.png', 'yosemite-m6', true],
      // m2's file is not named by the m6 row: the copy guard refuses it downstream.
      ['/home/u/a/m2.png', 'yosemite-m6', false],
    ]);
    expect(errors).toEqual(['Not opening /home/u/a/m2.png: the session left the stream.']);
  });
});
