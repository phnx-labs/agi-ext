import { describe, expect, test } from 'bun:test';
import { normalizeActiveSession, type RawActiveSession } from './remoteSessions';
import { sessionCardFields } from './sessionCardFields';

const HOME = '/home/u';
const raw = (over: Partial<RawActiveSession> = {}): RawActiveSession => ({
  kind: 'claude',
  sessionId: 's-1',
  status: 'idle',
  cwd: `${HOME}/src/atlas`,
  topic: 'Ship RUSH-812 merge guard',
  prUrl: 'https://github.com/acme/atlas/pull/511',
  planFile: `${HOME}/src/atlas/.agents/plans/guard.md`,
  artifacts: [
    { path: `${HOME}/src/atlas/.agents/artifacts/flow.png`, basename: 'flow.png', bucket: 'artifacts' },
    { path: `${HOME}/src/atlas/.agents/artifacts/report.html`, basename: 'report.html', bucket: 'reports' },
    { path: '/etc/outside.png', basename: 'outside.png', bucket: 'artifacts' },
  ],
  ...over,
} as RawActiveSession);

const preview = (p: string) => 'webview:' + p;

describe('sessionCardFields', () => {
  test('a local session previews only images under home', () => {
    const live = normalizeActiveSession(raw(), 'this-mac', 0);
    const card = sessionCardFields(live, { sessionId: 's-1', home: HOME, previewUri: preview });
    expect(card.sessionLocal).toBe(true);
    expect(card.artifacts.map((a) => a.uri)).toEqual([`webview:${HOME}/src/atlas/.agents/artifacts/flow.png`, undefined, undefined]);
    expect(card.artifacts[0]!.display).toContain('flow.png');
    expect(card.plan).toMatchObject({ path: `${HOME}/src/atlas/.agents/plans/guard.md` });
    expect(card.pullRequests).toEqual([{ url: 'https://github.com/acme/atlas/pull/511', ownerRepo: 'acme/atlas', number: 511 }]);
    expect(card.linearIssue).toBe('RUSH-812');
    expect(card.needsYou).toBeUndefined();
  });

  test('a remote session gets no preview URI: its files open by a copy on click', () => {
    const live = normalizeActiveSession(raw(), 'yosemite-m2', 0);
    const card = sessionCardFields(live, { sessionId: 's-1', home: HOME, remoteDevice: 'yosemite-m2', previewUri: preview });
    expect(card.sessionLocal).toBe(false);
    expect(card.artifacts.every((a) => a.uri === undefined)).toBe(true);
  });

  test('an open attention item is the needs-you card; a resolved one is not', () => {
    const attention = (state: string) => ({ key: 'k', sessionId: 's-1', kind: 'question', source: 'hook', state, openedAt: '2026-10-10T07:00:00Z', fingerprint: 'f', question: { text: 'Ship it?' } });
    const open = sessionCardFields(normalizeActiveSession(raw({ attention: attention('open') } as Partial<RawActiveSession>), 'this-mac', 0), { sessionId: 's-1', home: HOME });
    expect(open.needsYou).toEqual({ kind: 'question', text: 'Ship it?', openedAtMs: Date.parse('2026-10-10T07:00:00Z') });
    const done = sessionCardFields(normalizeActiveSession(raw({ attention: attention('resolved') } as Partial<RawActiveSession>), 'this-mac', 0), { sessionId: 's-1', home: HOME });
    expect(done.needsYou).toBeUndefined();
  });
});
