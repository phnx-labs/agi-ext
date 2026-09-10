import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskSummary, TerminalDetail as TerminalInfo, AgentDetail, UnifiedTask, RecentToolCall, ProjectRule } from '../../types'
import { AgentAvatar, agentIdFromPrefix } from './AgentAvatar'
import { Icon } from './icons'
import { relTime, taskNameToTitle, swarmOverallStatus, shortDuration } from './types'
import { postMessage, usePanelVisibility } from '../../hooks'
import { ExtLink } from '../common'
import { CMD_PALETTE_EVENTS } from './CommandPalette'
import { useNow } from './useNow'
import {
  isTerminalActive,
  isTerminalJustSpawned,
  reconcilePending,
  pruneExpiredPending,
  markTimedOutPending,
  markCloudFailedPending,
  filterDispatchedTaskIds,
  optimisticActivityLabel,
  PENDING_DISPATCH_TTL_MS,
  type PendingDispatch,
} from './dispatch'
import { FloorControls, floorControlsMode, type StatusChip } from './FloorControls'
import { FLOOR_SIDEBAR_DEFAULT_WIDTH, FLOOR_SIDEBAR_MAX_WIDTH, FLOOR_SIDEBAR_MIN_WIDTH } from './FloorSidebar'
import { FloorSubtabs, openTaskTab, closeTaskTab, type TaskTab } from './FloorSubtabs'
import { TaskDetail } from '../bench/TaskDetail'
import type { FlatTask } from '../bench/TaskCard'
import { TicketDetail } from './TicketDetail'
import { AttentionReceipt, FeedItem } from './FeedItem'
import { SessionsPane } from './SessionsPane'
import { NeedsYouClusters } from './NeedsYouClusters'
import {
  clusterByQuestion,
  sortAgents,
  sortByAttention,
  groupAgents,
  partitionFloorAgents,
  isPrevious,
  mergeSessionAgents,
  visibleFloorAgents,
  type FloorAgent,
  type FloorAttachment,
  type FloorTicket,
  type CenterMode,
  type FloorGroupBy,
  type FloorSort,
  type TicketGroupBy,
  type TicketSort,
  type TicketSource,
  type AgentAbbr,
  type CiStatus,
  type ManagedProject,
  linearIssueLabel,
  linearIssueUrl,
} from './floorModel'
import { postTerminalOpenForAgent, previousResumeMessage } from './sessions/sessionActions'
import { SavedViews } from './SavedViewsBar'
import { loadSavedViews, persistSavedViews, upsertView, removeView, viewMatches, type SavedView } from './savedViews'
import { composeFloorAgents, adaptRemote, sinceFromMs, type RemoteSessionLike } from './floorAdapter'
import type { PlanFile } from '../../utils/planDetector'
import {
  DispatchPanel,
  type DispatchDevice,
  type DispatchDeviceRepo,
  type DispatchDeviceSync,
  type DeviceDispatchRequest,
  type DraftResult,
  type DraftTicketPayload,
} from './DispatchPanel'
import { PlanReview } from './PlanReview'
import { FailureCard } from './FailureCard'
import { ticketKey } from './dispatchInput'
import { useVirtualList, type VirtualListItem } from './useVirtualList'
import type {
  InstalledAgent, DispatchHost, DispatchTarget, DispatchRequest, PendingPlan, PlanStep,
} from './dispatch.types'
import { loadFloorPrefs, saveFloorPrefs, FLOOR_PREFS_LAYOUT_VERSION } from './floorPrefs'
export { defaultFloorPrefs, loadFloorPrefs, FLOOR_PREFS_LAYOUT_VERSION } from './floorPrefs'
export { TaskDetailModal } from './TaskDetailModal'
export type { CloudProviderId } from './dispatchPrefs'

export function registeredDevicesToDispatchDevices(devices: unknown[]): DispatchDevice[] {
  return devices.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const device = value as { name?: unknown; host?: unknown; online?: unknown }
    if (typeof device.name !== 'string' || !device.name) return []
    return [{
      name: device.name,
      host: typeof device.host === 'string' && device.host ? device.host : device.name,
      reachable: device.online !== false,
    }]
  })
}

// Floor session refresh is event-driven + manual — no recurring local/remote
// polling (issue #2030). Local tab agents stream via the extension's monitor /
// webview pushes; remote rows refresh when the operator clicks the freshness
// chip (or on the one-shot seed when the panel becomes visible).
import { REMOTE_STALE_MS, THROUGHPUT_TICK_MS } from './floorRefresh'

const NEW_AGENT_MENU: Array<{ agent: string; name: string; abbr: string; keys: string[] }> = [
  { agent: 'claude', name: 'Claude', abbr: 'CC', keys: ['Cmd', 'Shift', 'A'] },
  { agent: 'codex', name: 'Codex', abbr: 'CX', keys: ['Cmd', 'Shift', 'B'] },
  { agent: 'gemini', name: 'Gemini', abbr: 'GX', keys: ['Cmd', 'Shift', 'X'] },
  { agent: 'antigravity', name: 'Antigravity', abbr: 'AG', keys: [] },
  { agent: 'grok', name: 'Grok', abbr: 'GK', keys: [] },
  { agent: 'kimi', name: 'Kimi', abbr: 'KM', keys: [] },
  { agent: 'droid', name: 'Droid', abbr: 'DR', keys: [] },
  { agent: 'opencode', name: 'OpenCode', abbr: 'OC', keys: ['Cmd', 'Shift', 'M'] },
  { agent: 'cursor', name: 'Cursor', abbr: 'CR', keys: ['Cmd', 'Shift', 'U'] },
]

type FilterTab = 'all' | 'terminal' | 'cloud' | 'team'

type FactoryTaskType = 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs'

function compactHumanLabel(text: string | null | undefined): string {
  const line = (text || '').split('\n').map((l) => l.trim()).find(Boolean) || ''
  return line.replace(/^#+\s+/, '').replace(/^[-*+]\s+/, '').replace(/[*_`]/g, '').slice(0, 72).trim()
}

export interface WatchdogEventUI {
  ts: number
  kind: 'tick' | 'decision' | 'nudge' | 'rotate' | 'error'
  terminalId?: string
  agentType?: string
  message: string
  reason?: string
  tailLines?: string[]
  stalledForMs?: number
  lastUserMessage?: string
  lastAssistantMessage?: string
  nudgeText?: string
}

export interface UnifiedAgent {
  kind: 'terminal' | 'headless' | 'cloud' | 'team' | 'watchdog'
  id: string
  agentType: string
  displayName: string
  sessionId?: string
  activity: string
  active: boolean
  duration: string
  timestamp: string
  prUrl?: string | null
  ci?: CiStatus | null
  cloudProvider?: string | null
  terminal?: TerminalInfo
  swarm?: TaskSummary
  agent?: AgentDetail
  teamAgents?: AgentDetail[]
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'idle'
  files: string[]
  toolCalls: number
  linearIssue?: string | null
  mode?: string
  // AGI EXT metadata surfaced as badges in the UI
  taskType?: FactoryTaskType | null
  teammateName?: string | null
  /** For team rows, a roll-up count of task-types across members. */
  taskTypeCounts?: Partial<Record<FactoryTaskType, number>>
  // Watchdog-specific
  watchdogEvents?: WatchdogEventUI[]
}

function buildUnifiedList(terminals: TerminalInfo[], tasks: TaskSummary[]): UnifiedAgent[] {
  const items: UnifiedAgent[] = []

  const now = Date.now()
  for (const t of terminals) {
    const justSpawned = isTerminalJustSpawned(t.createdAt, now)
    const isActive = isTerminalActive(t, now)
    const files: string[] = []
    if (t.recentFiles) files.push(...t.recentFiles.slice(0, 5))
    // Prefer a human label (manual > auto) so a card reads "terminal-race-fix" rather
    // than "claude-596c4c07"; the full session id stays available on hover.
    const humanLabel = compactHumanLabel(t.label) || compactHumanLabel(t.autoLabel) || compactHumanLabel(t.firstUserMessage)
    items.push({
      kind: 'terminal',
      id: `term-${t.id}`,
      agentType: t.agentType,
      sessionId: t.sessionId ?? undefined,
      displayName: humanLabel || `${t.agentType} session`,
      activity: t.currentActivity || t.label || (justSpawned ? 'Starting...' : t.status === 'idle' ? 'idle' : t.role ?? 'terminal'),
      active: isActive,
      duration: t.firstMessageTimestamp ? relTime(t.firstMessageTimestamp) : '',
      timestamp: t.lastActivityTimestamp || new Date(t.createdAt).toISOString(),
      terminal: t,
      status: isActive ? 'running' : 'idle',
      files,
      toolCalls: t.quickSummary?.toolCalls ?? 0,
      mode: t.role || 'auto',
    })
  }

  for (const task of tasks) {
    const isTeam = task.agents.length > 1
    const isActive = task.status_counts.running > 0

    if (isTeam) {
      const status = swarmOverallStatus(task)
      const pr = task.agents.map((a) => a.pr_url).find(Boolean)
      const dur = task.agents.map((a) => a.duration).find(Boolean)
      const allFiles = task.agents.flatMap((a) => [...(a.files_created || []), ...(a.files_modified || [])]).slice(0, 6)
      const totalTools = task.agents.reduce((s, a) => s + (a.bash_commands?.length || 0), 0)
      const linear = task.agents.map((a) => a.linear_issue).find(Boolean)
      const taskTypeCounts: Partial<Record<FactoryTaskType, number>> = {}
      for (const a of task.agents) {
        const tt = a.task_type as FactoryTaskType | null | undefined
        if (tt) taskTypeCounts[tt] = (taskTypeCounts[tt] ?? 0) + 1
      }
      items.push({
        kind: 'team',
        id: `team-${task.task_name}`,
        agentType: task.agents[0]?.agent_type ?? 'claude',
        displayName: taskNameToTitle(task.task_name),
        activity: `${task.agent_count} agents`,
        active: isActive,
        duration: dur || '',
        timestamp: task.latest_activity,
        prUrl: pr,
        ci: task.agents.map((a) => a.ci_status).find((c) => c != null) ?? null,
        swarm: task,
        teamAgents: task.agents,
        status: status === 'merged' ? 'completed' : status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'idle',
        files: allFiles,
        toolCalls: totalTools,
        linearIssue: linear,
        taskTypeCounts,
      })
    } else if (task.agents.length === 1) {
      const a = task.agents[0]
      const isCloud = a.mode === 'cloud' || !!a.cloud_provider
      const lastCmd = a.bash_commands?.[a.bash_commands.length - 1]
      const lastFile = a.files_modified?.[a.files_modified.length - 1]
      const lastMsg = a.last_messages?.[a.last_messages.length - 1]
      const promptFirstLine = a.prompt?.split('\n')[0]?.slice(0, 120) || ''
      const activity = isCloud
        ? (promptFirstLine || 'cloud run')
        : (lastCmd ? `$ ${lastCmd}` : lastFile ? `Editing ${lastFile}` : lastMsg ? lastMsg.slice(0, 120) : promptFirstLine || 'working...')
      const allFiles = [...(a.files_created || []), ...(a.files_modified || [])].slice(0, 6)
      items.push({
        kind: isCloud ? 'cloud' : 'headless',
        id: `agent-${a.agent_id}`,
        agentType: a.agent_type,
        displayName: a.name?.trim() || promptFirstLine || taskNameToTitle(task.task_name),
        activity,
        active: a.status === 'running',
        duration: a.duration || '',
        timestamp: a.started_at,
        prUrl: a.pr_url,
        ci: a.ci_status ?? null,
        cloudProvider: a.cloud_provider,
        agent: a,
        swarm: task,
        status: a.status as UnifiedAgent['status'],
        files: allFiles,
        toolCalls: a.bash_commands?.length || 0,
        linearIssue: a.linear_issue,
        mode: a.mode,
        taskType: (a.task_type as FactoryTaskType | null | undefined) ?? null,
        teammateName: a.name ?? null,
      })
    }
  }

  items.sort((a, b) => {
    if (a.active && !b.active) return -1
    if (!a.active && b.active) return 1
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  })

  return items
}

function statusLabel(status: UnifiedAgent['status']): string {
  return status
}

// Throughput counter — data tick once per second; CSS transitions interpolate
// bar heights. No 140ms React state churn (issue #2030 / floor performance).
export function ThroughputCounter({ tokensPerSec }: { tokensPerSec: number }) {
  const BAR_COUNT = 24
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0))
  const [displayValue, setDisplayValue] = useState(tokensPerSec)
  const prefersReducedMotion = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    prefersReducedMotion.current = mq.matches
    const onChange = () => { prefersReducedMotion.current = mq.matches }
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => {
    if (tokensPerSec <= 0) {
      setBars(Array(BAR_COUNT).fill(0))
      setDisplayValue(0)
      return
    }

    const nextBar = () => {
      if (prefersReducedMotion.current) {
        return Math.max(2, Math.min(22, tokensPerSec / 70))
      }
      const variance = 0.5 + Math.random() * 1.0
      return Math.max(2, Math.min(22, (tokensPerSec * variance) / 70))
    }

    const tick = () => {
      setBars(prev => {
        const next = prev.slice(1)
        next.push(nextBar())
        return next
      })
      setDisplayValue(prev => {
        if (prefersReducedMotion.current) return Math.round(tokensPerSec)
        const target = tokensPerSec * (0.88 + Math.random() * 0.24)
        return Math.round(prev * 0.55 + target * 0.45)
      })
    }

    tick()
    const id = setInterval(tick, THROUGHPUT_TICK_MS)
    return () => clearInterval(id)
  }, [tokensPerSec])

  return (
    <div className="sw-throughput" title="LLM output tokens per second (estimated)" data-tick-ms={THROUGHPUT_TICK_MS}>
      <div className="sw-throughput-sparkline">
        {bars.map((h, i) => (
          <div key={i} className="sw-spark-bar" style={{ height: h }} />
        ))}
      </div>
      <div className="sw-throughput-value">{displayValue}</div>
      <div className="sw-throughput-unit">
        <span className="sw-throughput-label">tok/s</span>
        <span className="sw-throughput-sub">throughput</span>
      </div>
    </div>
  )
}

interface UnifiedAgentsPaneProps {
  terminals: TerminalInfo[]
  tasks: TaskSummary[]
  tasksLoading: boolean
  unifiedTasks: UnifiedTask[]
  unifiedTasksLoading: boolean
  onDispatch: () => void
  onNavigate?: (tab: 'floor' | 'bench' | 'panel') => void
  onOpenInBench?: (taskId: string) => void
  openDispatchTrigger?: number
  quickSpawnTrigger?: number
  openDetailTaskId?: string | null
  onDetailTaskConsumed?: () => void
  onThroughputChange?: (tokensPerSec: number) => void
  /** The single live-feed filter, lifted to App so the TopBar search drives it. */
  search: string
  onSearch: (q: string) => void
  githubRepo?: string | null
  watchdogEnabled?: boolean
  watchdogEvents?: WatchdogEventUI[]
  projectRules?: ProjectRule[]
  /** True while the follower has not yet observed a CLI stream reset. */
  sessionStreamDegraded?: boolean
}

// Preserve object identity for unchanged agents across renders so memoized
// AgentCards don't all re-render when one agent's data changes. An item's
// signature is a full JSON serialization, so identity is reused ONLY when every
// rendered field is byte-identical — stale data is impossible.
function useStableList(items: UnifiedAgent[]): UnifiedAgent[] {
  const prevRef = useRef<Map<string, { sig: string; item: UnifiedAgent }>>(new Map())
  return useMemo(() => {
    const next = new Map<string, { sig: string; item: UnifiedAgent }>()
    const out = items.map((item) => {
      const sig = JSON.stringify(item)
      const prev = prevRef.current.get(item.id)
      const stable = prev && prev.sig === sig ? prev.item : item
      next.set(item.id, { sig, item: stable })
      return stable
    })
    prevRef.current = next
    return out
  }, [items])
}

// Wrap a FeedItem so double-clicking the card opens it as a closeable task tab.
// display:contents keeps the parent grid layout intact — the span box vanishes and the
// card stays the real grid child — while still catching the dblclick that bubbles up.
function FeedRow({ onOpenTask, ...props }: React.ComponentProps<typeof FeedItem> & { onOpenTask: (a: FloorAgent) => void }) {
  return (
    <span style={{ display: 'contents' }} onDoubleClick={() => onOpenTask(props.agent)}>
      <FeedItem {...props} />
    </span>
  )
}

// ---------- Agents feed virtualization (PHNX-2458) ----------
// Reuses the same fixed-offset windowing primitive as SessionsPane. Rows are
// variable-height, so we measure rendered rows with ResizeObserver and fall back
// to type-specific estimates for rows that have not mounted yet.

const DEFAULT_ROW_H = 140
const DEFAULT_HEADER_H = 45
const DEFAULT_SAVED_VIEWS_H = 70
const DEFAULT_PLAN_REVIEW_H = 130
const DEFAULT_NEEDS_CLUSTER_H = 80
const DEFAULT_FAILURE_CARD_H = 120
const DEFAULT_ATTENTION_RECEIPT_H = 45
const DEFAULT_STATUS_H = 45
const DEFAULT_HOST_FRESHNESS_H = 35
const DEFAULT_RECENT_EMPTY_H = 45
const FEED_OVERSCAN = 6

/** CLI attention kinds that are an interactive hand-back the operator answers, so they
 *  render as a decision card (clustered) rather than a failure or a plain review row. */
const DECISION_KINDS: ReadonlySet<FloorAgent['attentionKind']> = new Set(['question', 'permission', 'plan_review', 'declared'])

type FeedVItem = VirtualListItem & (
  | { kind: 'savedViews'; height: number; key: 'savedViews' }
  | { kind: 'needsHeader'; count: number; height: number; key: 'needsHeader' }
  | { kind: 'planReview'; plan: PendingPlan; height: number; key: string }
  | { kind: 'needsCluster'; cluster: FloorAgent[]; height: number; key: string }
  | { kind: 'feedRow'; agent: FloorAgent; height: number; key: string }
  | { kind: 'failureCard'; agent: FloorAgent; height: number; key: string }
  | { kind: 'activityHeader'; count: number; height: number; key: 'activityHeader' }
  | { kind: 'attentionReceipt'; event: { type?: string; key?: string; state?: string; source?: string; question?: string | { text?: string } }; index: number; height: number; key: string }
  | { kind: 'idleHeader'; count: number; height: number; key: 'idleHeader' }
  | { kind: 'runningHeader'; count: number; grouped: boolean; height: number; key: 'runningHeader' }
  | { kind: 'groupHeader'; label: string; count: number; projectPill?: string; height: number; key: string }
  | { kind: 'subgroupHeader'; label: string; count: number; projectPill?: string; height: number; key: string }
  | { kind: 'statusMessage'; node: React.ReactNode; height: number; key: string }
  | { kind: 'hostFreshnessLine'; hosts: Array<[string, number]>; height: number; key: 'hostFreshnessLine' }
  | { kind: 'doneHeader'; count: number; height: number; key: 'doneHeader' }
  | { kind: 'recentHeader'; count: number; hostFilter: string | null; height: number; key: 'recentHeader' }
  | { kind: 'recentEmpty'; height: number; key: 'recentEmpty' }
)

function defaultHeight(kind: FeedVItem['kind']): number {
  switch (kind) {
    case 'savedViews': return DEFAULT_SAVED_VIEWS_H
    case 'needsHeader':
    case 'activityHeader':
    case 'idleHeader':
    case 'runningHeader':
    case 'doneHeader':
    case 'recentHeader':
    case 'groupHeader':
    case 'subgroupHeader':
      return DEFAULT_HEADER_H
    case 'planReview': return DEFAULT_PLAN_REVIEW_H
    case 'needsCluster': return DEFAULT_NEEDS_CLUSTER_H
    case 'failureCard': return DEFAULT_FAILURE_CARD_H
    case 'feedRow': return DEFAULT_ROW_H
    case 'attentionReceipt': return DEFAULT_ATTENTION_RECEIPT_H
    case 'statusMessage': return DEFAULT_STATUS_H
    case 'hostFreshnessLine': return DEFAULT_HOST_FRESHNESS_H
    case 'recentEmpty': return DEFAULT_RECENT_EMPTY_H
  }
}

/** Wrapper that measures a rendered virtual row and reports its pixel height. */
function MeasuredRow({ vKey, onMeasure, children }: { vKey: string; onMeasure: (key: string, height: number) => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => onMeasure(vKey, el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [vKey, onMeasure])
  return <div className="vrow" style={{ display: 'flow-root' }} ref={ref}>{children}</div>
}

export function UnifiedAgentsPane({ terminals, tasks, tasksLoading, unifiedTasks, unifiedTasksLoading, onDispatch, onNavigate, onOpenInBench, openDispatchTrigger, quickSpawnTrigger, openDetailTaskId, onDetailTaskConsumed, onThroughputChange, search: floorSearch, onSearch: setFloorSearch, githubRepo, watchdogEnabled = false, watchdogEvents = [], projectRules = [], sessionStreamDegraded = false }: UnifiedAgentsPaneProps) {
  const panelVisible = usePanelVisibility()
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [statPopover, setStatPopover] = useState<'shipped' | 'open' | 'running' | 'nextup' | 'files' | null>(null)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchPrefill, setDispatchPrefill] = useState('')
  const [dispatchPrefillTicketId, setDispatchPrefillTicketId] = useState<string | undefined>(undefined)
  // Draft-prompt round-trip result (host 'draftPromptResult'); nonce forces the
  // DispatchPanel effect to fire even on a repeated ok/error. A monotonic counter
  // (not Date.now) so two results in the same ms can't collide to an equal nonce.
  const [draftResult, setDraftResult] = useState<DraftResult | null>(null)
  const draftNonce = useRef(0)
  // Consolidated dispatch data feeding the single DispatchPanel (from `dispatchData`).
  const [dispatchAgents, setDispatchAgents] = useState<InstalledAgent[]>([])
  const [dispatchHosts, setDispatchHosts] = useState<DispatchHost[]>([])
  const [dispatchTargets, setDispatchTargets] = useState<DispatchTarget[]>([])
  // Registered-device dispatch: devices (with live health), ranked repos->projects,
  // and the sync status for the currently-selected repo. All backend-driven.
  const [dispatchDevices, setDispatchDevices] = useState<DispatchDevice[]>([])
  // Sessions' alternate-device Resume menu consumes the same registered-device
  // inventory as Dispatch; no second Fleet derivation or request is needed.
  const fleetDevices = useMemo(
    () => dispatchDevices.map((device) => ({ name: device.name, online: device.reachable })),
    [dispatchDevices],
  )
  const [deviceRepos, setDeviceRepos] = useState<DispatchDeviceRepo[]>([])
  const [deviceSync, setDeviceSync] = useState<DispatchDeviceSync | null>(null)
  // This machine's real canonical device name (e.g. 'zion'), from the fleet fetch.
  // Local agents keep host==='this-mac' for routing but display under this name.
  const [localHostName, setLocalHostName] = useState<string>('')
  // Floor after-dispatch: plans awaiting review, one per sessionId (from `planReady`).
  const [pendingPlans, setPendingPlans] = useState<PendingPlan[]>([])
  const [cardDragActive, setCardDragActive] = useState(false)
  // The single open-the-Dispatch-panel entry point. Every legacy trigger (top-bar
  // button, cmd-K, cmd-palette, ticket rows, drag-drop) routes here, carrying an
  // optional prefill prompt and/or a ticket to pre-attach.
  const openDispatch = useCallback((opts?: { prefill?: string; ticketId?: string }) => {
    setDispatchPrefill(opts?.prefill ?? '')
    setDispatchPrefillTicketId(opts?.ticketId)
    setDispatchOpen(true)
  }, [])
  useEffect(() => {
    if (openDispatchTrigger !== undefined && openDispatchTrigger > 0) openDispatch()
  }, [openDispatchTrigger, openDispatch])
  useEffect(() => {
    if (quickSpawnTrigger !== undefined && quickSpawnTrigger > 0) openDispatch()
  }, [quickSpawnTrigger, openDispatch])
  useEffect(() => {
    if (!openDetailTaskId) return
    const task = unifiedTasks.find(t => t.id === openDetailTaskId)
    if (!task) return
    openDispatch({ ticketId: ticketKey(task) })
    onDetailTaskConsumed?.()
  }, [openDetailTaskId, unifiedTasks, onDetailTaskConsumed, openDispatch])
  const [pendingDispatches, setPendingDispatches] = useState<PendingDispatch[]>([])
  const [tick, setTick] = useState(0)
  // ---------- Floor 3-pane shell state ----------
  const floorPrefs0 = useRef(loadFloorPrefs()).current
  // Sessions is the primary surface (the work an operator lands), so the Floor
  // opens on it, not the Agents roster — matches "rank by progress" (root AGENTS.md).
  const [center, setCenter] = useState<CenterMode>('sessions')
  // Dynamic task tabs: double-clicking a backlog ticket or an agent card opens a
  // closeable tab in the sub-tab strip. activeTaskTab === null means a fixed center
  // tab is showing; otherwise the named task tab owns the center pane.
  const [openTaskTabs, setOpenTaskTabs] = useState<TaskTab[]>([])
  const [activeTaskTab, setActiveTaskTab] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  // Rich per-session preview digests (PHNX-2973), keyed by sessionId. Fetched
  // once when a session is selected (a user action, not a poll) via the one-shot
  // `sessions preview --json` CLI verb; the detail panel renders them at parity
  // with the CLI picker. `loading` guards against a duplicate in-flight fetch.
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [projFilter, setProjFilter] = useState<string | null>(null)
  // Host scope: click a HOSTS row to filter the feed to that machine; click again to clear.
  const [hostFilter, setHostFilter] = useState<string | null>(null)
  // Recent (historical) sessions per host, fetched lazily only when a host filter has
  // 0 live agents — so an empty host shows recent work instead of a blank pane.
  const [recentByHost, setRecentByHost] = useState<Record<string, RemoteSessionLike[]>>({})
  // PHNX-3594: PR-board and Recap state left with those removed Fleet centers.
  // Previous sessions now arrive on the canonical watch stream (PHNX-3621).
  const [floorSort, setFloorSort] = useState<FloorSort>('needs')
  // Group the live feed by an axis. Defaults to 'outcome' (ticket/PR/worktree) so a
  // fleet-scale floor shows deliverables, not ~1,100 agents (RUSH-1479). NEEDS YOU
  // stays pinned above the groups; 'none' falls back to flat phase sections
  // (NEEDS YOU -> RUNNING -> DONE). Reuses groupAgents() so the control bar and
  // the feed share one grouping implementation.
  const [floorGroup, setFloorGroup] = useState<FloorGroupBy | 'none'>('outcome')
  const [floorSubgroup, setFloorSubgroup] = useState<FloorGroupBy | 'none'>('none')
  const [plain, setPlain] = useState(floorPrefs0.plain)
  const [sidebarOpen, setSidebarOpen] = useState(floorPrefs0.sidebar)
  // Collapsed = the icon rail (mockup default); expanded = the full text sidebar.
  const [railCollapsed, setRailCollapsed] = useState(floorPrefs0.rail)
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(floorPrefs0.pinned))
  const [sidebarWidth, setSidebarWidth] = useState(floorPrefs0.sidebarWidth)
  // Ordered pinned HOSTS names (null = default: pin the local machine).
  const [hostPins, setHostPins] = useState<string[] | null>(floorPrefs0.hostPins)
  const [statusChips, setStatusChips] = useState<StatusChip[]>([])
  const [abbrChips, setAbbrChips] = useState<AgentAbbr[]>([])
  const [showBackground, setShowBackground] = useState(false)
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => loadSavedViews())
  // Per-row measured heights for the virtualized Agents feed. Stored in a ref so
  // rapid ResizeObserver callbacks don't churn React state; a tick increments when
  // a height actually changes so the virtual list recomputes offsets.
  const measuredHeightsRef = useRef<Map<string, number>>(new Map())
  const [heightTick, setHeightTick] = useState(0)
  const recordHeight = useCallback((key: string, height: number) => {
    const prev = measuredHeightsRef.current.get(key)
    if (prev === undefined || Math.abs(prev - height) > 1) {
      measuredHeightsRef.current.set(key, height)
      setHeightTick((t) => t + 1)
    }
  }, [])

  const activeViewName = useMemo(() => {
    const cur = { sort: floorSort, status: statusChips, abbrs: abbrChips, search: floorSearch }
    return savedViews.find((v) => viewMatches(v, cur))?.name ?? null
  }, [savedViews, floorSort, statusChips, abbrChips, floorSearch])

  const applyView = useCallback((v: SavedView) => {
    setFloorSort(v.sort)
    setStatusChips(v.status)
    setAbbrChips(v.abbrs)
    setFloorSearch(v.search)
  }, [])

  const saveView = useCallback((name: string) => {
    setSavedViews((prev) => {
      const next = upsertView(prev, { name, sort: floorSort, status: statusChips, abbrs: abbrChips, search: floorSearch })
      persistSavedViews(next)
      return next
    })
  }, [floorSort, statusChips, abbrChips, floorSearch])

  const deleteView = useCallback((name: string) => {
    setSavedViews((prev) => {
      const next = removeView(prev, name)
      persistSavedViews(next)
      return next
    })
  }, [])
  const [ticketGroup, setTicketGroup] = useState<TicketGroupBy>('project')
  const [ticketSubgroup, setTicketSubgroup] = useState<TicketGroupBy | 'none'>('none')
  const [ticketSort, setTicketSort] = useState<TicketSort>('priority')
  const [ticketSrc, setTicketSrc] = useState<Record<TicketSource, boolean>>({ LN: true, GH: true })

  const handleFloorGroup = useCallback((next: FloorGroupBy | 'none') => {
    setFloorGroup(next)
    setFloorSubgroup((cur) => (next === 'none' || cur === next ? 'none' : cur))
  }, [])

  const handleTicketGroup = useCallback((next: TicketGroupBy) => {
    setTicketGroup(next)
    setTicketSubgroup((cur) => (cur === next ? 'none' : cur))
  }, [])

  const [remoteSessions, setRemoteSessions] = useState<RemoteSessionLike[]>([])
  const [feedActivity, setFeedActivity] = useState<Array<{
    type?: string
    key?: string
    state?: string
    source?: string
    question?: string | { text?: string }
  }>>([])
  const [offlineHosts, setOfflineHosts] = useState<string[]>([])
  // Per-agent reply failures (host 'replyResult' with ok=false, or a 'none' channel),
  // shown inline near the reply control instead of a toast. Cleared on the next send.
  const [replyErrors, setReplyErrors] = useState<Map<string, string>>(new Map())
  // Full discovered roster (name + reachability) so the sidebar can list idle
  // reachable hosts, not only hosts currently running an agent.
  const [hostRoster, setHostRoster] = useState<Array<{ name: string; online: boolean }>>([])
  // Freshness of the cross-host (remote) sweep, for the LIVE ACTIVITY sync chip.
  const [lastRemoteSync, setLastRemoteSync] = useState(0)
  const [lastLocalSync, setLastLocalSync] = useState(0)
  const [syncingHosts, setSyncingHosts] = useState(false)
  // Per-host freshness from optional hostSessions.groups / hostFreshness fields
  // (host track may add these; keep backward-compat when absent).
  const [hostFreshness, setHostFreshness] = useState<Record<string, number>>({})
  const [remoteSyncError, setRemoteSyncError] = useState<string | null>(null)
  // Optional host signal: agents CLI missing / unusable (never blocks cached rows).
  const [cliUnavailable, setCliUnavailable] = useState(false)
  // Curated managed projects for the feed's linked-project lookup (the per-group
  // Linear-project pill). The Projects management pane moved to Settings
  // (FleetProjectsSection), which owns its own Linear-projects + folder-picker
  // state (PHNX-3592).
  const [managedProjects, setManagedProjects] = useState<ManagedProject[]>([])
  // Curated project names, reused (not refetched) for session attribution + the
  // Sessions surface's assign menus (PHNX-3796).
  const managedProjectNameList = useMemo(() => managedProjects.map((p) => p.name).filter(Boolean), [managedProjects])

  // Persist the durable Floor prefs (pinned set, plain/sidebar toggles, group-by, host pins).
  useEffect(() => {
    saveFloorPrefs({ layoutVersion: FLOOR_PREFS_LAYOUT_VERSION, plain, sidebar: sidebarOpen, rail: railCollapsed, pinned: [...pinned], hostPins, sidebarWidth })
  }, [plain, sidebarOpen, railCollapsed, pinned, hostPins, sidebarWidth])

  // Effective HOSTS pins: default to pinning just the local machine until the user
  // customizes. Pin/unpin and drag-reorder always write an explicit list.
  const effectiveHostPins = useMemo(
    () => hostPins ?? (localHostName ? [localHostName] : []),
    [hostPins, localHostName]
  )
  const toggleHostPin = useCallback((name: string) => {
    setHostPins((prev) => {
      const base = prev ?? (localHostName ? [localHostName] : [])
      return base.includes(name) ? base.filter((n) => n !== name) : [...base, name]
    })
  }, [localHostName])
  const reorderHostPins = useCallback((names: string[]) => setHostPins(names), [])

  // Cross-host merge: fold genuinely-remote sessions into the Floor. Two message
  // types arrive here:
  //   hostSessions  — full sweep (every online host); replaces the whole set + roster.
  //                   On failure (ok===false / error string), KEEP last-good rows.
  //   localSessions — this-mac only (event-driven / one-shot seed); replaces just the
  //                   this-mac rows so remote rows from the last sweep are preserved.
  // Optional typed fields from the host track (groups, hostFreshness, cliAvailable)
  // are accepted when present; absent fields keep backward compile compatibility.
  // Per-agent reply failures ('replyResult' with ok=false) surface inline near the reply
  // control instead of a toast; cleared on the next successful send.
  // Local-only Floor still works if neither ever arrives.
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'replyResult') {
        const agentId = String(msg.agentId ?? '')
        if (!agentId) return
        setReplyErrors((prev) => {
          const n = new Map(prev)
          if (msg.ok) n.delete(agentId)
          else n.set(agentId, String(msg.error || 'Reply failed'))
          return n
        })
        return
      }
      if (msg?.type === 'feedActivity') {
        if (Array.isArray(msg.activity)) setFeedActivity(msg.activity)
        return
      }
      if (msg?.type === 'hostSessions') {
        const failed = msg.ok === false || typeof msg.error === 'string'
        if (failed) {
          // Retain last-good sessions/roster; surface the error on the freshness chip.
          setRemoteSyncError(typeof msg.error === 'string' ? msg.error : 'Host sync failed')
          if (typeof msg.fetchedAt === 'number') setLastRemoteSync(msg.fetchedAt)
          setSyncingHosts(false)
          return
        }
        setRemoteSessions(Array.isArray(msg.sessions) ? (msg.sessions as RemoteSessionLike[]) : [])
        if (Array.isArray(msg.activity)) setFeedActivity(msg.activity)
        const roster = Array.isArray(msg.hosts)
          ? (msg.hosts as Array<{ name: string; online: boolean }>)
              .filter((h) => h && typeof h.name === 'string')
              .map((h) => ({ name: h.name, online: !!h.online }))
          : []
        setHostRoster(roster)
        setOfflineHosts(roster.filter((h) => !h.online).map((h) => h.name))
        setLastRemoteSync(typeof msg.fetchedAt === 'number' ? msg.fetchedAt : Date.now())
        setRemoteSyncError(null)
        setSyncingHosts(false)
        // Optional per-host freshness: groups[{host,fetchedAt}] or hostFreshness map.
        const nextFresh: Record<string, number> = {}
        if (Array.isArray(msg.groups)) {
          for (const g of msg.groups as Array<{ host?: string; fetchedAt?: number }>) {
            if (g && typeof g.host === 'string' && typeof g.fetchedAt === 'number') {
              nextFresh[g.host] = g.fetchedAt
            }
          }
        }
        if (msg.hostFreshness && typeof msg.hostFreshness === 'object') {
          for (const [k, v] of Object.entries(msg.hostFreshness as Record<string, unknown>)) {
            if (typeof v === 'number') nextFresh[k] = v
          }
        }
        if (Object.keys(nextFresh).length) setHostFreshness(nextFresh)
        if (typeof msg.cliAvailable === 'boolean') setCliUnavailable(!msg.cliAvailable)
      } else if (msg?.type === 'localSessions') {
        const local = Array.isArray(msg.sessions) ? (msg.sessions as RemoteSessionLike[]) : []
        // On local failure keep previous this-mac rows (last-good).
        if (msg.ok === false || typeof msg.error === 'string') {
          if (typeof msg.fetchedAt === 'number') setLastLocalSync(msg.fetchedAt)
          return
        }
        setRemoteSessions((prev) => [...prev.filter((s) => s.host !== 'this-mac'), ...local])
        if (Array.isArray(msg.activity)) setFeedActivity(msg.activity)
        setLastLocalSync(typeof msg.fetchedAt === 'number' ? msg.fetchedAt : Date.now())
        if (typeof msg.cliAvailable === 'boolean') setCliUnavailable(!msg.cliAvailable)
      } else if (msg?.type === 'recentSessions') {
        const rh = typeof msg.host === 'string' ? msg.host : ''
        const recent = Array.isArray(msg.sessions) ? (msg.sessions as RemoteSessionLike[]) : []
        setRecentByHost((p) => ({ ...p, [rh]: recent }))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // One-shot seed when the panel becomes visible — NOT a recurring poll. Local rows
  // then update from monitor/webview events; remote refresh is the manual chip only.
  useEffect(() => {
    if (!panelVisible) return
    setSyncingHosts(true)
    postMessage({ type: 'fetchLocalSessions' })
    postMessage({ type: 'fetchHostSessions' })
  }, [panelVisible])

  // The host detail pane (inventories + config-action errors) went with the detail
  // rail: its onSelectHost entry point was already dead after PHNX-3594, and
  // HostDetail was the last thing that read the fetched inventory. The extension
  // host still answers 'fetchHostInventory'/'enrollHost'/'removeHost' for the
  // Settings Devices surface; nothing in THIS pane listens for them any more.

  // Curated managed projects for the feed's linked-project lookup. Fetch on
  // mount; the host re-sends managedProjectsData after any save/delete (from the
  // Settings Projects section), so no optimistic update is needed. On error, KEEP
  // last-good projects (same pattern as hostSessions) — there is no pane here to
  // surface it, and the feed just uses whatever mapping it already has.
  useEffect(() => {
    postMessage({ type: 'fetchManagedProjects' })
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'managedProjectsData' && Array.isArray(msg.projects)) {
        setManagedProjects(msg.projects as ManagedProject[])
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Consolidated dispatch data (installed agents / hosts / ranked targets) for the
  // single DispatchPanel, plus the Floor after-dispatch `planReady` signal. Both are
  // ext->webview, so one listener serves both. Panel still opens if data never arrives.
  useEffect(() => {
    postMessage({ type: 'fetchDispatchData' })
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'dispatchData') {
        if (Array.isArray(msg.agents)) setDispatchAgents(msg.agents as InstalledAgent[])
        if (Array.isArray(msg.hosts)) setDispatchHosts(msg.hosts as DispatchHost[])
        if (Array.isArray(msg.targets)) setDispatchTargets(msg.targets as DispatchTarget[])
      } else if (msg?.type === 'planReady' && msg.plan) {
        const plan = msg.plan as PendingPlan
        // De-dupe by sessionId so a re-emitted plan replaces the stale one.
        setPendingPlans((prev) => [...prev.filter((p) => p.sessionId !== plan.sessionId), plan])
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Registered-device data for the Dispatch panel's device path. Fetched when the
  // panel opens. deviceHealth is activation-cache backed (PR #2031) — registry
  // online/offline only, no per-host SSH CPU/memory fan-out — so this is cheap
  // enough to request when Dispatch opens. Offline devices still list as rows.
  useEffect(() => {
    if (!dispatchOpen) return
    postMessage({ type: 'deviceHealth' })
    postMessage({ type: 'repos' })
  }, [dispatchOpen])
  // Cheap fleet fetch on mount (no SSH) so this machine's canonical device name
  // (localHostName) is resolved early; the DEVICES list itself now lives in Settings.
  useEffect(() => {
    postMessage({ type: 'listDevices' })
  }, [])
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'devicesData' && Array.isArray(msg.devices)) {
        if (typeof msg.local === 'string' && msg.local) setLocalHostName(msg.local)
        // Mount-time registry data powers the Sessions alternate-device menu
        // before Dispatch is ever opened. A later deviceHealthData event replaces
        // these rows with the same inventory plus richer live statistics.
        setDispatchDevices(registeredDevicesToDispatchDevices(msg.devices))
      } else if (msg?.type === 'deviceHealthData' && Array.isArray(msg.health)) {
        setDispatchDevices(
          (msg.health as Array<{ device: { name: string; host: string; secretRef?: string; softLimit?: number }; stats: { reachable?: boolean; runningAgents?: number; memPercent?: number; loadAvg1?: number } }>).map(
            ({ device, stats }) => ({
              name: device.name,
              host: device.host,
              secretRef: device.secretRef,
              softLimit: device.softLimit,
              reachable: !!stats?.reachable,
              runningAgents: stats?.runningAgents,
              memPercent: stats?.memPercent,
              loadAvg1: stats?.loadAvg1,
            }),
          ),
        )
      } else if (msg?.type === 'reposData' && Array.isArray(msg.repos)) {
        setDeviceRepos(msg.repos as DispatchDeviceRepo[])
      } else if (msg?.type === 'repoSyncData') {
        setDeviceSync((msg.status as DispatchDeviceSync | null) ?? null)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  const onRequestRepoSync = useCallback((deviceName: string, root: string) => {
    setDeviceSync(null)
    const dev = dispatchDevices.find((d) => d.name === deviceName)
    postMessage({ type: 'repoSync', root, host: dev?.host, secretRef: dev?.secretRef })
  }, [dispatchDevices])

  const onManageDevices = useCallback(() => {
    postMessage({ type: 'manageDevices' })
  }, [])

  const onDeviceDispatch = useCallback((req: DeviceDispatchRequest) => {
    setDispatchOpen(false)
    const now = Date.now()
    const perTicket = req.batch === 'per' && req.ticketIds.length > 1
    const seeds: (string | undefined)[] = perTicket ? req.ticketIds : [req.ticketIds[0]]
    const promptTitle = req.prompt.trim().slice(0, 60) || req.ticketIds[0] || 'New agent'
    seeds.forEach((tid) => {
      postMessage({
        type: 'dispatchTask',
        target: 'device',
        agentType: req.agent,
        deviceName: req.deviceName,
        host: req.host,
        secretRef: req.secretRef,
        projectPath: req.projectPath,
        repoSlug: req.repoSlug,
        syncPolicy: req.syncPolicy,
        mode: req.mode,
        title: perTicket && tid ? tid : promptTitle,
        description: req.prompt,
        identifier: tid ?? '',
      })
    })
    const pendings: PendingDispatch[] = seeds.map((tid, i) => ({
      id: `pending-dispatch-${now}-${i}`,
      agentType: req.agent,
      target: 'device',
      taskId: `dispatch-${now}-${i}`,
      taskIdentifier: tid ?? '',
      title: perTicket && tid ? tid : promptTitle,
      createdAt: now + i,
      deviceName: req.deviceName,
      secretRef: req.secretRef,
      projectPath: req.projectPath,
      repoSlug: req.repoSlug,
      syncPolicy: req.syncPolicy,
    }))
    setPendingDispatches((prev) => [...prev, ...pendings])
    setTimeout(() => {
      postMessage({ type: 'fetchAllTerminals' })
      postMessage({ type: 'fetchTasks' })
    }, 800)
  }, [])

  const newMenuRef = useRef<HTMLDivElement>(null)
  const statPopoverRef = useRef<HTMLDivElement>(null)
  const nextUpSectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Gate the 1s countdown on visibility: no point ticking the pending-dispatch
    // timeout clock while the panel is hidden — it just burns a wakeup per second
    // off-screen. The next reveal re-arms it (panelVisible flips true).
    if (pendingDispatches.length === 0 || !panelVisible) return
    const interval = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(interval)
  }, [pendingDispatches.length, panelVisible])

  useEffect(() => {
    if (pendingDispatches.length === 0) return
    const now = Date.now()
    setPendingDispatches((prev) => {
      // Lifecycle: surface confirmed Rush Cloud failures immediately, flip
      // anything past TTL to timedOut next, then fully remove once the
      // retention window has also passed. Each helper returns the same
      // reference when nothing changed, so steady state is a no-op.
      const failed = markCloudFailedPending(prev, tasks)
      const flipped = markTimedOutPending(failed, now)
      const pruned = pruneExpiredPending(flipped, now)
      return pruned
    })
  }, [tick, pendingDispatches, tasks])

  useEffect(() => {
    if (!newMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setNewMenuOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [newMenuOpen])

  useEffect(() => {
    if (!statPopover) return
    const handler = (e: MouseEvent) => {
      if (statPopoverRef.current && !statPopoverRef.current.contains(e.target as Node)) setStatPopover(null)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [statPopover])

  // Listen for command-palette-dispatched events. We can't call into App.tsx's
  // state from here, so the palette fires window-level CustomEvents we pick up.
  // Opening a task routes to the single DispatchPanel with that ticket attached.
  useEffect(() => {
    const onOpenTask = (e: Event) => {
      const ev = e as CustomEvent<{ taskId: string }>
      const taskId = ev.detail?.taskId
      if (!taskId) return
      const task = unifiedTasks.find((t) => t.id === taskId)
      if (!task) return
      openDispatch({ ticketId: ticketKey(task) })
    }
    const onFocusTerm = (e: Event) => {
      const ev = e as CustomEvent<{ terminalId: string }>
      const id = ev.detail?.terminalId
      if (!id) return
      postMessage({ type: 'focusTerminal', terminalId: id })
    }
    window.addEventListener(CMD_PALETTE_EVENTS.openTaskDetail, onOpenTask)
    window.addEventListener(CMD_PALETTE_EVENTS.focusTerminal, onFocusTerm)
    return () => {
      window.removeEventListener(CMD_PALETTE_EVENTS.openTaskDetail, onOpenTask)
      window.removeEventListener(CMD_PALETTE_EVENTS.focusTerminal, onFocusTerm)
    }
  }, [unifiedTasks, openDispatch])

  const baseItems = useMemo(() => {
    const list = buildUnifiedList(terminals, tasks)
    if (watchdogEnabled) {
      const lastEvent = watchdogEvents[watchdogEvents.length - 1]
      const lastNudge = [...watchdogEvents].reverse().find((e) => e.kind === 'nudge')
      const activity = lastNudge
        ? `Nudged ${lastNudge.terminalId?.split('-')[0] ?? 'terminal'} · ${relTime(new Date(lastNudge.ts).toISOString())}`
        : lastEvent
          ? `Last scan ${relTime(new Date(lastEvent.ts).toISOString())}`
          : 'Monitoring'
      list.unshift({
        kind: 'watchdog',
        id: 'watchdog',
        agentType: 'watchdog',
        displayName: 'Watchdog',
        activity,
        active: !!lastEvent,
        duration: '',
        timestamp: lastEvent ? new Date(lastEvent.ts).toISOString() : new Date().toISOString(),
        status: lastEvent ? 'running' : 'idle',
        files: [],
        toolCalls: 0,
        watchdogEvents,
      })
    }
    return list
  }, [terminals, tasks, watchdogEnabled, watchdogEvents])

  // Reconcile: drop a pending dispatch once a matching real terminal/task appears.
  useEffect(() => {
    if (pendingDispatches.length === 0) return
    setPendingDispatches((prev) => {
      const next = reconcilePending(prev, terminals, tasks)
      return next.length === prev.length ? prev : next
    })
  }, [terminals, tasks, pendingDispatches])

  const optimisticItems = useMemo<UnifiedAgent[]>(() => {
    void tick
    // Only render still-pending dispatches as optimistic cards. Timed-out
    // ones are surfaced as a separate dismissable banner above the grid
    // (see `timedOutDispatches` + banner render below) so they stand out
    // visually instead of masquerading as a running agent.
    return pendingDispatches
      .filter((p) => (p.status ?? 'pending') !== 'timedOut')
      .map((p) => ({
        kind: p.target === 'cloud' ? 'cloud' : 'terminal',
        id: p.id,
        agentType: p.agentType,
        displayName: p.taskIdentifier || p.title.slice(0, 40),
        activity: optimisticActivityLabel(p),
        active: true,
        duration: '',
        timestamp: new Date(p.createdAt).toISOString(),
        status: 'running',
        files: [],
        toolCalls: 0,
        mode: p.target === 'cloud' ? 'cloud' : 'auto',
        cloudProvider: p.target === 'cloud' ? 'anthropic' : null,
      }))
  }, [pendingDispatches, tick])

  // Timed-out dispatches surfaced as a warning banner. Collected separately
  // so the banner renders above the active grid and can be individually
  // dismissed without affecting still-pending entries.
  const timedOutDispatches = useMemo(() => {
    void tick
    return pendingDispatches.filter((p) => (p.status ?? 'pending') === 'timedOut')
  }, [pendingDispatches, tick])

  const dismissPending = (id: string) => {
    setPendingDispatches((prev) => prev.filter((p) => p.id !== id))
  }

  const rawItems = useMemo(() => [...optimisticItems, ...baseItems], [optimisticItems, baseItems])
  const items = useStableList(rawItems)
  const activeItems = useMemo(() => items.filter((i) => i.active), [items])
  const recentItems = useMemo(() => items.filter((i) => !i.active), [items])

  const pendingTaskIds = useMemo(
    () => new Set(pendingDispatches.map((p) => p.taskId)),
    [pendingDispatches]
  )

  // Queue eligible pool: urgent/high todo tasks not currently being dispatched.
  // Project filter is applied on top of this for the NEXT UP strip.
  const queueEligible = useMemo(() => {
    const eligible = unifiedTasks.filter(
      (t) => t.status === 'todo' && (t.priority === 'urgent' || t.priority === 'high')
    )
    return filterDispatchedTaskIds(eligible, pendingTaskIds)
  }, [unifiedTasks, pendingTaskIds])

  // Attach list for the cmd+k composer: every todo task (not just the
  // urgent/high Next Up pool), highest priority first.
  const composerTasks = useMemo(() => {
    const rank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
    const todo = unifiedTasks
      .filter((t) => t.status === 'todo')
      .sort((a, b) => (rank[a.priority || 'low'] ?? 3) - (rank[b.priority || 'low'] ?? 3))
    return filterDispatchedTaskIds(todo, pendingTaskIds)
  }, [unifiedTasks, pendingTaskIds])

  // Repo name of the workspace currently open in the IDE (e.g. "swarmify"
  // from "muqsitnawaz/swarmify"). Used to default the Next Up filter so
  // dispatches stay scoped to the repo the user is actually working on.
  const workspaceRepoName = useMemo(() => {
    if (!githubRepo) return null
    return githubRepo.includes('/') ? githubRepo.split('/').pop()! : githubRepo
  }, [githubRepo])

  const [queueRepoFilter, setQueueRepoFilter] = useState<string>(() => workspaceRepoName ?? 'all')
  const queueRepoFilterUserSet = useRef(false)

  // Distinct repo names present in the eligible queue. Derived from the
  // repo:* label on each Linear issue (resolved to "owner/repo" at fetch
  // time). Shown as just the repo name in the dropdown since they all share
  // the same owner.
  const queueRepos = useMemo(() => {
    const seen = new Set<string>()
    for (const t of queueEligible) {
      const full = t.metadata.repo
      if (!full) continue
      const name = full.includes('/') ? full.split('/').pop()! : full
      seen.add(name)
    }
    return Array.from(seen).sort()
  }, [queueEligible])

  // Once the workspace repo is known and there's at least one task tagged
  // for it, snap the filter to it — but only if the user hasn't manually
  // overridden the dropdown.
  useEffect(() => {
    if (queueRepoFilterUserSet.current) return
    if (!workspaceRepoName) return
    if (queueRepos.includes(workspaceRepoName) && queueRepoFilter !== workspaceRepoName) {
      setQueueRepoFilter(workspaceRepoName)
    }
  }, [workspaceRepoName, queueRepos, queueRepoFilter])

  // When the selected repo drains out of the eligible pool (all its tasks
  // got dispatched), fall back to "all" rather than showing an empty queue
  // the user can't clear without touching the dropdown. Skip this for the
  // workspace repo so a transient empty queue doesn't drop the user's repo
  // scope.
  useEffect(() => {
    if (queueRepoFilter === 'all') return
    if (queueRepoFilter === workspaceRepoName) return
    if (!queueRepos.includes(queueRepoFilter)) {
      setQueueRepoFilter('all')
    }
  }, [queueRepoFilter, queueRepos, workspaceRepoName])

  const queueTasks = useMemo(() => {
    const filtered = queueRepoFilter === 'all'
      ? queueEligible
      : queueEligible.filter((t) => {
          const full = t.metadata.repo
          if (!full) return false
          const name = full.includes('/') ? full.split('/').pop()! : full
          return name === queueRepoFilter
        })
    return filtered.slice(0, 4)
  }, [queueEligible, queueRepoFilter])

  // Intake queue: cloud teammates that a cloud provider flagged as
  // 'input_required'. Surface one banner per team; submit pipes through to
  // `agents factory answer <team> <text>` in the VS Code backend.
  const intakeTeams = useMemo(() => {
    const byTeam = new Map<string, { teammate: string; agentId: string }[]>()
    for (const t of tasks) {
      for (const a of t.agents) {
        if (a.status !== 'input_required') continue
        const existing = byTeam.get(t.task_name) ?? []
        existing.push({ teammate: (a.name ?? compactHumanLabel(a.prompt)) || `${a.agent_type} teammate`, agentId: a.agent_id })
        byTeam.set(t.task_name, existing)
      }
    }
    return Array.from(byTeam.entries()).map(([team, agents]) => ({ team, agents }))
  }, [tasks])

  // Gauge metrics
  const totalFiles = useMemo(() => {
    const fileSet = new Set<string>()
    for (const item of items) {
      for (const f of item.files) fileSet.add(f.split('/').pop() || f)
    }
    return fileSet.size
  }, [items])

  // Open PRs: items with a prUrl whose PR is not merged/completed.
  // swarmOverallStatus treats status === 'completed' as 'merged', so we exclude those.
  const openPRs = useMemo(
    () =>
      items
        .filter((i) => i.prUrl && i.status !== 'completed')
        .map((i) => ({
          key: i.id,
          title: i.displayName,
          url: i.prUrl as string,
          agentType: i.agentType,
          timestamp: i.timestamp,
        })),
    [items]
  )
  const totalPRs = openPRs.length

  // PRs shipped today: agents with pr_url that completed today.
  const shippedPRs = useMemo(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startMs = startOfDay.getTime()
    const out: Array<{ key: string; title: string; url: string; agentType: string; timestamp: string }> = []
    for (const task of tasks) {
      for (const a of task.agents) {
        if (!a.pr_url) continue
        if (a.status !== 'completed') continue
        if (!a.completed_at) continue
        if (new Date(a.completed_at).getTime() < startMs) continue
        out.push({
          key: `shipped-${a.agent_id}`,
          title: taskNameToTitle(task.task_name),
          url: a.pr_url,
          agentType: a.agent_type,
          timestamp: a.completed_at,
        })
      }
    }
    return out
  }, [tasks])
  const prsShippedToday = shippedPRs.length

  // Files touched today: unique files across agents that had activity today.
  const filesToday = useMemo(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startMs = startOfDay.getTime()
    const set = new Set<string>()
    for (const task of tasks) {
      for (const a of task.agents) {
        const ts = a.completed_at || a.started_at
        if (!ts) continue
        if (new Date(ts).getTime() < startMs) continue
        for (const f of a.files_created || []) set.add(f)
        for (const f of a.files_modified || []) set.add(f)
      }
    }
    return Array.from(set).sort()
  }, [tasks])
  const filesTouchedToday = filesToday.length

  const backlogRemaining = useMemo(() => {
    const todoCount = unifiedTasks.filter((t) => t.status === 'todo').length
    return Math.max(0, todoCount - queueTasks.length)
  }, [unifiedTasks, queueTasks.length])

  // Real LLM output tok/s, computed host-side from ActiveSession.tokPerSec
  // (which already rides the agents-cli session stream). The host pushes a
  // fresh 'floorThroughputData' message whenever that stream actually changes
  // (settings.vscode.ts refreshFloorFromSessionStream) — no poll here
  // (PHNX-2833: the extension must not own a timer that fetches).
  const [liveThroughput, setLiveThroughput] = useState(0)
  useEffect(() => {
    if (activeItems.length === 0 || !panelVisible) {
      // Panel hidden or nothing active: zero the value. ThroughputCounter
      // early-returns its 1s sparkline interval when tokensPerSec <= 0, so
      // resetting here clears the animation instead of letting it run
      // off-screen against the last frozen value.
      setLiveThroughput(0)
      onThroughputChange?.(0)
    }
  }, [activeItems.length, onThroughputChange, panelVisible])
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'floorThroughputData' && typeof msg.tokensPerSec === 'number') {
        if (activeItems.length === 0 || !panelVisible) return
        setLiveThroughput(msg.tokensPerSec)
        onThroughputChange?.(msg.tokensPerSec)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onThroughputChange, activeItems.length, panelVisible])

  // Draft-prompt result from the host. Stamp a nonce so the DispatchPanel effect
  // fires on every delivery (React would skip an object with unchanged fields).
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type !== 'draftPromptResult') return
      setDraftResult({
        ok: !!msg.ok,
        text: typeof msg.text === 'string' ? msg.text : undefined,
        error: typeof msg.error === 'string' ? msg.error : undefined,
        nonce: ++draftNonce.current,
      })
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const onDraftPrompt = useCallback((payload: { tickets: DraftTicketPayload[]; hint: string }) => {
    postMessage({ type: 'draftPrompt', tickets: payload.tickets, hint: payload.hint })
  }, [])

  const handleRetry = useCallback((taskName: string) => {
    postMessage({ type: 'retrySwarm', taskName })
  }, [])

  // Panel hosts: the ranked host list from `dispatchData`, folded with LIVE load —
  // online-ness from the hostSessions offline set + current agent counts per host from
  // the cross-host session index. This is the "Run on" list the DispatchPanel ranks.
  const panelHosts = useMemo<DispatchHost[]>(() => {
    if (dispatchHosts.length === 0) return []
    const offline = new Set(offlineHosts)
    const agentsByHost = new Map<string, number>()
    for (const s of remoteSessions) agentsByHost.set(s.host, (agentsByHost.get(s.host) ?? 0) + 1)
    return dispatchHosts.map((h) => {
      const online = h.kind === 'cloud' ? h.online : !offline.has(h.id)
      const liveAgents = agentsByHost.get(h.id)
      return { ...h, online, agents: liveAgents ?? h.agents }
    })
  }, [dispatchHosts, offlineHosts, remoteSessions])

  // The single dispatch entry point. The consolidated panel emits ONE DispatchRequest;
  // we hand it to the backend (`dispatch`) and drop optimistic pending cards so the Floor
  // shows the agent(s) coming up immediately (trust-it's-working). Replaces the scattered
  // dispatchTask / quickSpawn senders.
  const onDispatchRequest = useCallback((req: DispatchRequest) => {
    setDispatchOpen(false)
    postMessage({ type: 'dispatch', request: req })
    const host = panelHosts.find((h) => h.id === req.runOn)
    const isCloud = host?.kind === 'cloud'
    const now = Date.now()
    const perTicket = req.batch === 'per' && req.ticketIds.length > 1
    const seeds: (string | undefined)[] = perTicket ? req.ticketIds : [req.ticketIds[0]]
    const promptTitle = req.prompt.trim().slice(0, 60) || req.ticketIds[0] || 'New agent'
    const pendings: PendingDispatch[] = seeds.map((tid, i) => ({
      id: `pending-dispatch-${now}-${i}`,
      agentType: req.agent,
      target: isCloud ? 'cloud' : 'local',
      taskId: `dispatch-${now}-${i}`,
      taskIdentifier: tid ?? '',
      title: perTicket && tid ? tid : promptTitle,
      createdAt: now + i,
    }))
    setPendingDispatches((prev) => [...prev, ...pendings])
    setTimeout(() => {
      postMessage({ type: 'fetchAllTerminals' })
      postMessage({ type: 'fetchTasks' })
    }, 800)
  }, [panelHosts])

  // ---------- Floor view-model derivation ----------
  // This ticker IS a dependency of the agent adapters below — it bakes each
  // agent's `since` string (floorAdapter.ts: sinceFromIso). An earlier comment
  // here claimed the opposite; the dependency array two lines down always said
  // otherwise, so at 1s the whole feed was re-adapted every second (derivePhase,
  // splitActivity and a per-agent question regex for every agent), cascading
  // through the memos that consume it.
  //
  // 5s is the interval useNow's own docblock prescribes for exactly this case.
  // The visible live age does not get coarser: FeedItem holds its own 1s leaf
  // heartbeat and overrides `since` for running and stalled agents, so only an
  // idle row's age text lags, by at most five seconds.
  const nowMs = useNow(5000)

  // Compose exact execution owners once, keeping this window's interactive tab
  // and reply transport when the owner runs on another device.
  const streamedFloorAgents = useMemo(
    () => composeFloorAgents(items.filter((i) => i.kind !== 'watchdog'), { pinned, workspaceRepo: workspaceRepoName, nowMs, localHostName, projectRules, projectedSessions: remoteSessions, knownProjects: managedProjectNameList }),
    [items, pinned, workspaceRepoName, nowMs, localHostName, projectRules, remoteSessions, managedProjectNameList]
  )
  // Durable Previous rows ride the SAME watch stream under an explicit marker.
  // Keep them out of the live Feed/Needs-you surfaces, then fold them into Sessions
  // with the existing live-wins dedupe for a session that is currently running.
  const floorAgents = useMemo(
    () => streamedFloorAgents.filter((agent) => !isPrevious(agent)),
    [streamedFloorAgents]
  )
  const sessionsAgents = useMemo(
    () => mergeSessionAgents(floorAgents, streamedFloorAgents.filter(isPrevious)),
    [floorAgents, streamedFloorAgents]
  )
  // Lookup back to the source UnifiedAgent for the feed row's retry / option /
  // kill actions, which need the terminal + cloud handles the FloorAgent drops.
  const unifiedById = useMemo(() => {
    const m = new Map<string, UnifiedAgent>()
    for (const i of items) m.set(i.id, i)
    return m
  }, [items])

  // Center list scoped by project filter + host filter + status/agent chips + search.
  const scopedAgents = useMemo(() => {
    let list = visibleFloorAgents(floorAgents, showBackground)
    if (projFilter) list = list.filter((a) => a.project === projFilter)
    if (hostFilter) list = list.filter((a) => (a.hostLabel ?? a.host) === hostFilter)
    if (statusChips.length) list = list.filter((a) => statusChips.some((c) => (c === 'needs' ? a.needs : a.phase === c)))
    if (abbrChips.length) list = list.filter((a) => abbrChips.includes(a.abbr))
    const q = floorSearch.trim().toLowerCase()
    if (q) list = list.filter((a) => `${a.name} ${a.branch} ${a.verb} ${a.target} ${a.project} ${a.host} ${a.hostLabel ?? ''}`.toLowerCase().includes(q))
    return list
  }, [floorAgents, showBackground, projFilter, hostFilter, statusChips, abbrChips, floorSearch])

  // Empty host filter -> show that host's recent sessions instead of a blank pane.
  // Fetch once per host (lazily), then adapt through the SAME card path as live agents.
  const hostHasNoActive = !!hostFilter && scopedAgents.length === 0
  useEffect(() => {
    if (hostHasNoActive && hostFilter && recentByHost[hostFilter] === undefined) {
      postMessage({ type: 'fetchRecentSessions', host: hostFilter })
    }
  }, [hostHasNoActive, hostFilter, recentByHost])
  const recentAgents = useMemo(
    () => (hostFilter && hostHasNoActive ? adaptRemote(recentByHost[hostFilter] ?? [], pinned, localHostName, projectRules, managedProjectNameList) : []),
    [hostFilter, hostHasNoActive, recentByHost, pinned, localHostName, projectRules, managedProjectNameList]
  )

  // PHNX-3594: the PRs board and Recap ledger are removed from the Fleet view, so
  // their derivations and the lazy `fetchRecap` sweep are gone. Previous rows
  // require no separate effect because they ride the canonical watch stream.

  const feedPartition = useMemo(() => partitionFloorAgents(scopedAgents), [scopedAgents])
  const needsAgents = feedPartition.needs
  // The needs-you section's membership, per-row reason, and ORDER all come from the CLI
  // attention rows — the extension classifies nothing. An interactive hand-back the
  // operator answers (question / permission / plan_review / declared) renders as a
  // decision card, a failure renders as a failure card, and the rest (stall / review /
  // an attention with no kind) render as plain rows. Ordering within each group is the
  // CLI attention-kind rank (sortByAttention), never a client phase/heartbeat guess.
  const decisionAgents = useMemo(
    () => sortByAttention(needsAgents.filter((a) => DECISION_KINDS.has(a.attentionKind))),
    [needsAgents]
  )
  const failedAgents = useMemo(() => needsAgents.filter((a) => a.attentionKind === 'failure'), [needsAgents])
  const questionClusters = useMemo(() => clusterByQuestion(decisionAgents), [decisionAgents])
  // Needs-you agents that aren't an interactive decision or a failure: a genuine CLI
  // stall, a review request, or an open attention the CLI raised with no kind. Ordered
  // by the CLI attention-kind rank (stall before review), most-stuck first within a kind.
  const reviewNeedsAgents = useMemo(
    () => sortByAttention(needsAgents.filter((a) => !DECISION_KINDS.has(a.attentionKind) && a.attentionKind !== 'failure')),
    [needsAgents]
  )
  // One attention-ordered stream: NEEDS YOU -> IDLE -> RUNNING -> DONE, where status
  // is a position, not a filter. Idle leads the live lane because an idle session is
  // unfinished work that has stopped progressing — the highest abandonment risk — while
  // a running one needs nothing from the operator (root AGENTS.md "Purpose"). done
  // (without an unreviewed PR — those are NEEDS YOU) is the terminal lane.
  const idleFeed = useMemo(
    () => sortAgents(feedPartition.idle, floorSort),
    [feedPartition, floorSort]
  )
  const runningFeed = useMemo(
    () => sortAgents(feedPartition.active, floorSort),
    [feedPartition, floorSort]
  )
  const doneFeed = useMemo(
    () => sortAgents(feedPartition.done, floorSort),
    [feedPartition, floorSort]
  )
  const groupedFeed = useMemo(() => [...idleFeed, ...runningFeed, ...doneFeed], [idleFeed, runningFeed, doneFeed])

  // Flatten the Agents center into a single windowable item list. Ordering mirrors the
  // original non-virtualized feed exactly so behavior (selection, scroll, attention rows)
  // stays identical — only the RENDER path is windowed.
  const feedItems: FeedVItem[] = useMemo(() => {
    const out: FeedVItem[] = []
    const addRow = (a: FloorAgent) => out.push({ kind: 'feedRow', agent: a, height: measuredHeightsRef.current.get(a.id) ?? defaultHeight('feedRow'), key: a.id })
    const addHeader = (kind: FeedVItem['kind'] & `${string}Header`, key: string, count: number) => out.push({ kind, count, height: measuredHeightsRef.current.get(key) ?? defaultHeight(kind), key } as FeedVItem)

    out.push({ kind: 'savedViews', height: measuredHeightsRef.current.get('savedViews') ?? defaultHeight('savedViews'), key: 'savedViews' })

    if (needsAgents.length > 0 || pendingPlans.length > 0) {
      addHeader('needsHeader', 'needsHeader', needsAgents.length + pendingPlans.length)
      for (const plan of pendingPlans) {
        out.push({ kind: 'planReview', plan, height: measuredHeightsRef.current.get(`plan:${plan.sessionId}`) ?? defaultHeight('planReview'), key: `plan:${plan.sessionId}` })
      }
      for (const cluster of questionClusters.filter((c) => c.length > 1)) {
        const key = `cluster:${cluster[0]?.question?.clusterKey ?? cluster.map((a) => a.id).join(',')}`
        out.push({ kind: 'needsCluster', cluster, height: measuredHeightsRef.current.get(key) ?? defaultHeight('needsCluster'), key })
      }
      for (const c of questionClusters.filter((c) => c.length === 1)) addRow(c[0])
      for (const a of failedAgents) out.push({ kind: 'failureCard', agent: a, height: measuredHeightsRef.current.get(`fail:${a.id}`) ?? defaultHeight('failureCard'), key: `fail:${a.id}` })
      for (const a of reviewNeedsAgents) addRow(a)
    }

    const attentionEvents = feedActivity.filter((event) => event.type === 'attention.receipt')
    if (attentionEvents.length > 0) {
      addHeader('activityHeader', 'activityHeader', attentionEvents.length)
      attentionEvents.forEach((event, index) => {
        const key = event.key ?? `attention-receipt-${index}`
        out.push({ kind: 'attentionReceipt', event, index, height: measuredHeightsRef.current.get(key) ?? defaultHeight('attentionReceipt'), key })
      })
    }

    if (floorGroup === 'none' && idleFeed.length > 0) {
      addHeader('idleHeader', 'idleHeader', idleFeed.length)
      for (const a of idleFeed) addRow(a)
    }

    const runningLabel = floorGroup === 'none' ? `RUNNING · ${runningFeed.length}` : `GROUPED BY ${floorGroup.toUpperCase()}${floorSubgroup !== 'none' && floorSubgroup !== floorGroup ? ` / ${floorSubgroup.toUpperCase()}` : ''} · ${groupedFeed.length}`
    out.push({ kind: 'runningHeader', count: floorGroup === 'none' ? runningFeed.length : groupedFeed.length, grouped: floorGroup !== 'none', height: measuredHeightsRef.current.get('runningHeader') ?? defaultHeight('runningHeader'), key: 'runningHeader' })
    if (cliUnavailable) {
      out.push({ kind: 'statusMessage', node: null, height: measuredHeightsRef.current.get('cli-unavailable') ?? defaultHeight('statusMessage'), key: 'cli-unavailable' })
    }
    if (hostRoster.length === 0 && !syncingHosts && lastRemoteSync > 0) {
      out.push({ kind: 'statusMessage', node: null, height: measuredHeightsRef.current.get('zero-hosts') ?? defaultHeight('statusMessage'), key: 'zero-hosts' })
    }
    if (floorAgents.length === 0 && !syncingHosts && !cliUnavailable) {
      // A follower whose stream has not established (or is still waiting on an
      // online peer) shows a distinct "connecting" state, never the confident
      // "No running sessions" (PHNX-2735) — the empty feed is not yet trustworthy.
      const emptyKey = sessionStreamDegraded ? 'stream-degraded' : 'zero-sessions'
      out.push({ kind: 'statusMessage', node: null, height: measuredHeightsRef.current.get(emptyKey) ?? defaultHeight('statusMessage'), key: emptyKey })
    }
    const hostFreshnessEntries = Object.entries(hostFreshness)
    if (hostFreshnessEntries.length > 0) {
      out.push({ kind: 'hostFreshnessLine', hosts: hostFreshnessEntries, height: measuredHeightsRef.current.get('hostFreshnessLine') ?? defaultHeight('hostFreshnessLine'), key: 'hostFreshnessLine' })
    }
    if (floorGroup === 'none') {
      for (const a of runningFeed) addRow(a)
    } else {
      for (const [k, arr] of groupAgents(groupedFeed, floorGroup)) {
        const linkedProject = managedProjects.find((p) => p.name === k)?.linearProjectName
        const groupKey = `group:${k}`
        out.push({ kind: 'groupHeader', label: k, count: arr.length, projectPill: linkedProject, height: measuredHeightsRef.current.get(groupKey) ?? defaultHeight('groupHeader'), key: groupKey })
        const subgroupActive = floorSubgroup !== 'none' && floorSubgroup !== floorGroup
        if (subgroupActive) {
          for (const [subKey, subArr] of groupAgents(arr, floorSubgroup)) {
            const linkedSubProject = managedProjects.find((p) => p.name === subKey)?.linearProjectName
            const sgKey = `subgroup:${k}:${subKey}`
            out.push({ kind: 'subgroupHeader', label: subKey, count: subArr.length, projectPill: linkedSubProject, height: measuredHeightsRef.current.get(sgKey) ?? defaultHeight('subgroupHeader'), key: sgKey })
            for (const a of subArr) addRow(a)
          }
        } else {
          for (const a of arr) addRow(a)
        }
      }
    }

    if (floorGroup === 'none' && doneFeed.length > 0) {
      addHeader('doneHeader', 'doneHeader', doneFeed.length)
      for (const a of doneFeed) addRow(a)
    }

    if (hostHasNoActive) {
      addHeader('recentHeader', `recentHeader:${hostFilter}`, recentAgents.length)
      if (recentAgents.length === 0) {
        out.push({ kind: 'recentEmpty', height: measuredHeightsRef.current.get('recentEmpty') ?? defaultHeight('recentEmpty'), key: 'recentEmpty' })
      } else {
        for (const a of recentAgents) addRow(a)
      }
    }

    return out
  }, [needsAgents.length, pendingPlans, questionClusters, failedAgents, reviewNeedsAgents, feedActivity, floorGroup, idleFeed, runningFeed, groupedFeed, doneFeed, recentAgents, hostHasNoActive, hostFilter, cliUnavailable, hostRoster.length, syncingHosts, lastRemoteSync, floorAgents.length, hostFreshness, floorSubgroup, managedProjects, sessionStreamDegraded, heightTick])

  const { scrollRef, onScroll, visibleItems, totalHeight, padTop, padBottom } = useVirtualList(feedItems, { overscan: FEED_OVERSCAN })

  // Render one virtual feed item. Kept as a plain closure so every callback used
  // by a row stays current without a giant dependency list.
  const renderFeedItem = (it: FeedVItem): React.ReactNode => {
    switch (it.kind) {
      case 'savedViews':
        return (
          <SavedViews
            views={savedViews}
            activeName={activeViewName}
            onApply={applyView}
            onSave={saveView}
            onDelete={deleteView}
            feedFilters={{
              group: floorGroup,
              onGroup: handleFloorGroup,
              subgroup: floorSubgroup,
              onSubgroup: setFloorSubgroup,
              status: statusChips,
              onToggleStatus: (s) => setStatusChips((cur) => (
                cur.includes(s) ? cur.filter((c) => c !== s) : [...cur, s]
              )),
              abbrs: abbrChips,
              availableAbbrs: Array.from(new Set(floorAgents.map((a) => a.abbr))).sort(),
              onToggleAbbr: (a) => setAbbrChips((cur) => (
                cur.includes(a) ? cur.filter((c) => c !== a) : [...cur, a]
              )),
              showBackground,
              openAttentionCount: needsAgents.length,
              onToggleBackground: () => setShowBackground((current) => !current),
            }}
          />
        )
      case 'needsHeader':
        return (
          <div className="feed-sec attn">
            <Icon name="alert" size={11} /> NEEDS YOU · {it.count}{projFilter ? ` · ${projFilter}` : ''}
            <span className="ln" />
          </div>
        )
      case 'planReview':
        return (
          <PlanReview
            plan={it.plan}
            onApprove={(edited) => approvePlan(it.plan.sessionId, edited)}
            onSendBack={(note) => sendBackPlan(it.plan.sessionId, note)}
          />
        )
      case 'needsCluster':
        return (
          <NeedsYouClusters
            clusters={[it.cluster]}
            onBatchReply={onBatchReply}
            onReplyOne={selectFloorAgent}
          />
        )
      case 'feedRow':
        return (
          <FeedRow onOpenTask={openTaskFromAgent}
            agent={it.agent}
            selected={selectedFloorAgent?.id === it.agent.id}
            plain={plain}
            onSelect={selectFloorAgent}
            error={replyErrors.get(it.agent.id)}
            onOption={onAgentOption}
            onFreeText={replyToAgent}
            onAttach={onAttachScreenshot}
            onOpenPlan={openPlanPreview}
            onOpenAttachment={openAttachmentPreview}
            onOpenTerminal={openTerminalForAgent}
          />
        )
      case 'failureCard':
        return (
          <FailureCard
            agent={it.agent}
            agents={dispatchAgents}
            onRetry={() => retryFloorAgent(it.agent)}
            onReassign={(toAgent) => reassignFloorAgent(it.agent, toAgent)}
          />
        )
      case 'activityHeader':
        return <div className="feed-sec">ACTIVITY<span className="ln" /></div>
      case 'attentionReceipt':
        return (
          <div className="fitem">
            <AttentionReceipt
              state={it.event.state ?? 'resolved'}
              source={it.event.source}
              question={typeof it.event.question === 'string' ? it.event.question : it.event.question?.text}
            />
          </div>
        )
      case 'idleHeader':
        return <div className="feed-sec" title="Unfinished work that has stopped progressing — the highest abandonment risk">IDLE · {it.count}<span className="ln" /></div>
      case 'runningHeader':
        return (
          <div className="feed-sec">{it.grouped ? `GROUPED BY ${floorGroup.toUpperCase()}${floorSubgroup !== 'none' && floorSubgroup !== floorGroup ? ` / ${floorSubgroup.toUpperCase()}` : ''} · ${it.count}` : `RUNNING · ${it.count}`}<span className="ln" />
            <span
              className={`fresh${syncingHosts ? ' syncing' : ''}${!syncingHosts && (remoteSyncError || (lastRemoteSync > 0 && nowMs - lastRemoteSync > REMOTE_STALE_MS)) ? ' stale' : ''}`}
              title={remoteSyncError
                ? `Last sync failed: ${remoteSyncError}. Click to retry (cached rows stay visible).`
                : 'Last cross-host sync. Click to refresh remote hosts now.'}
              onClick={() => { if (!syncingHosts) { setSyncingHosts(true); setRemoteSyncError(null); postMessage({ type: 'fetchHostSessions', force: true }) } }}
              role="button"
              data-testid="host-freshness-chip"
            >
              <span className="rot"><Icon name="refresh" size={11} /></span>
              {syncingHosts
                ? 'refreshing hosts…'
                : remoteSyncError
                  ? `sync failed · retry`
                  : lastRemoteSync > 0
                    ? `hosts ${sinceFromMs(Math.max(0, nowMs - lastRemoteSync))} ago`
                    : 'refresh hosts'}
            </span>
            {lastLocalSync > 0 && (
              <span className="fresh local-fresh" title="Last local session seed / event update" data-testid="local-freshness-chip">
                local {sinceFromMs(Math.max(0, nowMs - lastLocalSync))} ago
              </span>
            )}
          </div>
        )
      case 'groupHeader':
        return (
          <div className="feed-sec">
            {it.label} · {it.count}
            {it.projectPill && <span className="proj-lk">{it.projectPill}</span>}
            <span className="ln" />
          </div>
        )
      case 'subgroupHeader':
        return (
          <div className="feed-sec feed-subsec">
            {it.label} · {it.count}
            {it.projectPill && <span className="proj-lk">{it.projectPill}</span>}
            <span className="ln" />
          </div>
        )
      case 'statusMessage':
        if (it.key === 'cli-unavailable') {
          return (
            <div className="feed-empty feed-empty-warn" role="status" data-testid="cli-unavailable">
              <strong>agents CLI unavailable.</strong> Cached floor rows stay visible. Install or fix PATH with <span className="mono">agents --version</span>, then refresh hosts.
            </div>
          )
        }
        if (it.key === 'zero-hosts') {
          return (
            <div className="feed-empty" role="status" data-testid="zero-hosts">
              No hosts registered. Add a device with <span className="mono">agents devices</span>, or open Dispatch once devices are online.
            </div>
          )
        }
        if (it.key === 'stream-degraded') {
          return (
            <div className="feed-empty feed-empty-warn" role="status" data-testid="stream-degraded">
              Session stream connecting. Fleet status is not available yet.
            </div>
          )
        }
        return (
          <div className="feed-empty" role="status" data-testid="zero-sessions">
            No running sessions. Dispatch an agent from the strip above, or refresh hosts if work is running on another machine.
          </div>
        )
      case 'hostFreshnessLine':
        return (
          <div className="host-freshness-line" data-testid="per-host-freshness">
            {it.hosts.map(([host, at]) => (
              <span key={host} className="host-fresh-pill" title={`Last good data for ${host}`}>
                {host} · {sinceFromMs(Math.max(0, nowMs - at))}
              </span>
            ))}
          </div>
        )
      case 'doneHeader':
        return <div className="feed-sec">DONE TODAY · {it.count}<span className="ln" /></div>
      case 'recentHeader':
        return <div className="feed-sec">RECENT · {it.count}{hostFilter ? ` · ${hostFilter}` : ''}<span className="ln" /></div>
      case 'recentEmpty':
        return <div className="detail-empty" style={{ padding: '10px 16px' }}>No recent sessions for this host.</div>
    }
  }

  const floorRunning = useMemo(() => floorAgents.filter((a) => a.phase === 'running').length, [floorAgents])
  const floorTok = useMemo(() => floorAgents.reduce((s, a) => s + a.tok, 0) + liveThroughput, [floorAgents, liveThroughput])

  // Selected agent: only when the user explicitly picks one. No auto-select — the right
  // rail must not slam to a "WAITING ON YOU" agent nobody clicked.
  const selectedFloorAgent: FloorAgent | null = useMemo(
    () => (selectedAgentId ? sessionsAgents.find((a) => a.id === selectedAgentId) ?? null : null),
    [selectedAgentId, sessionsAgents]
  )

  // The rail's one-shot `sessions preview --json` fetch is GONE with the rail: the
  // native sidebar renders the same facts straight off the warm session stream,
  // so nothing here spawns a CLI process on selection any more.

  // Real hosts for the dispatch panel: this machine + every reachable remote.
  const floorHosts = useMemo(() => {
    const set = new Set<string>(['this-mac'])
    for (const s of remoteSessions) if (s.host && s.host !== 'this-mac') set.add(s.host)
    return [...set]
  }, [remoteSessions])

  // ---------- Floor interaction handlers ----------
  const togglePin = useCallback((id: string) => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Reply transport: dispatch on the agent's reply channel (a.reply), computed by the
  // adapter from the agent's source. Local tabs also get focused so the user sees the
  // answer land in the terminal; cloud/team deliver headlessly via the CLI. The host
  // replies with a 'replyResult' we surface inline on failure — no toast, no fake success.
  // `keystroke` (a digit or 'esc') is set when the reply must drive an interactive
  // select-list prompt (permission / plan / AskUserQuestion) rather than type free text;
  // the extension host sends it through the terminal/tmux rail instead of the label.
  const replyToAgent = useCallback((a: FloorAgent, text: string, keystroke?: string) => {
    if (a.reply.kind === 'none') {
      setReplyErrors((prev) => new Map(prev).set(a.id, a.reply.reason || 'No reply channel for this agent'))
      return
    }
    if (a.reply.kind === 'terminal' && a.reply.terminalId) {
      postMessage({ type: 'focusTerminal', terminalId: a.reply.terminalId })
    }
    setReplyErrors((prev) => { const n = new Map(prev); n.delete(a.id); return n })
    postMessage({ type: 'replyToAgent', agentId: a.id, reply: a.reply, text, keystroke })
  }, [])

  const retryFloorAgent = useCallback((a: FloorAgent) => {
    const u = unifiedById.get(a.id)
    if (u?.swarm) handleRetry(u.swarm.task_name)
    else if (u?.terminal) postMessage({ type: 'focusTerminal', terminalId: u.terminal.id })
  }, [unifiedById, handleRetry])

  const onAgentOption = useCallback((a: FloorAgent, option: string) => {
    if (option === 'Retry') retryFloorAgent(a)
    else if (option === 'View error') { const u = unifiedById.get(a.id); if (u?.terminal) postMessage({ type: 'focusTerminal', terminalId: u.terminal.id }) }
    else {
      // If this option maps to an interactive select-list keystroke (permission Approve=1
      // / Deny=esc, plan, AskUserQuestion), send that keystroke so the TUI prompt is
      // actually driven; otherwise send the label as free text.
      const idx = a.question?.options.indexOf(option) ?? -1
      const key = idx >= 0 ? a.question?.optionKeys?.[idx] : undefined
      replyToAgent(a, option, key || undefined)
    }
  }, [retryFloorAgent, replyToAgent, unifiedById])

  // Screenshot attach: the capture/attach transport isn't wired yet. Intentionally a
  // no-op (no fake success) rather than pretending it worked. TODO: wire capture path.
  const onAttachScreenshot = useCallback((_a: FloorAgent) => { /* TODO: screenshot transport pending */ }, [])

  /**
   * Open/resume the session in a real terminal (RUSH-1520). Prefers an already-
   * open local tab, then a remote tmux rail, then `agents sessions focus <id>`.
   */
  const openTerminalForAgent = useCallback((a: FloorAgent) => {
    // A PREVIOUS (crashed/ended) session resumes from the CLI's OWN recovery command,
    // device-targeted — never the local-only focusSession candidate lookup, which
    // can't see a session recovered from a remote fleet device (PHNX-3593). The host
    // rebuilds the command from the id + device, so this only picks the session.
    if (postTerminalOpenForAgent(a, postMessage)) return
    const u = unifiedById.get(a.id)
    if (u?.terminal) {
      postMessage({ type: 'focusTerminal', terminalId: u.terminal.id })
    }
  }, [unifiedById])

  const resumeAgentOnDevice = useCallback((a: FloorAgent, device: string) => {
    if (!device) return
    const message = previousResumeMessage(a, device)
    if (message) postMessage(message)
  }, [])

  // Bulk reconnect: resume/focus every selected session. Each opens on its OWNING
  // machine via the same single-session path (the CLI decides attach vs recover and
  // routes remote sessions to their host) — so a whole project's worth of lost work
  // comes back in one action. The extension owns launching; this only posts intents.
  const resumeManyAgents = useCallback((list: FloorAgent[]) => {
    for (const a of list) openTerminalForAgent(a)
  }, [openTerminalForAgent])

  const onBatchReply = useCallback((cluster: FloorAgent[], option: string) => {
    for (const a of cluster) replyToAgent(a, option)
  }, [replyToAgent])

  // Reassign a failed agent's work to a different installed agent (FailureCard action).
  const reassignFloorAgent = useCallback((a: FloorAgent, toAgent: string) => {
    postMessage({ type: 'reassignAgent', sessionId: a.id, host: a.host, toAgent })
  }, [])

  const openPlanPreview = useCallback((a: FloorAgent, plan: PlanFile) => {
    postMessage({ type: 'openPlanPreview', path: plan.path, kind: plan.kind, host: a.host })
  }, [])

  const openAttachmentPreview = useCallback((a: FloorAgent, attachment: FloorAttachment) => {
    postMessage({ type: 'openAttachmentPreview', path: attachment.path, mediaType: attachment.mediaType, host: a.host })
  }, [])

  // Plan-review actions (Floor after-dispatch): approve as-is/edited, or send back a note.
  const approvePlan = useCallback((sessionId: string, edited?: PlanStep[]) => {
    postMessage({ type: 'approvePlan', sessionId, edited })
    setPendingPlans((prev) => prev.filter((p) => p.sessionId !== sessionId))
  }, [])
  const sendBackPlan = useCallback((sessionId: string, note: string) => {
    postMessage({ type: 'sendBackPlan', sessionId, note })
    setPendingPlans((prev) => prev.filter((p) => p.sessionId !== sessionId))
  }, [])

  // ---------- Sub-tab strip: fixed-center selection + dynamic task tabs ----------
  // Selecting a fixed center clears any active task tab so the center pane returns.
  const selectCenter = useCallback((c: CenterMode) => {
    setActiveTaskTab(null)
    setCenter(c)
  }, [])

  const openTaskFromTicket = useCallback((ticket: FloorTicket) => {
    setOpenTaskTabs((prev) => openTaskTab(prev, { id: ticket.id, title: ticket.title, source: ticket.source }))
    setActiveTaskTab(ticket.id)
  }, [])

  // Open (or focus) a task tab from an agent card. Keys off the agent's linked ticket
  // when it has one (so it collapses with the ticket's own tab); otherwise the agent id.
  const openTaskFromAgent = useCallback((a: FloorAgent) => {
    const id = a.ticket ?? a.id
    const source: TicketSource = a.ticket?.startsWith('#') ? 'GH' : 'LN'
    setOpenTaskTabs((prev) => openTaskTab(prev, { id, title: a.ticket ?? a.name, source }))
    setActiveTaskTab(id)
  }, [])

  const selectTaskTab = useCallback((id: string) => setActiveTaskTab(id), [])

  const handleCloseTaskTab = useCallback((id: string) => {
    // Compute both next states from current state in one pass — no nested setState
    // (an updater must be pure; nesting one inside another ran the reducer twice
    // under StrictMode and lost the next active id). Deps keep the reads fresh.
    const res = closeTaskTab(openTaskTabs, activeTaskTab, id)
    setOpenTaskTabs(res.tabs)
    setActiveTaskTab(res.activeId)
  }, [openTaskTabs, activeTaskTab])

  const onScope = useCallback((value: string) => {
    if (value === '__queue') { setCenter('backlog'); return }
    if (value === '__recap') { setCenter('recap'); return }
    if (value === '__needs') {
      // A REAL needs-only view: toggle the same 'needs' status chip the controls bar
      // and saved views drive, so one filter mechanism serves all three surfaces.
      setCenter('agents'); setProjFilter(null); setHostFilter(null)
      setStatusChips((cur) => (cur.includes('needs') ? cur.filter((c) => c !== 'needs') : ['needs']))
      return
    }
    if (value.startsWith('host:')) {
      const h = value.slice(5)
      setCenter('agents'); setProjFilter(null)
      setHostFilter((cur) => (cur === h ? null : h)) // click again to clear
      // Scoping to a host replaces the needs narrowing, mirroring how '__needs'
      // replaces the project/host scope — the smart views are mutually exclusive.
      setStatusChips((cur) => cur.filter((c) => c !== 'needs'))
      return
    }
    setCenter('agents')
    setHostFilter(null)
    setProjFilter(value || null)
    // Project scope and 'All agents' ('') both drop the needs narrowing too.
    setStatusChips((cur) => cur.filter((c) => c !== 'needs'))
  }, [])

  // Selecting a session no longer opens a rail — it points the ONE preview (the
  // native sidebar) at that session. `selectedAgentId` survives only as the row
  // highlight, so the list still shows what you picked.
  //
  // The click/expand split stays exactly as PHNX-3879 left it: the ROW selects,
  // the chevron (which stops propagation) expands the card in place.
  const selectSession = useCallback((agent: FloorAgent) => {
    setSelectedAgentId(agent.id)
    if (!agent.sessionId) return
    postMessage({ type: 'session.select', sessionId: agent.sessionId, host: agent.host })
  }, [])

  const selectFloorAgent = useCallback((id: string) => {
    setCenter('agents')
    setSelectedAgentId(id)
    const agent = sessionsAgents.find((a) => a.id === id)
    if (agent?.sessionId) postMessage({ type: 'session.select', sessionId: agent.sessionId, host: agent.host })
  }, [sessionsAgents])

  // Resolve the active task tab (if any) back to a bench FlatTask so its detail renders.
  const activeTab = activeTaskTab ? openTaskTabs.find((t) => t.id === activeTaskTab) ?? null : null
  const activeTabTask: FlatTask | null = activeTab
    ? (() => {
        const ut = unifiedTasks.find((t) => t.id === activeTab.id || t.metadata.identifier === activeTab.id)
        return ut
          ? { id: ut.id, source: ut.source, title: ut.title, description: ut.description, status: ut.status, priority: ut.priority, metadata: ut.metadata }
          : null
      })()
    : null
  // Only render a bar for centers that HAVE one (agents/backlog); a task tab suppresses it.
  const controlsMode = activeTaskTab ? null : floorControlsMode(center)

  const centerContent = activeTab ? (
    <div className="feed sw-tasktab-pane">
      <div className="sw-bench-detail">
        {activeTabTask ? (
          <TaskDetail
            task={activeTabTask}
            onDispatch={(t) => openDispatch({ ticketId: t.id })}
            onDismiss={() => handleCloseTaskTab(activeTab.id)}
            onOpenExternal={(url) => postMessage({ type: 'openExternal', url })}
          />
        ) : (
          <div className="detail-empty" style={{ flexDirection: 'column', gap: 12 }}>
            <span>{activeTab.title}</span>
            <button className="disp" onClick={() => openDispatch({ ticketId: activeTab.id })}>
              <Icon name="zap" size={12} /> Dispatch
            </button>
          </div>
        )}
      </div>
    </div>
  ) : center === 'sessions' ? (
    <SessionsPane
      agents={sessionsAgents}
      onToggleStar={(a) => togglePin(a.id)}
      onResume={openTerminalForAgent}
      onResumeOnDevice={resumeAgentOnDevice}
      onResumeMany={resumeManyAgents}
      devices={fleetDevices}
      onSelect={selectSession}
      selectedId={selectedAgentId}
      streamDegraded={sessionStreamDegraded}
      managedProjectNames={managedProjectNameList}
    />
  ) : (
    // PHNX-3594: Backlog (lives in BENCH), Recap, and PRs are removed from the
    // Fleet view. The only remaining non-sessions center is the Agents feed.
    <div className="feed-col" ref={scrollRef} onScroll={onScroll}>
      <div className="feed" style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${padTop}px)` }}>
          {visibleItems.map((it) => (
            <MeasuredRow key={it.key} vKey={it.key} onMeasure={recordHeight}>
              {renderFeedItem(it)}
            </MeasuredRow>
          ))}
          {/* bottom spacer keeps the scrollbar honest */}
          <div style={{ height: padBottom }} aria-hidden />
        </div>
      </div>
    </div>
  )

  return (
    <div className="sw-floor-dashboard" style={{ padding: 0, overflow: 'hidden' }}>
      {/* PHNX-3594 declutter: drop the center counter bar (Sessions/Agents/Backlog/
          …) — the Fleet view IS the session list. Dispatch now lives in the top header
          (PHNX-3925), so the sub-tab strip only renders when open task tabs exist —
          otherwise it collapsed to a blank full-width band with a stranded button. */}
      {openTaskTabs.length > 0 && (
        <FloorSubtabs
          fixed={[]}
          center={center}
          taskTabs={openTaskTabs}
          activeTaskTab={activeTaskTab}
          onSelectCenter={selectCenter}
          onSelectTaskTab={selectTaskTab}
          onCloseTaskTab={handleCloseTaskTab}
        />
      )}

      {controlsMode && (
        <FloorControls
          mode={controlsMode}
          needsCount={needsAgents.length}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          plain={plain}
          onTogglePlain={() => setPlain((o) => !o)}
          sort={floorSort}
          onSort={setFloorSort}
          ticketGroup={ticketGroup}
          onTicketGroup={handleTicketGroup}
          ticketSubgroup={ticketSubgroup}
          onTicketSubgroup={setTicketSubgroup}
          ticketSort={ticketSort}
          onTicketSort={setTicketSort}
          srcFilter={ticketSrc}
          onToggleSrc={(src) => setTicketSrc((p) => ({ ...p, [src]: !p[src] }))}
        />
      )}

      <div className="page" style={{ flex: 1, minHeight: 0, height: 'auto' } as React.CSSProperties}>
        {/* PHNX-3594 declutter: the left icon rail (FloorRail) and its expanded
            FloorSidebar are removed from the Fleet view. Their scopes (Backlog /
            Recap / Projects / Devices) are gone or moved to Settings; Dispatch stays
            pinned in the header sub-tab strip. The session list renders full-width. */}
        {/* The Fleet detail rail is GONE (PHNX-3939 follow-up). There is now ONE
            session preview in the extension — the native agentsPanel.terminal
            sidebar — and a row click points it at that session ('session.select').
            The rail's three real actions moved there: Focus and Resume in its
            header, the reply box in its footer. Removing it also removes the class
            of defect PHNX-3938 and PHNX-3592 chased: a persisted layout pref
            restoring a blank third-width column with nothing selected. The list is
            full width, always. */}
        {centerContent}
      </div>

      {cardDragActive && (
        <div
          className="sw-quick-dispatch-dropzone"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
          onDrop={(e) => {
            e.preventDefault()
            const text = e.dataTransfer.getData('text/plain')
            setCardDragActive(false)
            if (text) openDispatch({ prefill: text })
          }}
        >
          Drop to start an agent with this issue
        </div>
      )}

      {/* Intake Q&A -- teammates waiting on a human answer */}
      {intakeTeams.length > 0 && (
        <div className="sw-intake-section">
          {intakeTeams.map((team) => (
            <IntakeBanner key={team.team} team={team.team} teammates={team.agents} />
          ))}
        </div>
      )}

      {/* The single consolidated Dispatch panel — replaces the 5 legacy dispatch
          surfaces. Self-manages its open state via the `open` prop (returns null when
          closed) and re-seeds prefill/ticket each time it opens. */}
      <DispatchPanel
        open={dispatchOpen}
        tasks={unifiedTasks}
        agents={dispatchAgents}
        hosts={panelHosts}
        targets={dispatchTargets}
        prefill={dispatchPrefill}
        prefillTicketId={dispatchPrefillTicketId}
        onClose={() => setDispatchOpen(false)}
        onDispatch={onDispatchRequest}
        onDraftPrompt={onDraftPrompt}
        draftResult={draftResult}
        devices={dispatchDevices}
        deviceRepos={deviceRepos}
        deviceSync={deviceSync}
        onRequestRepoSync={onRequestRepoSync}
        onManageDevices={onManageDevices}
        onDeviceDispatch={onDeviceDispatch}
      />
    </div>
  )
}


/**
 * Inline banner for teammates waiting on human input.
 *
 * One banner per team; shows which teammates are blocked and provides a
 * single textarea whose submit forwards to `agents factory answer <team>`
 * via the extension backend. Oldest input_required teammate is the one
 * that gets the message (matches CLI behavior).
 */
function IntakeBanner({ team, teammates }: { team: string; teammates: { teammate: string; agentId: string }[] }) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const names = teammates.map((t) => t.teammate).join(', ')

  const submit = () => {
    const body = text.trim()
    if (!body || submitting) return
    setSubmitting(true)
    postMessage({ type: 'factoryAnswer', teamId: team, text: body })
    setText('')
    // Leave submitting=true briefly so the button disables until the next
    // status refresh removes this teammate from input_required.
    setTimeout(() => setSubmitting(false), 1500)
  }

  return (
    <div className="sw-intake-banner" role="status">
      <div className="sw-intake-banner-head">
        <Icon name="zap" size={13} />
        <span className="sw-intake-banner-title">
          {teammates.length === 1 ? 'Waiting on you' : `${teammates.length} teammates waiting on you`}
        </span>
        <span className="sw-intake-banner-sub">
          {team} · {names}
        </span>
      </div>
      <div className="sw-intake-banner-form">
        <textarea
          className="sw-intake-banner-input"
          placeholder="Your answer..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          rows={2}
        />
        <button
          type="button"
          className="sw-btn primary sm"
          onClick={submit}
          disabled={!text.trim() || submitting}
        >
          Send
        </button>
      </div>
    </div>
  )
}

type IdentityLabel = { text: string; variant: 'plain' | 'cloud' | 'team' | 'plan' | 'ralph' | 'auto' }

function identityLabel(item: UnifiedAgent): IdentityLabel {
  const termLabel = item.terminal?.label?.trim()
  if (termLabel) return { text: termLabel, variant: 'plain' }
  if (item.kind === 'team') {
    const n = item.teamAgents?.length ?? 0
    return { text: n > 0 ? `TEAM · ${n}` : 'TEAM', variant: 'team' }
  }
  if (item.kind === 'cloud' || item.mode === 'cloud') {
    return { text: 'CLOUD', variant: 'cloud' }
  }
  if (item.mode === 'plan') return { text: 'PLAN', variant: 'plan' }
  if (item.mode === 'ralph') return { text: 'RALPH', variant: 'ralph' }
  if (item.mode === 'auto') return { text: 'AUTO', variant: 'auto' }
  return { text: item.terminal?.autoLabel || item.displayName || item.agentType, variant: 'plain' }
}

function statusPhrase(item: UnifiedAgent): { word: string; tone: 'running' | 'idle' | 'failed' | 'completed' | 'waiting'; when: string } {
  if (item.status === 'failed') {
    return { word: 'Failed', tone: 'failed', when: item.timestamp ? relTime(item.timestamp) : '' }
  }
  if (item.status === 'completed') {
    return { word: 'Done', tone: 'completed', when: item.timestamp ? relTime(item.timestamp) : '' }
  }
  if (item.terminal?.waitingForInput && (item.status === 'running' || item.active)) {
    return { word: 'Waiting', tone: 'waiting', when: item.duration || (item.timestamp ? relTime(item.timestamp) : '') }
  }
  if (item.status === 'running' || item.active) {
    return { word: 'Running', tone: 'running', when: item.duration || (item.timestamp ? relTime(item.timestamp) : '') }
  }
  return { word: 'Idle', tone: 'idle', when: item.timestamp ? relTime(item.timestamp) : '' }
}

// Memoized: with identity-stable `item` refs (see useStableList) and stable
// onSelect/onRetry callbacks, a token streamed by one agent re-renders ONLY
// that agent's card instead of all of them. Default shallow prop compare is
// correct here because every field change rebuilds that agent's item object.
const AgentCard = React.memo(function AgentCard({ item, selected, onSelect, dimmed, onRetry }: {
  item: UnifiedAgent
  selected: boolean
  onSelect: (id: string) => void
  // Recent/completed agents render with a muted appearance to distinguish
  // them visually from currently-active ones.
  dimmed?: boolean
  // Only shown for completed/stopped swarm agents — lets the user rerun a
  // finished task without re-dispatching through the modal.
  onRetry?: (taskName: string) => void
}) {
  const label = identityLabel(item)
  const status = statusPhrase(item)
  const name = item.teammateName
    ? item.teammateName
    : item.agentType.charAt(0).toUpperCase() + item.agentType.slice(1)
  const filesCount = item.files.length
  const hasCounts = item.toolCalls > 0 || filesCount > 0
  const canRetry = !item.active && item.swarm && onRetry

  return (
    <button
      type="button"
      className={`sw-floor-agent-card ${selected ? 'selected' : ''} ${dimmed ? 'dimmed' : ''}`}
      onClick={() => onSelect(item.id)}
      aria-pressed={selected}
    >
      <div className="sw-floor-agent-card-top">
        <AgentAvatar id={item.agentType} size={24} />
        <span className="sw-floor-agent-card-name">{name}</span>
        <span className={`sw-floor-agent-card-chunk ${label.variant}`}>{label.text}</span>
        {canRetry && (
          <span
            role="button"
            tabIndex={0}
            className="sw-floor-agent-card-retry"
            onClick={(e) => { e.stopPropagation(); onRetry!(item.swarm!.task_name) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); e.stopPropagation()
                onRetry!(item.swarm!.task_name)
              }
            }}
            title="Retry this task"
          >
            Retry
          </span>
        )}
      </div>

      <div className="sw-floor-agent-card-status-line">
        <span className={`sw-floor-agent-card-status-word ${status.tone}`}>{status.word}</span>
        {status.when && <span>{status.tone === 'running' ? status.when : `· ${status.when}`}</span>}
      </div>

      {item.activity && (
        <div className="sw-floor-agent-card-activity">{item.activity}</div>
      )}

      {(hasCounts || item.linearIssue || item.prUrl) && (
        <div className="sw-floor-agent-card-meta">
          {hasCounts && (
            <span className="sw-floor-agent-card-meta-counts">
              {item.toolCalls > 0 && <>{item.toolCalls} tools</>}
              {item.toolCalls > 0 && filesCount > 0 && <span className="sw-floor-agent-card-meta-sep"> · </span>}
              {filesCount > 0 && <>{filesCount} files</>}
            </span>
          )}
          <span className="sw-floor-agent-card-meta-spacer" />
          {item.linearIssue && <span className="sw-tag-linear">{item.linearIssue}</span>}
          {item.prUrl && <span className="sw-tag-pr">#{item.prUrl.match(/\/pull\/(\d+)/)?.[1] || 'PR'}</span>}
        </div>
      )}
    </button>
  )
})

// Format a Linear dueDate (YYYY-MM-DD) into short human text for the card.
// Picks the largest unit that's still informative: minutes if <1h away,
// hours if <24h, days if <14d, else absolute date. "Due in 45m / 3h / 2d".
// The reference point is end-of-day local-tz because Linear dueDate has no
// time component and a task due "today" isn't late until the day is over.
function formatDueDate(iso: string | undefined): { label: string; tone: 'overdue' | 'soon' | 'normal' } | null {
  if (!iso) return null
  const parts = iso.split('T')[0].split('-')
  if (parts.length < 3) return null
  const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2])
  if (!y || !m || !d) return null
  const due = new Date(y, m - 1, d, 23, 59, 59, 999)
  const diffMs = due.getTime() - Date.now()
  const absMs = Math.abs(diffMs)
  const mins = Math.max(1, Math.round(absMs / 60000))
  const hours = Math.round(absMs / 3600000)
  const days = Math.round(absMs / 86400000)
  if (diffMs < 0) {
    if (absMs < 3600000) return { label: `Overdue ${mins}m`, tone: 'overdue' }
    if (absMs < 86400000) return { label: `Overdue ${hours}h`, tone: 'overdue' }
    return { label: `Overdue ${days}d`, tone: 'overdue' }
  }
  if (diffMs < 3600000) return { label: `Due in ${mins}m`, tone: 'soon' }
  if (diffMs < 86400000) return { label: `Due in ${hours}h`, tone: 'soon' }
  if (days <= 3) return { label: `Due in ${days}d`, tone: 'soon' }
  if (days <= 14) return { label: `Due in ${days}d`, tone: 'normal' }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return { label: `Due ${MONTHS[m - 1]} ${d}`, tone: 'normal' }
}

// Dispatch card with agent picker
function DispatchCard({ task, onOpen, onOpenInBench, onDragStateChange }: { task: UnifiedTask; onOpen: (task: UnifiedTask) => void; onOpenInBench?: (taskId: string) => void; onDragStateChange?: (dragging: boolean) => void }) {
  const priorityCls = task.priority === 'urgent' ? 'urgent' : task.priority === 'high' ? 'high' : 'medium'
  const repo = task.metadata.repo
  // Owner prefix ("muqsitnawaz/") bloats the 280px card; show the bare repo
  // name and keep the full slug in the hover tooltip.
  const repoName = repo ? repo.split('/').pop() : null
  const due = formatDueDate(task.metadata.dueDate)
  const repoHref = repo ? `https://github.com/${repo}` : null

  const stopOpen = (e: React.MouseEvent) => { e.stopPropagation() }

  // Use div role=button (not a <button> element) so we can nest an anchor
  // (the repo chip via <ExtLink>) without invalid HTML. Nesting <a> inside
  // <button> is spec-invalid and caused React/VS Code to silently drop the
  // anchor click — that was the original "repo chip doesn't open" bug.
  return (
    <div
      role="button"
      tabIndex={0}
      data-foreman-id={`task-card-${task.metadata.identifier || task.id.slice(0, 8)}`}
      className="sw-queue-card sw-queue-card-clickable"
      onClick={() => onOpen(task)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(task)
        }
      }}
      draggable
      onDragStart={(e) => {
        const label = task.metadata.identifier ? `${task.metadata.identifier}: ${task.title}` : task.title
        e.dataTransfer.setData('text/plain', label)
        e.dataTransfer.effectAllowed = 'copy'
        // Deferred: synchronous DOM mutation inside dragstart cancels the
        // drag in Chromium, and the dropzone strip mounts on this signal.
        setTimeout(() => onDragStateChange?.(true), 0)
      }}
      onDragEnd={() => onDragStateChange?.(false)}
    >
      <div className="sw-queue-card-header">
        <div className={`sw-queue-priority-led ${priorityCls}`} />
        <span className="sw-queue-badge">{task.metadata.identifier || task.id.slice(0, 8)}</span>
        {repoHref ? (
          <ExtLink
            className="sw-queue-repo-chip mono"
            href={repoHref}
            onMouseDown={stopOpen}
            title={`Open ${repo} on GitHub`}
            style={{ marginLeft: 'auto' }}
          >
            {repoName}
          </ExtLink>
        ) : repo ? (
          <span className="sw-queue-repo-chip mono" title={repo} style={{ marginLeft: 'auto' }}>{repoName}</span>
        ) : null}
        {onOpenInBench && (
          <button
            type="button"
            className="sw-queue-bench-btn"
            title="Open in Bench"
            aria-label="Open in Bench"
            onClick={(e) => { e.stopPropagation(); onOpenInBench(task.id) }}
            onMouseDown={stopOpen}
            style={!repo ? { marginLeft: 'auto' } : undefined}
          >
            <Icon name="external" size={11} />
          </button>
        )}
      </div>
      <div className="sw-queue-title">{task.title}</div>
      {due && (
        <div className="sw-queue-meta-row">
          <span className={`sw-queue-due ${due.tone}`}>{due.label}</span>
        </div>
      )}
    </div>
  )
}
