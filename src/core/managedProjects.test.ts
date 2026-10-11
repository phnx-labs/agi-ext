import { test, describe, expect } from 'bun:test';
import { defToManaged } from './managedProjects';

describe('defToManaged', () => {
  test('maps name to id and name, and carries the description', () => {
    expect(defToManaged({ name: 'rush', description: 'The Rush app' })).toEqual({
      id: 'rush', name: 'rush', description: 'The Rush app', repoSlug: undefined,
    });
  });

  test('prefers the top-level repo over repos[0].slug', () => {
    expect(defToManaged({ name: 'rush', repo: 'phnx-labs/rush', repos: [{ slug: 'phnx-labs/other' }] }).repoSlug).toBe('phnx-labs/rush');
  });

  test('falls back to repos[0].slug when repo is absent', () => {
    expect(defToManaged({ name: 'rush', repos: [{ slug: 'phnx-labs/rush' }, { slug: 'phnx-labs/other' }] }).repoSlug).toBe('phnx-labs/rush');
  });

  test('an empty name yields an empty id and name', () => {
    const m = defToManaged({ name: '' });
    expect(m.id).toBe('');
    expect(m.name).toBe('');
  });
});
