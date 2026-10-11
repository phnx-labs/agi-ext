---
kind: report
title: Component Health
updated: 2026-10-11
commit: 1d37830cd5b430e1644daf1fe10a34d802ad0fcc
---

# AGI EXT health baseline

## Summary

The extension has **32,616 lines of production code and 14,876 lines of tests** at `1d37830`, down from 73,157 and 31,253 at `c65ff03`, the commit before the Fleet dashboard was deleted (PHNX-4329, #126 and #127, released as 0.9.394). That is 40,541 production lines (55%) and 16,377 test lines gone in one change. No size budget has been agreed, so this report remains a baseline rather than a measurement against one.

The extension is now one back end and two small front ends:

| Part | Scope | Production LOC | Tests |
|---|---|---|---|
| Extension host | `src/core`, `src/vscode`, `src/monitor`, `src/shared`, `src/testing` | 28,578 | 14,228 |
| Reader webview | `ui/editor`, plus `ui/` build config | 2,358 | 106 |
| Build and release scripts | `scripts/` | 1,680 | 542 |

The two remaining webviews (the Active Session sidebar and the Project panel) are HTML and script strings rendered from the host: `agentPanel.vscode.ts` (2,154 lines), `projectPanel.vscode.ts` (1,039) and the shared cards in `src/shared/sessionCards.ts` (1,862). Every finding about the React Fleet UI, its 103-case message router and its stringly typed protocol went with it.

The main cost left to anyone maintaining the extension is still **re-derivation**: `normalizeActiveSession` (`src/core/remoteSessions.ts`) passes on a hand-picked set of `SessionWatchRow` fields and `mapStatusToPhase` (`remoteSessions.ts:1035`) still rebuilds the phase from a status string, with no case for `orphaned` or `crashed`. The transcript readers that fill the gaps (`sessions.vscode.ts` 789 lines, `session.activity.ts` 402, `sql.js`) are all still in the tree.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 250" role="img" aria-label="Session facts data path today versus target">
<title>Session facts: today versus target</title>
<text x="10" y="20" font-family="system-ui,sans-serif" font-size="13" fill="currentColor" font-weight="600">Today</text>
<rect x="10" y="32" width="190" height="52" rx="8" fill="none" stroke="#8a8f98" stroke-width="1.5"/><text x="22" y="54" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">agents feed watch</text><text x="22" y="72" font-family="ui-monospace,monospace" font-size="11" fill="currentColor">SessionWatchRow (full)</text>
<rect x="240" y="32" width="200" height="52" rx="8" fill="none" stroke="#d9534f" stroke-width="1.5"/><text x="252" y="54" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">normalizeActiveSession</text><text x="252" y="72" font-family="ui-monospace,monospace" font-size="11" fill="currentColor">field allow-list, drops 9</text>
<rect x="480" y="32" width="370" height="52" rx="8" fill="none" stroke="#d9534f" stroke-width="1.5"/><text x="492" y="54" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">UI rebuilds the dropped facts</text><text x="492" y="72" font-family="ui-monospace,monospace" font-size="11" fill="currentColor">transcript reads · sql.js · regex · classifiers</text>
<line x1="200" y1="58" x2="240" y2="58" stroke="#8a8f98"/><line x1="440" y1="58" x2="480" y2="58" stroke="#8a8f98"/>
<text x="10" y="140" font-family="system-ui,sans-serif" font-size="13" fill="currentColor" font-weight="600">Target</text>
<rect x="10" y="152" width="190" height="52" rx="8" fill="none" stroke="#8a8f98" stroke-width="1.5"/><text x="22" y="174" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">agents feed watch</text><text x="22" y="192" font-family="ui-monospace,monospace" font-size="11" fill="currentColor">SessionWatchRow (typed)</text>
<rect x="240" y="152" width="200" height="52" rx="8" fill="none" stroke="#3c9a5f" stroke-width="1.5"/><text x="252" y="174" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">presentation store</text><text x="252" y="192" font-family="ui-monospace,monospace" font-size="11" fill="currentColor">pass-through, indexed</text>
<rect x="480" y="152" width="370" height="52" rx="8" fill="none" stroke="#3c9a5f" stroke-width="1.5"/><text x="492" y="174" font-family="system-ui,sans-serif" font-size="13" fill="currentColor">render row fields</text><text x="492" y="192" font-family="ui-monospace,monospace" font-size="11" fill="currentColor">missing field = CLI change, never a client read</text>
<line x1="200" y1="178" x2="240" y2="178" stroke="#8a8f98"/><line x1="440" y1="178" x2="480" y2="178" stroke="#8a8f98"/>
<text x="10" y="236" font-family="ui-monospace,monospace" font-size="11" fill="currentColor">The Fleet removal took the largest re-deriving consumer (ui/settings). The allow-list and its transcript readers remain.</text>
</svg>
</figure>

## Findings

### What the Fleet removal resolved

Each of these findings from the 2026-10-01 baseline was about code that no longer exists at `1d37830`; it is closed by deletion, not by a fix.

| Finding (2026-10-01) | Status |
|---|---|
| The watchdog MCP server registered at a path the VSIX does not ship | Resolved: `src/mcp`, `watchdog.vscode.ts` and `watchdogBridge.vscode.ts` deleted |
| The Fleet webview starts host watchers for state it never renders (`App.tsx` terminal subscription) | Resolved: `ui/settings` deleted |
| The webview can SIGTERM any pid (`stopSession` case) | Resolved: `settings.vscode.ts` deleted; no `process.kill` on a webview-supplied pid remains |
| A webview value reaches the shell (`gh repo list ${owner}`) | Resolved: no `gh repo list` interpolation remains |
| `getSettings` writes global state on every read | Resolved: router deleted; settings live in `agentSettings.vscode.ts` |
| PowerShell commands use POSIX quoting in `settings.vscode.ts` | Resolved by deletion |
| Grouping ignores `confirmedProject` (`sessionProjects.ts`) | Resolved: `sessionProjects.ts` deleted; the Project panel filters on `confirmedProject` |
| Wave 1 dead code in `settings.vscode.ts`, `prBoard.vscode.ts`, `UnifiedAgentsPane.tsx`, `floorSnapshot.ts`, `FloorSidebar`, `TicketDetail.tsx`, `BacklogCenter.tsx`, `watchdogCycles.ts`, `recapModel`, `resumePicker` | Resolved: all deleted |
| Wave 3 rows for `foreman.registry.ts`, the mission-control classifiers and `planDetector` | Resolved: deleted |
| Wave 4 "one dispatch path", "shared types" in `ui/settings/types`, harness lists in `AgentAvatar.tsx`/`dispatchRanking.ts` | Resolved: deleted |
| Wave 5 Foreman OpenAI audio, `projectIndex.ts`/`repoIndex.ts` scans | Resolved: deleted |
| Back-end table: stringly typed webview protocol (103-case router), MCP server plumbing, `settings.vscode.ts` git and GitHub shell-outs | Resolved: deleted |
| The `extension.ts` ↔ `settings.vscode.ts` ↔ `linear.vscode.ts` value-import cycle | Resolved: both partner files deleted |
| Front-end waves F2 to F8 (theming, dropdowns, messages, `UnifiedAgentsPane`, icons, modals) and the five `ui/` source-text tests | Resolved: `ui/settings` deleted |
| `prewarm.vscode.ts` second crash-recovery store | Resolved earlier; file gone |

### Still open, re-checked at `1d37830`

1. **Dead agents show as idle.** `mapStatusToPhase` (`src/core/remoteSessions.ts:1035`) has no `orphaned`/`crashed` case and falls to `default`; the row's own `phase` is not read. Read `row.phase` instead.
2. **The activity buffer grows and nothing reads it.** `sessionPresentationStore.ts:86,99` appends every `activity.append`; `activityEvents()` (`:143`) has no production caller now that Fleet is gone. Delete the buffer rather than cap it.
3. **The sidebar re-renders by `innerHTML`** (`agentPanel.vscode.ts:1787,1801`), which recreates the reply field on each pushed snapshot. Keep the draft and focus, or move the sidebar into a bundle.
4. **Transcript readers and `sql.js` remain**: `sessions.vscode.ts` (789), `session.activity.ts` (402), `labelgen.ts` (184), `recap.vscode.ts` (114), `handoff.ts` (338), with `sql.js` shipped whole by `.vscodeignore` (`!node_modules/sql.js/**`). This is still wave 3 (consume `SessionWatchRow` as typed); its estimate is now smaller because the Fleet consumers are gone, not re-measured.
5. **`fetchRemoteSessionLabelSource`** (`src/vscode/remoteSessions.vscode.ts:67`) is still called from `extension.ts:3395`.
6. **Readiness debt**: `readinessDetector.ts` (443) and `sessionParse.ts` (63) remain; they need a CLI readiness fact (wave 5).
7. **`extension.ts` is 5,183 lines** with 11 `createTerminal(` sites; one tab opener and a split into launch, resume, status bar and URI modules is still wave 4.
8. **`scripts/bench-fs-watch.ts`** (273) is still outside knip's reach through the `scripts/*.ts` entry glob.
9. **`fs.watch` plus poll in `swarmifyConfig.vscode.ts:199-214`** instead of `createFileSystemWatcher`.
10. **154 `console.*` calls** under `src/` with no output channel.

Not re-checked at `1d37830` (carried from the 2026-10-01 audit as candidates): host keys not matching the CLI's (`src/shared/project.ts`), non-Claude harnesses skipping `agents run` in `openAgentTerminals`/`clearActiveTerminal`, the TTL-cache and debounce copies, lease heartbeat frequency, extension-host bundling with esbuild, and the editor bundle size.

### Doc drift

- `AGENTS.md` still names `matchLinearProject` (`src/shared/linearProjects.ts`) as the source of project attribution; that function and file no longer exist. The Project panel uses `confirmedProject`.
- `docs/PRD.md` and `docs/ARCH.md` were updated for the Fleet removal in the same PR as this report.

## Evidence

**How lines were counted:** `git ls-files <area> | grep -vE '\.test\.|/testdata/|\.md$|bun\.lock' | xargs cat | wc -l` for production, and the same with `grep -E '\.test\.|/testdata/'` for tests, over `src`, `ui` and `scripts`. The counts include comments, blank lines and non-TypeScript files such as `package.json` and shell scripts in those areas. The `c65ff03` baseline was recomputed with the same filter through `git ls-tree`/`git cat-file`: 73,157 production and 31,247 tests (the 31,253 quoted when the deletion was planned included 6 lines of uncommitted test changes).

| Area | Production at `c65ff03` | Production at `1d37830` | Tests at `c65ff03` | Tests at `1d37830` |
|---|---|---|---|---|
| `src/vscode` | 22,405 | 14,035 | 4,761 | 3,659 |
| `src/core` | 14,130 | 9,500 | 13,917 | 7,958 |
| `src/monitor` | 2,994 | 2,983 | 2,764 | 2,523 |
| `src/shared` | 2,264 | 2,008 | 71 | 22 |
| `src/testing` | 52 | 52 | 66 | 66 |
| `src/mcp` | 536 | deleted | 314 | deleted |
| `ui/settings` | 26,639 | deleted | 8,706 | deleted |
| `ui/editor` + `ui/` config | 2,457 | 2,358 | 106 | 106 |
| `scripts` | 1,680 | 1,680 | 542 | 542 |
| **Total** | **73,157** | **32,616** | **31,247** | **14,876** |

**Largest files at `1d37830`:**

| File | Lines |
|---|---|
| `src/vscode/extension.ts` | 5,183 |
| `src/vscode/agentPanel.vscode.ts` | 2,154 |
| `src/shared/sessionCards.ts` | 1,862 |
| `src/core/remoteSessions.ts` | 1,315 |
| `src/vscode/projectPanel.vscode.ts` | 1,039 |
| `src/vscode/terminals.vscode.ts` | 931 |
| `src/vscode/sessions.vscode.ts` | 789 |

**Scope and limits:** the whole extension repo at `1d37830` (origin/main after #126 and #127). This refresh re-measured size and re-checked the open findings listed above by reading the cited lines; it did not re-run jscpd, knip, the `tsc --noUnusedLocals` scan, or the performance measurements of the 2026-10-01 audit, so those numbers are not repeated here. Items under "Not re-checked" are candidates, not confirmed findings.
