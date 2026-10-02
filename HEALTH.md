---
kind: report
title: Component Health
updated: 2026-10-01
commit: 5bf79877527954f31cabd802a93bb4061eb9030e
---

# AGI EXT health baseline

## Summary

The extension has **59,860 lines of production TypeScript and 26,530 lines of tests** at `5bf7987`. Half of the production code sits in two places: `src/vscode` (21,916) and `ui/settings` (19,578). No size budget has been agreed, so this report sets a baseline rather than measuring against one.

The code splits into two halves that talk only through `postMessage`:

| Half | Scope | Production LOC | Separate reduction found |
|---|---|---|---|
| Back end (extension host) | `src/core`, `src/vscode`, `src/monitor`, `src/mcp`, `src/shared` | 38,301 | about 1,000 LOC of hand-rolled machinery |
| Front end (webviews) | `ui/settings`, `ui/editor` (`app/` was deleted after this baseline), plus the sidebar's inline CSS and JS in `agentPanel.vscode.ts:840-2604` | 21,516, plus about 1,760 inline | about 2,000 LOC of hand-rolled UI |

Agents wrote much of this code by hand, and both halves show the result: helpers and components already in the repo, or in an installed dependency, sit unused next to new copies. The back end has `cachedInFlight` with one caller next to about 12 hand-written caches. The front end has a `components/ui` folder whose `Button` is used 0 times next to 147 raw `<button>`s. See [Back end: hand-rolled machinery](#back-end-hand-rolled-machinery) and [Front end: hand-rolled UI](#front-end-hand-rolled-ui).

The main cost to anyone maintaining it is **re-derivation, not copy-paste**. jscpd finds only 280 cloned lines (0.59%). The real problem is that the extension drops most of what the CLI sends about each session, then rebuilds those facts itself:

- `normalizeActiveSession` (`src/core/remoteSessions.ts:1056-1190`) passes on only a hand-picked set of fields from `SessionWatchRow`. It discards `phase`, `confirmedProject`, `generatedTitle`/`title`, `userPromptKind`, `recapSource`, `lastAgentLine`, `lastUserMessage`, `importantMessage` and `plan`.
- The UI then rebuilds each of these from transcripts, regexes and its own classifiers, which breaks the thin-client rule in `AGENTS.md`. The rebuilt copies have already drifted from the CLI and cause the bugs below.

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
<text x="10" y="236" font-family="ui-monospace,monospace" font-size="11" fill="currentColor">Estimated removal: about 5,000 LOC now, plus about 2,900 once the CLI adds the fields listed in wave 5.</text>
</svg>
</figure>

Estimated reductions, reconciled for overlap between audits:

| Source | Production LOC | Depends on |
|---|---|---|
| Dead or test-only code | about 2,700, plus about 800 test lines | nothing |
| Re-derivations the CLI already provides | about 5,000 | nothing |
| Consolidating duplicates in the extension (net) | about 1,500 | nothing |
| Re-derivations the CLI does not yet provide | about 2,900 | new CLI fields or verbs |
| **Total** | **about 9,000 now, about 12,000 with CLI work** | |

These are estimates from line ranges. The three sources overlap: the dead-code audit and the other two both counted `UnifiedAgentsPane` and the `resumePicker` and `recapModel` builders. Those were counted once.

### Confirmed bugs found by this assessment

| Bug | Evidence |
|---|---|
| Dead agents show as idle | CLI `derivePhase` maps `orphaned`/`crashed` to `failed` (`agents-cli/cli/src/lib/session/active.ts:2885-2887`). The extension ignores `phase`. Its own `mapStatusToPhase` (`src/core/remoteSessions.ts:~1004`) has no case for those statuses and falls through to `default`, which means idle. |
| The sidebar's recent-activity fallback never produces anything | When `live.activity` is empty, `agentPanel.vscode.ts:733` passes `live.tail`, which is plain assistant text, to `collectRecentActivity`. That calls `parseLineForActivity`, which runs `JSON.parse(line)` (`session.activity.ts:106`), throws, and returns nothing. |
| "Local" launches are placed on another machine | `agents run --help` (1.22.118): "A bare interactive run otherwise places itself like --device auto; --local pins it here." The extension emits no flag for `local` (`src/core/agents.ts:249`). Fixed in phnx-labs/agi-ext#83 and shipped in 0.9.376. |
| The watchdog MCP server points at a file that doesn't exist | It is registered at `dist/mcp/watchdog-server.js` (`watchdogBridge.vscode.ts:250-255`), but the VSIX ships `out/mcp/`. `isInstalled` checks only the server name, so it never corrects the path. |
| Activity buffer grows for as long as the window is open | `sessionPresentationStore.ts:86,99` only ever appends. `clear()` (`:147`) is called only from tests. The whole array is reposted on every Fleet rebuild (`settings.vscode.ts:1128`). |
| Host keys don't match the CLI's | Extension: `/[^a-z0-9]+/g` → `-` (`src/shared/project.ts:90`, and again in `floorModel.ts:352`). CLI: `/[^a-z0-9_-]/g` (`machine-id.ts:16`). `mac_mini` becomes two different keys. Reported by the audit, not re-checked. |
| Grouping ignores `confirmedProject` | The extension groups by `resolveProject(cwd)` basename (`sessionProjects.ts:137-169`). The CLI's `watch.ts:98` says not to. Reported by the audit, not re-checked. |
| Non-Claude harnesses skip `agents run` | `openAgentTerminals` (`extension.ts:3630`) and `clearActiveTerminal` (`:4538`) route only Claude through the CLI. Reported by the audit, not re-checked. |
| The sidebar wipes a half-typed reply | Every pushed snapshot replaces the panel with `root.innerHTML` (`agentPanel.vscode.ts:2462,2471`) and recreates `#reply-input` (`:2137`). Nothing saves the draft or the focus. |
| The Fleet webview starts host work for state it never renders | `App.tsx` auto-posts `fetchAgentTerminals` and `subscribeAgentTerminals` (`:550-551`), which start session-file watchers on the host (`settings.vscode.ts:1772`). The `agentTerminals` and `sessionTasks` results are never passed to a component. |
| The webview can SIGTERM any pid | `case 'stopSession'` (`settings.vscode.ts:3122-3128`) runs `process.kill(pid, 'SIGTERM')` for any pid above 1, bypassing `agents sessions stop`. Nothing in the UI sends this message, so deleting the case is the fix. |
| A webview value reaches the shell | `setGithubOwner` only trims `owner` (`settings.vscode.ts:1639`) before ``exec(`gh repo list ${owner} …`)`` (`:1658`). Nothing sends `setGithubOwner`, but the same value is live: `PanelTab.tsx:260` saves `githubOwner` through `saveSettings`, and `resolveGithubOwner` feeds it to the same `exec`. Fix it at the sink. |
| `getSettings` writes global state on every read | The `display` and `notifications` branches (`settings.vscode.ts:1201-1296`) can fire up to 20 unawaited `globalState.update` calls per read, and `getSettings` is called 20 times in that file. Reported by the audit, not re-checked. |
| PowerShell commands use POSIX quoting | `settings.vscode.ts:367-376` breaks on paths containing `'`. `gh repo list ${owner}` is unquoted (`:1658`, `:2460`). Reported by the audit, not re-checked. |

## Findings

Ranked by user-visible value per unit of risk. Each wave lands as its own PR or PRs, and a later wave never waits on an earlier one unless the table says so.

### Wave 0: correctness fixes (small, ship first)

1. Read `row.phase` instead of `mapStatusToPhase`. This removes the idle-for-dead bug and starts wave 3.
2. Point the watchdog MCP path at `out/mcp/watchdog-server.js`, and re-register it when the stored path differs.
3. Done in #83 (0.9.376): `--local` for local launches, plus a `(Local)` variant for each harness. Follow-up: `resumeInBest.ts:60-67` (Resume, Pick Harness) still emits a bare run.
4. Add one `psQuote` beside `shellQuote` in `src/core/deviceDispatchShell.ts`, and quote `owner`.
5. Route every harness through `agents run` in `openAgentTerminals`/`clearActiveTerminal`.
6. Security: delete the `stopSession` case (no sender), and replace the `gh repo list ${owner}` shell string with `execFile` plus owner validation. Deleting `setGithubOwner` alone is not enough, because `saveSettings` carries the owner too.
7. Keep the reply draft and focus across sidebar re-renders, until wave F1 replaces the template.
8. Delete the unused `App.tsx` terminal subscription and its host watchers.
9. Make `getSettings` read-only: merge defaults once at activation and write once.

### Wave 1: delete dead code (no behavior change, about 2,700 LOC plus about 800 test lines)

Found with `tsc --noEmit --noUnusedLocals`, which neither tsconfig enables (`ui/tsconfig.json:32` sets it false), plus non-test importer scans:

- `agentPanel.vscode.ts`: 10 cards that are never rendered (`:1807-2456`), their host branches `revealCwd`, `openWorktree` and `runQuickAction` (`:421-539`), and `runInShellTerminal` `:2744`.
- `settings.vscode.ts`: about 25 router cases that nothing sends (for example `mergePr`, `fetchRecap`, `enrollHost`, `quickSpawn`, `spawnAgentForTask`), about 304 lines, plus `prBoard.vscode.ts`.
- `UnifiedAgentsPane.tsx`:
  - The components `AgentCard` and `DispatchCard`.
  - The constant `NEW_AGENT_MENU`, which is also a hand-written harness list.
  - Host-pin state, and about 15 memos that are computed but never used.
- `floorSnapshot.ts:104-281` (the host-sessions half).
- The `FloorSidebar` component, `TicketDetail.tsx`, `BacklogCenter.tsx`, `watchdogCycles.ts`, and the unused part of `listFilter.ts`.
- `recapModel.buildRecap` and `resumePicker.buildResumeCandidates`, including their helpers. Production uses neither.
- `scripts/bench-fs-watch.ts`. It escapes knip because `scripts/*.ts` is an entry glob.
- Dead state and handlers in `App.tsx`, plus about 40 unused imports.
- Keep it from coming back:
  - Enable `noUnusedLocals` in both tsconfigs.
  - Make `bun run lint:dead` work from a fresh checkout. Today it fails with `knip: command not found` until dependencies are installed.

### Wave 2: performance (each item is small and independent)

| Fix | Effect | Evidence |
|---|---|---|
| Cap activity at a ring buffer of about 200; post `feedActivity.append` deltas | Memory, IPC and render cost stop growing with uptime | `sessionPresentationStore.ts:86,99,143`; `settings.vscode.ts:1128` |
| Don't rebuild Fleet terminals on `activity.append`, and take `swarm.fetchTasks` off the stream path | Removes per-fact transcript reads, 3.0-5.3 ms per live transcript (measured) | `extension.ts:5573`; `terminals.vscode.ts:957-1016`; `swarm.vscode.ts:890-1000` |
| Index sessions by id in the store; skip the label sync for `activity.*`/`attention.*`; broadcast only to sockets that demand the stream | 3.5 ms per fact at 1,000 rows, 50 attention, 30 tabs (measured), multiplied by every window | `sessionPresentationStore.ts:283`; `extension.ts:3837`; `host.ts:302-304` |
| Register commands before the awaited setup; compare before writing `workbench.editorAssociations` | No more "command not found" during activation, and no global settings write in every window | `extension.ts:1228-1262`; `workbench.vscode.ts:12-27` |
| Bundle the extension host with esbuild; lazy-require `yaml`/`ws` | Require time 63-69 ms → 35-39 ms (measured, warm cache) | `scripts/build.sh` is tsc-only; 209 modules |
| Cache the swarm and MCP probes by extension version | Removes `claude mcp list` ×2, `codex mcp list` and `opencode mcp list` at every window's activation | `extension.ts:1119`; `swarm.detect.ts`; `watchdogInstall.ts` |
| Lease heartbeat 2 s → 10 s with a 30 s TTL | About 43k leader writes per day → about 8.6k | `leader.ts:49,78`; `lease.ts:46-58` |
| Remove the shell-adoption log; stop collecting a timer handle per tick | The log is 9.8 MB / 105,483 lines on zion | `terminalReadiness.ts:16-24,400-460` |
| Pause `useNow`/ThroughputCounter while `document.hidden` | The whole floor recomposes every 5 s while hidden | `UnifiedAgentsPane.tsx:326,1369` |
| Load editor lowlight languages lazily and code-split tiptap; debounce the HTML reader by 250 ms | Editor bundle is 1.09 MB in one chunk; the HTML reader reloads its iframe on every keystroke | `ui/editor/components/Editor.tsx:1-30`; `htmlReader.ts:41` |
| Ship only `sql-wasm.js` and `sql-wasm.wasm` | VSIX 35 MB → about 12 MB, until wave 3 removes `sql.js` entirely | `.vscodeignore` `!node_modules/sql.js/**` |

### Wave 3: consume `SessionWatchRow` as typed (about 5,000 LOC, fixes the drift bugs)

Import the row type from agents-cli instead of mirroring it in `RemoteSession`/`RawActiveSession`, store rows unmodified, and delete what this makes unnecessary:

| Delete | LOC | Row field that replaces it |
|---|---|---|
| Transcript readers: `sessions.vscode.ts`, `session.summary.ts`, the `terminals.vscode.ts` tails and preview, `getSessionPreviewForEntry`; also drops `sql.js` | about 1,710 | `firstUserMessage`, `lastUserMessage`, `files`, `timeline`, `attachments`, `tail`, `lastAgentLine`, `sessionFile` |
| Mission-control classifiers (`recapModel`, `floorAdapter`, `floorModel`, `sessionProjects`, `planDetector`) | about 770 | `title`, `recapSource`, `userPromptKind`, `request.headline`, `todos`, `rateLimited`, `plan`, `ticket`, `confirmedProject` |
| Auto-label subsystem (`labelgen`, `sessionName`, `remoteAutoLabel`, the `extension.ts` poller) | about 755 | `title` ladder |
| `remoteSessions.ts` normalizers and mirrored types | about 710 | the row itself, `phase`, `previous` rows |
| `session.activity.ts` JSONL activity parser | about 320 | `activity`, `timeline.steps` |
| `handoff.ts` and `continueInNewSession` | about 275 | `agents sessions fork <id>` |
| `foreman.registry.ts` (a second cross-window registry) | about 277 | the store plus `windowId`/`terminalId`/`viewingIn` |
| `recap.vscode.ts` | about 159 | daemon `goal`/`checkpoints`/`summaryChecklist` |
| `swarm.fetchTasks` meta.json reads | about 140 | `agents teams status --json` |
| Per-host recap fan-out, `watchForPlan`, `extractLinearTicketId` | about 175 | `previous` rows, `plan`, `ticket` |

Deleting the transcript readers also removes performance findings 2 and 7: the per-tab `agents sessions <id> --json` label spawns.

### Wave 4: consolidate within the extension (about 1,500 LOC net)

- **One tab opener:** a single `openAgentTab(spec)` replaces about 10 copies of `createTerminal` → `registerAgentTerminal` → `armAgentReady` in `extension.ts` (`:554`, `2050`, `2159`, `2742`, `3226`, `3511`, `3639`, `4571`, `4842`, `5216`, `5336`). Then split `extension.ts` (5,620 lines) into launch, resume, statusBar, commands and uri modules.
- **One spawn path:** `spawnAgents(argv, {timeout})` in `agentsBin.ts` replaces about 12 hand-rolled spawns (`commitgen`, `labelgen`, `draftPrompt`, `managedProjects`, `deviceHealth`, `watchdog`, `foreman.sources`, and the bare `spawn('agents')` at `extension.ts:236,283`).
- **One harness catalog:** `CLI_AGENT_META` gains `abbr`, `color` and `installHint`. That deletes about 15 hand-written harness lists and unions, for example in `formatting.ts`, `AgentAvatar.tsx`, `dispatchRanking.ts`, `settings.vscode.ts:803,1409`, and `extension.ts:2501`.
- **Shared types:** about 9 hand-copied types in `ui/settings/types/index.ts` and `dispatch.types.ts` move to `@shared` re-exports. `HostLoad` has already drifted between the two copies.
- **One dispatch path:** merge router cases `dispatchTask` (`settings.vscode.ts:2335-2562`) and `dispatch` (`:2594-2717`), and build cloud runs only through `buildCloudDispatchArgs`.
- **One home for time and path helpers:** `src/core/time.ts` and path helpers replace 10 relative-time and duration formatters and 8 basename shorteners.
- **Sidebar into the UI bundle:** the sidebar's inline CSS and JS (`agentPanel.vscode.ts:840-2604`, about 1,760 lines) becomes a `ui/` bundle that reuses `escapeHtml`, `renderMarkdown` and the time helpers.

### Wave 5: CLI-first (about 2,900 LOC, needs agents-cli work first)

| Extension code | CLI addition needed |
|---|---|
| `readinessDetector.ts`, `sessionParse.ts`, `probes.ts`, readiness in `terminalReadiness` (about 1,050) | a readiness fact on the row, keyed by `launchId`/`terminalId` |
| Foreman OpenAI audio and smart (about 670) | a CLI voice/LLM verb |
| `prewarm*` crash-restore mapping (about 403) | daemon-owned restore |
| `resumePicker.classifyResumeState` (about 365) | `resumeState` on the row |
| `projectIndex.ts` and `repoIndex.ts` JSONL scans (about 282) | `agents projects suggest --json` |
| `handoffToAgent` and `findRecentClaudePlan` (about 130) | `sessions fork --agent <other>` |
| Message count and quick-summary counters | `messageCount` and counters on live rows |

### Back end: hand-rolled machinery

About 1,000 LOC net, beyond the waves above. Each item replaces copies with the owner that already exists, or with the Node, VS Code or installed-dependency API.

| Hand-rolled | Copies (evidence) | Replace with | Net LOC |
|---|---|---|---|
| Stringly typed webview protocol | A 103-case `switch` (`settings.vscode.ts:1619`), `handleMessage(msg: any)` (`agentPanel.vscode.ts:407`), 61 `typeof message.x` guards, `isRecord` three times | `WebviewToHost`/`HostToWebview` discriminated unions in `src/shared`, one validator, per-domain handler maps | about -150 |
| TTL and in-flight caches | About 12: `agentModels.ts:4-33`, `hostInventory.ts:175-195`, `agentResources.ts:55-75`, `swarm.vscode.ts:39-62,1017-1046`, `settings.vscode.ts:1410-1452`, `foreman.sources.ts:197,282`, `agentlinks.vscode.ts:164-185`, `swarmifyConfig.vscode.ts:18-104` | `cachedInFlight` (`core/cachedInFlight.ts:21`), which has one caller today | about -110 |
| MCP server plumbing | `watchdog-server.ts` uses the low-level `Server`, hand-written JSON schemas and six content wrappers | `McpServer.registerTool` from the installed `@modelcontextprotocol/sdk` 1.30.0 | about -110 |
| Crash-recovery state stored twice | `sessions.persist.ts` (one YAML file shared by all windows, unlocked read-modify-write at `:49-75`) and prewarm `workspaceState` (`prewarm.vscode.ts:23-27`), restored back to back (`extension.ts:1012-1018`); plus two per-window publishers on 60 s intervals (`extension.ts:5395-5422`, `:5580-5595`) | `context.workspaceState` only; the leader writes `live-terminals.json` from the tuples it already receives | about -280 |
| Terminal replies outside `sessionReply.ts` | `agentPanel.vscode.ts:478-486`, `watchdogBridge.vscode.ts:136-140,211`, `extension.ts:1178-1187,3273,3581`, `settings.vscode.ts:736,2726-2749` | `sessionReply.ts`, which calls itself "the one terminal-reply rail" | about -30 |
| Debounce, sleep, backoff, exec | 7 inline debounce copies, 6 `sleep` copies, 5 backoff loops, 7 `promisify(exec)` | `createCoalescingScheduler` moved to core; `node:timers/promises`; one backoff; `execFile` | about -80 |
| Git and GitHub shell-outs | `exec('git remote get-url origin')` (`settings.vscode.ts:106`) next to the `vscode.git` wrapper (`git.vscode.ts:14`); `inferOwnerFromGhCli` (`:135`) | The `vscode.git` API and `vscode.authentication.getSession('github')` | about -40 |
| Config watcher | `fs.watch` plus a 5 s poll for the file to appear (`swarmifyConfig.vscode.ts:185-240`) | `vscode.workspace.createFileSystemWatcher` | about -40 |
| Logging | 163 `console.*` calls under about 26 tags, three file loggers, two writing the same `shell-adoption.log` | One `createOutputChannel('Agents', {log: true})` passed into core and monitor | small; users can finally see logs |
| PATH lists | `bootstrapPath` (`agentsBin.ts:106`) and `commonBinDirs` (`binResolve.ts:18`); `runAgents` appends `PATH` twice | One list | about -10 |

Structure:

- A value-import cycle runs `extension.ts` ↔ `settings.vscode.ts` ↔ `linear.vscode.ts`. 17 inline `require()` calls work around it.
- Ten `src/vscode` files (about 2,500 LOC) import no `vscode` and belong in `src/core` or deletion. Examples: `sessions.vscode.ts` 861, `foreman.audio.ts` 499, `remoteSessions.vscode.ts` 242.
- 20 of the 80 `src/core` files do filesystem or process IO, so "pure presentation logic" in `AGENTS.md` is not true today.
- Error handling has 20 empty catches and 59 that return null, `[]`, `{}` or false. The riskiest: `settings.vscode.ts:2374` defaults a device's platform to POSIX on failure, which sends the wrong shell to a Windows host.
- 170 comment blocks of 8+ lines hold 2,021 lines, and the code has 234 ticket references. Most of them narrate history that belongs in commits.

Adding a launch verb touches 6-8 files: `package.json`, `launchTarget.ts`, `agents.ts`, its test, `extension.ts`, and, if the Fleet exposes it, a UI `post`, a router `case`, and an import back into `extension.ts` that deepens the cycle.

### Front end: hand-rolled UI

About 2,000 LOC net. The repo already ships the pieces these copies rebuild: `components/ui` (cva and Radix slot), `lucide-react`, `marked` with DOMPurify in `renderMarkdown`, and `SegmentedControl`.

| Wave | Hand-rolled | Copies (evidence) | Replace with | Net LOC |
|---|---|---|---|---|
| F1 | Sidebar webview as a string template | 831 lines of CSS and about 920 of JS (`agentPanel.vscode.ts:849-2604`) rebuilt with `innerHTML`; its own `esc`, regex markdown (`:2255-2296`) and time formatters | A third Vite entry, `ui/sidebar`, reusing `renderMarkdown`, `CardChecklist`, `VerticalTimeline` (no consumer today) and `AgentAvatar`; keep the `--vscode-*` CSS | about -550 |
| F2 | Theming | `ui/settings` has 0 `var(--vscode-*)` references. Three theme mechanisms, 267 hex colors in CSS, and `sessionRowStyles.ts` holding 191 hard-coded dark colors injected with `<style>`; 178 inline `style={{}}` objects; about 37 pill and badge class families | `--ds-*` tokens defined once on top of `--vscode-*`, `SESSION_ROW_CSS` moved into `floor.css`, one `Badge` cva | about -300 |
| F3 | Dropdowns and popovers | 12 copies (`HostSelect`, three in `DispatchPanel`, `ProjectSelect`, `NotifyBell`, two in `UnifiedAgentsPane`, `ResumeDeviceMenu`, `ProjectMenu`, three 150 ms `onBlur` comboboxes in `TaskDetailModal`); 34 clickable `div`s and only one has a role; `useClickAway` lives in an icon file | One `components/ui/Dropdown` with keyboard and Escape, or add `@radix-ui/react-dropdown-menu` beside the installed Radix packages | about -300 |
| F4 | Webview messages | 17 `window.addEventListener('message')` sites while `bridge.onMessage` is unused; `devicesData` parsed three ways in `App.tsx`, `LaunchMatrix.tsx:71` and `UnifiedAgentsPane.tsx:829`; an 800 ms refetch `setTimeout` | The shared unions from the back-end table plus one `useHostMessage(type, fn)` hook | about -120 |
| F5 | `UnifiedAgentsPane` god component | About 1,650 lines with 62 `useState`, 27 `useEffect` and 45 `useMemo`; about 470 lines of pure selectors (`:1003-1470`); derived state stored in state; `SessionsPane.tsx:57-102` hand-estimates row heights | `floorSelectors.ts` next to `floorModel`; row measurement inside `useVirtualList` | about -150 |
| F6 | Copied icons | `mission-control/icons.tsx` (30 paths) and three in `dispatchIcons.tsx` are lucide paths | `lucide-react` 0.561.0, already used in 7 files | about -100 |
| F7 | Modals, toggles, segmented controls | Five overlays with three Escape behaviors and no focus trap; five inline copies of the `Rocker` toggle in `PanelTab.tsx`; two controls that bypass `SegmentedControl` | `components/ui/Modal`, `Rocker` and `SegmentedControl` | about -135 |
| F8 | Electron shell data backend | `app/floorData.ts` reads `~/.agents/*/meta.json` and regex-parses `access_token` from YAML; `floorPoll.ts` refetches every 5 s | Done: `app/` deleted (owner decision, 2026-10-02) | about -400 production, plus its tests and scripts |
| F9 | Editor shortcuts | `KeyboardShortcuts.ts` re-declares about 14 bindings that StarterKit, TaskList and Highlight already provide | The extensions' default bindings | about -35 |

`components/ui` is the root cause of F2, F3 and F7. Its `Button` uses shadcn tokens (`--primary`) while 95% of the UI uses `--ds-*`, so nobody used it. Make it the primitive home on `--ds-*` tokens first, then migrate.

Adding a column to the Fleet list touches 7-8 files across three layers: the CLI row, `settings.vscode.ts`, `ui/settings/types`, `floorModel.ts`, both paths in `floorAdapter.ts`, `SessionRow.tsx`, `sessionRowStyles.ts`, and the hand-tuned `ROW_H` in `SessionsPane.tsx`. After waves 3, F2, F4 and F5 it is three: the row field, the selector and the row markup.

Five more tests assert on source text in `ui/`: `App.poll.test.ts`, `UnifiedAgentsPane.poll.test.ts` (334 lines), `ForemanOrb.test.ts`, and the wiring guard in `floorModel.fixes.test.ts:89-124`, which duplicates knip.

### Owner decisions (not counted above)

- **Migration shims:** about 200 LOC across `watchdog.vscode.ts`, `prewarm.vscode.ts`, `core/settings.ts`, `editorAssociations.ts` and `agentInventory.ts`. How long should the upgrade window stay open?
- **Older-CLI fallbacks:** `handoff.ts:133,161` and `remoteSessions.ts:381-437,1136`. These can go once a minimum CLI version is enforced.
- **Markdown editor `aiAction`:** it posts `aiResult`, which nothing handles. Finish it or delete it.

### Doc drift to correct with the waves

- `AGENTS.md` names `matchLinearProject` as the source of project attribution. The CLI now owns `confirmedProject`.
- `docs/ARCH.md` still says `watchForPlan` is waiting for the CLI to carry `plan`. The row already has it.
- `docs/ARCH.md` lists a transcript `fs.watch` in `terminalReadiness` as debt. It no longer exists.

## Evidence

**How lines were counted:** `git ls-files <area> | grep -E '\.(ts|tsx)$'`, split into tests (`*.test.ts(x)`) and everything else, then `wc -l`. The counts include comments and blank lines. Generated `out/` and `node_modules` are excluded.

| Area | Production | Tests |
|---|---|---|
| `src/vscode` | 21,916 | 3,505 |
| `ui/settings` | 19,578 | 7,953 |
| `src/core` | 12,723 | 12,279 |
| `src/monitor` | 2,869 | 2,148 |
| `ui/editor` | 1,543 | 106 |
| `src/mcp` | 551 | 314 |
| `app` | 395 | 110 |
| `src/shared` + `src/testing` | 285 | 115 |

**Largest files:**

| File | Lines |
|---|---|
| `extension.ts` | 5,620 |
| `settings.vscode.ts` | 3,575 |
| `agentPanel.vscode.ts` | 2,817 |
| `UnifiedAgentsPane.tsx` | 2,408 |
| `remoteSessions.ts` | 1,570 |
| `swarm.vscode.ts` | 1,305 |
| `terminals.vscode.ts` | 1,302 |

**Tools:**

| Tool | Command | Result |
|---|---|---|
| knip | `bunx knip@6 --no-progress` | Clean for unused files and exports; flags `@tiptap/pm`. `--production` gives no usable signal because it fails to load the vite configs. |
| jscpd | `jscpd@4 --min-tokens 60`, tests excluded | 21 clones, 280 lines (0.59%) |
| tsc | `tsc --noEmit --noUnusedLocals`, on the root and `ui/` tsconfigs | Dead locals |

Scripts written for this audit cross-checked non-test importers, webview message types (both directions) and `contributes` against code. All 111 declared commands are registered, and all 8 configuration keys are read.

**Measurements:**

| What | Result | Conditions |
|---|---|---|
| Require time, tsc output | 63-69 ms | node 24, warm cache, stubbed `vscode` |
| Require time, bun bundle (0.69 MB) | 35-39 ms | same |
| Tail read + parse, per transcript | 3.0-5.3 ms | 10 newest real transcripts |
| Store projection cost per fact | 0.07 / 0.69 / 3.5 ms | 100/300/1,000 rows (with matching attention and tab counts) |

**Corrections made during verification:**

- A finding that `sql.js` had no importers was wrong. `sessions.vscode.ts:26` loads it with a dynamic import, so it goes only with the wave 3 transcript readers.

**Back-end and front-end audits (second pass):** value-import cycles were found with a Tarjan cycle finder run under `bun`, because `madge` was not available. Front-end library versions were read from `ui/bun.lock` (`lucide-react` 0.561.0, `@tiptap/*` 2.27.1, `marked` 14.1.4, `dompurify` 3.3.1), because `ui/node_modules` was not installed. Re-checked by hand: the `stopSession` kill, the `gh repo list ${owner}` interpolation, the sidebar `innerHTML` re-render of `#reply-input`, and the unused `App.tsx` terminal subscription.

**Not measured:**

- The live event rate of `agents feed watch`; the command was not run during the audit.
- React render times.
- `claude mcp list` duration.
- Webview memory.

**Scope:** the whole extension repo at `5bf7987`. agents-cli was read at `9f71d1d5b` to compare implementations, not assessed. Findings marked "reported by the audit" in the bug table were not re-checked by hand. LOC figures are estimates from line ranges.
