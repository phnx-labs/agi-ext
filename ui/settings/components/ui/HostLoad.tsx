import React from 'react'
import type { DispatchHost } from '../mission-control/dispatch.types'
import type { DispatchDevice } from '../mission-control/DispatchPanel'

export function HostLoad({ host, device }: { host?: DispatchHost; device?: DispatchDevice }) {
  if (host?.kind === 'cloud') return <span className="use">{host.costHint ?? 'usage 60%'}</span>
  const online = device ? device.reachable : host!.online
  if (!online) return <span className="loadtxt busy">offline</span>
  const running = device ? device.runningAgents ?? 0 : host!.agents
  const limit = device?.softLimit
  const hot = device ? limit !== undefined && running >= limit : host!.load === 'hot'
  const filled = device ? Math.min(5, Math.ceil(running / Math.max(1, limit ?? 5) * 5)) : Math.min(5, running)
  const busy = device ? hot : host!.load === 'busy'
  const label = device
    ? hot ? 'At limit' : limit !== undefined ? `${running}/${limit}` : `${running} agents`
    : host!.load === 'idle' ? 'idle' : host!.load === 'free' ? `${running} agent · free` : `${running} agents · busy`
  return <>
    <span className="loadbar">{Array.from({ length: 5 }, (_, i) => <i key={i} className={i < filled ? hot ? 'hot' : 'f' : ''} />)}</span>
    <span className={`loadtxt ${busy ? 'busy' : 'free'}`}>{label}</span>
  </>
}
