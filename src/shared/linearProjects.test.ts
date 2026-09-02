import { test, expect } from 'bun:test';
import { normalizeProjectKey, matchLinearProject, type LinearProjectLite } from './linearProjects';

test('normalizeProjectKey collapses name / slug / folder to one key', () => {
  expect(normalizeProjectKey('Agents CLI')).toBe('agentscli');
  expect(normalizeProjectKey('phnx-labs/agents-cli')).toBe('agentscli');
  expect(normalizeProjectKey('/Users/me/src/github.com/phnx-labs/agents-cli')).toBe('agentscli');
  expect(normalizeProjectKey('rush_app')).toBe('rushapp');
  expect(normalizeProjectKey('')).toBe('');
});

const PROJECTS: LinearProjectLite[] = [
  { id: 'a', name: 'Agents CLI' },
  { id: 'b', name: 'Rush App' },
  { id: 'c', name: 'Prix' },
];

test('matchLinearProject: exact normalized match wins', () => {
  expect(matchLinearProject('phnx-labs/agents-cli', PROJECTS)?.id).toBe('a');
  expect(matchLinearProject('rush-app', PROJECTS)?.id).toBe('b');
});

test('matchLinearProject: containment fallback for near names', () => {
  // "agents-cli-web" has no exact peer; its words start with "agents cli" -> Agents CLI.
  expect(matchLinearProject('agents-cli-web', PROJECTS)?.id).toBe('a');
  // and the other direction: a project name that contains the queried repo's words.
  expect(matchLinearProject('rush', PROJECTS)?.id).toBe('b');
});

test('matchLinearProject: containment is word-wise, so a short project name cannot swallow an unrelated repo', () => {
  const projects: LinearProjectLite[] = [...PROJECTS, { id: 'd', name: 'Rush' }];
  // "crushcli" contains the substring "rush" — character containment filed this
  // unrelated repo under project Rush. Words are ["crush","cli"], so it must not.
  expect(matchLinearProject('someuser/crush-cli', projects)).toBeUndefined();
  expect(matchLinearProject('o/brush-fix', projects)).toBeUndefined();
  expect(matchLinearProject('airbrush', projects)).toBeUndefined();
  // the real word still matches, in either direction
  expect(matchLinearProject('o/rush-web', projects)?.id).toBe('d');
});

test('matchLinearProject: fuzzy:false keeps only the exact normalized match', () => {
  expect(matchLinearProject('agents-cli-web', PROJECTS, { fuzzy: false })).toBeUndefined();
  expect(matchLinearProject('phnx-labs/agents-cli', PROJECTS, { fuzzy: false })?.id).toBe('a');
});

test('matchLinearProject: no match returns undefined', () => {
  expect(matchLinearProject('totally-unrelated', PROJECTS)).toBeUndefined();
  expect(matchLinearProject('', PROJECTS)).toBeUndefined();
});
