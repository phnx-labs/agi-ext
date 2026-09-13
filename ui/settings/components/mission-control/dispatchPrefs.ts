import type { UnifiedTask } from '../../types'

export type CloudProviderId = 'rush' | 'codex' | 'factory'

export type DispatchPrefs = {
  lastAgent: string
  lastTarget: 'local' | 'cloud'
  lastCloudProvider: CloudProviderId
  notifyOnQuestion: boolean
  notifyOnFinish: boolean
  notifyChannel: string
  lastCodexEnv: string
  /** Most-recently-dispatched repos, newest first. Capped at MRU_MAX. */
  recentRepos: string[]
  /**
   * Per-task-type overrides for agent/target/cloudProvider. Keyed by the
   * task's type bucket (see `taskTypeKey`) — e.g. `docs` tasks remember
   * Codex while `engineering` tasks remember Claude without either
   * leaking into the other. Missing keys fall back to the global
   * `lastAgent`/`lastTarget`/`lastCloudProvider` fields above.
   */
  byTaskType?: Record<string, Partial<Pick<DispatchPrefs, 'lastAgent' | 'lastTarget' | 'lastCloudProvider'>>>
}

const DISPATCH_PREFS_KEY = 'swarmify.dispatchPrefs.v1'
const MRU_MAX = 10
const RESERVED_LABEL_PREFIXES = ['repo:', 'agent:', 'priority:']

/**
 * Derive a stable "task type" bucket from a task's metadata, used as the
 * key in `DispatchPrefs.byTaskType`. Strategy: pick the first label that
 * isn't a reserved routing label (repo:, agent:, priority:). Falls back
 * to `task.source` (linear / github / markdown) so tasks without useful
 * labels still get a source-level override.
 */
export function taskTypeKey(task: UnifiedTask): string {
  const labels = (task.metadata.labels || []).map((l) => (typeof l === 'string' ? l.toLowerCase() : ''))
  for (const l of labels) {
    if (!l) continue
    if (RESERVED_LABEL_PREFIXES.some((p) => l.startsWith(p))) continue
    return l
  }
  return task.source || 'default'
}

export function loadDispatchPrefs(): DispatchPrefs {
  try {
    const raw = localStorage.getItem(DISPATCH_PREFS_KEY)
    if (!raw) return defaultPrefs()
    const parsed = JSON.parse(raw)
    return { ...defaultPrefs(), ...parsed }
  } catch {
    return defaultPrefs()
  }
}

/**
 * Merge the global prefs with any per-task-type overrides. Returns prefs
 * with agent/target/cloudProvider taking from the type-specific bucket
 * when present, falling back to the global defaults otherwise.
 */
export function prefsForTask(p: DispatchPrefs, task: UnifiedTask): DispatchPrefs {
  const key = taskTypeKey(task)
  const override = p.byTaskType?.[key]
  if (!override) return p
  return {
    ...p,
    lastAgent: override.lastAgent ?? p.lastAgent,
    lastTarget: override.lastTarget ?? p.lastTarget,
    lastCloudProvider: override.lastCloudProvider ?? p.lastCloudProvider,
  }
}

function defaultPrefs(): DispatchPrefs {
  return {
    lastAgent: 'claude',
    lastTarget: 'local',
    lastCloudProvider: 'rush',
    notifyOnQuestion: true,
    notifyOnFinish: true,
    notifyChannel: 'ios',
    lastCodexEnv: '',
    recentRepos: [],
    byTaskType: {},
  }
}

export function saveDispatchPrefs(p: DispatchPrefs): void {
  try { localStorage.setItem(DISPATCH_PREFS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

/** Push repos to the front of the MRU list, dedupe, cap at MRU_MAX. */
export function bumpRecentRepos(existing: string[], used: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of used) {
    if (!r || seen.has(r)) continue
    seen.add(r)
    out.push(r)
  }
  for (const r of existing) {
    if (!r || seen.has(r)) continue
    seen.add(r)
    out.push(r)
  }
  return out.slice(0, MRU_MAX)
}
