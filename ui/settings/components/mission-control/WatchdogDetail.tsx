import React, { useState } from 'react'
import type { WatchdogEventUI } from './UnifiedAgentsPane'
import { groupIntoCycles } from './watchdogCycles'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatStalledFor(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

export function WatchdogDetail({ events }: { events: WatchdogEventUI[] }) {
  const [expandedTails, setExpandedTails] = useState<Set<number>>(new Set())

  const toggleTail = (idx: number) => {
    setExpandedTails((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }

  if (events.length === 0) {
    return (
      <div className="sw-unified-detail-content">
        <div className="sw-unified-detail-empty" style={{ padding: '24px 0', textAlign: 'center' }}>
          No scans yet. Watchdog runs every minute — it will appear here once it checks a terminal.
        </div>
      </div>
    )
  }

  const cycles = groupIntoCycles(events)

  return (
    <div className="sw-unified-detail-content">
      {cycles.map((cycle, ci) => {
        const ticks = cycle.events.filter((e) => e.kind === 'tick')
        const nudges = cycle.events.filter((e) => e.kind === 'nudge')
        const rotates = cycle.events.filter((e) => e.kind === 'rotate')
        const errors = cycle.events.filter((e) => e.kind === 'error')

        return (
          <div key={ci} className="sw-unified-detail-section" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                {formatTime(cycle.events[0].ts)}
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                {ticks.length} terminal{ticks.length !== 1 ? 's' : ''} scanned
                {nudges.length > 0 && ` · ${nudges.length} nudged`}
                {rotates.length > 0 && ` · ${rotates.length} rotated`}
                {errors.length > 0 && ` · ${errors.length} error${errors.length !== 1 ? 's' : ''}`}
              </span>
            </div>

            {ticks.map((tick, ti) => {
              const globalIdx = ci * 100 + ti
              const isTailOpen = expandedTails.has(globalIdx)
              const decision = cycle.events.find(
                (e) => e.kind === 'decision' && e.terminalId === tick.terminalId
              )
              const nudge = cycle.events.find(
                (e) => e.kind === 'nudge' && e.terminalId === tick.terminalId
              )

              return (
                <div
                  key={ti}
                  style={{
                    background: 'var(--ds-bg-panel)',
                    border: '1px solid var(--ds-border-subtle)',
                    borderRadius: 6,
                    padding: '10px 12px',
                    marginBottom: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
                      {tick.terminalId}
                    </span>
                    {tick.agentType && (
                      <span style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>({tick.agentType})</span>
                    )}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                      stalled {tick.stalledForMs !== undefined ? formatStalledFor(tick.stalledForMs) : tick.message}
                    </span>
                  </div>

                  {(tick.lastUserMessage || tick.lastAssistantMessage ||
                    decision?.lastUserMessage || decision?.lastAssistantMessage ||
                    nudge?.lastUserMessage || nudge?.lastAssistantMessage) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                      {(tick.lastUserMessage || decision?.lastUserMessage || nudge?.lastUserMessage) && (
                        <div style={{ fontSize: 11, lineHeight: 1.4 }}>
                          <span style={{ color: 'var(--ds-text-dim)' }}>User: </span>
                          <span style={{ color: 'var(--ds-text-muted)' }}>
                            {tick.lastUserMessage || decision?.lastUserMessage || nudge?.lastUserMessage}
                          </span>
                        </div>
                      )}
                      {(tick.lastAssistantMessage || decision?.lastAssistantMessage || nudge?.lastAssistantMessage) && (
                        <div style={{ fontSize: 11, lineHeight: 1.4 }}>
                          <span style={{ color: 'var(--ds-text-dim)' }}>Agent: </span>
                          <span style={{ color: 'var(--ds-text-muted)' }}>
                            {tick.lastAssistantMessage || decision?.lastAssistantMessage || nudge?.lastAssistantMessage}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {tick.tailLines && tick.tailLines.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <button
                        type="button"
                        className="sw-link-btn"
                        style={{ fontSize: 10.5, color: 'var(--ds-text-dim)', marginBottom: isTailOpen ? 6 : 0 }}
                        onClick={() => toggleTail(globalIdx)}
                      >
                        {isTailOpen ? 'Hide' : 'Show'} {tick.tailLines.length} lines read
                      </button>
                      {isTailOpen && (
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 9.5,
                            lineHeight: 1.5,
                            color: 'var(--ds-text-dim)',
                            background: 'var(--muted)',
                            borderRadius: 4,
                            padding: '6px 8px',
                            overflow: 'auto',
                            maxHeight: 160,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                        >
                          {tick.tailLines.join('\n')}
                        </pre>
                      )}
                    </div>
                  )}

                  {decision && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          className={`sw-badge ${nudge ? 'running' : 'ok'}`}
                          style={{ fontSize: 10 }}
                        >
                          {nudge ? 'NUDGE' : 'SKIP'}
                        </span>
                        {decision.reason && (
                          <span style={{ fontSize: 11, color: 'var(--ds-text-muted)' }}>
                            {decision.reason}
                          </span>
                        )}
                        <span style={{ flex: 1 }} />
                        {nudge && (
                          <span className="mono" style={{ fontSize: 10, color: 'var(--ds-text-dim)' }}>
                            sent {formatTime(nudge.ts)}
                          </span>
                        )}
                      </div>
                      {nudge && (
                        <div
                          style={{
                            fontSize: 11.5,
                            fontStyle: 'italic',
                            color: 'var(--ds-text)',
                            paddingLeft: 4,
                            borderLeft: '2px solid var(--brand)',
                          }}
                        >
                          "{nudge.nudgeText || nudge.message}"
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {rotates.map((ev, ri) => (
              <div
                key={`r${ri}`}
                style={{
                  background: 'var(--ds-bg-panel)',
                  border: '1px solid var(--ds-border-subtle)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span className="sw-badge ok" style={{ fontSize: 10 }}>ROTATE</span>
                <span className="mono" style={{ fontSize: 11 }}>{ev.terminalId}</span>
                <span style={{ fontSize: 11, color: 'var(--ds-text-muted)', flex: 1 }}>{ev.message}</span>
                {ev.reason && <span style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>{ev.reason}</span>}
              </div>
            ))}

            {errors.map((ev, ei) => (
              <div
                key={`e${ei}`}
                style={{
                  background: 'var(--ds-bg-panel)',
                  border: '1px solid var(--ds-border-subtle)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  marginBottom: 6,
                  display: 'flex',
                  gap: 6,
                  alignItems: 'flex-start',
                }}
              >
                <span className="sw-badge failed" style={{ fontSize: 10, flexShrink: 0 }}>ERROR</span>
                <span style={{ fontSize: 11, color: 'var(--ds-text-muted)' }}>{ev.message}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
