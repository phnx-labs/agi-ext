// Reusable segmented control — the shared JSX behind ModeSeg / SurfaceSeg /
// WatchdogSeg. Renders the prototype's `.seg` button row plus an optional
// `.modehint` line. Generic over the option value (string OR boolean), so a
// boolean axis like Interactive/Headless delegates here unchanged. renderHint
// returns React.ReactNode because hints carry inline markup (e.g. <b>).
import React from 'react'

interface SegmentedOption<T> {
  value: T
  label: string
}

export interface SegmentedControlProps<T> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  renderHint?: (value: T) => React.ReactNode
}

export function SegmentedControl<T extends string | boolean>({ options, value, onChange, renderHint }: SegmentedControlProps<T>) {
  return (
    <>
      <span className="seg">
        {options.map(o => (
          <button key={String(o.value)} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </span>
      {renderHint && <div className="modehint">{renderHint(value)}</div>}
    </>
  )
}
