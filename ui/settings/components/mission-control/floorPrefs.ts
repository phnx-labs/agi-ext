import { FLOOR_SIDEBAR_DEFAULT_WIDTH, FLOOR_SIDEBAR_MAX_WIDTH, FLOOR_SIDEBAR_MIN_WIDTH } from './FloorSidebar'

// ---------- Floor shell persisted prefs ----------

const FLOOR_PREFS_KEY = 'swarmify.floorPrefs.v1'
export const FLOOR_PREFS_LAYOUT_VERSION = 2

export interface FloorPrefs {
  layoutVersion: number
  plain: boolean
  sidebar: boolean
  // Collapsed icon rail (true) vs the full text sidebar when sidebar is open.
  rail: boolean
  right: boolean
  pinned: string[]
  // Ordered pinned host names for the HOSTS sidebar. null = never customized
  // (the local machine is pinned by default); [] = user explicitly unpinned all.
  hostPins: string[] | null
  sidebarWidth: number
}

export function defaultFloorPrefs(): FloorPrefs {
  return {
    layoutVersion: FLOOR_PREFS_LAYOUT_VERSION,
    plain: false,
    sidebar: false,
    rail: true,
    right: false,
    pinned: [],
    hostPins: null,
    sidebarWidth: FLOOR_SIDEBAR_DEFAULT_WIDTH,
  }
}

function clampSidebarWidth(width: unknown): number {
  const n = typeof width === 'number' ? width : Number(width)
  if (!Number.isFinite(n)) return FLOOR_SIDEBAR_DEFAULT_WIDTH
  return Math.max(FLOOR_SIDEBAR_MIN_WIDTH, Math.min(FLOOR_SIDEBAR_MAX_WIDTH, Math.round(n)))
}

export function loadFloorPrefs(): FloorPrefs {
  try {
    const raw = localStorage.getItem(FLOOR_PREFS_KEY)
    if (!raw) return defaultFloorPrefs()
    const saved = JSON.parse(raw) as Partial<FloorPrefs>
    const parsed = { ...defaultFloorPrefs(), ...saved }
    const migrated = saved.layoutVersion === FLOOR_PREFS_LAYOUT_VERSION
      ? parsed
      : { ...parsed, layoutVersion: FLOOR_PREFS_LAYOUT_VERSION, sidebar: false, rail: true, right: false }
    return { ...migrated, sidebarWidth: clampSidebarWidth(migrated.sidebarWidth) }
  } catch {
    return defaultFloorPrefs()
  }
}

export function saveFloorPrefs(p: FloorPrefs): void {
  try { localStorage.setItem(FLOOR_PREFS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}
