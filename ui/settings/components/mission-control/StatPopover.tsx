import React from 'react'
import type { UnifiedTask } from '../../types'
import { AgentAvatar } from './AgentAvatar'
import type { UnifiedAgent } from './UnifiedAgentsPane'

// Short PR label from a GitHub URL: https://github.com/org/repo/pull/123 → org/repo#123
export function shortPrLabel(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i)
  if (m) return `${m[1]}/${m[2]}#${m[3]}`
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}`
  } catch {
    return url
  }
}

export type StatPopoverKey = 'shipped' | 'open' | 'running' | 'nextup' | 'files'

export function statPopoverTitle(key: StatPopoverKey): string {
  switch (key) {
    case 'shipped': return 'Shipped today'
    case 'open': return 'Open PRs'
    case 'running': return 'Running agents'
    case 'nextup': return 'Next up'
    case 'files': return 'Files today'
  }
}

export function statPopoverEmptyLabel(key: StatPopoverKey): string {
  switch (key) {
    case 'shipped': return 'No PRs shipped yet'
    case 'open': return 'No open PRs'
    case 'running': return 'No running agents'
    case 'nextup': return 'Queue is empty'
    case 'files': return 'No files touched today'
  }
}

export interface BuildRowsCtx {
  activeItems: UnifiedAgent[]
  queueTasks: UnifiedTask[]
  filesToday: string[]
  shippedPRs: Array<{ key: string; title: string; url: string; agentType: string; timestamp: string }>
  openPRs: Array<{ key: string; title: string; url: string; agentType: string; timestamp: string }>
  onOpenExternal: (url: string) => void
  onFocusTerminal: (terminalId: string) => void
  onOpenFile: (path: string) => void
}

export function buildStatPopoverRows(key: StatPopoverKey, ctx: BuildRowsCtx): StatPopoverRow[] {
  switch (key) {
    case 'shipped':
    case 'open': {
      const prs = key === 'shipped' ? ctx.shippedPRs : ctx.openPRs
      return prs.map((pr) => ({
        key: pr.key,
        icon: <AgentAvatar id={pr.agentType} size={16} />,
        title: pr.title,
        subtitle: shortPrLabel(pr.url),
        onClick: () => ctx.onOpenExternal(pr.url),
      }))
    }
    case 'running': {
      return ctx.activeItems.map((item) => {
        const terminalId = item.kind === 'terminal' ? item.terminal?.id : undefined
        const action = terminalId
          ? () => ctx.onFocusTerminal(terminalId)
          : item.prUrl
            ? () => ctx.onOpenExternal(item.prUrl as string)
            : undefined
        return {
          key: item.id,
          icon: <AgentAvatar id={item.agentType} size={16} />,
          title: item.displayName,
          subtitle: item.activity.slice(0, 48),
          onClick: action,
          disabled: !action,
        }
      })
    }
    case 'nextup': {
      return ctx.queueTasks.map((task) => ({
        key: task.id,
        title: task.title,
        subtitle: task.metadata.identifier || undefined,
        onClick: task.metadata.url ? () => ctx.onOpenExternal(task.metadata.url as string) : undefined,
        disabled: !task.metadata.url,
      }))
    }
    case 'files': {
      return ctx.filesToday.map((path) => {
        const base = path.split('/').pop() || path
        const dir = path.slice(0, path.length - base.length).replace(/\/$/, '')
        return {
          key: path,
          title: base,
          subtitle: dir || undefined,
          onClick: () => ctx.onOpenFile(path),
        }
      })
    }
  }
}

export interface StatPopoverRow {
  key: string
  icon?: React.ReactNode
  title: string
  subtitle?: string
  disabled?: boolean
  onClick?: () => void
}

export function StatPopover({
  title,
  rows,
  emptyLabel,
}: {
  title: string
  rows: StatPopoverRow[]
  emptyLabel: string
}) {
  return (
    <div className="sw-floor-pr-popover" role="menu">
      <div className="sw-floor-pr-popover-head">{title}</div>
      {rows.length === 0 ? (
        <div className="sw-floor-pr-popover-empty">{emptyLabel}</div>
      ) : (
        <div className="sw-floor-pr-popover-list">
          {rows.map((row) => (
            <button
              key={row.key}
              type="button"
              className="sw-floor-pr-popover-row"
              onClick={row.onClick}
              disabled={row.disabled || !row.onClick}
            >
              {row.icon}
              <span className="sw-floor-pr-popover-title">{row.title}</span>
              {row.subtitle && <span className="sw-floor-pr-popover-num">{row.subtitle}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
