import React, { useEffect, useMemo, useState } from 'react'
import { Icon, TaskDetailModal } from '../mission-control'
import { postMessage } from '../../hooks'
import { TaskCard } from './TaskCard'
import { TaskDetail } from './TaskDetail'
import { CycleBar } from './CycleBar'
import { KanbanBoard } from './KanbanBoard'
import { DeadlineView } from './DeadlineView'
import type { FlatTask } from './TaskCard'
import type { CloudProviderId } from '../mission-control'
import { filterTasks, sortTasks, type TaskSortOption } from '../mission-control/listFilter'
import type {
  AgentSettings,
  ContextFile,
  CycleInfo,
  IconConfig,
  TaskSource,
  UnifiedTask,
  WorkspaceConfig,
} from '../../types'

interface BenchTabProps {
  unifiedTasks: UnifiedTask[]
  cycleInfo: CycleInfo | null
  unifiedTasksLoading: boolean
  expandedSources: Set<TaskSource>
  availableSources: { linear: boolean; github: boolean }
  settings: AgentSettings | null
  defaultAgent: string
  contextFiles: ContextFile[]
  contextLoading: boolean
  collapsedDirs: Set<string>
  workspaceConfig: WorkspaceConfig | null
  workspaceConfigLoaded: boolean
  workspaceConfigExists: boolean
  workspacePath: string | null
  githubRepo: string | null
  dismissedTaskIds: Set<string>
  icons: IconConfig
  isLightTheme: boolean
  onToggleSource: (source: TaskSource) => void
  onRefreshTasks: () => void
  onRefreshContext: () => void
  onUpdateTaskSources: (sources: Partial<any>) => void
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => void
  onInitWorkspaceConfig: () => void
  onSaveWorkspaceConfig: (config: WorkspaceConfig) => void
  onDismissTask: (taskId: string) => void
  onConnectLinear: () => void
  onConnectGitHub: () => void
  /** When set, BenchTab selects that task and clears it via onOpenBenchTaskConsumed. */
  openBenchTaskId?: string | null
  onOpenBenchTaskConsumed?: () => void
}

const SOURCE_FILTERS: Array<{ key: TaskSource; label: string; cls: string }> = [
  { key: 'linear', label: 'LN', cls: 'ln' },
  { key: 'github', label: 'GH', cls: 'gh' },
]

type BenchView = 'list' | 'kanban' | 'deadline'

const BENCH_VIEWS: Array<{ key: BenchView; label: string }> = [
  { key: 'list', label: 'List' },
  { key: 'kanban', label: 'Board' },
  { key: 'deadline', label: 'Deadline' },
]

export function BenchTab(props: BenchTabProps) {
  const {
    unifiedTasks,
    cycleInfo,
    unifiedTasksLoading,
    settings,
    dismissedTaskIds,
    githubRepo,
    availableSources,
    onRefreshTasks,
    onDismissTask,
    openBenchTaskId,
    onOpenBenchTaskConsumed,
  } = props

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [dispatchTask, setDispatchTask] = useState<UnifiedTask | null>(null)
  const [activeFilters, setActiveFilters] = useState<Set<TaskSource>>(
    new Set(['linear', 'github'])
  )
  const [repoFilter, setRepoFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<TaskSortOption>('priority')
  const [view, setView] = useState<BenchView>('list')

  const toggleFilter = (source: TaskSource) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
  }

  const allRepos = useMemo(() => {
    const repos = new Set<string>()
    for (const t of unifiedTasks) {
      if (t.metadata.repo) repos.add(t.metadata.repo)
    }
    return Array.from(repos).sort()
  }, [unifiedTasks])

  const workspaceRepoName = useMemo(() => {
    if (!githubRepo) return null
    return githubRepo.includes('/') ? githubRepo.split('/').pop()! : githubRepo
  }, [githubRepo])

  useEffect(() => {
    if (workspaceRepoName && allRepos.includes(workspaceRepoName) && repoFilter === 'all') {
      setRepoFilter(workspaceRepoName)
    }
  }, [workspaceRepoName, allRepos, repoFilter])

  const flatTasks = useMemo<FlatTask[]>(() => {
    const filteredUnified = unifiedTasks.filter(task => !dismissedTaskIds.has(task.id))
    return sortTasks(filteredUnified, sortBy).map(task => ({
      id: task.id,
      source: task.source,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      metadata: task.metadata,
    }))
  }, [unifiedTasks, dismissedTaskIds, sortBy])

  const filteredTasks = useMemo(
    () => filterTasks(flatTasks, { activeSources: activeFilters, repoFilter }),
    [flatTasks, activeFilters, repoFilter]
  )

  const dispatchSiblings = useMemo(() => {
    const ids = new Set(filteredTasks.map(t => t.id))
    return unifiedTasks.filter(t => ids.has(t.id))
  }, [filteredTasks, unifiedTasks])

  const selectedTask = useMemo(
    () => filteredTasks.find(t => t.id === selectedTaskId) ?? null,
    [filteredTasks, selectedTaskId]
  )

  useEffect(() => {
    if (filteredTasks.length === 0) return
    if (selectedTaskId && filteredTasks.some(t => t.id === selectedTaskId)) return
    setSelectedTaskId(filteredTasks[0].id)
  }, [filteredTasks, selectedTaskId])

  // Honor floor-jump requests: when the floor sends a task id, select it
  // (clearing any active source/repo filters that would hide it) and ack.
  useEffect(() => {
    if (!openBenchTaskId) return
    const task = flatTasks.find(t => t.id === openBenchTaskId)
    if (!task) {
      onOpenBenchTaskConsumed?.()
      return
    }
    if (!activeFilters.has(task.source)) {
      setActiveFilters(prev => new Set(prev).add(task.source))
    }
    if (repoFilter !== 'all' && task.metadata.repo !== repoFilter) {
      setRepoFilter('all')
    }
    setView('list')
    setSelectedTaskId(openBenchTaskId)
    onOpenBenchTaskConsumed?.()
  }, [openBenchTaskId, flatTasks, activeFilters, repoFilter, onOpenBenchTaskConsumed])

  const handleDispatch = (task: FlatTask) => {
    const source = unifiedTasks.find(t => t.id === task.id)
    if (source) setDispatchTask(source)
  }

  const handleConfiguredDispatch = (args: {
    agent: string
    target: 'local' | 'cloud'
    cloudProvider: CloudProviderId
    branch: string
    codexEnv: string
    targetRepos: string[]
    extraComments: string
    notify: { onQuestion: boolean; onFinish: boolean; channel: string }
  }) => {
    if (!dispatchTask) return
    postMessage({
      type: 'dispatchTask',
      taskId: dispatchTask.id,
      agentType: args.agent,
      target: args.target,
      cloudProvider: args.cloudProvider,
      title: dispatchTask.title,
      description: dispatchTask.description || '',
      identifier: dispatchTask.metadata.identifier || '',
      url: dispatchTask.metadata.url || '',
      labels: dispatchTask.metadata.labels || [],
      targetRepos: args.targetRepos,
      branch: args.branch,
      codexEnv: args.codexEnv,
      extraComments: args.extraComments,
      notify: args.notify,
    })
    setDispatchTask(null)
  }

  const handleDismiss = (taskId: string) => {
    onDismissTask(taskId)
    if (selectedTaskId === taskId) setSelectedTaskId(null)
  }

  const handleOpenExternal = (url: string) => {
    postMessage({ type: 'openExternal', url })
  }

  const isLoading = unifiedTasksLoading

  const emptyState = (
    <div className="sw-empty">
      <span className="sw-empty-title">Work queue empty</span>
      <span className="sw-empty-sub">
        {availableSources.linear || availableSources.github
          ? 'No tasks in view. Either the active cycle is empty, your filters are hiding everything, or the source returned an error — check the extension Output panel for details.'
          : 'Connect Linear or GitHub to see tasks here.'}
      </span>
    </div>
  )

  return (
    <>
      <div className="sw-bench-wrap">
        <div className="sw-bench-toolbar">
          <span className="sw-section-label">Work Queue</span>
          <span className="sw-section-count">{filteredTasks.length}</span>
          <div className="sw-active-filter sw-bench-view-switch" role="tablist" aria-label="Bench view">
            {BENCH_VIEWS.map(v => (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                className={`sw-active-filter-btn ${view === v.key ? 'active' : ''}`}
                onClick={() => setView(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="sw-bench-list-filters">
            {SOURCE_FILTERS.map(f => (
              <button
                key={f.key}
                className={`sw-source-chip ${f.cls}${activeFilters.has(f.key) ? ' active' : ''}`}
                onClick={() => toggleFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {allRepos.length >= 2 && (
            <select
              className="sw-bench-filter-select mono"
              value={repoFilter}
              onChange={e => setRepoFilter(e.target.value)}
              title="Filter by repo"
            >
              <option value="all">All repos</option>
              {allRepos.map(r => (
                <option key={r} value={r}>
                  {r}{r === workspaceRepoName ? ' (this)' : ''}
                </option>
              ))}
            </select>
          )}
          {view !== 'kanban' && (
            <select
              className="sw-bench-filter-select"
              value={sortBy}
              onChange={e => setSortBy(e.target.value as TaskSortOption)}
              title="Sort tasks"
            >
              <option value="priority">Priority</option>
              <option value="due">Due date</option>
              <option value="priority+due">Priority, then due</option>
            </select>
          )}
          <span className="sw-section-line" />
          <button
            className="sw-icon-btn"
            onClick={onRefreshTasks}
            disabled={isLoading}
            title="Refresh tasks"
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>

        {view === 'list' && (
          <div className="sw-bench">
            <div className="sw-bench-list">
              {cycleInfo && <CycleBar cycleInfo={cycleInfo} />}
              <div className="sw-bench-list-body">
                {isLoading && filteredTasks.length === 0 ? (
                  <div className="sw-empty">
                    <span className="sw-empty-title">Loading tasks...</span>
                  </div>
                ) : filteredTasks.length === 0 ? (
                  emptyState
                ) : (
                  filteredTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      selected={task.id === selectedTaskId}
                      onClick={() => setSelectedTaskId(task.id)}
                    />
                  ))
                )}
              </div>
            </div>

            <div className="sw-bench-detail">
              {selectedTask ? (
                <TaskDetail
                  task={selectedTask}
                  cycleInfo={cycleInfo}
                  onDispatch={handleDispatch}
                  onDismiss={handleDismiss}
                  onOpenExternal={handleOpenExternal}
                />
              ) : (
                <div className="sw-empty" style={{ flex: 1 }}>
                  <Icon name="inbox" size={32} style={{ color: 'var(--ds-text-faint)' }} />
                  <span className="sw-empty-title">Select a task to see details</span>
                  <span className="sw-empty-sub">
                    Click a task in the work queue to view its full description, metadata, and actions.
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {view === 'kanban' && (
          filteredTasks.length === 0 ? emptyState : (
            <KanbanBoard
              tasks={filteredTasks}
              selectedTaskId={selectedTaskId}
              onOpen={handleDispatch}
            />
          )
        )}

        {view === 'deadline' && (
          filteredTasks.length === 0 ? emptyState : (
            <DeadlineView tasks={filteredTasks} onOpen={handleDispatch} />
          )
        )}
      </div>
      {dispatchTask && (
        <TaskDetailModal
          task={dispatchTask}
          tasks={dispatchSiblings.length > 1 ? dispatchSiblings : undefined}
          onClose={() => setDispatchTask(null)}
          onTaskSwitch={setDispatchTask}
          onDispatch={handleConfiguredDispatch}
          requireCloudRepo
        />
      )}
    </>
  )
}
