// Project / Repo picker. Ports the prototype's renderProject() (dispatch.html):
// renders items in their incoming order (confidence-first for managed projects,
// usage order for cloud repos), a MOST USED badge on the genuine max-uses entry, a
// Linear pill + confidence meter, and the mono path sub-line for local projects.
import React from 'react'
import { useState } from 'react'
import { Icon } from './icons'
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownSection, DropdownItem } from '../ui/Dropdown'
import { Badge } from '../ui/Badge'
import type { DispatchTarget } from './dispatch.types'

export interface ProjectSelectProps {
  items: DispatchTarget[]     // already scoped to projects (local) or repos (cloud)
  value: string
  cloud: boolean              // hide the path sub-line for cloud repos
  onChange: (id: string) => void
}

function LinearPill({ name }: { name: string }) {
  return <Badge variant="linear" title={`Linear · ${name}`}>{name}</Badge>
}

// Tiny confidence meter: high = full lime, medium = ~60% cyan, low = ~25% dim.
function ConfMeter({ level }: { level: 'high' | 'medium' | 'low' }) {
  const pct = level === 'high' ? 100 : level === 'medium' ? 60 : 25
  const color = level === 'high' ? 'var(--ds-success)' : level === 'medium' ? 'var(--ds-info)' : 'var(--ds-text-dim)'
  return (
    <span
      title={`${level} confidence`}
      aria-label={`${level} confidence`}
      style={{
        display: 'inline-block', width: 28, height: 4, borderRadius: 2,
        background: 'var(--ds-bg-inset)', overflow: 'hidden',
      }}
    >
      <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} />
    </span>
  )
}

export function ProjectSelect({ items, value, cloud, onChange }: ProjectSelectProps) {
  const [open, setOpen] = useState(false)

  // Preserve the incoming order: for managed projects that is buildManagedTargets'
  // confidence-first ranking (so the dropdown matches the sidebar); for cloud repos
  // it is usage order. The MOST USED badge still marks the genuine max-uses entry,
  // wherever it lands — never re-flatten confidence back into pure usage order.
  const [first] = items
  if (!first) return null
  const sel = items.find(i => i.id === value) ?? first
  const top = items.reduce((m, i) => (i.uses > m.uses ? i : m), first)

  return (
    <>
      <Dropdown open={open} onOpenChange={setOpen} className={`dd ${open ? 'open' : ''}`}>
        <DropdownTrigger className="dd-btn">
          <span>{sel.label}</span>
          <span className="caret" style={{ marginLeft: 'auto' }}><Icon name="chevD" size={13} /></span>
        </DropdownTrigger>
        <DropdownMenu className="dd-menu">
          {items.map(i => (
            <DropdownItem
              key={i.id}
              selected={i.id === sel.id}
              className={`opt ${i.id === sel.id ? 'sel' : ''}`}
              onClick={() => { onChange(i.id); setOpen(false) }}
            >
              <span className="nm">{i.label}</span>
              {top && i.id === top.id ? <Badge variant="used">MOST USED</Badge> : null}
              {i.linearProject ? <LinearPill name={i.linearProject} /> : null}
              {i.confidence ? <ConfMeter level={i.confidence} /> : null}
              <span className="right"><span className="use">{i.uses}×</span></span>
            </DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>
      {cloud ? null : <div className="sub2 mono">{sel.path}</div>}
    </>
  )
}
