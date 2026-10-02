import { HostLoad } from '../ui/HostLoad'
// Run-on host picker with LIVE load. Ports the prototype's renderHost() +
// loadBar()/hostRight() (dispatch.html): MACHINES/CLOUD sections, load bars,
// SUGGESTED (least-busy) + MOST USED badges, cloud cost, offline-disabled rows,
// and the busy-host nudge to the free machine.
import React from 'react'
import { useState } from 'react'
import { Icon } from './icons'
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownSection, DropdownItem } from '../ui/Dropdown'
import { Badge } from '../ui/Badge'
import type { DispatchHost } from './dispatch.types'

export interface HostSelectProps {
  hosts: DispatchHost[]
  value: string
  onChange: (hostId: string) => void
}

/** Least-busy online machine (non-cloud) — drives the SUGGESTED badge + nudge. */
export function suggestedHost(hosts: DispatchHost[]): DispatchHost | undefined {
  return hosts
    .filter(h => h.kind !== 'cloud' && h.online)
    .sort((a, b) => a.agents - b.agents)[0]
}

/** Most-used online machine (non-cloud) — the demoted MOST USED badge. */
function mostUsedHost(hosts: DispatchHost[]): DispatchHost | undefined {
  return hosts
    .filter(h => h.kind !== 'cloud')
    .sort((a, b) => b.uses - a.uses)[0]
}

export function HostSelect({ hosts, value, onChange }: HostSelectProps) {
  const [open, setOpen] = useState(false)

  const sel = hosts.find(h => h.id === value) ?? hosts[0]
  if (!sel) return null
  const sug = suggestedHost(hosts)
  const most = mostUsedHost(hosts)
  const local = hosts.filter(h => h.kind !== 'cloud')
  const cloud = hosts.filter(h => h.kind === 'cloud')
  const isCloud = sel.kind === 'cloud'
  const busy = sel.kind !== 'cloud' && sel.online && sel.load === 'busy'

  const pick = (h: DispatchHost) => {
    if (!h.online) return
    onChange(h.id)
    setOpen(false)
  }

  const Row = ({ h }: { h: DispatchHost }) => (
    <DropdownItem
      disabled={!h.online}
      selected={h.id === sel.id}
      className={`opt ${h.id === sel.id ? 'sel' : ''} ${h.kind === 'cloud' ? 'cloud' : ''} ${!h.online ? 'dis' : ''}`}
      onClick={() => pick(h)}
    >
      <span className={`dot ${h.online ? '' : 'off'}`} />
      <span className="nm">{h.label}</span>
      {sug && h.id === sug.id
        ? <Badge>SUGGESTED</Badge>
        : (most && h.id === most.id ? <Badge variant="used">MOST USED</Badge> : null)}
      <span className="right"><HostLoad host={h} /></span>
    </DropdownItem>
  )

  const subText = isCloud
    ? 'Cloud runs a fresh clone — local uncommitted changes are not included.'
    : sel.kind === 'remote'
      ? `Runs over SSH on ${sel.label}`
      : 'Runs on this machine'

  return (
    <>
      <Dropdown open={open} onOpenChange={setOpen} className={`dd ${open ? 'open' : ''}`}>
        <DropdownTrigger className="dd-btn">
          <span className={`dot ${sel.online ? '' : 'off'}`} />
          <span>{sel.label}</span>
          <span className="right">{isCloud ? null : <HostLoad host={sel} />}</span>
          <span className="caret"><Icon name="chevD" size={13} /></span>
        </DropdownTrigger>
        <DropdownMenu className="dd-menu">
          <DropdownSection className="dd-sec">MACHINES</DropdownSection>
          {local.map(h => <Row key={h.id} h={h} />)}
          <DropdownSection className="dd-sec">CLOUD</DropdownSection>
          {cloud.map(h => <Row key={h.id} h={h} />)}
        </DropdownMenu>
      </Dropdown>
      <div className="sub2">{subText}</div>
      {busy && sug && (
        <div className="nudge">
          <Icon name="alert" size={13} /> {sel.label} has {sel.agents} agents running — may slow your other apps.
          <span className="go" onClick={() => onChange(sug.id)}>Run on {sug.label} (free)</span>
        </div>
      )}
    </>
  )
}
