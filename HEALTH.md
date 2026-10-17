---
kind: report
title: Component Health
updated: 2026-10-17
commit: fe1a96163db57e9180ad593150b12a3a66238eaa
---

# AGI EXT health baseline

## Summary

The extension is a presentation layer over one `agents feed watch --json` stream: a stream monitor elects one window to own the CLI child, the extension host turns rows into tabs, two sidebars and a Reader editor, and every user action leaves as one `agents …` verb. **Its shape problem is that the same decision is made in several places**: there are 11 hand-built agent-tab openers, two launch-command builders besides the canonical one, two copies of every readiness probe, and two sidebars that compute a card's words separately and now disagree. That is redundancy, not copy-paste. jscpd finds only 0.33% exact duplication, but reading the code shows about 1,700 lines of confirmed removable duplicate or dead code, plus about 700 more that depend on a CLI field. Ten of the duplicated paths have already drifted into user-visible bugs (Findings 1, 2, 5, 6 and 8).

At `fe1a961` the extension has **35,477 production lines and 17,521 test lines**. On 2026-10-11, at `1d37830`, it had 32,616 and 14,876; the 33 commits since added 2,861 production lines, mostly the Project panel (`projectPanel.vscode.ts` grew from 1,039 to 1,760 lines). No size budget has been agreed, so this report remains a baseline.

| Part | Scope | Production | Tests |
|---|---|---|---|
| Extension host | `src/core`, `src/vscode`, `src/monitor`, `src/shared`, `src/testing` | 31,424 | 16,873 |
| Reader webview | `ui/editor` and `ui/` build config | 2,358 | 106 |
| Build and release scripts | `scripts/` | 1,695 | 542 |

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 500" role="img" aria-label="C4 container view of the AGI EXT VS Code extension with numbered finding markers">
<title>AGI EXT: C4 container view (level 2)</title>
<defs>
<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8a8f98"/></marker>
<marker id="ahr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#d9534f"/></marker>
</defs>
<g font-family="system-ui,sans-serif" fill="currentColor">
<!-- person -->
<circle cx="60" cy="178" r="13" fill="none" stroke="#8a8f98" stroke-width="1.5"/>
<rect x="12" y="196" width="96" height="50" rx="10" fill="none" stroke="#8a8f98" stroke-width="1.5"/>
<text x="60" y="216" font-size="12" text-anchor="middle" font-weight="600">Owner</text>
<text x="60" y="233" font-size="10" text-anchor="middle">[Person]</text>
<!-- system boundary -->
<rect x="140" y="16" width="470" height="440" rx="10" fill="none" stroke="#8a8f98" stroke-width="1.2" stroke-dasharray="6 4"/>
<text x="152" y="448" font-size="11" font-weight="600">AGI EXT  [Software system: VS Code extension, one per editor window]</text>
<!-- webviews -->
<rect x="156" y="40" width="140" height="62" rx="8" fill="none" stroke="#3a7bd5" stroke-width="1.5"/>
<text x="166" y="60" font-size="12" font-weight="600">Active Session</text>
<text x="166" y="75" font-size="10">[Webview: HTML strings]</text>
<text x="166" y="90" font-size="10" font-family="ui-monospace,monospace">agentPanel 2,274</text>
<rect x="306" y="40" width="140" height="62" rx="8" fill="none" stroke="#3a7bd5" stroke-width="1.5"/>
<text x="316" y="60" font-size="12" font-weight="600">Project panel</text>
<text x="316" y="75" font-size="10">[Webview: HTML strings]</text>
<text x="316" y="90" font-size="10" font-family="ui-monospace,monospace">projectPanel 1,760</text>
<rect x="456" y="40" width="140" height="62" rx="8" fill="none" stroke="#3a7bd5" stroke-width="1.5"/>
<text x="466" y="60" font-size="12" font-weight="600">Reader editors</text>
<text x="466" y="75" font-size="10">[Webview: React, TipTap]</text>
<text x="466" y="90" font-size="10" font-family="ui-monospace,monospace">ui/editor 2,358</text>
<!-- host -->
<rect x="156" y="178" width="300" height="96" rx="8" fill="none" stroke="#3a7bd5" stroke-width="1.5"/>
<text x="168" y="200" font-size="12" font-weight="600">Extension host</text>
<text x="168" y="216" font-size="10">[Node, VS Code API] commands, tabs, store, URI handler</text>
<text x="168" y="232" font-size="10" font-family="ui-monospace,monospace">extension.ts 4,960 · terminals 931</text>
<text x="168" y="248" font-size="10" font-family="ui-monospace,monospace">terminalReadiness 602 · sessions 789</text>
<text x="168" y="264" font-size="10">presentation store (rows, attention, activity)</text>
<!-- monitor -->
<rect x="156" y="350" width="300" height="72" rx="8" fill="none" stroke="#3a7bd5" stroke-width="1.5"/>
<text x="168" y="372" font-size="12" font-weight="600">Stream monitor</text>
<text x="168" y="388" font-size="10">[Node] leader election, demand gate, broadcast</text>
<text x="168" y="404" font-size="10" font-family="ui-monospace,monospace">src/monitor 2,983 · readinessDetector 443</text>
<!-- harness tabs inside VS Code -->
<rect x="470" y="294" width="126" height="56" rx="8" fill="none" stroke="#3a7bd5" stroke-width="1.5"/>
<text x="480" y="314" font-size="12" font-weight="600">Agent tabs</text>
<text x="480" y="329" font-size="10">[VS Code terminals]</text>
<text x="480" y="343" font-size="10">TUIs via agents run</text>
<!-- externals -->
<rect x="650" y="30" width="220" height="70" rx="8" fill="none" stroke="#8a8f98" stroke-width="1.5"/>
<text x="662" y="52" font-size="12" font-weight="600">agents CLI + daemon</text>
<text x="662" y="68" font-size="10">[External system: agi-cli]</text>
<text x="662" y="84" font-size="10">feed, ps, run, fork, projects, lead</text>
<rect x="650" y="200" width="220" height="56" rx="8" fill="none" stroke="#d9534f" stroke-width="1.5" stroke-dasharray="5 3"/>
<text x="662" y="222" font-size="12" font-weight="600">Harness transcripts</text>
<text x="662" y="240" font-size="10">[Files] ~/.claude, ~/.codex, cursor db</text>
<rect x="650" y="276" width="220" height="56" rx="8" fill="none" stroke="#d9534f" stroke-width="1.5" stroke-dasharray="5 3"/>
<text x="662" y="298" font-size="12" font-weight="600">~/.agents directory</text>
<text x="662" y="316" font-size="10">[Files] the CLI's data home</text>
<rect x="650" y="372" width="220" height="56" rx="8" fill="none" stroke="#8a8f98" stroke-width="1.5"/>
<text x="662" y="394" font-size="12" font-weight="600">Other editor windows</text>
<text x="662" y="412" font-size="10">[Same system, follower monitors]</text>
<!-- arrows -->
<line x1="108" y1="210" x2="154" y2="90" stroke="#8a8f98" stroke-width="1.2" marker-end="url(#ah)"/>
<text x="66" y="128" font-size="10">clicks, replies</text>
<path d="M60 246 C 80 336, 380 334, 468 326" stroke="#8a8f98" stroke-width="1.2" fill="none" marker-end="url(#ah)"/>
<text x="30" y="300" font-size="10">types in tabs</text>
<line x1="300" y1="104" x2="300" y2="176" stroke="#8a8f98" stroke-width="1.2" marker-start="url(#ah)" marker-end="url(#ah)"/>
<text x="306" y="136" font-size="10">postMessage: HTML patches down,</text>
<text x="306" y="150" font-size="10">one action per gesture up</text>
<line x1="300" y1="348" x2="300" y2="276" stroke="#8a8f98" stroke-width="1.2" marker-end="url(#ah)"/>
<text x="306" y="294" font-size="10">SessionWatchRow resets, events</text>
<text x="306" y="306" font-size="10">[in-process]</text>
<line x1="456" y1="270" x2="490" y2="292" stroke="#8a8f98" stroke-width="1.2" marker-end="url(#ah)"/>
<path d="M440 178 C 470 140, 600 70, 648 56" stroke="#8a8f98" stroke-width="1.2" fill="none" marker-end="url(#ah)"/>
<text x="466" y="170" font-size="9">one-shot verbs [execFile argv]</text>
<path d="M456 380 C 646 380, 650 170, 668 102" stroke="#8a8f98" stroke-width="1.2" fill="none" marker-end="url(#ah)"/>
<text x="466" y="374" font-size="10">feed watch --json [NDJSON stdout]</text>
<line x1="456" y1="232" x2="648" y2="228" stroke="#d9534f" stroke-width="1.2" stroke-dasharray="5 3" marker-end="url(#ahr)"/>
<text x="470" y="222" font-size="9" fill="#d9534f">reads transcripts [fs, sql.js]</text>
<line x1="456" y1="256" x2="648" y2="298" stroke="#d9534f" stroke-width="1.2" stroke-dasharray="5 3" marker-end="url(#ahr)"/>
<text x="478" y="252" font-size="9" fill="#d9534f">watches dir [fs.watch, poll]</text>
<line x1="456" y1="404" x2="648" y2="404" stroke="#8a8f98" stroke-width="1.2" marker-end="url(#ah)"/>
<text x="466" y="418" font-size="10">row broadcast [Unix socket]</text>
<!-- finding markers -->
<circle cx="446" cy="188" r="9" fill="#e8a33d"/><text x="446" y="192" font-size="11" font-weight="700" text-anchor="middle" fill="#111">1</text>
<circle cx="600" cy="62" r="9" fill="#e8a33d"/><text x="600" y="66" font-size="11" font-weight="700" text-anchor="middle" fill="#111">2</text>
<circle cx="624" cy="214" r="9" fill="#e8a33d"/><text x="624" y="218" font-size="11" font-weight="700" text-anchor="middle" fill="#111">3</text>
<circle cx="420" cy="262" r="9" fill="#e8a33d"/><text x="420" y="266" font-size="11" font-weight="700" text-anchor="middle" fill="#111">4</text>
<circle cx="446" cy="360" r="9" fill="#e8a33d"/><text x="446" y="364" font-size="11" font-weight="700" text-anchor="middle" fill="#111">4</text>
<circle cx="296" cy="40" r="9" fill="#e8a33d"/><text x="296" y="44" font-size="11" font-weight="700" text-anchor="middle" fill="#111">5</text>
<circle cx="626" cy="270" r="9" fill="#e8a33d"/><text x="626" y="274" font-size="11" font-weight="700" text-anchor="middle" fill="#111">8</text>
<!-- legend -->
<rect x="20" y="462" width="16" height="10" rx="2" fill="none" stroke="#3a7bd5" stroke-width="1.5"/><text x="42" y="471" font-size="10">container in this system</text>
<rect x="190" y="462" width="16" height="10" rx="2" fill="none" stroke="#8a8f98" stroke-width="1.5"/><text x="212" y="471" font-size="10">person or external system</text>
<rect x="380" y="462" width="16" height="10" rx="2" fill="none" stroke="#d9534f" stroke-width="1.5" stroke-dasharray="4 2"/><text x="402" y="471" font-size="10">path that should not exist (debt or bug)</text>
<circle cx="660" cy="467" r="7" fill="#e8a33d"/><text x="672" y="471" font-size="10">finding number</text>
<text x="20" y="490" font-size="10">Arrows: what flows [protocol]. Omitted: Lead tab webview and child, dictation (ffmpeg, whisper-cli), PDF export.</text>
</g>
</g>
</svg>
<figcaption>Container view at <code>fe1a961</code>, traced from <code>child_process</code>, <code>net</code>, <code>registerWebviewViewProvider</code> and <code>fs.watch</code> call sites. Markers 1 to 8 refer to the findings below.</figcaption>
</figure>

## Findings

Ranked by maintenance payoff. "Confirmed" means both sides of a duplicate and all their callers were read at `fe1a961`; "candidate" needs a CLI field or a product decision first. Line estimates are net of the replacement code and were not implemented.

### 1. An agent tab is opened eleven different ways (confirmed, about 290 lines)

There are 12 `createTerminal(` sites. Eleven open agent tabs: `extension.ts` 490, 1939, 2093, 2642, 2877, 3152, 3280, 4257, 4608, 4707, and `customEditor.ts:166`. Only three use `registerAgentTerminal` (`extension.ts:367`). The others each wire `terminals.register`, `readiness.registerTerminal`, the agent type, session id, host and poller by hand. Those hand-wired copies already differ:

- Four sites pass the shell-aware environment. The rest scrub as an agent, including `openSingleAgentWithQueue` (3152), which can launch `shell`.
- Six sites `await terminal.processId` with no timeout (381, 994, 2885, 3161, 3288, 4265). Three use `processIdWithin`.
- `customEditor.ts` never registers readiness. It sends queued prompts with `sendText(msg)` after a flat 5 s wait, and the comment at `extension.ts:3208` says a newline does not submit in Ink.
- `reopenLastClosedSession` (4685) repeats `openAgentSessionTerminal` but skips its live-tab check. It can open a second tab on a session that is already open.
- `extension.ts:778` holds a second `extractTerminalIdentificationOptions` that drops `sessionId` and `version` from the one in `terminals.vscode.ts:32`. So `restoredSessionId(identOpts.sessionId, …)` at `:1010` always receives `undefined`.

One `openTrackedTab(spec)` over `registerAgentTerminal`, one prompt-typing helper, and one exported per-terminal adopt function would remove the copies. That makes the planned split of `extension.ts` (4,960 lines) mechanical.

### 2. Launch commands are composed outside `buildAgentLaunchCommand` (confirmed, about 130 lines)

- `buildClaudeLaunchCommand` (`extension.ts:276`) forwards with no target, so `local` is false and `agents.ts:197` emits `--device auto`. **Clear on a local Claude tab can relaunch it on another machine.**
- `openAgentTerminals` (3263) and `clearActiveTerminal` (3956) start non-Claude harnesses as raw binaries (`codex`, `agy`) with no `agents run`. The startup auto-open (1821) and `agents.open` reach them.
- `customEditor.ts:153` launches `claude --session-id …` through `buildClaudeOpenCommand` (`prewarm.simple.ts:19`), bypassing the CLI.
- `buildAgentRunLaunchCommand` and `buildAutoRunLaunchCommand` (`resumeInBest.ts:32,58`) are two more `agents run` builders without `--cwd`.
- **Fork exists twice.** `forkCurrentSession` runs the CLI's `agents fork`. `forkPickedSession` (4504) launches an agent and types `/continue <id>` into it, which keeps five extra fields on `ForkSessionRequest` (`forkSession.ts:196-211`) alive.

### 3. A transcript reader the debt list does not name (candidate, about 550 lines plus `sql.js`)

`sessions.vscode.ts` (789 lines) reads Claude, Codex, OpenCode and Cursor transcripts, Cursor through `sql.js` (`:17`). Almost all of it feeds one detail line in the Go-to-Terminal picker (`extension.ts:2973-2995`). Replacing it with row fields (`lastActivityMs`, `request.headline`, and a `messageCount` that `docs/ARCH.md` already lists as missing) deletes the file's readers, the `sql.js` and `@types/sql.js` dependencies, and the `sql.js` checks in `scripts/build.sh`. The file also contains a literal NUL byte at `:395` (`file` reports it as "data"), so `grep` silently skips it. That byte is a one-character fix, worth doing now.

### 4. Every readiness probe exists twice (confirmed, about 150 to 190 lines)

`terminalReadiness.ts:402-595` (`startShellReadyProbe`, `startPromptReadyFallbackProbe`, `startAgentReadyProbe`, `startLocalShellAdoption`) mirrors `readinessDetector.ts` (`startShellProbe`, `startPromptProbe`, `startAgentProbe`, `startAdoptionLoop`). Only the key (terminal or pid) and the sink differ; jscpd flags `:563-571` against `readinessDetector.ts:380-388`. `ArmAgentOptions` (`agentKey`, `sessionId`, `cwd`) is built at ten call sites and read by neither probe. Two writers append to `~/.cache/swarmify/shell-adoption.log` (`terminalReadiness.ts:14`, `extension.ts:3586`). Running one `ReadinessDetector` in-window when the monitor is down shrinks named debt instead of carrying a second copy.

### 5. One card renderer, but the card's words are computed twice and drifted (confirmed, about 200 lines)

The sidebars share only `PATCH_SCRIPT` and `THUMB_SCRIPT`. Everything a card says is derived separately:

- **PR verdict.** `prMini` (`core/projectPanel.ts:416`) says "ready to merge" on green checks. `prVerdict` (`agentPanel.vscode.ts:1470`) also checks `mergeable` and `review`. **A conflicting PR reads "ready to merge" on its card and "Conflicts" in the sidebar.** `prAction` (`prStatus.ts:77`) and `prState` (`projectPanel.ts:1052`) are third and fourth readings.
- **Title.** `streamTitle` is bypassed by the resume picker (`sessionPicker.ts:65`), the name sort (`projectPanel.ts:885`) and `agentPanel.vscode.ts:840,1008,1182`. These show the raw `<folder>-<n>` placeholder labels that `streamTitle` filters out.
- **State tone.** Three maps sit on top of `sessionStateOf`: the sidebar's `sessionState()` (`agentPanel.vscode.ts:1296`), `RELATED_DOT` (`:1627`) and `DOT_TONE` (`projectPanel.ts:869`). Each uses its own CSS class vocabulary.
- **Theme tokens.** The tokens are copied in `sessionCards.ts:633-735` and `projectPanel.vscode.ts:1008-1032`, and both copies claim to be the only one. The copies now differ in high-contrast colors, the gold rail and the hover token name. `.card` has a different radius and padding in each, against "one card style".
- **Smaller copies.** Five time formatters (`relAge`, `ago`, `relTime`, `formatSessionWhen`, `waitWords` copied verbatim from `waitFor`), two "latest words" rules that disagree on order (`agentLine` and `agentWords`), four nonce functions (`htmlReader.ts:170` is the exported one), two escapers, duplicated GitHub and Linear SVG marks, and two harness-logo lookups (the sidebar shows the dark logo on light themes).

### 6. Hand-written harness tables (confirmed, about 90 lines)

`utils.ts` restates `PRESENTED_AGENTS` in `KNOWN_PREFIXES`, `PREFIX_MAPPINGS`, the 40-line `NAME_TO_PREFIX`, `ICON_TO_PREFIX`, `PREFIX_TO_ICON` and `SessionAgentType`. It also redeclares a `DisplayPreferences` that differs from `settings.ts:135`. Also hand-written: `terminalReadiness.ts:181-209` (`AGENT_RUN_KEYS` omits `auto`, so `agents run auto --resume` tabs are never detected from their argv), `prewarm.ts` `supportsPrewarming` (which makes Resume in Best Profile silently do nothing for grok, kimi, droid and antigravity at `extension.ts:2704`), and the nine-harness `builtIn` literal duplicated in `settings.ts:217` and `agentSettings.vscode.ts:114`.

### 7. Dead code (confirmed, about 750 lines)

| What | Where | Lines |
|---|---|---|
| Throwaway benchmark kept alive by knip's `scripts/*.ts` entry glob | `scripts/bench-fs-watch.ts` | 273 |
| `summarizeDiff`, `MAX_CONTEXT_SIZE`, the second `prepareCommitContext` call; `.context`/`.userPrompt` assigned at `git.vscode.ts:143` and never read | `src/core/git.ts:114-196`, `:256-273` | 130 |
| mtime cache that never hits (`sessionFilePath` never passed), `todos` computed and dropped, `todoProgressFromCli` duplicating `normalizeTodos` | `handoff.ts:160-226`, `session.activity.ts:48-70` | 60 |
| Unreachable from `extension.ts`; only its test imports it, so knip misses it | `src/core/concurrencyLimiter.ts` | 49 |
| `ArmAgentOptions`, `armAgentKey`, protocol fields no probe reads | Finding 4 sites, `host.ts:199` | 40 |
| Unread `PREWARM_CONFIGS` fields `command`, `statusCommand`, `sessionIdPattern` | `prewarm.ts:17-50` | 40 |
| Router cases no script posts (`revealCwd`, `openPr`, `diff`, `slash` and `sendSlash`), unread `workspaceRoot` | `agentPanel.vscode.ts:524,738-786,1973` | 35 |
| Forwarding wrappers and ignored parameters (`usesManagedAgentLaunch`, `shquote`, `pickLaunchHost`, `setupSwarmIntegrationForAgent`, `modeFlagForAgent`) | `agents.ts:123,133,305`, `swarm.vscode.ts:141` | 35 |
| CSS selectors no markup produces (`.tkt`, `.lab`, `.folder`, `.made`, `.note`, `.fact`, `.checkpoint`, `.actions-row`, …) | `projectPanel.vscode.ts:1041-1279`, `sessionCards.ts:911,1168` | 32 |
| Parameters and branches no caller reaches (`resumeCommandOverride`, `session.cwd`, `session.terminalId`) | `openAgentSessionTerminal`, `extension.ts:2603-2656` | 30 |
| `ICON` table and `icon()`, plus 8 more `tsc --noUnusedLocals` hits | `projectPanel.ts:389-401,985`, `agentPanel.vscode.ts:59,105`, and others in Evidence | 25 |
| `extractFirstNWords` | `utils.ts:240-253` | 14 |

The test-reset hooks (`clearAgentsBinCache`, `clearSessionPathCache`, `clearAgentModelsCache`) are legitimate and stay.

### 8. The user config "file" is the CLI's data directory (confirmed bug, about 40 lines)

`AGENTS_CONFIG_FILENAME` is `.agents` (`swarmifyConfig.ts:6`), so `getUserConfigPath()` (`swarmifyConfig.vscode.ts:24`) is `~/.agents`, a 49-entry directory on this machine. `userConfigExists` is therefore always true, which disables the per-document symlink path (`agentlinks.vscode.ts:79`). `loadUserConfig` gets EISDIR and falls back to defaults. `fs.watch` plus a 5 s poll (`:189-244`) watches the whole directory, so every CLI write there (for example `pty.log`) clears the config cache and re-runs `ensureSymlinksOnWorkspaceOpen` for every folder (`extension.ts:1045`), with no debounce. Fix the path, then use one `createFileSystemWatcher`.

### 9. Exec, cache and debounce helpers written many times (confirmed, about 90 lines)

- **Exec.** `runAgents` (shell string, 9 callers) clones `runCliArgs` (`agentsBin.ts:141-165`), and `deviceHealth.vscode.ts:79` writes its own. Six callers append `process.env.PATH` after `bootstrapPath` already did. `detachAgentToBackground` spawns a bare `'agents'` with its own PATH builder (`extension.ts:186-231`), against the one-resolver invariant.
- **Install package.** Two installers name different packages: `@swarmify/agents-cli` (`swarm.vscode.ts:109`) and `@phnx-labs/agents-cli` (`extension.ts:94`).
- **Caches, debounces, single-flights.** About 12 TTL caches, 5 debounces and 7 single-flight guards exist next to `cachedInFlight` and `coalesceTrailing`. `cachedInFlight`'s TTL half has no production caller, and `agentModels.ts` caches without in-flight dedupe.

### 10. Smaller items

- `getSettings` writes `globalState` on every read (`agentSettings.vscode.ts:64`). It has 21 callers, including the Project panel's render path. Its legacy `claudeCount` migration reads keys `package.json` no longer declares.
- The presentation store's activity buffer grows without bound (`sessionPresentationStore.ts:86,99`). A reset never trims it, and `activityEvents()` copies it on each render.
- Three paths rebind tabs to sessions (`syncTerminalSessionBindingsFromStream`, `tryHydrateLiveSessionId`, and the "legacy label poller" `armAutoLabelPoller`). Keeping only the stream path is about 150 lines (candidate).
- `mapStatusToPhase` (`remoteSessions.ts:1077`) still has no `orphaned` or `crashed` case. `liveStatus` masks it. `sessionIdFromFile` (`:1109-1139`) re-implements `canonicalSessionId`.
- There are 109 `console.*` calls under `src/` and no output channel.
- OpenCode session ids come from running `opencode session list` (`prewarm.simple.ts:27-85`), a non-CLI process (candidate; check whether the stream already binds them).

### Status of the 2026-10-11 findings

| Finding | Now |
|---|---|
| Dead agents show as idle (`mapStatusToPhase`) | Open, Finding 10 |
| Activity buffer has no reader | Changed: it has readers now, but still grows without bound (Finding 10) |
| Sidebar re-renders by `innerHTML` | Resolved: `patchChildren` in `sessionCards.ts` |
| Transcript readers and `sql.js` | Open, Finding 3. `labelgen.ts` is gone; `recap.vscode.ts` and `handoff.ts` remain |
| `fetchRemoteSessionLabelSource` | Resolved: no longer in `src/` |
| Readiness debt | Open, and duplicated in-window (Finding 4) |
| `extension.ts` size, 11 `createTerminal` sites | Open: 4,960 lines, 12 sites (Finding 1) |
| `scripts/bench-fs-watch.ts` | Open, Finding 7 |
| `fs.watch` plus poll in `swarmifyConfig.vscode.ts` | Open, and it watches a directory (Finding 8) |
| 154 `console.*` calls | 109 now |

### Doc drift

- `AGENTS.md:207` lists `watchForPlan` as debt, but it no longer exists in `src/`. `docs/ARCH.md` attributes a recursive transcript `fs.watch` to `terminalReadiness.ts`, which has none. The only `fs.watch` calls left are `swarmifyConfig.vscode.ts:204` and `lead.ts:414`.
- Neither debt list names `sessions.vscode.ts` (Finding 3), `findRecentClaudePlan` (`handoff.ts:51`, which reads the newest file in `~/.claude/plans` across all sessions), or `swarm.detect.ts` (`which` and `mcp list` shell-outs).
- AGENTS.md describes shared session cards. In practice the two sidebars share only the patch and thumbnail scripts (Finding 5).

## Evidence

**Counting.** Production is `git ls-files <area> | grep -vE '\.test\.|/testdata/|\.md$|bun\.lock' | xargs cat | wc -l`; tests use `grep -E '\.test\.|/testdata/'`. Areas are `src`, `ui` and `scripts`. This is the same filter as the 2026-10-11 report, so the counts compare. They include comments, blank lines, CSS, shell and JSON. TypeScript alone is 33,729 production lines.

| Area | Production at `1d37830` | Production at `fe1a961` | Tests at `1d37830` | Tests at `fe1a961` |
|---|---|---|---|---|
| `src/vscode` | 14,035 | 15,829 | 3,659 | 4,284 |
| `src/core` | 9,500 | 10,601 | 7,958 | 9,843 |
| `src/monitor` | 2,983 | 2,983 | 2,523 | 2,523 |
| `src/shared` | 2,008 | 1,945 | 22 | 157 |
| `src/testing` | 52 | 66 | 66 | 66 |
| `ui` | 2,358 | 2,358 | 106 | 106 |
| `scripts` | 1,680 | 1,695 | 542 | 542 |
| **Total** | **32,616** | **35,477** | **14,876** | **17,521** |

**Largest files at `fe1a961`:** `extension.ts` 4,960 · `agentPanel.vscode.ts` 2,274 · `projectPanel.vscode.ts` 1,760 · `sessionCards.ts` 1,690 · `remoteSessions.ts` 1,278 · `core/projectPanel.ts` 1,151 · `terminals.vscode.ts` 931 · `sessions.vscode.ts` 789.

**Tools run, from the worktree at `fe1a961`:**

- `knip` 6.35.1 (`bun run lint:dead`): exit 0, no findings. `knip --production` mis-reports every dependency as unused, because the config declares no production entry, so it was discarded.
- A TypeScript `preProcessFile` import walk from `src/vscode/extension.ts`: 2 unreachable files, `src/core/concurrencyLimiter.ts` and the test double `src/testing/vscodeDouble.ts`.
- An export-consumer scan over `src`, `ui/editor`, `scripts` and `package.json`: 105 exports used only inside their own file, 108 used only by tests besides their own file, and 6 with no production use at all.
- `tsc` 5.9.3 `--noEmit --noUnusedLocals --noUnusedParameters`: 9 hits:
  - `projectPanel.ts:401,985`
  - `agentPanel.vscode.ts:59,105`
  - `customEditor.ts:526`
  - `extension.ts:3049`
  - `sessions.vscode.ts:387`
  - `swarm.vscode.ts:151`
  - `terminals.vscode.ts:562`
- `jscpd` 4.3.0 at `--min-tokens 50` over production code: 9 exact clones, 76 lines (0.33%).
- The `code` skill's `modules.ts` (6 modules; one cycle, `core` ↔ `monitor`), `patterns.ts` (30 discriminator families, 254 collapsible arms, unreviewed) and `signatures.ts` (returned an empty list; treated as no coverage, not as no duplicates).

**Semantic review.** Three independent read-only agents each read one area in full: the terminal and launch paths, the sidebars, and core plus monitor plus scripts. For each candidate duplicate they read both bodies and grepped the callers. The bugs in Findings 1, 2, 5 and 8 and the dead code in Finding 7 were then re-checked by reading the cited lines.

**Limits.** No refactor was implemented, so every line estimate is a reading, not a measurement. Behavior bugs were confirmed by reading code, not by running the extension. `ui/editor` got only the knip and jscpd passes. The NUL byte in `sessions.vscode.ts` hides that file from `grep`-based scanners: the line counts above include it, but any earlier grep-only claim about it is suspect. Line references were checked with `grep -a`.
