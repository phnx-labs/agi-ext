import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Guarded like App.test.tsx: the persistence helpers below need a real
// localStorage, and this file must also survive a run launched outside ui/ where
// bunfig.toml's preload does not apply.
if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()

import { beforeEach, describe, expect, test } from 'bun:test'
import type { FloorAgent } from './floorModel'
import {
  applyProjectAssignments,
  assignProjects,
  assignableProjectNames,
  attributeSessionProject,
  filterProjectOptions,
  isUnassigned,
  loadProjectAssignments,
  loadProjectFilter,
  persistProjectAssignments,
  persistProjectFilter,
  projectFilterLabel,
  projectFilterOptions,
  repoSlugFromUrl,
  UNASSIGNED_LABEL,
  UNASSIGNED_PROJECT,
} from './sessionProjects'

function mk(over: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: over.id ?? 's1',
    host: 'this-mac',
    hostLabel: 'zion',
    project: 'agents-cli',
    name: 'session',
    abbr: 'CC',
    phase: 'running',
    verb: '',
    target: '',
    tok: 0,
    since: '2s',
    lastActivityMs: 0,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: null,
    prUrl: null,
    ticket: null,
    branch: '',
    worktreeSlug: '',
    worktreePath: '',
    resp: '',
    topic: '',
    messages: [],
    question: null,
    reply: { kind: 'none', host: 'this-mac' },
    todos: [],
    summary: '',
    recent: [],
    ...over,
  } as FloorAgent
}

const KNOWN = ['agents-cli', 'agi-ext', 'rush']

describe('attributeSessionProject — cwd stays the strongest signal', () => {
  test('a cwd resolves exactly as it always did, and user rules still win', () => {
    expect(attributeSessionProject({ cwd: '/home/m/src/github.com/o/agents-cli' })).toEqual({
      project: 'agents-cli',
      source: 'cwd',
    })
    expect(attributeSessionProject(
      { cwd: '/home/m/src/agents/prix/api' },
      { rules: [{ pattern: '**/agents/prix/api', project: 'Prix API' }] },
    )).toEqual({ project: 'Prix API', source: 'cwd' })
  })

  test('a worktree cwd still folds back to its repo', () => {
    expect(attributeSessionProject({ cwd: '/home/m/src/agi-ext/.agents/worktrees/phnx-3796' }).project).toBe('agi-ext')
  })

  test('a row with only a worktree PATH is treated as a cwd', () => {
    expect(attributeSessionProject({ cwd: '', worktreePath: '/home/m/src/agi-ext/.agents/worktrees/x' })).toEqual({
      project: 'agi-ext',
      source: 'cwd',
    })
  })
})

describe('attributeSessionProject — widened hints (PHNX-3796)', () => {
  test('a repo slug attributes with no cwd, folding onto a known project', () => {
    expect(attributeSessionProject({ repo: 'phnx-labs/agents-cli' }, { known: KNOWN })).toEqual({
      project: 'agents-cli',
      source: 'repo',
    })
  })

  test('an unknown repo slug still attributes — to its own basename, not Unassigned', () => {
    expect(attributeSessionProject({ repo: 'phnx-labs/brand-new-repo' }, { known: KNOWN })).toEqual({
      project: 'brand-new-repo',
      source: 'repo',
    })
  })

  test("a run CONTEXT word ('cloud') is not a project — it must not rename the blank bucket", () => {
    // This is the exact live shape of the orphaned rows: context 'cloud', no cwd,
    // and the CLI's project slot holding the word "cloud".
    expect(attributeSessionProject({ repo: 'cloud', cwd: '' }, { known: KNOWN })).toEqual({
      project: UNASSIGNED_PROJECT,
      source: 'none',
    })
  })

  test("a cloud run's PR url supplies the repo slug", () => {
    expect(attributeSessionProject(
      { repo: 'cloud', prUrl: 'https://github.com/phnx-labs/agi-ext/pull/412' },
      { known: KNOWN },
    )).toEqual({ project: 'agi-ext', source: 'cloud' })
  })

  test('branch, worktree slug, and team bind only to an ALREADY-KNOWN project', () => {
    expect(attributeSessionProject({ branch: 'agents-cli/fix-lease' }, { known: KNOWN })).toEqual({
      project: 'agents-cli',
      source: 'branch',
    })
    expect(attributeSessionProject({ worktreeSlug: 'agi-ext' }, { known: KNOWN })).toEqual({
      project: 'agi-ext',
      source: 'worktree',
    })
    expect(attributeSessionProject({ team: 'rush' }, { known: KNOWN })).toEqual({
      project: 'rush',
      source: 'actor',
    })
    // No known peer -> no guess.
    expect(attributeSessionProject({ branch: 'agents-cli/fix-lease' }).project).toBe(UNASSIGNED_PROJECT)
  })

  test('a weak hint never takes the containment shortcut a repo slug is allowed', () => {
    // A branch that merely carries a project's word says nothing about the project.
    expect(attributeSessionProject({ branch: 'rush-the-lease-fix' }, { known: KNOWN }).project).toBe(UNASSIGNED_PROJECT)
    // The same containment IS wanted for a real repo slug.
    expect(attributeSessionProject({ repo: 'o/agents-cli-web' }, { known: KNOWN }).project).toBe('agents-cli')
  })

  test('a repo whose name merely CONTAINS a short project name is never filed under it', () => {
    // Regression: character containment ("crushcli" contains "rush") filed an
    // unrelated repo under project Rush. It must keep its own name instead.
    expect(attributeSessionProject({ repo: 'someuser/crush-cli' }, { known: KNOWN })).toEqual({
      project: 'crush-cli',
      source: 'repo',
    })
    expect(attributeSessionProject({ prUrl: 'https://github.com/someuser/brush-fix/pull/3' }, { known: KNOWN })).toEqual({
      project: 'brush-fix',
      source: 'cloud',
    })
    // the genuine repo still folds onto the project
    expect(attributeSessionProject({ repo: 'phnx-labs/rush-web' }, { known: KNOWN }).project).toBe('rush')
  })

  test('a prompt-shaped label is never mined — a genuinely repo-less run stays Unassigned', () => {
    expect(attributeSessionProject(
      { repo: 'cloud', branch: '', worktreeSlug: '', team: '' },
      { known: [...KNOWN, 'factory'] },
    )).toEqual({ project: UNASSIGNED_PROJECT, source: 'none' })
  })

  test('hints are tried strongest first', () => {
    const both = attributeSessionProject(
      { cwd: '/home/m/src/agents-cli', prUrl: 'https://github.com/phnx-labs/agi-ext/pull/1' },
      { known: KNOWN },
    )
    expect(both).toEqual({ project: 'agents-cli', source: 'cwd' })
  })
})

describe('repoSlugFromUrl', () => {
  test('reads owner/repo out of a GitHub PR url and ignores everything else', () => {
    expect(repoSlugFromUrl('https://github.com/phnx-labs/agi-ext/pull/412')).toBe('phnx-labs/agi-ext')
    expect(repoSlugFromUrl('https://github.com/phnx-labs/agi-ext.git')).toBe('phnx-labs/agi-ext')
    expect(repoSlugFromUrl('https://linear.app/getrush/issue/PHNX-3796')).toBe('')
    expect(repoSlugFromUrl(null)).toBe('')
  })
})

describe('projectFilterOptions — counts, All projects, Unassigned', () => {
  const list = [
    mk({ id: 'a', project: 'agents-cli' }),
    mk({ id: 'b', project: 'agents-cli' }),
    mk({ id: 'c', project: 'rush' }),
    mk({ id: 'd', project: UNASSIGNED_PROJECT }),
    mk({ id: 'e', project: UNASSIGNED_PROJECT }),
  ]

  test('All projects leads with the total; projects rank by count; Unassigned is last', () => {
    expect(projectFilterOptions(list)).toEqual([
      { value: null, label: 'All projects', count: 5 },
      { value: 'agents-cli', label: 'agents-cli', count: 2 },
      { value: 'rush', label: 'rush', count: 1 },
      { value: UNASSIGNED_PROJECT, label: UNASSIGNED_LABEL, count: 2 },
    ])
  })

  test('Unassigned is offered only when something is actually unattributed', () => {
    const attributed = projectFilterOptions([mk({ id: 'a' }), mk({ id: 'b', project: 'rush' })])
    expect(attributed.some((o) => o.label === UNASSIGNED_LABEL)).toBe(false)
  })

  test('the menu search filters by label, and the collapsed control names the pick', () => {
    expect(filterProjectOptions(projectFilterOptions(list), 'ru').map((o) => o.label)).toEqual(['rush'])
    expect(filterProjectOptions(projectFilterOptions(list), 'unas').map((o) => o.label)).toEqual([UNASSIGNED_LABEL])
    expect(projectFilterLabel(null)).toBe('All projects')
    expect(projectFilterLabel('rush')).toBe('rush')
    expect(projectFilterLabel(UNASSIGNED_PROJECT)).toBe(UNASSIGNED_LABEL)
  })
})

describe('manual assignment', () => {
  const orphan = mk({ id: 'cloud1', sessionId: 'cloud1', project: UNASSIGNED_PROJECT })
  const other = mk({ id: 'k2', sessionId: 'k2', project: 'rush' })

  test('assigning overrides the row project and clears back to Unassigned', () => {
    const assigned = assignProjects({}, [orphan], 'agi-ext')
    const [row] = applyProjectAssignments([orphan], assigned)
    expect(row?.project).toBe('agi-ext')
    expect(isUnassigned(row!)).toBe(false)

    const cleared = assignProjects(assigned, [orphan], '')
    expect(applyProjectAssignments([orphan], cleared)[0]?.project).toBe(UNASSIGNED_PROJECT)
  })

  test('bulk assign covers every target and leaves untouched rows identical', () => {
    const bulk = assignProjects({}, [orphan, mk({ id: 'cloud2', sessionId: 'cloud2', project: UNASSIGNED_PROJECT })], 'rush')
    const rows = applyProjectAssignments([orphan, mk({ id: 'cloud2', sessionId: 'cloud2', project: UNASSIGNED_PROJECT }), other], bulk)
    expect(rows.map((r) => r.project)).toEqual(['rush', 'rush', 'rush'])
    // identity is preserved for rows with no assignment, so React memoization holds
    expect(rows[2]).toBe(other)
  })

  test('the assign menu offers projects in view plus the curated managed ones', () => {
    expect(assignableProjectNames([orphan, other], ['AGI UI', 'rush'])).toEqual(['AGI UI', 'rush'])
  })
})

describe('persistence — the pick and the assignments survive a reload', () => {
  beforeEach(() => localStorage.clear())

  test('project filter round-trips, and All projects clears the key', () => {
    persistProjectFilter('agents-cli')
    expect(loadProjectFilter()).toBe('agents-cli')
    // Unassigned is a real remembered pick, not "nothing selected".
    persistProjectFilter(UNASSIGNED_PROJECT)
    expect(loadProjectFilter()).toBe(UNASSIGNED_PROJECT)
    persistProjectFilter(null)
    expect(loadProjectFilter()).toBe(null)
  })

  test('assignments round-trip and corrupt storage degrades to empty', () => {
    persistProjectAssignments({ cloud1: 'agi-ext' })
    expect(loadProjectAssignments()).toEqual({ cloud1: 'agi-ext' })
    localStorage.setItem('swarm.sessions.projectAssignments', '{not json')
    expect(loadProjectAssignments()).toEqual({})
    localStorage.setItem('swarm.sessions.projectFilter', '{not json')
    expect(loadProjectFilter()).toBe(null)
  })
})
