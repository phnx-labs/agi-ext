import { Modal } from '../ui/Modal'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { UnifiedTask } from '../../types'
import { Icon } from './icons'
import { relTime } from './types'
import { postMessage } from '../../hooks'
import { renderTodoDescription } from '../../utils/markdown'
import {
  bumpRecentRepos,
  loadDispatchPrefs,
  prefsForTask,
  saveDispatchPrefs,
  taskTypeKey,
  type CloudProviderId,
  type DispatchPrefs,
} from './dispatchPrefs'

/**
 * Compact search input + typeahead dropdown in the TaskDetailModal header.
 * Lets the user jump between open tasks without closing the modal.
 * Current task is excluded from results. Empty query surfaces the first
 * 8 tasks so clicking the input gives an immediate browse list.
 */
function TaskSwitcher({ current, tasks, onPick }: {
  current: UnifiedTask
  tasks: UnifiedTask[]
  onPick: (task: UnifiedTask) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = tasks.filter((t) => t.id !== current.id)
    const filtered = q
      ? pool.filter((t) =>
          t.title.toLowerCase().includes(q) ||
          (t.metadata.identifier || '').toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q),
        )
      : pool
    return filtered.slice(0, 8)
  }, [tasks, current.id, query])
  return (
    <div className="sw-task-switcher" style={{ position: 'relative', marginLeft: 'auto', marginRight: 8 }}>
      <input
        ref={inputRef}
        type="text"
        className="sw-dispatch-modal-search-input"
        placeholder={`Switch task (${tasks.length - 1} open)`}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) {
            e.preventDefault()
            onPick(results[0])
            setQuery('')
            setOpen(false)
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
        style={{ width: 220, fontSize: 12 }}
      />
      {open && results.length > 0 && (
        <div className="sw-task-detail-repo-suggest" style={{ width: 360, maxHeight: 320, overflowY: 'auto' }}>
          {results.map((t) => (
            <button
              key={t.id}
              type="button"
              className="sw-task-detail-repo-suggest-item"
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(t)
                setQuery('')
                setOpen(false)
              }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '6px 10px' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {t.metadata.identifier && (
                  <span className="sw-queue-badge" style={{ fontSize: 10 }}>{t.metadata.identifier}</span>
                )}
                {t.priority && (
                  <span className={`sw-queue-priority-label ${t.priority === 'urgent' ? 'urgent' : t.priority === 'high' ? 'high' : 'medium'}`} style={{ fontSize: 10 }}>
                    {t.priority.toUpperCase()}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 12, fontWeight: 500 }}>{t.title.slice(0, 70)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TaskDetailModal({ task, tasks, onClose, onBack, onDispatch, onTaskSwitch, requireCloudRepo = false }: {
  task: UnifiedTask
  // Sibling tasks for the in-header switcher. When provided, the modal
  // shows a search input that filters these and lets the user jump to
  // another task without closing the modal.
  tasks?: UnifiedTask[]
  onClose: () => void
  // When provided, renders a "Back" button in the header that returns
  // the user to wherever they came from (e.g. DispatchModal list). No
  // button is rendered when the modal is opened directly from a queue
  // card — in that case there's no "back" to go to.
  onBack?: () => void
  onDispatch: (args: {
    agent: string
    target: 'local' | 'cloud'
    cloudProvider: CloudProviderId
    branch: string
    codexEnv: string
    targetRepos: string[]
    extraComments: string
    notify: { onQuestion: boolean; onFinish: boolean; channel: string }
  }) => void
  onTaskSwitch?: (task: UnifiedTask) => void
  requireCloudRepo?: boolean
}) {
  const prefs = useRef<DispatchPrefs>(loadDispatchPrefs())
  // Resolve per-task-type overrides at mount so e.g. `docs` tasks default
  // to Codex while `engineering` tasks default to Claude, without the
  // two bleeding into each other. Falls back to global defaults when the
  // task's type has never been dispatched before.
  const seed = useMemo(() => prefsForTask(prefs.current, task), [task])
  const typeKey = useMemo(() => taskTypeKey(task), [task])
  const [agent, setAgent] = useState(seed.lastAgent)
  const [target, setTarget] = useState<'local' | 'cloud'>(seed.lastTarget)
  const [cloudProvider, setCloudProvider] = useState<CloudProviderId>(seed.lastCloudProvider)
  const [branch, setBranch] = useState('')
  const [codexEnv, setCodexEnv] = useState(prefs.current.lastCodexEnv)
  const [extraComments, setExtraComments] = useState('')
  const [notifyOnQuestion, setNotifyOnQuestion] = useState(prefs.current.notifyOnQuestion)
  const [notifyOnFinish, setNotifyOnFinish] = useState(prefs.current.notifyOnFinish)
  const [notifyChannel, setNotifyChannel] = useState(prefs.current.notifyChannel)

  // Seed selected repos from Linear `repo:<name>` labels. Repo picker lets
  // user add/remove; suggestions come from `gh repo list <owner>`.
  const initialRepos = useMemo(() => {
    const labelRepos = (task.metadata.labels || []).filter((l) => l.startsWith('repo:')).map((l) => l.slice(5))
    return labelRepos
  }, [task.metadata.labels])
  const [selectedRepos, setSelectedRepos] = useState<string[]>(initialRepos)
  const [repoOwner, setRepoOwner] = useState<string>('')
  const [availableRepos, setAvailableRepos] = useState<string[]>([])
  const [repoInput, setRepoInput] = useState('')
  const [repoSuggestOpen, setRepoSuggestOpen] = useState(false)
  const [branchSuggestOpen, setBranchSuggestOpen] = useState(false)
  // Branches keyed by repo — cached per-modal-open so switching back to a
  // repo that was already fetched is instant. Includes the repo's default
  // branch so the UI can mark it.
  const [branchesByRepo, setBranchesByRepo] = useState<Record<string, { branches: string[]; defaultBranch: string }>>({})

  useEffect(() => {
    postMessage({ type: 'fetchGithubRepos' })
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'githubReposList') {
        setRepoOwner(typeof msg.owner === 'string' ? msg.owner : '')
        setAvailableRepos(Array.isArray(msg.repos) ? msg.repos : [])
      }
      if (msg.type === 'githubBranchesList') {
        const repo = typeof msg.repo === 'string' ? msg.repo : ''
        const branches: string[] = Array.isArray(msg.branches) ? msg.branches : []
        const defaultBranch: string = typeof msg.defaultBranch === 'string' ? msg.defaultBranch : ''
        if (repo) setBranchesByRepo((prev) => ({ ...prev, [repo]: { branches, defaultBranch } }))
      }
    }
    window.addEventListener('message', onMsg)
    return () => {
      window.removeEventListener('message', onMsg)
    }
  }, [onClose])

  // When exactly one repo is selected, fetch its branches (cached).
  // Multi-repo dispatch (Rush Cloud) passes a single --branch applied to all
  // clones — we still let the user type, but don't fetch suggestions because
  // branches differ per repo.
  useEffect(() => {
    if (selectedRepos.length !== 1) return
    const repo = selectedRepos[0]
    if (!repo) return
    if (branchesByRepo[repo]) return
    postMessage({ type: 'fetchGithubBranches', repo })
  }, [selectedRepos, branchesByRepo])

  // Persist selections on EVERY change so that closing the modal without
  // clicking Dispatch still remembers what the user picked. Previously we
  // only saved inside handleDispatch, which meant a half-configured modal
  // dismissed via Cancel/Escape would lose the user's choices on reopen.
  useEffect(() => {
    const byTaskType = { ...(prefs.current.byTaskType || {}) }
    // Persist the routing triple (agent/target/cloudProvider) under the
    // current task's type bucket so next time a task of the same type
    // opens, those are the seeded defaults. Notify/codexEnv stay global
    // because they're user-preference, not task-class.
    byTaskType[typeKey] = {
      lastAgent: agent,
      lastTarget: target,
      lastCloudProvider: cloudProvider,
    }
    const next: DispatchPrefs = {
      lastAgent: agent,
      lastTarget: target,
      lastCloudProvider: cloudProvider,
      notifyOnQuestion,
      notifyOnFinish,
      notifyChannel,
      lastCodexEnv: codexEnv,
      recentRepos: prefs.current.recentRepos,
      byTaskType,
    }
    saveDispatchPrefs(next)
    prefs.current = next
  }, [agent, target, cloudProvider, notifyOnQuestion, notifyOnFinish, notifyChannel, codexEnv, typeKey])

  // Re-seed state when the displayed task changes (via TaskSwitcher).
  // Without this, switching from a `docs` task to an `engineering` task
  // would keep the docs task's agent/target selection.
  const lastTypeKeyRef = useRef(typeKey)
  useEffect(() => {
    if (lastTypeKeyRef.current === typeKey) return
    lastTypeKeyRef.current = typeKey
    const override = prefs.current.byTaskType?.[typeKey]
    if (!override) return
    if (override.lastAgent) setAgent(override.lastAgent)
    if (override.lastTarget) setTarget(override.lastTarget)
    if (override.lastCloudProvider) setCloudProvider(override.lastCloudProvider)
  }, [typeKey])

  const singleRepo = selectedRepos.length === 1 ? selectedRepos[0] : ''
  const branchInfo = singleRepo ? branchesByRepo[singleRepo] : undefined
  const branchesForRepo = branchInfo?.branches || []
  const defaultBranch = branchInfo?.defaultBranch || ''
  const branchSuggestions = useMemo(() => {
    const q = branch.trim().toLowerCase()
    const matches = branchesForRepo.filter((b) => !q || b.toLowerCase().includes(q))
    // Pin the default branch to the top if it passes the filter.
    if (defaultBranch && matches.includes(defaultBranch)) {
      const rest = matches.filter((b) => b !== defaultBranch)
      return [defaultBranch, ...rest].slice(0, 8)
    }
    return matches.slice(0, 8)
  }, [branchesForRepo, branch, defaultBranch])

  const addRepo = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    // Accept bare name (suffix owner/) or owner/name
    const full = trimmed.includes('/') ? trimmed : (repoOwner ? `${repoOwner}/${trimmed}` : trimmed)
    if (selectedRepos.includes(full)) return
    setSelectedRepos((prev) => [...prev, full])
    setRepoInput('')
    setRepoSuggestOpen(false)
  }

  const removeRepo = (name: string) => {
    setSelectedRepos((prev) => prev.filter((r) => r !== name))
  }

  const repoSuggestions = useMemo(() => {
    const q = repoInput.trim().toLowerCase()
    const recent = prefs.current.recentRepos.filter((r) =>
      !selectedRepos.includes(r) && (!q || r.toLowerCase().includes(q))
    )
    const rest = availableRepos.filter((r) =>
      !selectedRepos.includes(r) && !recent.includes(r) && (!q || r.toLowerCase().includes(q))
    )
    // Recently-used repos first (up to 3), then the rest from gh repo list.
    // Mark recents so the UI can style/label them; cap total at 8.
    const out: { repo: string; recent: boolean }[] = []
    for (const r of recent.slice(0, 3)) out.push({ repo: r, recent: true })
    for (const r of rest) {
      if (out.length >= 8) break
      out.push({ repo: r, recent: false })
    }
    return out
  }, [availableRepos, selectedRepos, repoInput])

  const runTarget: 'local' | 'rush' | 'codex' = target === 'local' ? 'local' : cloudProvider === 'codex' ? 'codex' : 'rush'

  const modelsForTarget: Array<{ id: string; label: string }> = (() => {
    if (runTarget === 'local') return [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
    ]
    if (runTarget === 'rush') return [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
    ]
    return [{ id: 'codex', label: 'Codex' }]
  })()

  useEffect(() => {
    if (!modelsForTarget.some((m) => m.id === agent)) {
      const firstModel = modelsForTarget[0]
      if (firstModel) setAgent(firstModel.id)
    }
  }, [runTarget, agent, modelsForTarget])

  const priorityCls = task.priority === 'urgent' ? 'urgent' : task.priority === 'high' ? 'high' : 'medium'
  const priorityLabel = task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : 'Medium'

  const createdAt = (task as UnifiedTask & { createdAt?: string }).createdAt
  const createdRel = createdAt ? relTime(createdAt) : null

  // Show the task switcher only when there are sibling tasks to jump to.
  const switcherEnabled = !!onTaskSwitch && !!tasks && tasks.length > 1

  const hasCloudRepo = runTarget === 'local' || selectedRepos.length > 0 || (!requireCloudRepo && (runTarget === 'rush' || runTarget === 'codex'))
  const canDispatch = (runTarget !== 'codex' || codexEnv.trim().length > 0) && hasCloudRepo

  const handleDispatch = () => {
    // All other prefs are already persisted by the on-change effect above.
    // Dispatch only needs to bump the MRU repo list, which is the only
    // thing that should change on an actual dispatch (vs idle selection).
    const next: DispatchPrefs = {
      ...prefs.current,
      recentRepos: bumpRecentRepos(prefs.current.recentRepos, selectedRepos),
    }
    saveDispatchPrefs(next)
    prefs.current = next
    onDispatch({
      agent,
      target,
      cloudProvider,
      branch: branch.trim(),
      codexEnv: codexEnv.trim(),
      targetRepos: selectedRepos,
      extraComments: extraComments.trim(),
      notify: { onQuestion: notifyOnQuestion, onFinish: notifyOnFinish, channel: notifyChannel },
    })
  }

  return (
    <Modal className="sw-dispatch-modal-overlay" onClose={onClose} aria-label="Task details">
      <div className="sw-task-detail-modal">
        <div className="sw-task-detail-head">
          <div className="sw-task-detail-head-top">
            {onBack && (
              <button
                type="button"
                className="sw-btn ghost sm"
                onClick={onBack}
                title="Back to dispatch list"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 6 }}
              >
                <span aria-hidden="true">&larr;</span>
                <span>Back</span>
              </button>
            )}
            <span className={`sw-queue-priority-led ${priorityCls}`} />
            {task.metadata.identifier && (
              <span className="sw-queue-badge">{task.metadata.identifier}</span>
            )}
            <span className={`sw-queue-priority-label ${priorityCls}`}>{priorityLabel}</span>
            <span className="sw-task-detail-meta">
              {task.source}{createdRel ? ` - created ${createdRel}` : ''}
            </span>
            {switcherEnabled && (
              <TaskSwitcher
                current={task}
                tasks={tasks || []}
                onPick={(t) => onTaskSwitch?.(t)}
              />
            )}
            <button className="sw-dispatch-modal-close" onClick={onClose} aria-label="Close">
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="sw-task-detail-title">{task.title}</div>
        </div>

        <div className="sw-task-detail-body">
          {task.description ? (
            <div className="sw-task-detail-desc">
              {renderTodoDescription(task.description, false)}
            </div>
          ) : (
            <div className="sw-task-detail-desc sw-task-detail-desc-empty">No description.</div>
          )}
        </div>

        <div className="sw-task-detail-form">
          <div className="sw-task-detail-row sw-task-detail-row-notes">
            <label className="sw-task-detail-label">Comments</label>
            <textarea
              className="sw-task-detail-input sw-task-detail-textarea"
              placeholder="Context, constraints, handoff notes"
              value={extraComments}
              onChange={(e) => setExtraComments(e.target.value)}
              rows={3}
            />
          </div>

          <div className="sw-task-detail-row">
            <label className="sw-task-detail-label">Run on</label>
            <div className="sw-task-detail-seg">
              <button
                type="button"
                className={`sw-task-detail-seg-btn ${target === 'local' ? 'active' : ''}`}
                onClick={() => setTarget('local')}
              >Local</button>
              <button
                type="button"
                className={`sw-task-detail-seg-btn ${target === 'cloud' && cloudProvider === 'rush' ? 'active' : ''}`}
                onClick={() => { setTarget('cloud'); setCloudProvider('rush') }}
              >Rush Cloud</button>
              <button
                type="button"
                className={`sw-task-detail-seg-btn ${target === 'cloud' && cloudProvider === 'codex' ? 'active' : ''}`}
                onClick={() => { setTarget('cloud'); setCloudProvider('codex') }}
              >Codex Cloud</button>
            </div>
          </div>

          <div className="sw-task-detail-row">
            <label className="sw-task-detail-label">Model</label>
            <div className="sw-task-detail-seg">
              {modelsForTarget.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`sw-task-detail-seg-btn ${agent === m.id ? 'active' : ''}`}
                  onClick={() => setAgent(m.id)}
                >{m.label}</button>
              ))}
            </div>
          </div>

          {runTarget !== 'local' && (
            <div className="sw-task-detail-row sw-task-detail-row-repos">
              <label className="sw-task-detail-label">
                {runTarget === 'rush' ? 'Repositories' : 'Repository'}
              </label>
              <div className="sw-task-detail-repos-picker">
                <div className="sw-task-detail-repo-chips">
                  {selectedRepos.map((r) => (
                    <span key={r} className="sw-task-detail-repo-chip">
                      {r}
                      <button
                        type="button"
                        className="sw-task-detail-repo-chip-x"
                        onClick={() => removeRepo(r)}
                        aria-label={`Remove ${r}`}
                      >
                        <Icon name="x" size={10} />
                      </button>
                    </span>
                  ))}
                  {selectedRepos.length === 0 && (
                    <span className="sw-task-detail-hint">
                      {runTarget === 'rush' ? 'Add one or more repos' : 'Add a repo'}
                    </span>
                  )}
                </div>
                <div className="sw-task-detail-repo-input-wrap">
                  <input
                    type="text"
                    className="sw-task-detail-input"
                    placeholder={repoOwner ? `${repoOwner}/repo or paste owner/repo` : 'owner/repo'}
                    value={repoInput}
                    onChange={(e) => { setRepoInput(e.target.value); setRepoSuggestOpen(true) }}
                    onFocus={() => setRepoSuggestOpen(true)}
                    onBlur={() => setTimeout(() => setRepoSuggestOpen(false), 150)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && repoInput.trim()) {
                        e.preventDefault()
                        addRepo(repoInput)
                      }
                      if (runTarget === 'codex' && selectedRepos.length >= 1) {
                        // Codex Cloud rejects multi-repo — block typing more.
                        e.preventDefault()
                      }
                    }}
                    disabled={runTarget === 'codex' && selectedRepos.length >= 1}
                  />
                  {repoSuggestOpen && repoSuggestions.length > 0 && (
                    <div className="sw-task-detail-repo-suggest">
                      {repoSuggestions.map(({ repo, recent }) => (
                        <button
                          key={repo}
                          type="button"
                          className={`sw-task-detail-repo-suggest-item ${recent ? 'recent' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); addRepo(repo) }}
                        >
                          <span className="sw-task-detail-repo-suggest-name">{repo}</span>
                          {recent && <span className="sw-task-detail-repo-suggest-badge">Recent</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {runTarget === 'codex' && (
                  <div className="sw-task-detail-hint">Codex Cloud: one repo per task (env bundles multi-repo).</div>
                )}
              </div>
            </div>
          )}

          {runTarget === 'codex' && (
            <div className="sw-task-detail-row">
              <label className="sw-task-detail-label">Codex env</label>
              <input
                type="text"
                className="sw-task-detail-input"
                placeholder="env_abc123"
                value={codexEnv}
                onChange={(e) => setCodexEnv(e.target.value)}
              />
            </div>
          )}

          {runTarget !== 'local' && (
            <div className="sw-task-detail-row">
              <label className="sw-task-detail-label">Branch</label>
              <div className="sw-task-detail-repo-input-wrap">
                <input
                  type="text"
                  className="sw-task-detail-input"
                  placeholder={
                    selectedRepos.length > 1
                      ? 'main (applied to all repos)'
                      : defaultBranch
                        ? `${defaultBranch} (default)`
                        : 'main (default)'
                  }
                  value={branch}
                  onChange={(e) => { setBranch(e.target.value); setBranchSuggestOpen(true) }}
                  onFocus={() => setBranchSuggestOpen(true)}
                  onBlur={() => setTimeout(() => setBranchSuggestOpen(false), 150)}
                />
                {branchSuggestOpen && branchSuggestions.length > 0 && (
                  <div className="sw-task-detail-repo-suggest">
                    {branchSuggestions.map((b) => {
                      const isDefault = b === defaultBranch
                      return (
                        <button
                          key={b}
                          type="button"
                          className={`sw-task-detail-repo-suggest-item ${isDefault ? 'recent' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); setBranch(b); setBranchSuggestOpen(false) }}
                        >
                          <span className="sw-task-detail-repo-suggest-name">{b}</span>
                          {isDefault && <span className="sw-task-detail-repo-suggest-badge">Default</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
                {selectedRepos.length > 1 && (
                  <div className="sw-task-detail-hint">One branch applies to every selected repo.</div>
                )}
              </div>
            </div>
          )}

          <div className="sw-task-detail-row sw-task-detail-row-notify">
            <label className="sw-task-detail-label">Notify me</label>
            <div className="sw-task-detail-notify">
              <label className="sw-task-detail-check">
                <input
                  type="checkbox"
                  checked={notifyOnQuestion}
                  onChange={(e) => setNotifyOnQuestion(e.target.checked)}
                />
                <span>When it asks a question</span>
              </label>
              <label className="sw-task-detail-check">
                <input
                  type="checkbox"
                  checked={notifyOnFinish}
                  onChange={(e) => setNotifyOnFinish(e.target.checked)}
                />
                <span>When it finishes</span>
              </label>
              <div className="sw-task-detail-channel">
                <span className="sw-task-detail-hint">Channel</span>
                <select
                  className="sw-task-detail-input sw-task-detail-select"
                  value={notifyChannel}
                  onChange={(e) => setNotifyChannel(e.target.value)}
                  disabled={!notifyOnQuestion && !notifyOnFinish}
                >
                  <option value="ios">iOS push</option>
                  <option value="email">Email</option>
                  <option value="linear">Linear comment</option>
                  <option value="none">None</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="sw-task-detail-foot">
          <button className="sw-btn secondary" onClick={onClose}>Cancel</button>
          <button className="sw-btn-dispatch" onClick={handleDispatch} disabled={!canDispatch}>
            Dispatch
          </button>
        </div>
      </div>
    </Modal>
  )
}
