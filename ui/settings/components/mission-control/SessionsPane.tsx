import React, { useMemo, useState, useCallback } from 'react'
import { Icon } from './icons'
import {
  isPrevious,
  resumeCommand,
  todoProgress,
  type FloorAgent,
  type SessionFilter,
  type SessionGroup,
  type SessionSort,
} from './floorModel'
import {
  scopeSessions,
  buildSessionSections,
  sessionChipCounts,
  orderedPrevious,
  previousInitialCount,
  PREVIOUS_PAGE,
  type SessionSection,
  type SessionScope,
} from './sessionsModel'
import { sessionRowView, type SessionRowView } from './recapModel'
import { useVirtualList } from './useVirtualList'
import { useNow } from './useNow'
import { AgentAvatar, agentIdFromPrefix } from './AgentAvatar'

// The Sessions surface: one place to see every session you own — local + remote,
// active + orphaned — and resume any of them, or a whole project's worth after a
// reboot. It reads the roster AGI EXT already polls (floorAgents); every filter /
// sort / group runs client-side, and the list is virtualized (fixed-offset
// windowing below), so hundreds of rows render like twenty.

const ROW_H = 122
const ROW_EXPANDED_EXTRA = 56
const HEADER_H = 32
const OVERSCAN = 4

export const SESSION_ROW_CSS = `
.sw-sessions .sx-band {
  display: flex; align-items: center; gap: 9px; padding: 9px 14px; height: auto;
  box-sizing: border-box;
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace;
  font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase;
  color: #8b94a6; background: #111828; border-bottom: 1px solid #1b2334; border-top: 0;
}
.sw-sessions .sx-band .g { width: 7px; height: 7px; border-radius: 50%; background: #a78bfa; font-size: 0; color: transparent; }
.sw-sessions .sx-band .lab { letter-spacing: 1.2px; color: #8b94a6; }
.sw-sessions .sx-band .cnt { color: #5c6675; font-size: 11px; letter-spacing: 0; text-transform: none; }
.sw-sessions .sx-band-act {
  margin-left: auto; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace;
  font-size: 11.5px; color: #a3e635; letter-spacing: 0; text-transform: none; font-weight: 400;
  border: 1px solid #34401a; background: #161e0b; border-radius: 6px; padding: 3px 10px;
}
.sw-sessions .sx-row {
  display: flex; align-items: flex-start; gap: 11px;
  padding: 12px 14px; cursor: default; overflow: hidden;
  box-sizing: border-box; width: 100%;
  border-top: 0; border-bottom: 1px solid #1b2334;
  grid-template-columns: none;
}
.sw-sessions .sx-row:last-child { border-bottom: none; }
.sw-sessions .sx-row:hover { background: #0f1625; }
.sw-sessions .sx-row.sel { background: rgba(163, 230, 53, 0.06); }
.sw-sessions .sx-row.active { background: #0f1625; }
.sw-sessions .sx-cb { flex: none; margin-top: 2px; width: 14px; height: 14px; border: 1.5px solid #5c6675; border-radius: 3px; background: transparent; }
.sw-sessions .sx-cb.on { background: #a3e635; border-color: #a3e635; }
.sw-sessions .sx-star { flex: none; margin-top: 1px; color: #5c6675; font-size: 13px; }
.sw-sessions .sx-star.on { color: #f5c518; }
.sw-sessions .sx-pdot { width: 8px; height: 8px; border-radius: 50%; background: #a78bfa; flex: none; margin-top: 5px; }
.sw-sessions .sx-pdot.off { background: #5c6675; }
.sw-sessions .sx-grow { min-width: 0; flex: 1; }
.sw-sessions .sx-titleline { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sw-sessions .sx-ttl { color: #e6e9ef; font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-sessions .sx-src { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 9.5px; letter-spacing: .3px; text-transform: uppercase; padding: 1px 5px; border-radius: 4px; flex: none; }
.sw-sessions .sx-src.agent { color: #4ade80; background: #0d2417; border: 1px solid #1c4a2f; }
.sw-sessions .sx-src.last { color: #6ea8fe; background: #0c1a2e; border: 1px solid #1c3a5a; }
.sw-sessions .sx-src.rename { color: #a78bfa; background: #1a1430; border: 1px solid #342a52; }
.sw-sessions .sx-roleline { display: flex; align-items: flex-start; gap: 9px; margin-top: 3px; font-size: 12.5px; }
.sw-sessions .sx-roletag { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 10.5px; font-weight: 700; flex: none; width: 62px; text-align: right; padding-top: 1px; letter-spacing: .2px; white-space: nowrap; }
.sw-sessions .sx-roletag.you { color: #6ea8fe; }
.sw-sessions .sx-roletag.agent { color: #d97757; }
.sw-sessions .sx-rolebody { min-width: 0; flex: 1; color: #8b94a6; }
.sw-sessions .sx-rolebody.clip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-sessions .sx-expand { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: #5eead4; cursor: pointer; margin-left: 6px; background: none; border: 0; padding: 0; }
.sw-sessions .sx-expand:hover { color: #a3e635; }
.sw-sessions .sx-imgchip, .sw-sessions .sx-cmdchip, .sw-sessions .sx-slashchip {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px;
  border-radius: 5px; padding: 0 6px; margin-right: 5px;
}
.sw-sessions .sx-imgchip { color: #5eead4; background: #0c1a20; border: 1px solid #123; }
.sw-sessions .sx-cmdchip { color: #f5b544; background: #1c1608; border: 1px solid #3a2e12; }
.sw-sessions .sx-slashchip { color: #a78bfa; background: #160f28; border: 1px solid #2a2050; }
.sw-sessions .sx-full { margin: 6px 0 2px 71px; padding: 9px 11px; border-left: 2px solid #223; background: #0b101c; border-radius: 0 7px 7px 0; color: #8b94a6; font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
.sw-sessions .sx-metarow { display: flex; align-items: center; gap: 7px; margin-top: 8px; flex-wrap: wrap; padding-left: 71px; }
.sw-sessions .sx-metarow .sx-chip { display: inline-flex; align-items: center; gap: 5px; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; padding: 1.5px 7px; border-radius: 5px; border: 1px solid #1b2334; color: #8b94a6; white-space: nowrap; background: #0c1220; }
.sw-sessions .sx-metarow .sx-chip.repo { color: #5eead4; border-color: #123; }
.sw-sessions .sx-metarow .sx-chip.pr { color: #a3e635; border-color: #2c3a16; background: #141c0a; }
.sw-sessions .sx-metarow .sx-chip.pr .ci { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; display: inline-block; }
.sw-sessions .sx-metarow .sx-chip.pr .ci.run { background: #f5b544; }
.sw-sessions .sx-metarow .sx-chip.pr .ci.fail { background: #f87171; }
.sw-sessions .sx-metarow .sx-chip.branch { color: #a78bfa; border-color: #241d3a; }
.sw-sessions .sx-metarow .sx-chip.host { color: #8b94a6; }
.sw-sessions .sx-metarow .sx-chip.nopr { color: #5c6675; }
.sw-sessions .sx-rowactions { display: flex; align-items: center; gap: 10px; flex: none; margin-top: 0; }
.sw-sessions button { appearance: none; font-family: inherit; }
.sw-sessions .sx-resumebtn {
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: #a3e635;
  border: 1px solid #34401a; background: #161e0b; border-radius: 6px; padding: 3px 10px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
}
.sw-sessions .sx-resumebtn:hover { background: #1e2a0d; border-color: #4a5a24; }
.sw-sessions .sx-age { color: #5c6675; font-size: 12px; flex: none; width: 34px; text-align: right; margin-top: 1px; }
.sw-sessions .sx-live { width: 10px; height: 10px; border-radius: 50%; background: #4ade80; flex: none; margin-top: 4px; box-shadow: 0 0 6px #4ade8066; }
.sw-sessions .sx-live.idle { background: #f5b544; box-shadow: 0 0 6px #f5b54455; }
.sw-sessions .sx-live.done { background: #5c6675; box-shadow: none; }
.sw-sessions .sx-live.orphan { background: #a78bfa; box-shadow: 0 0 6px #a78bfa66; }
@media (max-width: 720px) {
  .sw-sessions .sx-row { gap: 7px; padding: 9px 10px; }
  .sw-sessions .sx-cb, .sw-sessions .sx-star { display: none; }
  .sw-sessions .sx-roletag { width: 48px; }
  .sw-sessions .sx-metarow { padding-left: 57px; }
  .sw-sessions .sx-rowactions { gap: 6px; }
  .sw-sessions .sx-resumebtn { padding: 3px 6px; }
  .sw-sessions .sx-resumelabel { display: none; }
  .sw-sessions .sx-age { width: 28px; font-size: 10px; }
}
`

// fleet-controlroom: light/dark-safe token overrides + the Control-Room card
// elements (agent logo, project tag, phase pill, now-line). Injected AFTER
// SESSION_ROW_CSS so these win on conflict without rewriting the base block.
// Dark hex kept as var() fallbacks so a missing token still renders.
export const SESSION_ROW_CSS2 = `
.sw-sessions .sx-band { background: var(--ds-bg-sunken, #111828); color: var(--ds-text-dim, #8b94a6); border-bottom-color: var(--ds-border, #1b2334); }
.sw-sessions .sx-band .lab { color: var(--ds-text, #e6e9ef); font-weight: 600; }
.sw-sessions .sx-band .cnt { color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-band .g { background: var(--brand, #a3e635); border-radius: 3px; }
.sw-sessions .sx-band.recon .g { background: #a78bfa; }
.sw-sessions .sx-band-act { color: var(--brand, #a3e635); background: rgba(163,230,53,.12); border-color: var(--brand, #a3e635); }
.sw-sessions .sx-row { border-bottom-color: var(--ds-border, #1b2334); }
.sw-sessions .sx-row:hover { background: rgba(127,140,160,0.07); }
.sw-sessions .sx-row.active { background: rgba(127,140,160,0.10); }
.sw-sessions .sx-ttl { color: var(--ds-text, #e6e9ef); }
.sw-sessions .sx-rolebody { color: var(--ds-text-dim, #8b94a6); }
.sw-sessions .sx-full { background: var(--ds-bg-sunken, #0b101c); color: var(--ds-text-dim, #8b94a6); border-left-color: var(--ds-border, #223); margin-left: 49px; }
.sw-sessions .sx-metarow { padding-left: 49px; }
.sw-sessions .sx-metarow .sx-chip { background: var(--ds-bg-sunken, #0c1220); border-color: var(--ds-border, #1b2334); color: var(--ds-text-dim, #8b94a6); }
.sw-sessions .sx-metarow .sx-chip.pr { color: var(--brand, #a3e635); background: rgba(163,230,53,.08); border-color: rgba(163,230,53,.3); }
.sw-sessions .sx-metarow .sx-chip.ticket { color: #a78bfa; border-color: rgba(167,139,250,.3); }
.sw-sessions .sx-metarow .sx-chip.repo { color: #2aa899; border-color: rgba(94,234,212,.3); }
.sw-sessions .sx-metarow .sx-chip.branch { color: #a78bfa; border-color: rgba(167,139,250,.25); }
.sw-sessions .sx-metarow .sx-chip.host, .sw-sessions .sx-metarow .sx-chip.nopr { color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-src.agent { background: rgba(74,222,128,.12); border-color: rgba(74,222,128,.3); }
.sw-sessions .sx-src.last { background: rgba(110,168,254,.12); border-color: rgba(110,168,254,.3); }
.sw-sessions .sx-src.rename { background: rgba(167,139,250,.12); border-color: rgba(167,139,250,.3); }
.sw-sessions .sx-imgchip { background: rgba(94,234,212,.1); border-color: rgba(94,234,212,.28); }
.sw-sessions .sx-cmdchip { background: rgba(245,181,68,.12); border-color: rgba(245,181,68,.3); }
.sw-sessions .sx-slashchip { background: rgba(167,139,250,.12); border-color: rgba(167,139,250,.3); }
.sw-sessions .sx-resumebtn { color: var(--brand, #a3e635); background: rgba(163,230,53,.12); border-color: var(--brand, #a3e635); }
.sw-sessions .sx-resumebtn:hover { background: rgba(163,230,53,.2); }
.sw-sessions .sx-age { color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-cb { border-color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-cb.on { background: var(--brand, #a3e635); border-color: var(--brand, #a3e635); }
.sw-sessions .sx-star { color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-av { flex: none; margin-top: 1px; }
.sw-sessions .sx-roletag { width: 40px; }
.sw-sessions .sx-titleline { margin-bottom: 3px; gap: 7px; }
.sw-sessions .sx-agent { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 10.5px; color: var(--ds-text-dim, #8b94a6); font-weight: 600; flex: none; }
.sw-sessions .sx-proj { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 10.5px; color: var(--brand, #a3e635); font-weight: 700; letter-spacing: .4px; text-transform: uppercase; flex: none; }
.sw-sessions .sx-phase { margin-left: auto; flex: none; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 9.5px; letter-spacing: .3px; text-transform: uppercase; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--ds-border, #1b2334); color: var(--ds-text-dim, #8b94a6); white-space: nowrap; }
.sw-sessions .sx-phase.running { color: #6ea8fe; border-color: rgba(110,168,254,.4); background: rgba(110,168,254,.10); }
.sw-sessions .sx-phase.idle, .sw-sessions .sx-phase.waiting { color: #d98a2b; border-color: rgba(245,181,68,.45); background: rgba(245,181,68,.14); }
.sw-sessions .sx-phase.failed { color: #dc4b4b; border-color: rgba(248,113,113,.45); background: rgba(248,113,113,.14); }
.sw-sessions .sx-phase.done { color: #2f9e5a; border-color: rgba(74,222,128,.4); background: rgba(74,222,128,.10); }
.sw-sessions .sx-phase.needs { color: #dc4b4b; border-color: rgba(248,113,113,.55); background: rgba(248,113,113,.16); font-weight: 700; }
.sw-sessions .sx-now { font-size: 12px; color: var(--ds-text-dim, #8b94a6); margin: 0 0 4px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-sessions .sx-now b { color: var(--ds-text, #e6e9ef); font-weight: 600; }
`

// PHNX-3593: the Previous·resumable band, the device chip, the View action for
// non-resumable harnesses, and the click-to-expand detail card (the ask / activity
// bar / checklist / catch-up). Injected last so it wins on conflict.
export const SESSION_ROW_CSS3 = `
.sw-sessions .sx-band.previous .g { background: #a78bfa; }
.sw-sessions .sx-band-more {
  margin-left: 8px; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px;
  color: var(--ds-text-dim, #8b94a6); background: none; border: 0; cursor: pointer; letter-spacing: 0; text-transform: none;
}
.sw-sessions .sx-band-more:hover { color: var(--brand, #a3e635); }
.sw-sessions .sx-metarow .sx-chip.device { color: #6ea8fe; border-color: rgba(110,168,254,.3); }
.sw-sessions .sx-metarow .sx-chip.attach { color: #5eead4; border-color: rgba(94,234,212,.28); }
.sw-sessions .sx-metarow .sx-chip.art { color: #f5b544; border-color: rgba(245,181,68,.3); }
.sw-sessions .sx-viewbtn {
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: var(--ds-text-dim, #8b94a6);
  border: 1px solid var(--ds-border, #2a3550); background: transparent; border-radius: 6px; padding: 3px 10px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
}
.sw-sessions .sx-viewbtn:hover { color: var(--ds-text, #e6e9ef); border-color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-detail { margin: 6px 0 4px 49px; display: flex; flex-direction: column; gap: 12px; }
.sw-sessions .sx-dsec { display: flex; flex-direction: column; gap: 6px; }
.sw-sessions .sx-dcap { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-ask { color: var(--ds-text-dim, #8b94a6); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; padding: 8px 11px; border-left: 2px solid var(--ds-border, #223); background: var(--ds-bg-sunken, #0b101c); border-radius: 0 7px 7px 0; max-height: 140px; overflow-y: auto; }
.sw-sessions .sx-goal { color: var(--ds-text-muted, #5c6675); font-size: 12px; font-style: italic; }
.sw-sessions .sx-goal b { color: var(--ds-text-dim, #8b94a6); font-style: normal; }
.sw-sessions .sx-actbar { display: flex; align-items: center; height: 8px; border-radius: 4px; overflow: hidden; background: var(--ds-bg-sunken, #0c1220); border: 1px solid var(--ds-border, #1b2334); }
.sw-sessions .sx-actbar i { height: 100%; }
.sw-sessions .sx-actbar i.reading { background: #6ea8fe; }
.sw-sessions .sx-actbar i.editing { background: #a3e635; }
.sw-sessions .sx-actbar i.agents { background: #a78bfa; }
.sw-sessions .sx-actbar i.idle { background: #3a4560; }
.sw-sessions .sx-actlegend { display: flex; gap: 12px; font-size: 10.5px; color: var(--ds-text-muted, #5c6675); margin-top: 2px; }
.sw-sessions .sx-actlegend span { display: inline-flex; align-items: center; gap: 4px; }
.sw-sessions .sx-actlegend .dot { width: 7px; height: 7px; border-radius: 2px; background: #3a4560; }
.sw-sessions .sx-actlegend .dot.reading { background: #6ea8fe; }
.sw-sessions .sx-actlegend .dot.editing { background: #a3e635; }
.sw-sessions .sx-actlegend .dot.agents { background: #a78bfa; }
.sw-sessions .sx-actlegend .dot.idle { background: #3a4560; }
.sw-sessions .sx-actspan { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--ds-text-muted, #5c6675); margin-top: 2px; }
.sw-sessions .sx-todo { display: flex; flex-direction: column; gap: 3px; }
.sw-sessions .sx-todo .it { display: flex; align-items: baseline; gap: 7px; font-size: 12.5px; color: var(--ds-text-dim, #8b94a6); }
.sw-sessions .sx-todo .it .mk { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 12px; flex: none; width: 12px; }
.sw-sessions .sx-todo .it.done .mk { color: #4ade80; } .sw-sessions .sx-todo .it.done .tx { text-decoration: line-through; color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-todo .it.cur .mk { color: #f5b544; } .sw-sessions .sx-todo .it.cur .tx { color: var(--ds-text, #e6e9ef); }
.sw-sessions .sx-todo .it.pend .mk { color: #5c6675; }
.sw-sessions .sx-catch { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sw-sessions .sx-catch a, .sw-sessions .sx-catch .lnk {
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: var(--ds-text-dim, #8b94a6);
  border: 1px solid var(--ds-border, #1b2334); border-radius: 5px; padding: 2px 8px; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
}
.sw-sessions .sx-catch a:hover, .sw-sessions .sx-catch .lnk:hover { color: var(--ds-text, #e6e9ef); border-color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-catch .lnk.go { color: var(--brand, #a3e635); border-color: var(--brand, #a3e635); background: rgba(163,230,53,.1); }
.sw-sessions .sx-thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.sw-sessions .sx-thumbs .th { width: 46px; height: 46px; border-radius: 6px; border: 1px solid var(--ds-border, #1b2334); object-fit: cover; background: var(--ds-bg-sunken, #0c1220); }
.sw-sessions .sx-thumbs .th.ph { display: inline-flex; align-items: center; justify-content: center; font-size: 16px; color: var(--ds-text-muted, #5c6675); }
`

interface SessionsPaneProps {
  agents: FloorAgent[]
  /** Toggle the favorite (pin) on a session — parent owns the persisted set. */
  onToggleStar: (a: FloorAgent) => void
  /** Resume / focus a single session — parent routes to the owning machine. */
  onResume: (a: FloorAgent) => void
  /** Resume many at once (bulk). Parent loops the resume path. */
  onResumeMany: (agents: FloorAgent[]) => void
  /** Select a session for the detail pane. */
  onSelect: (a: FloorAgent) => void
  /** View a non-resumable session's transcript (recovery: null harnesses).
   *  Defaults to onSelect (open the detail pane) when the parent supplies none. */
  onView?: (a: FloorAgent) => void
  /** Currently selected session id (detail pane). */
  selectedId?: string | null
  /** True while the follower has not yet observed a CLI stream reset. */
  streamDegraded?: boolean
}

type VItem =
  | { kind: 'header'; section: SessionSection; height: number; key: string }
  | { kind: 'row'; agent: FloorAgent; section: SessionSection; height: number; key: string }

function rowHeight(agent: FloorAgent, expanded: boolean, ask: string): number {
  if (!expanded) return ROW_H
  // The detail card: the ask (quoted prompt, capped), the activity bar + legend,
  // the checklist (one line per todo), and the catch-up link row. Estimate each so
  // the virtual list reserves enough space without clipping.
  const askLines = Math.min(8, Math.max(1, ask.split(/\n/).length + Math.ceil(ask.length / 88)))
  const askH = 34 + askLines * 18            // caption + goal + quoted block
  const activityH = 58                        // caption + bar + legend + span
  const todos = agent.todos ?? []
  const todoH = todos.length > 0 ? 22 + todos.length * 20 : 0
  const catchH = 40                           // caption + link row
  return ROW_H + ROW_EXPANDED_EXTRA + askH + activityH + todoH + catchH
}

const SORT_OPTS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Last active' },
  { value: 'started', label: 'Started' },
  { value: 'status', label: 'Status' },
  { value: 'name', label: 'Name' },
  { value: 'tok', label: 'Tokens/s' },
]
const GROUP_OPTS: { value: SessionGroup; label: string }[] = [
  { value: 'state', label: 'State' },
  { value: 'project', label: 'Project' },
  { value: 'host', label: 'Host' },
  { value: 'flat', label: 'Flat' },
]

export function SessionsPane({ agents, onToggleStar, onResume, onResumeMany, onSelect, onView, selectedId, streamDegraded = false }: SessionsPaneProps) {
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [project, setProject] = useState<string | null>(null)
  const [host, setHost] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<SessionGroup>('project')
  const [sort, setSort] = useState<SessionSort>('recent')
  const [desc, setDesc] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // How many Previous rows are shown; null = the default 7-day/50 bound. "Show 10
  // more" bumps it, paging further back through the resumable history.
  const [previousShown, setPreviousShown] = useState<number | null>(null)
  const nowMs = useNow(30000)

  const counts = useMemo(() => sessionChipCounts(agents), [agents])

  // Distinct projects / hosts for the selectors — from the live roster, cheap.
  const projects = useMemo(() => [...new Set(agents.map((a) => a.project).filter(Boolean))].sort(), [agents])
  const hosts = useMemo(() => [...new Set(agents.map((a) => a.hostLabel ?? a.host).filter(Boolean))].sort(), [agents])

  const scope: SessionScope = useMemo(() => ({ filter, project, host, search }), [filter, project, host, search])
  const scoped = useMemo(() => scopeSessions(agents, scope), [agents, scope])
  const sections = useMemo(
    () => buildSessionSections(scoped, group, sort, desc, { filter, nowMs, previousShown: previousShown ?? undefined }),
    [scoped, group, sort, desc, filter, nowMs, previousShown],
  )

  // Flatten sections into a single windowable item list with per-item heights.
  const items: VItem[] = useMemo(() => {
    const out: VItem[] = []
    for (const s of sections) {
      out.push({ kind: 'header', section: s, height: HEADER_H, key: `h:${s.key}` })
      for (const a of s.agents) {
        const open = expanded.has(a.id)
        const ask = open ? sessionRowView(a).you.text : ''
        out.push({ kind: 'row', agent: a, section: s, height: rowHeight(a, open, ask), key: a.id })
      }
    }
    return out
  }, [sections, expanded])

  const { scrollRef, onScroll, visibleItems: visible, totalHeight, padTop, padBottom } = useVirtualList(items, { overscan: OVERSCAN })

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectedAgents = useMemo(() => scoped.filter((a) => selected.has(a.id)), [scoped, selected])
  // Every resumable Previous row in scope — the bulk "Resume all N" default action.
  const previousAll = useMemo(() => orderedPrevious(scoped), [scoped])
  const previousResumable = useMemo(() => previousAll.filter((a) => !!resumeCommand(a)), [previousAll])
  const previousTotal = previousAll.length
  const previousVisible = previousShown ?? previousInitialCount(previousAll, nowMs)
  const previousHasMore = previousTotal > previousVisible

  // A band's group Resume action resumes only the RESUMABLE rows it holds.
  const resumeSection = useCallback((s: SessionSection) => onResumeMany(s.agents.filter((a) => !!resumeCommand(a))), [onResumeMany])
  const showMorePrevious = useCallback(() => setPreviousShown((s) => (s ?? previousInitialCount(previousAll, nowMs)) + PREVIOUS_PAGE), [previousAll, nowMs])
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <div className="sw-sessions">
      <style>{SESSION_ROW_CSS}</style>
      <style>{SESSION_ROW_CSS2}</style>
      <style>{SESSION_ROW_CSS3}</style>
      <div className="sx-filters">
        <div className="sx-chips">
          {(['all', 'active', 'favorites'] as SessionFilter[]).map((f) => (
            <button
              key={f}
              className={`sx-chip${filter === f ? ' on' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f[0]!.toUpperCase() + f.slice(1)}
              <span className="n">{counts[f]}</span>
            </button>
          ))}
        </div>
        <select className="sx-sel" value={project ?? ''} onChange={(e) => setProject(e.target.value || null)} title="Filter by project">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="sx-sel" value={host ?? ''} onChange={(e) => setHost(e.target.value || null)} title="Filter by machine">
          <option value="">All hosts</option>
          {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <div className="sx-search">
          <Icon name="search" size={12} />
          <input
            aria-label="Search sessions"
            placeholder="Search topic, repo, id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="sx-group" title="Group sessions">
          Group <b>{GROUP_OPTS.find((o) => o.value === group)!.label}</b>
          <select value={group} onChange={(e) => setGroup(e.target.value as SessionGroup)}>
            {GROUP_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="sx-group" title="Sort sessions">
          Sort <b>{SORT_OPTS.find((o) => o.value === sort)!.label}</b>
          <select value={sort} onChange={(e) => setSort(e.target.value as SessionSort)}>
            {SORT_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <button className="sx-dir" title={desc ? 'Descending' : 'Ascending'} onClick={() => setDesc((d) => !d)}>
          <Icon name={desc ? 'chevD' : 'chevR'} size={12} />
        </button>
      </div>

      <div className="sx-scroll" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 ? (
          <div className="sx-empty">
            {streamDegraded && agents.length === 0
              ? 'Session data unavailable. Waiting for the first snapshot…'
              : <>No sessions match. {agents.length > 0 && <button className="sx-link" onClick={() => { setFilter('all'); setProject(null); setHost(null); setSearch('') }}>Clear filters</button>}</>}
          </div>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${padTop}px)` }}>
              {visible.map((it, i) =>
                it.kind === 'header' ? (
                  <SectionHeader
                    key={it.section.key}
                    section={it.section}
                    resumableCount={it.section.band === 'previous' ? it.section.agents.filter((a) => !!resumeCommand(a)).length : 0}
                    onResumeAll={() => resumeSection(it.section)}
                    hasMore={it.section.band === 'previous' && previousHasMore}
                    moreCount={PREVIOUS_PAGE}
                    onShowMore={showMorePrevious}
                  />
                ) : (
                  <SessionRow
                    key={it.agent.id}
                    agent={it.agent}
                    nowMs={nowMs}
                    selected={selected.has(it.agent.id)}
                    active={selectedId === it.agent.id}
                    expanded={expanded.has(it.agent.id)}
                    height={it.height}
                    onToggleSelect={toggleSelect}
                    onToggleStar={onToggleStar}
                    onResume={onResume}
                    onView={onView ?? onSelect}
                    onSelect={onSelect}
                    onToggleExpand={toggleExpand}
                  />
                )
              )}
              {/* bottom spacer keeps the scrollbar honest */}
              <div style={{ height: padBottom }} aria-hidden />
            </div>
          </div>
        )}
      </div>

      {(selected.size > 0 || previousResumable.length > 0) && (
        <div className="sx-bulk">
          {selected.size > 0 ? (
            <>
              <span className="sx-bulk-n"><b>{selected.size}</b> selected</span>
              <button className="sx-ghost" onClick={() => setSelected(new Set(scoped.map((a) => a.id)))}>Select all ({scoped.length})</button>
              <button className="sx-ghost" onClick={() => setSelected(new Set())}>Clear</button>
              <button className="sx-ghost" onClick={() => selectedAgents.forEach(onToggleStar)}>Favorite</button>
              <button className="sx-primary" onClick={() => onResumeMany(selectedAgents.filter((a) => !!resumeCommand(a)))}>Resume {selected.size} selected</button>
            </>
          ) : (
            <>
              <span className="sx-bulk-n"><b>{previousResumable.length}</b> previous · resumable</span>
              <button className="sx-primary" onClick={() => onResumeMany(previousResumable)}>Resume all {previousResumable.length}</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SectionHeaderImpl({ section, resumableCount, onResumeAll, hasMore, moreCount, onShowMore }: {
  section: SessionSection
  resumableCount: number
  onResumeAll: () => void
  hasMore: boolean
  moreCount: number
  onShowMore: () => void
}) {
  const isPrev = section.band === 'previous'
  return (
    <div className={`sx-band${isPrev ? ' previous' : ''}${section.kind === 'favorites' ? ' star' : ''}`} style={{ height: HEADER_H }}>
      <span className="g" aria-hidden />
      <span className="lab">{section.label}</span>
      <span className="cnt">{section.total ?? section.agents.length}</span>
      {hasMore && (
        <button className="sx-band-more" onClick={(e) => { e.stopPropagation(); onShowMore() }}>Show {moreCount} more</button>
      )}
      {resumableCount > 0 && (
        <button className="sx-band-act" onClick={(e) => { e.stopPropagation(); onResumeAll() }}>Resume all {resumableCount}</button>
      )}
    </div>
  )
}
const SectionHeader = React.memo(SectionHeaderImpl)

interface RowProps {
  agent: FloorAgent
  nowMs: number
  selected: boolean
  active: boolean
  expanded: boolean
  height: number
  onToggleSelect: (id: string) => void
  onToggleStar: (a: FloorAgent) => void
  onResume: (a: FloorAgent) => void
  onView: (a: FloorAgent) => void
  onSelect: (a: FloorAgent) => void
  onToggleExpand: (id: string) => void
}

function PromptChips({ you }: { you: SessionRowView['you'] }) {
  if (you.kind === 'image') {
    return <><span className="sx-imgchip">{'\u{1F5BC}'} screenshot</span>{you.text}</>
  }
  if (you.kind === 'command') {
    return <><span className="sx-cmdchip">$ {you.chip}</span>{you.text}</>
  }
  if (you.kind === 'skill') {
    return <><span className="sx-slashchip">{you.chip}</span>{you.text}</>
  }
  return <>{you.text}</>
}

const PHASE_LABEL: Record<string, string> = {
  running: 'working', idle: 'idle', waiting: 'waiting', failed: 'failed', done: 'done',
}

/** What a tool call was doing, for the activity bar. */
type ActKind = 'reading' | 'editing' | 'agents' | 'idle'
const ACT_LEGEND: { kind: ActKind; label: string }[] = [
  { kind: 'reading', label: 'reading' },
  { kind: 'editing', label: 'editing' },
  { kind: 'agents', label: 'agents' },
  { kind: 'idle', label: 'idle' },
]
function actKindOf(name: string): ActKind {
  if (/^(Read|Grep|Glob|WebFetch|WebSearch|NotebookRead|LS)$/i.test(name)) return 'reading'
  if (/^(Edit|Write|NotebookEdit|MultiEdit|Bash)$/i.test(name)) return 'editing'
  if (/^(Task|Agent|SendMessage|Workflow)$/i.test(name)) return 'agents'
  return 'idle'
}
/** Proportions of the activity bar by what the session was doing. Falls back to a
 *  single idle span when there is no recent tool stream (every Previous row). */
function activitySegments(a: FloorAgent): { kind: ActKind; pct: number }[] {
  const calls = a.recent ?? []
  if (calls.length === 0) return [{ kind: 'idle', pct: 100 }]
  const tally: Record<ActKind, number> = { reading: 0, editing: 0, agents: 0, idle: 0 }
  for (const c of calls) tally[actKindOf(c.name)] += 1
  const total = calls.length
  return (Object.keys(tally) as ActKind[])
    .filter((k) => tally[k] > 0)
    .map((k) => ({ kind: k, pct: Math.round((tally[k] / total) * 100) }))
}
/** Short "Aug 30, 3:12 PM" for the activity span labels. */
function clockLabel(ms: number): string {
  if (!ms) return ''
  try { return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return '' }
}

function ExpandedDetail({ a, row, nowMs, onResume, onView }: {
  a: FloorAgent; row: SessionRowView; nowMs: number; onResume: (a: FloorAgent) => void; onView: (a: FloorAgent) => void
}) {
  const ask = row.you.text || a.prompt || ''
  const segments = activitySegments(a)
  const todos = a.todos ?? []
  const { done, total } = todoProgress(todos)
  const device = a.sourceDevice || row.host
  const canResume = !isPrevious(a) || !!resumeCommand(a)
  const startLabel = clockLabel(a.startedAtMs || 0)
  const nowLabel = a.lastActivityMs ? clockLabel(a.lastActivityMs) : 'now'
  const attachments = a.attachments ?? []
  return (
    <div className="sx-detail" onClick={(e) => e.stopPropagation()}>
      <div className="sx-dsec">
        <div className="sx-dcap">The ask</div>
        {ask && <div className="sx-ask">{ask}</div>}
        <div className="sx-goal">Goal, as a recap agent reads it: <b>{row.title}</b></div>
        {attachments.length > 0 && (
          <div className="sx-thumbs">
            {attachments.slice(0, 6).map((att, i) =>
              att.thumbnailUri
                ? <img key={i} className="th" src={att.thumbnailUri} alt={att.label} title={att.label} />
                : <span key={i} className="th ph" title={att.label}>{'\u{1F5BC}'}</span>,
            )}
          </div>
        )}
      </div>
      <div className="sx-dsec">
        <div className="sx-dcap">Activity</div>
        <div className="sx-actbar">
          {segments.map((s, i) => <i key={i} className={s.kind} style={{ width: `${s.pct}%` }} />)}
        </div>
        <div className="sx-actlegend">
          {ACT_LEGEND.map((l) => <span key={l.kind}><span className={`dot ${l.kind}`} />{l.label}</span>)}
        </div>
        <div className="sx-actspan"><span>{startLabel || 'started'}</span><span>{nowLabel}</span></div>
      </div>
      {total > 0 && (
        <div className="sx-dsec">
          <div className="sx-dcap">Checklist — {done} of {total} done</div>
          <div className="sx-todo">
            {todos.map((t, i) => {
              const st = String(t.status)
              const cls = st === 'completed' ? 'done' : st === 'in_progress' ? 'cur' : 'pend'
              const mk = st === 'completed' ? '✓' : st === 'in_progress' ? '▸' : '○'
              return <div key={i} className={`it ${cls}`}><span className="mk">{mk}</span><span className="tx">{t.content}</span></div>
            })}
          </div>
        </div>
      )}
      <div className="sx-dsec">
        <div className="sx-dcap">Catch up</div>
        <div className="sx-catch">
          {a.ticket && <span className="lnk">◇ {a.ticket}</span>}
          {row.repo && <span className="lnk">▪ {row.repo}{a.files ? ` · ${a.files} files` : ''}</span>}
          <span className="lnk" onClick={() => onView(a)}>Session ↗</span>
          {device && <span className="lnk">◈ {device}</span>}
          {canResume
            ? <span className="lnk go" onClick={() => onResume(a)}>↻ Resume here</span>
            : <span className="lnk" onClick={() => onView(a)}>View transcript</span>}
        </div>
      </div>
    </div>
  )
}

function SessionRowImpl({
  agent: a, nowMs, selected, active, expanded, height,
  onToggleSelect, onToggleStar, onResume, onView, onSelect, onToggleExpand,
}: RowProps) {
  const prev = isPrevious(a)
  // A LIVE session is always resumable/focusable via the normal path; only a PREVIOUS
  // (index) row gates on a recovery command, so a non-resumable harness (recovery
  // null — grok/gemini/droid/cursor) offers View instead of a dead Resume.
  const canResume = !prev || !!resumeCommand(a)
  // For a Previous (ended) session, Resume relaunches from the transcript on its
  // owning device; the recovery command the row carries already targets --device.
  const resumeTitle = prev
    ? `Resume — relaunch from the transcript on ${a.sourceDevice || a.hostLabel || a.host}`
    : 'Resume this session'
  const row = sessionRowView(a)
  const liveClass = row.live === 'run' ? '' : row.live
  // Control-Room card fields — all straight off the streamed FloorAgent, no new CLI work.
  const agentId = agentIdFromPrefix(a.abbr) ?? (row.harnessTag || 'agent').toLowerCase()
  const phaseClass = prev ? 'done' : a.needs ? 'needs' : (a.phase || 'running')
  const phaseLabel = prev ? 'previous' : a.needs ? 'needs you' : (PHASE_LABEL[a.phase] ?? a.phase ?? '')
  const step = prev ? '' : ((a.summary || '').trim() || (a.verb ? `${a.verb} ${a.target}`.trim() : ''))
  const todos = a.todos ?? []
  const todoDone = todos.filter((t) => String(t.status) === 'completed').length
  const device = a.sourceDevice || row.host
  return (
    <div
      className={`sx-row${selected ? ' sel' : ''}${active ? ' active' : ''}`}
      style={{ height }}
      onClick={() => onToggleExpand(a.id)}
    >
      <button
        className={`sx-cb${selected ? ' on' : ''}`}
        title="Select"
        onClick={(e) => { e.stopPropagation(); onToggleSelect(a.id) }}
      />
      <button
        className={`sx-star${a.pinned ? ' on' : ''}`}
        title={a.pinned ? 'Remove from Favorites' : 'Favorite — pin to top'}
        onClick={(e) => { e.stopPropagation(); onToggleStar(a) }}
      >{a.pinned ? '★' : '☆'}</button>
      <span className="sx-av"><AgentAvatar id={agentId} size={24} title={row.harnessTag || agentId} /></span>
      <span className="sx-grow">
        <div className="sx-titleline">
          <span className="sx-agent">{agentId}</span>
          {a.project && <span className="sx-proj" title={a.project}>{a.project}</span>}
          <span className="sx-ttl" title={row.title}>{row.title}</span>
          {phaseLabel && <span className={`sx-phase ${phaseClass}`} title={a.liveStatus || a.phase}>{phaseLabel}</span>}
        </div>
        {step || (!prev && todos.length > 0) ? (
          <div className="sx-now">
            {step && <b>{step}</b>}
            {!prev && todos.length > 0 && <span>{step ? ' · ' : ''}checklist {todoDone}/{todos.length}</span>}
          </div>
        ) : null}
        {/* Collapsed row leads with the user's prompt (one line) — the important info. */}
        <div className="sx-roleline">
          <span className="sx-roletag you">You ›</span>
          <span className="sx-rolebody clip"><PromptChips you={row.you} /></span>
        </div>
        {/* Compact chip row: attachments, artifacts, and links (PR / ticket / repo / device). */}
        <div className="sx-metarow">
          {row.repo && <span className="sx-chip repo">▪ {row.repo}</span>}
          {row.pr && (
            <span className="sx-chip pr">
              <span className={`ci${row.pr.ci === 'running' ? ' run' : row.pr.ci === 'failed' ? ' fail' : ''}`} />
              {' '}{row.pr.label}
            </span>
          )}
          {a.ticket && <span className="sx-chip ticket">◇ {a.ticket}</span>}
          {row.branch && <span className="sx-chip branch">⑂ {row.branch}</span>}
          {(a.attachments?.length ?? 0) > 0 && <span className="sx-chip attach">{'\u{1F5BC}'} {a.attachments!.length}</span>}
          {(a.plans?.length ?? 0) > 0 && <span className="sx-chip art">◆ {a.plans!.length}</span>}
          {device && <span className="sx-chip device">◈ {device}</span>}
          {!row.pr && !a.ticket && <span className="sx-chip nopr">no PR</span>}
        </div>
        {expanded && <ExpandedDetail a={a} row={row} nowMs={nowMs} onResume={onResume} onView={onView} />}
      </span>
      <span className="sx-rowactions">
        {canResume ? (
          <button
            className="sx-resumebtn"
            title={resumeTitle}
            onClick={(e) => { e.stopPropagation(); onResume(a) }}
          ><span aria-hidden>↻</span><span className="sx-resumelabel">Resume</span></button>
        ) : (
          <button
            className="sx-viewbtn"
            title="View the session transcript (this harness has no resume path)"
            onClick={(e) => { e.stopPropagation(); onView(a) }}
          ><span aria-hidden>↗</span><span className="sx-resumelabel">View</span></button>
        )}
        <span className="sx-age">{row.age}</span>
        <span className={`sx-live${liveClass ? ` ${liveClass}` : ''}`} title={a.liveStatus || a.phase} />
      </span>
    </div>
  )
}
export const SessionRow = React.memo(SessionRowImpl)
