import { expect, mock, test } from 'bun:test';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());

// One PR as `agents projects prs <project> --json --repo R --number N` reads it.
const read = (o: Record<string, unknown> = {}, merge: Record<string, unknown> = { viewerIsAdmin: true, adminBypass: true }) => JSON.stringify({ repositories: [{ slug: 'o/r', merge,
  pullRequests: [{ number: 7, isDraft: false, state: 'OPEN', headSha: 'abcdef1234567', mergeableState: 'clean', reviewDecision: 'APPROVED', ciState: 'SUCCESS', ...o }] }] });

function harness(opts: { reads: string[]; pick?: (labels: string[]) => string | undefined; confirm?: boolean }) {
  const calls: string[][] = [];
  const shown: string[] = [];
  const reads = [...opts.reads];
  const deps = {
    run: async (args: string[]) => { calls.push(args); return { stdout: args[2] === 'merge' ? '{}' : reads.shift() ?? reads[reads.length - 1] ?? '{}' }; },
    ui: {
      showQuickPick: async (items: { label: string }[]) => { const want = opts.pick?.(items.map((i) => i.label)); return items.find((i) => i.label === want) as never; },
      showWarningMessage: async (msg: string, _o?: unknown, go?: string) => { shown.push(msg); return (opts.confirm ? go : undefined) as never; },
      showInformationMessage: async (msg: string) => { shown.push(msg); return undefined as never; },
    },
  };
  return { deps: deps as never, calls, shown };
}

test('merge flow: cancel merges nothing; a method runs one pinned merge; --admin only for the admin choice', async () => {
  const { mergeWithMenu } = await import('./prMerge.vscode');
  {
    const h = harness({ reads: [read()], pick: () => undefined });
    expect(await mergeWithMenu('p', 'o/r', 7, h.deps)).toBe(false);
    expect(h.calls.filter((c) => c[2] === 'merge')).toHaveLength(0);
  }
  {
    const h = harness({ reads: [read(), read()], pick: () => 'Squash and merge', confirm: false });
    expect(await mergeWithMenu('p', 'o/r', 7, h.deps)).toBe(false);
    expect(h.calls.filter((c) => c[2] === 'merge')).toHaveLength(0);
  }
  {
    const h = harness({ reads: [read(), read()], pick: () => 'Squash and merge', confirm: true });
    expect(await mergeWithMenu('p', 'o/r', 7, h.deps)).toBe(true);
    const merge = h.calls.find((c) => c[2] === 'merge')!;
    expect(merge).toEqual(['projects', 'prs', 'merge', 'p', '--repo', 'o/r', '--number', '7', '--sha', 'abcdef1234567', '--method', 'squash']);
  }
  {
    const h = harness({ reads: [read(), read()], pick: (l) => l.find((x) => x.includes('Admin merge')), confirm: true });
    expect(await mergeWithMenu('p', 'o/r', 7, h.deps)).toBe(true);
    expect(h.calls.find((c) => c[2] === 'merge')).toContain('--admin');
    expect(h.shown[0]).toContain('bypasses branch protection');
  }
});

test('merge flow: a head that moved during the dialog, or a non-admin, never gets the admin merge', async () => {
  const { mergeWithMenu } = await import('./prMerge.vscode');
  {
    const h = harness({ reads: [read(), read({ headSha: 'fffffff0000000' })], pick: () => 'Squash and merge', confirm: true });
    expect(await mergeWithMenu('p', 'o/r', 7, h.deps)).toBe(false);
    expect(h.calls.filter((c) => c[2] === 'merge')).toHaveLength(0);
    expect(h.shown.at(-1)).toContain('changed while the dialog was open');
  }
  {
    let offered: string[] = [];
    const h = harness({ reads: [read({ mergeableState: 'blocked' }, { viewerIsAdmin: false, adminBypass: true })], pick: (l) => { offered = l; return undefined; } });
    expect(await mergeWithMenu('p', 'o/r', 7, h.deps)).toBe(false);
    expect(offered).toEqual([]);
    expect(h.shown[0]).toContain('cannot be merged from here');
  }
});
