import { DropdownMenu, DropdownItem } from '../../ui/Dropdown'
import React, { useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { FloorAgent } from '../floorModel'
import { resumeSourceDevice } from './sessionActions'

export interface ResumeDevice {
  name: string
  online: boolean
}

export interface ResumeDeviceMenuState {
  agent: FloorAgent
  x: number
  y: number
}

export function ResumeDeviceMenu({ state, devices, onChoose, onClose }: {
  state: ResumeDeviceMenuState
  devices: ResumeDevice[]
  onChoose: (agent: FloorAgent, device: string) => void
  onClose: () => void
}) {
  const current = resumeSourceDevice(state.agent)
  const alternatives = useMemo(
    () => devices.filter((device) => device.name && device.name !== current),
    [current, devices],
  )

  const left = Math.max(8, Math.min(state.x, window.innerWidth - 260))
  const top = Math.max(8, Math.min(state.y, window.innerHeight - 280))
  return createPortal(
    <DropdownMenu
      onClose={onClose}
      className="sx-resume-menu"
      role="menu"
      aria-label="Resume on a different device"
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="sx-resume-menu-title">Resume on a different device…</div>
      {alternatives.length > 0 ? alternatives.map((device) => (
        <DropdownItem
          key={device.name}
          type="button"
          role="menuitem"
          disabled={!device.online}
          title={device.online ? `Resume on ${device.name}` : `${device.name} is offline`}
          onClick={() => { onChoose(state.agent, device.name); onClose() }}
        >
          <span className={`sx-resume-device-dot${device.online ? '' : ' offline'}`} aria-hidden />
          {device.name}
          {!device.online && <span className="sx-resume-device-state">offline</span>}
        </DropdownItem>
      )) : <div className="sx-resume-menu-empty">No other devices available</div>}
    </DropdownMenu>,
    document.body,
  )
}
