// Surface segmented control — Interactive · Headless (default Interactive).
// Orthogonal to Mode: a headless run still uses Mode's permissions (a headless
// auto-mode agent is the common case). Maps 1:1 to the CLI's --interactive /
// --headless axis. Interactive opens a terminal tab; Headless runs detached in the
// background (no tab) and shows in the Floor under its device, focusable later.
// Thin wrapper over the shared SegmentedControl.
import React from 'react'
import { SegmentedControl } from './SegmentedControl'

export interface SurfaceSegProps {
  headless: boolean
  onChange: (headless: boolean) => void
}

const SURFACES: { value: boolean; label: string }[] = [
  { value: false, label: 'Interactive' },
  { value: true, label: 'Headless' },
]

function hint(headless: boolean): React.ReactNode {
  return headless
    ? <>Runs <b>in the background</b> — no terminal tab. Shows in the Floor under its device; open it later with Focus.</>
    : 'Opens a terminal tab you drive directly.'
}

export function SurfaceSeg({ headless, onChange }: SurfaceSegProps) {
  return <SegmentedControl options={SURFACES} value={headless} onChange={onChange} renderHint={hint} />
}
