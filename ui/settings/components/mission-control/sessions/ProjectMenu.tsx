import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectFilterOption } from '../sessionsModel'

export interface ProjectMenuState {
  x: number
  y: number
}

/**
 * Searchable project popover, shared by the toolbar `Project: …` filter and the
 * Unassigned bucket's per-row / bulk "assign project" affordances. Renders a search box
 * + a scrollable list of options (label + session count), closes on outside-click / Esc.
 * Pure presentation — the caller owns the option list and what a pick means.
 */
export function ProjectMenu({ state, options, selected, title, searchPlaceholder = 'Search projects…', onPick, onClose }: {
  state: ProjectMenuState
  options: ProjectFilterOption[]
  /** Currently-selected value (null = All), for the check mark. Omit for assign menus. */
  selected?: string | null
  title: string
  searchPlaceholder?: string
  onPick: (value: string | null) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options
  }, [options, query])

  const left = Math.max(8, Math.min(state.x, window.innerWidth - 260))
  const top = Math.max(8, Math.min(state.y, window.innerHeight - 340))
  return createPortal(
    <div
      ref={ref}
      className="sx-project-menu"
      role="menu"
      aria-label={title}
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="sx-project-menu-search">
        <input
          autoFocus
          aria-label={title}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="sx-project-menu-list">
        {filtered.length > 0 ? filtered.map((o) => {
          const on = selected !== undefined && (selected ?? null) === o.value
          return (
            <button
              key={o.value ?? '__all__'}
              type="button"
              role="menuitem"
              className={`sx-project-menu-item${on ? ' on' : ''}`}
              onClick={() => { onPick(o.value); onClose() }}
            >
              <span className="lab">{o.label}</span>
              <span className="n">{o.count}</span>
            </button>
          )
        }) : <div className="sx-project-menu-empty">No projects match</div>}
      </div>
    </div>,
    document.body,
  )
}
