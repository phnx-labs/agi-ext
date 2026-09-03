// Mode segmented control — Plan · Auto · Edit (default Auto). Ports the prototype's
// #modeSeg + #modehint (dispatch.html renderExpanded / wireExpanded). Thin wrapper
// over the shared SegmentedControl.
import React from 'react'
import type { DispatchMode } from './dispatch.types'
import { SegmentedControl } from './SegmentedControl'

export interface ModeSegProps {
  value: DispatchMode
  onChange: (mode: DispatchMode) => void
}

const MODES: { value: DispatchMode; label: string }[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'auto', label: 'Auto' },
  { value: 'edit', label: 'Edit' },
]

function hint(mode: DispatchMode): React.ReactNode {
  if (mode === 'plan') return 'Read-only. Cannot edit files or run commands until you approve.'
  if (mode === 'auto') return <>Runs safe steps itself, <b>asks before anything risky</b> — deletes, pushes, installs.</>
  return 'Full access — edits files and runs commands without asking.'
}

export function ModeSeg({ value, onChange }: ModeSegProps) {
  return <SegmentedControl options={MODES} value={value} onChange={onChange} renderHint={hint} />
}
