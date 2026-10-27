// The Review tab's ring through the panel's real webview script in happy-dom (owner,
// 2026-10-27 12:07 PM): a click arms it and nothing is sent, a second click stops it, five
// seconds later one merge goes to the host, and the host's answer turns the ring violet
// (Merged) or red with GitHub's reason; the agent's logo sends one Fix.
import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { vscodeDouble } from '../testing/vscodeDouble';

mock.module('vscode', () => vscodeDouble());
const { shell } = await import('./projectPanel.vscode');
const { parsePrs, renderPrs, DEFAULT_REVIEW_PREFS } = await import('../core/projectPanel');

const pr = (number: number, extra: Record<string, unknown>) => ({ number, title: `pr ${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false, ciState: 'SUCCESS', headSha: `abc000${number}`, author: { login: 'm' }, createdAt: '2026-10-26T00:00:00Z', ...extra });
const model = parsePrs(JSON.stringify({ repositories: [{ slug: 'o/r', pullRequests: [pr(1, {}), pr(2, {}), pr(3, { mergeable: false, mergeableState: 'dirty', baseRefName: 'main' })], recentlyMerged: [] }] }));
const html = renderPrs(model, Date.parse('2026-10-27T00:00:00Z'), { prefs: DEFAULT_REVIEW_PREFS, mergeWith: 'squash', avatar: () => null, fixAgent: { key: 'claude', name: 'Claude' } });

const window = new Window();
afterAll(() => window.happyDOM.close());
const { document } = window;
const page = shell('vscode-webview:');
document.body.innerHTML = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script'));
const sent: { type: string; repo?: string; number?: number; sha?: string }[] = [];
const open = page.indexOf('<script');
const script = page.slice(page.indexOf('>', open) + 1, page.lastIndexOf('</script'));
new Function('window', 'document', 'acquireVsCodeApi', 'CSS', 'IntersectionObserver', 'innerWidth', 'innerHeight', script)(
  window, document, () => ({ postMessage: (m: { type: string }) => sent.push(m) }), { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  class { observe() { /* thumbnails are not under test */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }, 800, 600,
);
const deliver = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
const ring = (n: number) => document.querySelector(`.pring[data-merge-number="${n}"]`) as unknown as HTMLButtonElement;
const word = (n: number) => ring(n).closest('.prli')!.querySelector('.vw')!.textContent;
deliver({ type: 'tab', tab: 'prs' });
deliver({ type: 'html', tab: 'prs', html });

test('a click arms the ring and sends nothing; a second click stops it', () => {
  sent.length = 0;
  ring(1).click();
  expect(ring(1).classList.contains('armed')).toBe(true);
  expect(ring(1).title).toBe('Merging in 5 s. Click to stop');
  ring(1).click();
  expect(ring(1).classList.contains('armed')).toBe(false);
  expect(sent.filter((m) => m.type === 'merge')).toEqual([]);
});

test('after five seconds one merge goes out, pinned to the head; the host answer turns the ring violet or red', async () => {
  sent.length = 0;
  ring(1).click();
  ring(2).click();
  await new Promise((r) => setTimeout(r, 5300));
  expect(sent.filter((m) => m.type === 'merge')).toEqual([{ type: 'merge', repo: 'o/r', number: 1, sha: 'abc0001' }, { type: 'merge', repo: 'o/r', number: 2, sha: 'abc0002' }]);
  expect(ring(1).classList.contains('merging')).toBe(true);
  expect(word(1)).toBe('Merging…');
  deliver({ type: 'merged', repo: 'o/r', number: 1, error: '' });
  expect(ring(1).className).toBe('pring v-merged');
  expect(word(1)).toBe('Merged');
  deliver({ type: 'merged', repo: 'o/r', number: 2, error: 'Base branch was modified.' });
  expect(ring(2).className).toBe('pring v-bad');
  expect(word(2)).toBe('Not merged: Base branch was modified.');
}, 10000);

test("a conflict's ring is not a button; the agent's logo sends one Fix", () => {
  sent.length = 0;
  expect(document.querySelector('[data-merge-number="3"]')).toBeNull();
  const fix = document.querySelector('[data-fix-number="3"]') as unknown as HTMLButtonElement;
  fix.click();
  fix.click();
  expect(sent).toEqual([{ type: 'fixPr', repo: 'o/r', number: 3 }]);
  expect(fix.disabled).toBe(true);
});
