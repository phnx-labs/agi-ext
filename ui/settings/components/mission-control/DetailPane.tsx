import React, { useEffect, useState } from 'react'
import type { TaskSummary, TerminalDetail as TerminalInfo, AgentDetail } from '../../types'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './icons'
import { ExtLink } from '../common'
import { renderTodoDescription, renderMarkdown } from '../../utils/markdown'
import { CloudActivityFeed } from './CloudActivityFeed'
import { TerminalExpandedDetail } from './TerminalDetail'
import { WatchdogDetail } from './WatchdogDetail'
import { statusPhrase, type UnifiedAgent } from './UnifiedAgentsPane'

const IDLE_AFTER_MS = 2 * 60 * 1000

function kindBadge(kind: UnifiedAgent['kind']): string {
  switch (kind) {
    case 'terminal': return 'terminal'
    case 'headless': return 'headless'
    case 'cloud': return 'cloud'
    case 'team': return 'team'
    case 'watchdog': return 'watchdog'
  }
}

function friendlyRelTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Math.max(0, nowMs - then)
  if (diff < 10_000) return 'Just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day}d ago`
  return `${Math.floor(day / 7)}w ago`
}

function DetailStatusRow({ item, onFocusTerminal }: { item: UnifiedAgent; onFocusTerminal: (t: TerminalInfo) => void }) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])
  const tsMs = item.timestamp ? new Date(item.timestamp).getTime() : NaN
  const staleMs = Number.isFinite(tsMs) ? nowMs - tsMs : 0
  const stale = staleMs > IDLE_AFTER_MS
  const effectiveItem: UnifiedAgent =
    item.status === 'running' && stale ? { ...item, status: 'idle', active: false } : item
  const phrase = statusPhrase(effectiveItem)
  const rel = friendlyRelTime(item.timestamp, nowMs)
  const focus = item.terminal ? () => onFocusTerminal(item.terminal!) : undefined
  const clickProps = focus
    ? { onClick: focus, role: 'button' as const, tabIndex: 0, style: { cursor: 'pointer' as const } }
    : {}
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 14,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          {...clickProps}
          className={`sw-badge ${phrase.tone === 'completed' ? 'ok' : phrase.tone}`}
          title={focus ? 'Focus terminal' : undefined}
        >
          {phrase.word}
        </span>
        {item.prUrl && (
          <ExtLink
            href={item.prUrl}
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--brand)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Icon name="external" size={10} /> PR
          </ExtLink>
        )}
      </div>
      {rel && (
        <span className="sw-pill" {...clickProps} title={focus ? 'Focus terminal' : undefined}>
          {rel}
        </span>
      )}
    </div>
  )
}

export function DetailPane({ item, previewCard, hasPreviewData = false, onClose, onFocusTerminal, onRetry, onKill, loading, degraded, error }: {
  item: UnifiedAgent
  /** Picker-parity preview card (PHNX-2973), rendered at the top of the body. */
  previewCard?: React.ReactNode
  /** True once the card's digest is loaded — suppresses the terminal detail's
   *  own duplicate msgs/tools/recent-files so there's one source of truth. */
  hasPreviewData?: boolean
  onClose: () => void
  onFocusTerminal: (t: TerminalInfo) => void
  onRetry: (taskName: string) => void
  onKill: (taskName: string) => void
  loading?: boolean
  degraded?: boolean
  error?: string | null
}) {
  const isActive = item.active
  const hasBodyContent = Boolean(
    item.kind === 'watchdog' ||
    item.terminal ||
    (item.kind === 'team' && item.swarm) ||
    ((item.kind === 'headless' || item.kind === 'cloud') && item.agent)
  )

  let bodyContent: React.ReactNode
  if (error && !hasBodyContent) {
    bodyContent = (
      <div className="sw-detail-state sw-detail-state-error" data-testid="detail-error" role="alert">
        <span className="sw-detail-state-icon"><Icon name="alert" size={14} /></span>
        <span className="sw-detail-state-title">Detail unavailable</span>
        <span className="sw-detail-state-body">{error}</span>
      </div>
    )
  } else if (degraded && !hasBodyContent) {
    bodyContent = (
      <div className="sw-detail-state sw-detail-state-degraded" data-testid="detail-degraded" role="status">
        <span className="sw-detail-state-icon"><Icon name="clock" size={14} /></span>
        <span className="sw-detail-state-title">Data is stale</span>
        <span className="sw-detail-state-body">The upstream snapshot is out of date. Details will refresh when the connection recovers.</span>
      </div>
    )
  } else if (loading && !hasBodyContent) {
    bodyContent = (
      <div className="sw-detail-state sw-detail-state-loading" data-testid="detail-loading" role="status" aria-busy="true">
        <span className="sw-detail-state-icon"><Icon name="loader" size={14} /></span>
        <span className="sw-detail-state-title">Loading details…</span>
        <div className="sw-detail-skeleton" style={{ width: '100%', maxWidth: 280, marginTop: 4 }}>
          <div className="sw-detail-skeleton-row long" />
          <div className="sw-detail-skeleton-row medium" />
          <div className="sw-detail-skeleton-row short" />
          <div className="sw-detail-skeleton-row long" />
        </div>
      </div>
    )
  } else if (!hasBodyContent) {
    bodyContent = (
      <div className="sw-detail-state" data-testid="detail-empty" role="status">
        <span className="sw-detail-state-icon"><Icon name="inbox" size={14} /></span>
        <span className="sw-detail-state-title">No details yet</span>
        <span className="sw-detail-state-body">This agent has no recorded activity. Details will appear once it starts working.</span>
      </div>
    )
  } else {
    bodyContent = (
      <>
        <DetailStatusRow item={item} onFocusTerminal={onFocusTerminal} />

        {previewCard}
        {item.kind === 'watchdog' && <WatchdogDetail events={item.watchdogEvents ?? []} />}
        {item.terminal && <TerminalExpandedDetail terminal={item.terminal} hideActivityStats={hasPreviewData} />}
        {item.kind === 'team' && item.swarm && <TeamDetail swarm={item.swarm} onRetry={onRetry} onKill={onKill} />}
        {(item.kind === 'headless' || item.kind === 'cloud') && item.agent && (
          <AgentDetailView agent={item.agent} swarm={item.swarm} onRetry={onRetry} onKill={onKill} />
        )}
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, height: '100%', flex: 1 }}>
      <div className="sw-mc-pane-head">
        <AgentAvatar id={item.agentType} size={20} />
        <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {item.displayName}
        </span>
        <span className={`sw-unified-kind-badge ${item.kind}`}>{kindBadge(item.kind)}</span>
        {item.cloudProvider && <span className="mono sw-unified-provider">{item.cloudProvider}</span>}
        <div className="sw-spacer" />
        {item.swarm && (
          <>
            <button className="sw-btn secondary sm" onClick={() => onRetry(item.swarm!.task_name)}>
              <Icon name="refresh" size={11} />
              Retry
            </button>
            {isActive && (
              <button className="sw-btn danger sm" onClick={() => onKill(item.swarm!.task_name)}>
                <Icon name="x" size={11} />
                Kill
              </button>
            )}
          </>
        )}
        {item.terminal && (
          <button className="sw-btn secondary sm" onClick={() => onFocusTerminal(item.terminal!)}>
            <Icon name="terminal" size={11} />
            Focus
          </button>
        )}
        <button className="sw-btn secondary sm" onClick={onClose} aria-label="Close detail pane">
          <Icon name="x" size={11} />
        </button>
      </div>

      <div className="sw-mc-pane-body">
        {bodyContent}
      </div>
    </div>
  )
}


function TeamDetail({ swarm, onRetry, onKill }: { swarm: TaskSummary; onRetry: (n: string) => void; onKill: (n: string) => void }) {
  const isActive = swarm.status_counts.running > 0
  return (
    <div className="sw-unified-detail-content">
      <div className="sw-unified-detail-section">
        <div className="sw-section-label">Agents</div>
        <div className="sw-unified-team-agents">
          {swarm.agents.map((a) => {
            const statusClass = a.status === 'running' ? 'running' : a.status === 'completed' ? 'ok' : a.status === 'failed' ? 'failed' : 'idle'
            const lastAction = a.bash_commands?.slice(-1)[0] || a.files_modified?.slice(-1)[0] || a.last_messages?.slice(-1)[0]?.slice(0, 80) || ''
            return (
              <div key={a.agent_id} className="sw-unified-team-agent">
                <AgentAvatar id={a.agent_type} size={16} />
                <span style={{ fontSize: 12, fontWeight: 550, textTransform: 'capitalize' }}>{a.agent_type}</span>
                <span className={`sw-badge ${statusClass}`}>{a.status}</span>
                <div className="sw-spacer" />
                {a.duration && <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>{a.duration}</span>}
                {a.pr_url && (
                  <ExtLink href={a.pr_url} className="mono" style={{ fontSize: 10.5, color: 'var(--brand)' }}>
                    <Icon name="external" size={10} /> PR
                  </ExtLink>
                )}
                {lastAction && (
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)', gridColumn: '1 / -1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: 24 }}>
                    {lastAction}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="sw-unified-detail-actions">
        <button className="sw-btn secondary sm" onClick={() => onRetry(swarm.task_name)}>
          <Icon name="refresh" size={11} />
          Retry
        </button>
        {isActive && (
          <button className="sw-btn danger sm" onClick={() => onKill(swarm.task_name)}>
            <Icon name="x" size={11} />
            Kill
          </button>
        )}
      </div>
    </div>
  )
}

function AgentDetailView({ agent, swarm, onRetry, onKill }: { agent: AgentDetail; swarm?: TaskSummary; onRetry: (n: string) => void; onKill: (n: string) => void }) {
  const isActive = agent.status === 'running'
  const isCloud = agent.mode === 'cloud' || !!agent.cloud_provider
  const allFiles = [...(agent.files_created || []), ...(agent.files_modified || [])]

  if (isCloud) {
    return (
      <div className="sw-unified-detail-content">
        {agent.repo_owner && agent.repo_name && (
          <div className="sw-unified-detail-section">
            <div className="sw-section-label">Repository</div>
            <div className="mono" style={{ fontSize: 12 }}>{agent.repo_owner}/{agent.repo_name}</div>
          </div>
        )}
        {agent.prompt && (
          <div className="sw-unified-detail-section">
            <div className="sw-section-label">Task</div>
            <div className="sw-unified-detail-text sw-cloud-prompt">
              {renderTodoDescription(agent.prompt, false)}
            </div>
          </div>
        )}
        {(agent.cloud_summary || isActive) && (
          <div className="sw-unified-detail-section">
            <div className="sw-section-label">Activity</div>
            {agent.cloud_summary ? (
              <CloudActivityFeed summary={agent.cloud_summary} />
            ) : (
              <div className="sw-unified-detail-text" style={{ color: 'var(--ds-text-dim)', fontStyle: 'italic' }}>
                Agent is running, no output yet...
              </div>
            )}
          </div>
        )}
        {swarm && (
          <div className="sw-unified-detail-actions">
            <button className="sw-btn secondary sm" onClick={() => onRetry(swarm.task_name)}>
              <Icon name="refresh" size={11} />
              Retry
            </button>
            {isActive && (
              <button className="sw-btn danger sm" onClick={() => onKill(swarm.task_name)}>
                <Icon name="x" size={11} />
                Stop
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="sw-unified-detail-content">
      {agent.prompt && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Task</div>
          <div className="sw-unified-detail-text">
            {renderTodoDescription(agent.prompt.slice(0, 500), false)}
          </div>
        </div>
      )}
      {agent.last_messages && agent.last_messages.length > 0 && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Activity</div>
          <div className="sw-activity-feed">
            {agent.last_messages
              .filter((m) => typeof m === 'string' && m.trim().length > 0)
              .map((m, i) => (
                <div key={i} className="sw-activity-msg md">{renderMarkdown(m)}</div>
              ))}
          </div>
        </div>
      )}
      {allFiles.length > 0 && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Files ({allFiles.length})</div>
          <div className="sw-unified-detail-files">
            {allFiles.slice(0, 8).map((f) => (
              <span key={f} className="mono sw-unified-file-pill">{f.split('/').pop()}</span>
            ))}
            {allFiles.length > 8 && <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>+{allFiles.length - 8} more</span>}
          </div>
        </div>
      )}
      {swarm && (
        <div className="sw-unified-detail-actions">
          <button className="sw-btn secondary sm" onClick={() => onRetry(swarm.task_name)}>
            <Icon name="refresh" size={11} />
            Retry
          </button>
          {isActive && (
            <button className="sw-btn danger sm" onClick={() => onKill(swarm.task_name)}>
              <Icon name="x" size={11} />
              Stop
            </button>
          )}
        </div>
      )}
    </div>
  )
}
