// Watchdog segmented control — Off · Keep moving (default) · Hands-off. Ports the
// prototype's #wdSeg + #wdhint + the WD hint map (dispatch.html). Thin wrapper over
// the shared SegmentedControl.
import React from 'react'
import type { WatchdogPolicy } from './dispatch.types'
import { SegmentedControl } from './SegmentedControl'

export interface WatchdogSegProps {
  value: WatchdogPolicy
  onChange: (policy: WatchdogPolicy) => void
}

const POLICIES: { value: WatchdogPolicy; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'keep', label: 'Keep moving' },
  { value: 'handsoff', label: 'Hands-off' },
]

function hint(policy: WatchdogPolicy): React.ReactNode {
  if (policy === 'keep') return <>If it stalls, auto-nudge it. If it&apos;s stuck after 2 tries, <b>ping you</b>.</>
  if (policy === 'off') return 'No auto-nudge'
  return 'Nudges to keep going, only pings on finish/fail'
}

export function WatchdogSeg({ value, onChange }: WatchdogSegProps) {
  return <SegmentedControl options={POLICIES} value={value} onChange={onChange} renderHint={hint} />
}
