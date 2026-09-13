import React from 'react'
import { Rocker } from './PanelTab'
import type { AgentSettings } from '../../types'

interface SourcesSectionProps {
  settings: AgentSettings
  availableSources: { linear: boolean; github: boolean }
  onUpdateTaskSources: (sources: Partial<AgentSettings['taskSources']>) => void
  onConnectLinear: () => void
  onConnectGitHub: () => void
}

export function SourcesSection({
  settings,
  availableSources,
  onUpdateTaskSources,
  onConnectLinear,
  onConnectGitHub,
}: SourcesSectionProps) {
  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">Sources</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
        <span className="sw-badge open" style={{ minWidth: 26, justifyContent: 'center' }}>LN</span>
        <span style={{ flex: 1, fontSize: '12px' }}>Linear</span>
        {availableSources.linear ? (
          <Rocker
            on={settings.taskSources?.linear ?? false}
            onChange={(v) => onUpdateTaskSources({ linear: v })}
          />
        ) : (
          <button className="sw-btn secondary sm" onClick={onConnectLinear}>
            Connect
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
        <span className="sw-badge" style={{ minWidth: 26, justifyContent: 'center', background: 'rgba(35,134,54,0.1)', color: '#238636' }}>GH</span>
        <span style={{ flex: 1, fontSize: '12px' }}>GitHub</span>
        {availableSources.github ? (
          <Rocker
            on={settings.taskSources?.github ?? false}
            onChange={(v) => onUpdateTaskSources({ github: v })}
          />
        ) : (
          <button className="sw-btn secondary sm" onClick={onConnectGitHub}>
            Connect
          </button>
        )}
      </div>

      {availableSources.github && settings.taskSources?.github && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 6px 34px' }}>
          <span style={{ flex: 1, fontSize: '11px', opacity: 0.75 }}>Only show issues assigned to me</span>
          <Rocker
            on={settings.taskSources?.githubAssignedOnly ?? false}
            onChange={(v) => onUpdateTaskSources({ githubAssignedOnly: v })}
          />
        </div>
      )}
    </div>
  )
}
