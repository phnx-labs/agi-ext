import { expect, test } from 'bun:test';
import { displayPath } from './displayPath';
const cwd = '/Users/muqsit/src/github.com/muqsitnawaz/agents-cli';
const sessionId = 'c0d7375b-ce77-4952-8126-491e435b4eac';
const options = { cwd, sessionId, home: '/Users/muqsit' };
const scratch = '/private/tmp/claude-501/-Users-muqsit-src-github-com-muqsitnawaz-agents-cli/';
for (const name of ['merge-tb.sh', 'timebomb-body.md', 'timebomb2.sh', 'timebomb.sh', 'review.md', 'add-store-test.sh', 'gen-index2.sh', 'gen-index.sh']) {
  test(`own scratch preserves scratchpad/${name}`, () => {
    expect(displayPath(`${scratch}${sessionId}/scratchpad/${name}`, options)).toBe(`scratchpad/${name}`);
  });
}
test('path precedence and boundaries', () => {
  expect(displayPath(`${cwd}/cli/src/lib/session/active.ts`, options)).toBe('cli/src/lib/session/active.ts');
  expect(displayPath(`${scratch}other/scratchpad/review.md`, options)).toBe('scratch/…/review.md');
  expect(displayPath('/Users/muqsit/.agents/artifacts/2026-10-02/report.md', options)).toBe('~/.agents/artifacts/2026-10-02/report.md');
  expect(displayPath('/etc/config', options)).toBe('/etc/config');
  expect(displayPath(`${cwd}-other/file.ts`, options)).toContain('agents-cli-other/file.ts');
});
test('middle elision never cuts a basename, including one longer than the limit', () => {
  const basename = 'very-long-filename-'.repeat(8) + '.md';
  expect(displayPath(`/outside/long/directory/${basename}`, options)).toBe(`…/${basename}`);
  const result = displayPath('/outside/' + 'directory/'.repeat(15) + 'report.md', options);
  expect(result.length).toBe(56);
  expect(result).toEndWith('/report.md');
  expect(result).toContain('…');
});

test('Linux scratch uses the same ownership boundaries', () => {
  const cwd = '/home/user/repo';
  expect(displayPath('/tmp/claude-1000/-home-user-repo/session/scratchpad/test.md', { cwd, sessionId: 'session' })).toBe('scratchpad/test.md');
  expect(displayPath('/tmp/claude-1000/-home-user-repo/other/test.md', { cwd, sessionId: 'session' })).toBe('scratch/…/test.md');
});
test('Windows separators compact without cutting the basename', () => {
  expect(displayPath('C:\\Users\\user\\repo\\src\\test.ts', { cwd: 'C:\\Users\\user\\repo' })).toBe('src/test.ts');
  const name = 'very-long-filename-'.repeat(8) + '.md';
  expect(displayPath('C:\\outside\\directory\\' + name, {})).toBe('…/' + name);
});
test('remote paths never borrow the extension host home', () => {
  const file = '/home/user/report.md';
  expect(displayPath(file, { home: '/home/user', isRemote: true })).toBe(file);
  expect(displayPath(file, { home: '/home/user', isRemote: false })).toBe('~/report.md');
  expect(displayPath(file, { home: '/Users/local', isRemote: true, hostHome: '/home/user' })).toBe('~/report.md');
});
