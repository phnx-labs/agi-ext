import { describe, expect, test } from 'bun:test';
import { normalizeActiveSession, type RawActiveSession } from './remoteSessions';
import { madeShelf, renderedHtmlCandidates, sessionCardFields } from './sessionCardFields';

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

  test('a session that opened several PRs lists each, oldest first', () => {
    const prs = [{ url: 'https://github.com/acme/atlas/pull/509', number: 509 }, { url: 'https://github.com/acme/atlas/pull/511', number: 511 }];
    const card = sessionCardFields(normalizeActiveSession(raw({ prs }), 'this-mac', 0), { sessionId: 's-1', home: HOME });
    expect(card.pullRequests?.map((p) => p.number)).toEqual([509, 511]);
  });

  test('the newest PR joins the earlier ones once, and an entry with no url is dropped', () => {
    const prs = [{ url: 'https://github.com/acme/atlas/pull/509' }, null, { number: 3 }, { url: 'https://github.com/acme/atlas/pull/511' }];
    const card = sessionCardFields(normalizeActiveSession(raw({ prs } as Partial<RawActiveSession>), 'this-mac', 0), { sessionId: 's-1', home: HOME });
    expect(card.pullRequests?.map((p) => p.number)).toEqual([509, 511]);
    const older = sessionCardFields(normalizeActiveSession(raw({ prs: [{ url: 'https://github.com/acme/atlas/pull/509' }] }), 'this-mac', 0), { sessionId: 's-1', home: HOME });
    expect(older.pullRequests?.map((p) => p.number)).toEqual([509, 511]);
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

  test('a source listed beside its rendered page shows once, as the page; the plan follows it', () => {
    const dir = `${HOME}/src/atlas/.agents/plans`;
    const live = normalizeActiveSession(raw({
      planFile: `${dir}/guard.md`,
      artifacts: [
        { path: `${dir}/guard.md`, basename: 'guard.md', bucket: 'plans' },
        { path: `${dir}/guard.html`, basename: 'guard.html', bucket: 'plans' },
        { path: `${dir}/notes.md`, basename: 'notes.md', bucket: 'plans' },
        { path: `${dir}/.artifacts/map.html`, basename: 'map.html', bucket: 'plans' },
        { path: `${dir}/map.md`, basename: 'map.md', bucket: 'plans' },
      ],
    }), 'this-mac', 0);
    const card = sessionCardFields(live, { sessionId: 's-1', home: HOME });
    expect(card.artifacts.map((a) => [a.basename, a.renderedFrom])).toEqual([
      ['guard.html', 'guard.md'],
      ['notes.md', undefined],
      ['map.html', 'map.md'],
    ]);
    expect(card.plan?.path).toBe(`${dir}/guard.html`);
  });
});

describe('madeShelf', () => {
  test('one shelf for both panels: PRs, the ticket it is on and the ones it created, files, and what it only acted on', () => {
    const live = normalizeActiveSession(raw({ createdTickets: ['RUSH-900'], touchedPrs: [{ url: 'https://github.com/acme/atlas/pull/3', number: 3, action: 'merged' }] } as Partial<RawActiveSession>), 'this-mac', 0);
    const card = sessionCardFields(live, { sessionId: 's-1', home: HOME, previewUri: preview });
    const shelf = madeShelf(live, card);
    expect(shelf.pullRequests?.map((p) => p.number)).toEqual([511]);
    expect(shelf.ticket).toEqual({ id: 'RUSH-812' });
    expect(shelf.createdTickets).toEqual([{ id: 'RUSH-900' }]);
    expect(shelf.artifacts).toBe(card.artifacts);
    expect(shelf.sessionLocal).toBe(true);
    expect(shelf.touchedPrs).toEqual([{ url: 'https://github.com/acme/atlas/pull/3', number: 3, action: 'merged' }]);
    expect(shelf.touchedTickets).toBeUndefined();
  });
});

test('a source renders beside itself or in its .artifacts/ folder; a page is its own', () => {
  expect(renderedHtmlCandidates('/a/b/plan.md')).toEqual(['/a/b/plan.html', '/a/b/.artifacts/plan.html']);
  expect(renderedHtmlCandidates('/a/b/page.html')).toEqual(['/a/b/page.html']);
});
