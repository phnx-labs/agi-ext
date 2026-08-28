import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

/** One windowable item. Height is the pixel footprint in the scroll region;
 *  callers that need variable heights can measure rendered rows and re-derive. */
export interface VirtualListItem {
  key: string
  height: number
}

export interface UseVirtualListOptions {
  /** Extra rows to render above/below the viewport to reduce blanking. */
  overscan?: number
}

export interface UseVirtualListResult<T extends VirtualListItem> {
  scrollRef: React.RefObject<HTMLDivElement | null>
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void
  visibleItems: T[]
  totalHeight: number
  padTop: number
  padBottom: number
  startIndex: number
  endIndex: number
}

/**
 * Fixed-offset windowing primitive extracted from SessionsPane.tsx. Flattens a
 * list of items with known heights into prefix-sum offsets, then renders only
 * the slice that intersects the current viewport plus overscan. The spacer divs
 * above and below keep the scrollbar honest.
 */
export function useVirtualList<T extends VirtualListItem>(
  items: T[],
  options: UseVirtualListOptions = {},
): UseVirtualListResult<T> {
  const { overscan = 4 } = options
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewportH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Prefix-sum offsets: offsets[i] = pixel top of item i; offsets[n] = total height.
  const offsets = useMemo(() => {
    const o = new Array(items.length + 1)
    o[0] = 0
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + items[i]!.height
    return o
  }, [items])
  const totalH = offsets[items.length] ?? 0

  // Binary-search the first visible item, then walk to the last — O(log n) + O(visible).
  const [start, end] = useMemo(() => {
    const avgH = items.length > 0 ? totalH / items.length : 1
    const top = scrollTop - overscan * avgH
    const bottom = scrollTop + viewportH + overscan * avgH
    if (items.length === 0) return [0, 0]
    // first i with offsets[i+1] > top
    let lo = 0
    let hi = items.length - 1
    let first = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] > top) { first = mid; hi = mid - 1 } else lo = mid + 1
    }
    let last = first
    while (last < items.length && offsets[last] < bottom) last++
    return [first, Math.min(last, items.length)]
  }, [scrollTop, viewportH, offsets, items.length, totalH, overscan])

  const visible = items.slice(start, end)
  const padTop = offsets[start] ?? 0
  const padBottom = totalH - (offsets[end] ?? totalH)

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop((e.target as HTMLDivElement).scrollTop)
  }, [])

  return { scrollRef, onScroll, visibleItems: visible, totalHeight: totalH, padTop, padBottom, startIndex: start, endIndex: end }
}
