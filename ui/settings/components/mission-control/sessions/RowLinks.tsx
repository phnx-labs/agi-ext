import React from 'react'
import { ExtLink } from '../../common'
import { linearIssueUrl, type FloorAgent } from '../floorModel'
import type { SessionRowView } from '../recapModel'

/** Copy a short value and keep the click out of the row expand handler. */
export function copyPill(e: React.MouseEvent, text: string): void {
  e.stopPropagation()
  navigator.clipboard?.writeText(text)?.catch(() => { /* clipboard unavailable in this host */ })
}

/** Normalize only a real GitHub pull-request URL. */
export function githubPullRequestUrl(prUrl: string | null | undefined): string | null {
  if (!prUrl) return null
  try {
    const url = new URL(prUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
    if (parts.length < 4 || parts[2] !== 'pull' || !/^\d+$/.test(parts[3] ?? '')) return null
    return `https://github.com/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}/pull/${parts[3]}`
  } catch {
    return null
  }
}

/** Derive the repository root only from a validated GitHub PR URL. */
export function githubRepoUrl(prUrl: string | null | undefined): string | null {
  const normalized = githubPullRequestUrl(prUrl)
  if (!normalized) return null
  return normalized.replace(/\/pull\/\d+$/, '')
}

export interface PillLinkProps {
  href: string | null
  copyText: string
  className: string
  children: React.ReactNode
}

/** A navigating pill when a trustworthy URL exists, otherwise an honest copy pill. */
export function PillLink({ href, copyText, className, children }: PillLinkProps) {
  if (href) {
    return (
      <ExtLink href={href} className={className} title={`Open ${copyText}`} onClick={(e) => e.stopPropagation()}>
        {children} <span aria-hidden>↗</span>
      </ExtLink>
    )
  }
  return (
    <span className={className} role="button" title={`Copy ${copyText}`} onClick={(e) => copyPill(e, copyText)}>
      {children} <span aria-hidden>⧉</span>
    </span>
  )
}

interface RowLinksProps {
  agent: FloorAgent
  row: SessionRowView
  mode: 'compact' | 'expanded'
}

/** The row's two metadata-link surfaces, kept behind one interaction contract. */
export function RowLinks({ agent: a, row, mode }: RowLinksProps) {
  if (mode === 'expanded') {
    return (
      <div className="sx-catch">
        {a.ticket && <PillLink href={linearIssueUrl(a.ticket)} copyText={a.ticket} className="lnk">◇ {a.ticket}</PillLink>}
        {row.pr && <PillLink href={githubPullRequestUrl(a.prUrl)} copyText={row.pr.label} className="lnk pr">{row.pr.label}</PillLink>}
        {row.repo && <PillLink href={githubRepoUrl(a.prUrl)} copyText={row.repo} className="lnk repo">▪ {row.repo}{a.files ? ` · ${a.files} files` : ''}</PillLink>}
        {row.branch && <PillLink href={null} copyText={row.branch} className="lnk branch">⑂ {row.branch}</PillLink>}
      </div>
    )
  }

  return (
    <div className="sx-metarow">
      {row.repo && <PillLink href={githubRepoUrl(a.prUrl)} copyText={row.repo} className="sx-chip repo">▪ {row.repo}</PillLink>}
      {row.pr && (
        <PillLink href={githubPullRequestUrl(a.prUrl)} copyText={row.pr.label} className="sx-chip pr">
          <span className={`ci${row.pr.ci === 'running' ? ' run' : row.pr.ci === 'failed' ? ' fail' : ''}`} />
          {' '}{row.pr.label}
        </PillLink>
      )}
      {a.ticket && <PillLink href={linearIssueUrl(a.ticket)} copyText={a.ticket} className="sx-chip ticket">◇ {a.ticket}</PillLink>}
      {row.branch && <PillLink href={null} copyText={row.branch} className="sx-chip branch">⑂ {row.branch}</PillLink>}
      {(a.attachments?.length ?? 0) > 0 && <span className="sx-chip attach">{'🖼'} {a.attachments!.length}</span>}
      {(a.plans?.length ?? 0) > 0 && <span className="sx-chip art">◆ {a.plans!.length}</span>}
      {!row.pr && !a.ticket && <span className="sx-chip nopr">no PR</span>}
    </div>
  )
}
