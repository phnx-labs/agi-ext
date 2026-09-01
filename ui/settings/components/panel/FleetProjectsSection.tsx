import React, { useEffect, useState } from 'react'
import { postMessage } from '../../hooks'
import { ProjectsPane } from '../mission-control/ProjectsPane'
import type { ManagedProject, LinearProjectLite } from '../mission-control/floorModel'

/**
 * Fleet — Projects, relocated into the Settings (Panel) surface after the Fleet
 * view's left rail was removed (PHNX-3594). The rail was the ONLY way to reach
 * the managed-Projects pane, so removing it left `center === 'projects'`
 * unreachable — nothing calls `setCenter('projects')` anymore, so the pane was
 * orphaned dead code in UnifiedAgentsPane. This restores it (PHNX-3592).
 *
 * Devices are NOT rendered here — PanelTab already owns a Devices section fed by
 * its `devices` prop; this section is Projects only, to avoid a second surface.
 *
 * Self-contained for data exactly like PanelTab's LinearApiKeyCard /
 * WatchdogPlaybookCard: it owns its own postMessage fetches + a single window
 * 'message' listener, and threads nothing through App or PanelTab props. The
 * extension backend answers fetchManagedProjects / fetchLinearProjects
 * regardless of which surface asked.
 *
 * Reuses the mission-control ProjectsPane verbatim (add / remove / link a Linear
 * project). rollups is empty here — Settings has no live agent feed to summarize
 * — and onClose is omitted, so the pane drops its "back to agents" affordance
 * (there is no detail column to return from in Settings).
 */
export function FleetProjectsSection() {
  const [managedProjects, setManagedProjects] = useState<ManagedProject[]>([])
  const [linearProjects, setLinearProjects] = useState<LinearProjectLite[]>([])
  const [pickedFolder, setPickedFolder] = useState<
    { path: string; repoSlug?: string; name: string; suggestedLinear?: LinearProjectLite } | null
  >(null)
  const [projectCommandError, setProjectCommandError] = useState<string | null>(null)

  // Fetch on mount; the host re-sends managedProjectsData after any save/delete,
  // so no optimistic update is needed. projectFolderPicked answers Browse… and
  // prefills the add form. On a managedProjectsData error, KEEP last-good
  // projects and surface the failure inline on the pane (never a toast) — same
  // last-good pattern UnifiedAgentsPane used before this pane moved out of it.
  useEffect(() => {
    postMessage({ type: 'fetchManagedProjects' })
    postMessage({ type: 'fetchLinearProjects' })
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'managedProjectsData') {
        if (typeof msg.error === 'string') {
          setProjectCommandError(msg.error)
          return
        }
        if (Array.isArray(msg.projects)) {
          setManagedProjects(msg.projects as ManagedProject[])
          setProjectCommandError(null)
        }
      } else if (msg?.type === 'linearProjectsData' && Array.isArray(msg.projects)) {
        setLinearProjects(msg.projects as LinearProjectLite[])
      } else if (msg?.type === 'projectFolderPicked' && typeof msg.path === 'string') {
        setPickedFolder({
          path: msg.path,
          repoSlug: typeof msg.repoSlug === 'string' ? msg.repoSlug : undefined,
          name: typeof msg.name === 'string' ? msg.name : '',
          suggestedLinear: msg.suggestedLinear as LinearProjectLite | undefined,
        })
      } else if (
        (msg?.type === 'managedProjectsError' || msg?.type === 'projectCommandError') &&
        typeof msg.error === 'string'
      ) {
        setProjectCommandError(msg.error)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  return (
    <ProjectsPane
      projects={managedProjects}
      rollups={{}}
      linearProjects={linearProjects}
      pickedFolder={pickedFolder}
      commandError={projectCommandError}
      onSave={(p) => {
        setProjectCommandError(null)
        postMessage({ type: 'saveManagedProject', project: p })
      }}
      onDelete={(id) => {
        setProjectCommandError(null)
        postMessage({ type: 'deleteManagedProject', id })
      }}
      onPickFolder={() => postMessage({ type: 'pickProjectFolder' })}
    />
  )
}
