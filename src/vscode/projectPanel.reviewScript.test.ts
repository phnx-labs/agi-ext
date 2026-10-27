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
  expect(ring(1).title).toBe('Merging #1…');
  expect(ring(1).getAttribute('aria-label')).toBe('Merging #1…');
  // Off for the keyboard too: a click while it merges arms nothing and sends nothing.
  expect(ring(1).disabled).toBe(true);
  const before = sent.length;
  ring(1).dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as unknown as Event);
  expect(ring(1).classList.contains('armed')).toBe(false);
  expect(sent.length).toBe(before);
  // A redraw while the host merges keeps the ring spinning, so it cannot be clicked again.
  deliver({ type: 'html', tab: 'prs', html });
  expect(ring(1).classList.contains('merging')).toBe(true);
  deliver({ type: 'merged', repo: 'o/r', number: 1, error: '', merged: true });
  expect(ring(1).className).toBe('pring v-merged');
  expect(ring(1).title).toBe('Merged');
  deliver({ type: 'merged', repo: 'o/r', number: 2, error: 'Base branch was modified.', merged: false });
  expect(ring(2).className).toBe('pring v-bad');
  expect(ring(2).title).toBe('Not merged: Base branch was modified. Click to try again');
  // A refused ring stays a button: a click arms it again.
  expect(ring(2).disabled).toBe(false);
  ring(2).click();
  expect(ring(2).classList.contains('armed')).toBe(true);
  expect(ring(2).classList.contains('v-ok')).toBe(true);
  // Leaving Review mid-countdown puts the ring back to ready, with nothing sent.
  sent.length = 0;
  const armed = ring(2);
  deliver({ type: 'choose', tab: 'sessions' });
  expect(armed.classList.contains('armed')).toBe(false);
  deliver({ type: 'choose', tab: 'prs' });
  deliver({ type: 'html', tab: 'prs', html });
  expect(ring(2).classList.contains('armed')).toBe(false);
  expect(sent.filter((m) => m.type === 'merge')).toEqual([]);
}, 10000);

test('a merge turned down here with its own warning puts the ring back to ready', async () => {
  ring(2).click();
  await new Promise((r) => setTimeout(r, 5300));
  expect(ring(2).classList.contains('merging')).toBe(true);
  deliver({ type: 'merged', repo: 'o/r', number: 2, error: '', merged: false });
  expect(ring(2).className).toBe('pring v-ok');
  expect(ring(2).title).toBe('Ready to merge. Click to merge #2');
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
