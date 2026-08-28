import React from 'react'
import { postMessage } from '../../hooks'
import { ExtLink } from '../common'
import { relTime, shortDuration } from './types'
import { humanTokens, tildePath, type SessionPreview, type PreviewFileChange } from './sessionPreview'

// The picker-parity card for the Fleet detail panel (PHNX-2973). Renders the
// field set `agents sessions preview <id> --json` computes — the version /
// account / token header, per-file Changes, Tools mix, Tests, Errors, Links,
// Skills, Hooks, Repos, Dirs — in the CLI picker's order, so the panel shows
// what `agents sessions` shows instead of a thin subset.
//
// Prompt (firstUser) and Last response (lastAssistant) are intentionally NOT
// rendered here: the surrounding detail pane already shows Task + the live
// Activity feed, so this card carries only the fields the panel lacked. The two
// together == the full picker field set, with no duplicated prompt/response.

const OP_SYMBOL: Record<PreviewFileChange['op'], string> = { created: '+', modified: '~', deleted: '−' }
const OP_COLOR: Record<PreviewFileChange['op'], string> = {
  created: 'var(--ds-diff-added, #4ade80)',
  modified: 'var(--brand, #60a5fa)',
  deleted: 'var(--ds-diff-removed, #f87171)',
}

const FILES_SHOWN = 12

function Section({ label, count, children }: { label: string; count?: string; children: React.ReactNode }) {
  return (
    <div className="sw-unified-detail-section">
      <div className="sw-section-label">
        {label}
        {count && <span className="sw-section-count">{count}</span>}
      </div>
      {children}
    </div>
  )
}

export function SessionPreviewCard({ preview }: { preview: SessionPreview }) {
  const { session: s, digest: d } = preview

  const created = relTime(s.createdAt)
  const active = relTime(s.lastActivity)
  const lasted = s.durationMs > 0 ? shortDuration(Math.round(s.durationMs / 1000)) : ''
  const cwd = tildePath(s.cwd)

  const headerL1 = [s.agent && cap(s.agent), s.version && `v${s.version}`, s.shortId, s.model, s.account]
    .filter(Boolean)
    .join(' · ')
  const metaBits = [
    s.gitBranch && s.gitBranch,
    created && `created ${created}`,
    active && `active ${active}`,
    lasted && `lasted ${lasted}`,
  ].filter(Boolean)
  const costBits = [
    s.messageCount > 0 && `${s.messageCount} msgs`,
    s.tokenCount > 0 && `${humanTokens(s.tokenCount)} tokens`,
    s.costUsd > 0 && `$${s.costUsd.toFixed(2)}`,
  ].filter(Boolean)

  return (
    <div className="sw-preview-card">
      {/* Version / account / model + timing + cost header — the CLI card's top line. */}
      <div className="sw-unified-detail-section">
        <div className="mono sw-preview-head">
          {headerL1 && <div className="sw-preview-head-id">{headerL1}</div>}
          <div className="sw-preview-head-meta">
            {cwd && (
              <button
                type="button"
                className="sw-preview-link"
                title="Reveal folder"
                onClick={() => postMessage({ type: 'revealFolder', path: s.cwd })}
              >
                {cwd}
              </button>
            )}
            {cwd && metaBits.length > 0 && <span> · </span>}
            {metaBits.join(' · ')}
          </div>
          {costBits.length > 0 && <div className="sw-preview-head-meta">{costBits.join(' · ')}</div>}
        </div>
      </div>

      {!d ? (
        preview.error ? (
          <div className="sw-unified-detail-section">
            <div className="sw-preview-note" style={{ color: 'var(--ds-text-muted)' }}>
              Preview unavailable — {preview.error}
            </div>
          </div>
        ) : null
      ) : (
        <>
          {/* Made → Changes: counts + reads + tools, then the per-file diff list
              the CLI now carries on the digest (changedFiles). */}
          {(d.changes.created + d.changes.modified + d.changes.deleted > 0 ||
            d.filesRead > 0 ||
            d.toolCalls > 0) && (
            <Section label="Changes">
              <div className="sw-unified-detail-stats">
                {d.changes.created > 0 && <span style={{ color: OP_COLOR.created }}>+{d.changes.created}</span>}
                {d.changes.modified > 0 && <span style={{ color: OP_COLOR.modified }}>~{d.changes.modified}</span>}
                {d.changes.deleted > 0 && <span style={{ color: OP_COLOR.deleted }}>−{d.changes.deleted}</span>}
                {d.changes.created + d.changes.modified + d.changes.deleted > 0 && <span>changed</span>}
                {d.filesRead > 0 && <span>{d.filesRead} read</span>}
                {d.toolCalls > 0 && <span>{d.toolCalls} tools</span>}
              </div>
              {d.changedFiles.length > 0 && (
                <div className="sw-unified-detail-files" style={{ marginTop: 6 }}>
                  {d.changedFiles.slice(0, FILES_SHOWN).map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      className="mono sw-unified-file-pill sw-unified-file-pill-btn"
                      title={f.path}
                      style={{ borderColor: OP_COLOR[f.op], color: OP_COLOR[f.op] }}
                      onClick={() => postMessage({ type: 'openTerminalFile', path: f.path })}
                    >
                      <span style={{ opacity: 0.8 }}>{OP_SYMBOL[f.op]}</span> {f.path.split('/').pop()}
                    </button>
                  ))}
                  {d.changedFiles.length > FILES_SHOWN && (
                    <span className="sw-preview-more">+{d.changedFiles.length - FILES_SHOWN} more</span>
                  )}
                </div>
              )}
            </Section>
          )}

          {/* Cost → Tools: the Bash 280 · Edit 11 breakdown. */}
          {d.toolHistogram.length > 0 && (
            <Section label="Tools">
              <div className="sw-unified-detail-stats">
                {d.toolHistogram.map((t) => (
                  <span key={t.tool} className="mono">
                    {t.tool} {t.count}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Health → Tests. */}
          {d.test && (
            <Section label="Tests">
              <div className="sw-unified-detail-stats">
                <span className="mono">{d.test.runner}</span>
                {typeof d.test.passed === 'number' && (
                  <span style={{ color: OP_COLOR.created }}>{d.test.passed} pass</span>
                )}
                {typeof d.test.failed === 'number' && d.test.failed > 0 && (
                  <span style={{ color: OP_COLOR.deleted }}>{d.test.failed} fail</span>
                )}
                {!d.test.ok && d.test.failed === undefined && (
                  <span style={{ color: OP_COLOR.deleted }}>failing</span>
                )}
              </div>
            </Section>
          )}

          {/* Health → Errors. */}
          {d.errorCount > 0 && (
            <Section label="Errors">
              <div className="sw-unified-detail-stats">
                <span style={{ color: OP_COLOR.deleted }}>{d.errorCount} failures</span>
                {d.firstError && <span className="mono">first: {d.firstError}</span>}
              </div>
            </Section>
          )}

          {/* Links: PRs / tickets the session opened. */}
          {d.links.length > 0 && (
            <Section label="Links">
              <div className="sw-unified-detail-stats">
                {d.links.map((l) => (
                  <ExtLink key={l.url} href={l.url} className="mono sw-preview-linkchip">
                    {l.label}
                  </ExtLink>
                ))}
              </div>
            </Section>
          )}

          {/* Skills used. */}
          {d.skills.length > 0 && (
            <Section label="Skills">
              <div className="sw-unified-detail-stats">
                {d.skills.map((sk) => (
                  <span key={sk.name} className="mono">
                    {sk.name}
                    {sk.count > 1 ? ` ×${sk.count}` : ''}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Hooks: name ×count (N failed). */}
          {d.hooks.length > 0 && (
            <Section label="Hooks">
              <div className="sw-unified-detail-stats">
                {d.hooks.map((h) => (
                  <span key={h.name} className="mono" title={h.event}>
                    {h.name} ×{h.count}
                    {h.failed > 0 ? ` (${h.failed} failed)` : ''}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Repos + Dirs touched. */}
          {d.repos.length > 0 && (
            <Section label="Repos">
              <div className="sw-unified-detail-stats">
                {d.repos.map((r) => (
                  <span key={r} className="mono">
                    {r}
                  </span>
                ))}
              </div>
            </Section>
          )}
          {d.dirs.length > 0 && (
            <Section label="Dirs">
              <div className="sw-unified-detail-stats">
                {d.dirs.map((dir) => (
                  <span key={dir} className="mono" title={dir}>
                    {tildePath(dir)}
                  </span>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  )
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}
