---
kind: report
title: AGI EXT architecture
summary: "How the extension turns one agents-cli stream into tabs, a sidebar, and a Fleet dashboard, and turns gestures into one-shot CLI verbs; the measured module graph; the debt and the direction."
status: "Internal design"
project: agi-ext
repository: phnx-labs/agi-ext
tracking: PHNX-4044
date: "2026-09-11"
facts:
  - "7 modules · 12 import edges (11 between source modules) · 2 cycles (measured 2026-09-11)"
  - "One agents feed watch child per machine, demand-gated"
  - "Every consumer reads the warm presentation store"
links:
  - https://github.com/phnx-labs/agi-ext
  - https://linear.app/getrush/issue/PHNX-4044
  - https://linear.app/getrush/issue/PHNX-3939
---

## Summary

AGI EXT is a presentation and interaction layer over agents-cli. The CLI owns every fact (sessions, devices, accounts, executions, teams, attention, activity) and every mechanism (launch, placement, resume, fork, stop, scheduling, watchdog). The extension owns editor tabs, webviews, the mapping between them, and local presentation preferences. Two rules follow: every live fact on screen arrives through one `agents feed watch --json` stream that exactly one elected editor window runs, and every user action leaves the extension as exactly one CLI verb. Missing facts are added to the CLI's stream row, never reconstructed from transcripts or fetched on a loop. The [PRD](PRD.html) states what the user gets; this document explains how the pieces produce it and where the code still falls short.

**Read by question:** [ownership](#ownership) · [runtime components](#components) · [session projection](#projection) · [terminal lifecycle](#lifecycle) · [launch composition](#launch) · [needs-you](#attention) · [module graph and debt](#findings) · [build, test, release](#evidence).

<a id="ownership"></a>

## System boundary and ownership

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 560" role="img" aria-label="C4 container diagram: the editor window with the extension host and sandboxed webviews, the agents CLI daemon and commands, and fleet devices">
<title>C4 container view of AGI EXT</title>
<desc>Containers inside the editor process boundary: the extension host (Node) and sandboxed webviews. Outside: the agents CLI (daemon and one-shot commands) on this machine, and fleet devices reached only by the CLI. Arrows are labeled with what flows and how.</desc>
<defs><marker id="c4a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker><marker id="c4g" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a3e635"/></marker></defs>
<rect x="1" y="1" width="998" height="558" rx="16" fill="#09090b" stroke="#3f3f46"/>
<text x="24" y="30" fill="#a1a1aa" font-family="system-ui,sans-serif" font-size="12">C4 · CONTAINER LEVEL · ONE MACHINE, PLUS THE FLEET THE CLI REACHES</text>
<rect x="24" y="50" width="590" height="400" rx="12" fill="#0f1211" stroke="#5ad6c0" stroke-dasharray="6 4"/>
<text x="40" y="74" fill="#5ad6c0" font-family="system-ui,sans-serif" font-size="13" font-weight="600">Editor process boundary (VS Code / VSCodium, one window; N windows exist)</text>
<rect x="40" y="90" width="340" height="340" rx="10" fill="#161a18" stroke="#26302a"/>
<text x="56" y="114" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="14" font-weight="600">Extension host</text>
<text x="56" y="130" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">Node · out/vscode/extension.js</text>
<rect x="56" y="144" width="320" height="40" rx="6" fill="#12211a" stroke="#a3e635"/><text x="66" y="161" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Stream leader + demand gate</text><text x="66" y="176" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">src/monitor/host.ts · sessionCliStream.ts</text>
<rect x="56" y="192" width="320" height="40" rx="6" fill="#111312" stroke="#3f3f46"/><text x="66" y="209" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Cross-window broadcast (Unix socket)</text><text x="66" y="224" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">src/monitor/broadcast.ts · monitor-broadcast.sock</text>
<rect x="56" y="240" width="320" height="40" rx="6" fill="#111312" stroke="#3f3f46"/><text x="66" y="257" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Presentation store (window-local projection)</text><text x="66" y="272" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">src/core/sessionPresentationStore.ts</text>
<rect x="56" y="288" width="320" height="40" rx="6" fill="#111312" stroke="#3f3f46"/><text x="66" y="305" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Terminal registry + persistence</text><text x="66" y="320" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">terminals.vscode.ts · sessions.persist.ts</text>
<rect x="56" y="336" width="320" height="40" rx="6" fill="#111312" stroke="#3f3f46"/><text x="66" y="353" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Command adapters + URI handler</text><text x="66" y="368" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">extension.ts · agents.ts · launchTarget.ts</text>
<rect x="56" y="384" width="320" height="36" rx="6" fill="#111312" stroke="#3f3f46"/><text x="66" y="401" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Webview bridge</text><text x="66" y="414" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">settings.vscode.ts · agentPanel.vscode.ts</text>
<rect x="400" y="90" width="200" height="340" rx="10" fill="#161a18" stroke="#26302a"/>
<text x="416" y="114" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="14" font-weight="600">Sandboxed webviews</text>
<text x="416" y="130" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">React · Vite · postMessage</text>
<rect x="416" y="144" width="170" height="56" rx="6" fill="#111312" stroke="#3f3f46"/><text x="426" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Fleet dashboard</text><text x="426" y="177" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">ui/settings (3 tabs)</text><text x="426" y="191" fill="#8b938c" font-family="system-ui,sans-serif" font-size="10">list · needs-you · dispatch</text>
<rect x="416" y="208" width="170" height="56" rx="6" fill="#111312" stroke="#3f3f46"/><text x="426" y="226" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Active Session sidebar</text><text x="426" y="241" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">agentsPanel.terminal</text><text x="426" y="255" fill="#8b938c" font-family="system-ui,sans-serif" font-size="10">the one session preview</text>
<rect x="416" y="272" width="170" height="56" rx="6" fill="#111312" stroke="#3f3f46"/><text x="426" y="290" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Reader editors</text><text x="426" y="305" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">ui/editor · htmlReader.ts</text><text x="426" y="319" fill="#8b938c" font-family="system-ui,sans-serif" font-size="10">Markdown editor, HTML viewer</text>
<rect x="416" y="336" width="170" height="84" rx="6" fill="#111312" stroke="#3f3f46"/><text x="426" y="354" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12">Agent terminals</text><text x="426" y="369" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">vscode.Terminal per agent</text><text x="426" y="383" fill="#8b938c" font-family="system-ui,sans-serif" font-size="10">local harness, or ssh to a</text><text x="426" y="397" fill="#8b938c" font-family="system-ui,sans-serif" font-size="10">host; not a webview, drawn</text><text x="426" y="411" fill="#8b938c" font-family="system-ui,sans-serif" font-size="10">here: it lives in the editor</text>
<path d="M376 394L414 394" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#c4a)"/><text x="382" y="389" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="9">view</text>
<path d="M414 410L378 410" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#c4a)"/><text x="381" y="426" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="9">intent</text>
<rect x="660" y="90" width="316" height="160" rx="10" fill="#12211a" stroke="#a3e635"/>
<text x="676" y="114" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="14" font-weight="600">agents CLI (this machine)</text>
<text x="676" y="130" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">daemon + one-shot commands · agentsBin.ts</text>
<text x="676" y="156" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">owns sessions, devices, accounts, attention,</text>
<text x="676" y="172" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">activity, placement, resume, fork, stop,</text>
<text x="676" y="188" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">scheduling, watchdog, restore</text>
<text x="676" y="216" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">agents feed watch --json  (NDJSON, long-lived)</text>
<text x="676" y="232" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="10">agents run · sessions · feed answer (one-shot)</text>
<rect x="660" y="290" width="316" height="160" rx="10" fill="#161a18" stroke="#3f3f46"/>
<text x="676" y="314" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="14" font-weight="600">Fleet devices</text>
<text x="676" y="330" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">reached only by the CLI, over ssh</text>
<text x="676" y="356" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">worker pool (devices role &lt;name&gt; worker)</text>
<text x="676" y="372" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">each runs real harness binaries and its own</text>
<text x="676" y="388" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">agents daemon; the local CLI fans the feed out</text>
<text x="676" y="404" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">per device as its own stream scope</text>
<path d="M660 170L616 170" stroke="#a3e635" stroke-width="1.8" marker-end="url(#c4g)"/><text x="470" y="60" fill="#a3e635" font-family="ui-monospace,monospace" font-size="9"></text>
<path d="M616 210L658 210" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#c4a)"/>
<path d="M818 250L818 288" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#c4a)"/><text x="826" y="273" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="9">ssh · run</text>
<text x="24" y="482" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Legend</text>
<line x1="24" y1="500" x2="60" y2="500" stroke="#a3e635" stroke-width="1.8"/><text x="68" y="504" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">live stream in (NDJSON over a child's stdout)</text>
<line x1="24" y1="520" x2="60" y2="520" stroke="#a1a1aa" stroke-width="1.4"/><text x="68" y="524" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">one-shot command out, or host↔webview message</text>
<rect x="440" y="492" width="36" height="14" rx="3" fill="none" stroke="#5ad6c0" stroke-dasharray="6 4"/><text x="484" y="504" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">process boundary (the editor)</text>
<rect x="440" y="512" width="36" height="14" rx="3" fill="#12211a" stroke="#a3e635"/><text x="484" y="524" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">the CLI and the stream it owns</text>
<text x="24" y="548" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Every window has its own extension host and webviews; only the elected leader window's host runs the stream child.</text>
</svg>
<figcaption>Facts flow in on one lime arrow. Everything else the extension does is a gesture becoming one command.</figcaption>
</figure>

The CLI owns facts and mechanisms. The extension owns presentation: which tab is visible, local labels, dashboard layout, transient selection, and the restoration metadata needed to reopen a tab. When the UI needs a fact the stream lacks, the fact is added to the CLI's `SessionWatchRow` (backfilled from the index, the way `version` landed), never reconstructed from transcripts or fetched on a poll (the one exception, an explicit-click timeline filter, is described under the sidebar row below)ing loop. That side channel is how the 2026-08-25 CPU incident happened (agi-cli#3019).

The invariants, each checkable against the file named:

| Invariant | Enforced where |
|---|---|
| One elected child process receives live CLI state for all windows, and only while a window demands it | `src/monitor/host.ts` `MonitorHost`, `src/monitor/sessionDemand.ts` `SessionStreamDemand`, `src/monitor/host.demand.test.ts` |
| A reset replaces a scope; increments apply only when newer; stale events are ignored | `src/core/sessionPresentationStore.ts` `apply`, `sessionPresentationStore.test.ts` |
| UI code never parses harness transcripts or reads raw agents configuration for facts | rule; remaining violators are listed under [debt](#findings) |
| Acting timers belong to the CLI daemon, never the extension host or a webview | `src/vscode/pollTimers.replacement.test.ts` asserts on source text |
| User actions invoke the owning CLI noun exactly once | `src/core/agents.ts` `buildAgentLaunchCommand`, `src/core/agentsBin.ts` `runAgents` |
| A missing CLI capability fails as an upgrade error, never a filesystem fallback | rule; `src/core/agentsBin.ts` `resolveAgentsBin` throws when the binary is absent |
| Publisher and URI authority stay `swarmify.swarm-ext` | `package.json` `publisher`, `name`; the CLI emits `swarm-ext://swarmify.swarm-ext/…` |
| `src/core` never imports `vscode` | `src/testing/vscodeDouble.test.ts`, the `@shared` Vite alias in `ui/` |

<a id="components"></a>

## Runtime components

The extension host is a single Node process per editor window. It holds the elected stream leader (or a follower client), the broadcast server or client, the window-local presentation store, the terminal registry, the command adapters, and the webview bridge. React webviews render serializable view models and post typed intent back; native VS Code APIs and CLI execution never leave the host.

| Component | Role | Source |
|---|---|---|
| Stream leader | Spawns and owns the single `agents feed watch --json` child in its own process group; exponential restart backoff to 30 s; SIGTERM then SIGKILL on stop | `src/monitor/sessionCliStream.ts` `SessionCliStream`, `SessionCliReplay` |
| Demand gate | Union of every window's demand (dashboard visible, sidebar visible, unresolved agent tab); leases keyed by follower socket so a dropped window releases immediately; 5 s stop debounce | `src/monitor/host.ts` `MonitorHost`, `src/monitor/sessionDemand.ts` |
| Leader election | One window holds the lease: each claim creates the next numbered generation exclusively, so windows starting together elect one leader; a crashed holder (expired, dead pid) is taken over; the holder mirrors itself into the legacy lease file so older installed versions stay followers. Loss triggers election and replay, not one poller per follower. A failed start is retried with backoff to 30 s while the lease is held | `src/monitor/leader.ts`, `src/monitor/lease.ts`, `src/monitor/gate.ts` |
| Broadcast | Unix-socket pub/sub from the leader to follower windows; frames carry monitor facts and session-CLI facts; requests (register tuples, snapshot) flow back | `src/monitor/broadcast.ts`, `src/monitor/protocol.ts`, `src/monitor/follower.ts` |
| Presentation store | Window-local index of rows, attention, activity, per-scope sequence and reset state; selectors derive local/remote groupings and counts without becoming a source of truth | `src/core/sessionPresentationStore.ts` |
| Terminal registry | Maps a `vscode.Terminal` to extension-local id, harness, host, version, account, label, and the canonical session id once known; persists per workspace | `src/vscode/terminals.vscode.ts`, `src/core/sessions.persist.ts`, `src/core/terminals.ts` |
| Launch engine | Turns a command variant and the active workspace into one `agents run` line | `src/core/launchTarget.ts`, `src/core/agents.ts` `buildAgentLaunchCommand`, `src/core/deviceDispatchShell.ts` `shellQuote` |
| CLI location | One resolver and one exec path for the `agents` binary; nvm node first on PATH, then the binary's dir | `src/core/agentsBin.ts` `resolveAgentsBin`, `bootstrapPath`, `runAgents` |
| Command adapters | Every palette command; the `swarm-ext://` URI handler for `/focus`, `/inject`, and `/spawn` (the agents-cli terminal engine's `vscodium-agent` backend resumes a session into an editor tab through it; a request opens only in a window whose folders contain its `project` (no `project` is refused), focuses this window's live tab for the session instead of duplicating it, and with a `nonce` writes `~/.swarmify/agents/spawn-acks/<nonce>.json`, contract in `src/core/spawn.ts`); status bar | `src/vscode/extension.ts`, `src/vscode/sessions.vscode.ts`, `src/vscode/forkCommands.vscode.ts` |
| Webview bridge | Serializes bounded view models into the Fleet webview and routes its messages to host actions | `src/vscode/settings.vscode.ts` (message router), `ui/settings/host/bridge.ts` |
| Active Session sidebar | The one session preview; module-local subject; synchronous render from the store | `src/vscode/agentPanel.vscode.ts` |
| Session cards | The Timeline and Artifacts cards (webview script + stylesheet) the sidebar inlines and an expanded Fleet row evaluates in a shadow root; their host fields and click actions | `src/shared/sessionCards.ts`, `src/core/sessionCardFields.ts`, `src/vscode/sessionCardActions.ts` |
| Project sidebar | One view, four icon tabs (Overview, Sessions, Pull requests, Tickets) for one project; only the active tab loads. Sessions renders store rows filtered on the CLI's `confirmedProject` as cards and is a stream-demand source only while it is the visible tab; a card click is one verb (show the local tab, `agents ps focus --attach-only` for a tab elsewhere, or `openAgentSessionByRecovery`). The other three read one CLI verb when shown or on Refresh, at most once a minute; no timer | `src/vscode/projectPanel.vscode.ts`, `src/core/projectPanel.ts` |
| Session state words | One mapping from the CLI row (phase, live status, attention) to a state and its word, used by the Project panel, the session sidebar and Fleet rows | `src/shared/sessionState.ts` |
| Fleet dashboard | React app with `floor`, `bench`, `panel` tabs; floor model, needs-you ranking, project attribution, dispatch panel, recap ledger | `ui/settings/App.tsx`, `ui/settings/components/mission-control/*` |
| Reader | Optional custom editors for `.md` (TipTap) and `.html` (sandboxed viewer) | `src/vscode/customEditor.ts`, `src/vscode/htmlReader.ts`, `ui/editor/*` |
| Autogit | Diff and status from the git extension; message from `agents run claude --model haiku`; stage, commit, push | `src/vscode/git.vscode.ts`, `src/core/commitgen.ts` |
| Foreman orb | Realtime voice over OpenAI with ffmpeg audio capture; reads floor state, can dispatch and file issues | `src/vscode/foreman.*.ts`, `ui/settings/components/foreman/*` |
| Watchdog bridge | Editor adapter that delivers socket requests to live terminals; the wire protocol and MCP server remain editor-independent | `src/vscode/watchdogBridge.vscode.ts`, `src/mcp/watchdogProtocol.ts`, `src/mcp/watchdog-server.ts` |

<a id="projection"></a>

## Session projection

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 520" role="img" aria-label="UML sequence diagram: agents feed watch emits reset and monotonic upsert/remove events; the leader normalizes and broadcasts; followers apply to their presentation store; tabs, sidebar, and Fleet re-render">
<title>Session projection sequence</title>
<desc>Lifelines for the CLI child, the leader window, the broadcast socket, a follower window's presentation store, and the UI surfaces. A reset replaces a scope; an upsert or remove applies only if its sequence is newer. Solid filled arrows are synchronous calls, open arrowheads are asynchronous messages.</desc>
<defs><marker id="sq-sync" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#e7ece8"/></marker><marker id="sq-async" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5M0 10L10 5" fill="none" stroke="#a3e635" stroke-width="1.5"/></marker></defs>
<rect x="1" y="1" width="998" height="518" rx="16" fill="#09090b" stroke="#3f3f46"/>
<text x="24" y="30" fill="#a1a1aa" font-family="system-ui,sans-serif" font-size="12">UML SEQUENCE · ONE RESET THEN INCREMENTS · TIME FLOWS DOWN</text>
<g font-family="system-ui,sans-serif" font-size="12" fill="#e7ece8">
<rect x="25" y="50" width="180" height="40" rx="6" fill="#12211a" stroke="#a3e635"/><text x="35" y="67" font-size="12">agents feed watch</text><text x="35" y="83" fill="#8b938c" font-size="10">child process (CLI)</text>
<rect x="225" y="50" width="180" height="40" rx="6" fill="#161a18" stroke="#3f3f46"/><text x="235" y="67" font-size="12">Leader window</text><text x="235" y="83" fill="#8b938c" font-size="9">SessionCliStream · MonitorHost</text>
<rect x="425" y="50" width="180" height="40" rx="6" fill="#161a18" stroke="#3f3f46"/><text x="435" y="67" font-size="12">Broadcast socket</text><text x="435" y="83" fill="#8b938c" font-size="9">MonitorBroadcastServer</text>
<rect x="625" y="50" width="180" height="40" rx="6" fill="#161a18" stroke="#3f3f46"/><text x="635" y="67" font-size="12">Presentation store</text><text x="635" y="83" fill="#8b938c" font-size="10">per window</text>
<rect x="815" y="50" width="180" height="40" rx="6" fill="#161a18" stroke="#3f3f46"/><text x="825" y="67" font-size="12">UI consumers</text><text x="825" y="83" fill="#8b938c" font-size="10">tabs · sidebar · Fleet</text>
</g>
<g stroke="#3f3f46" stroke-dasharray="4 4"><line x1="115" y1="90" x2="115" y2="470"/><line x1="315" y1="90" x2="315" y2="470"/><line x1="515" y1="90" x2="515" y2="470"/><line x1="715" y1="90" x2="715" y2="470"/><line x1="905" y1="90" x2="905" y2="470"/></g>
<rect x="310" y="110" width="10" height="330" fill="#26302a"/><rect x="710" y="150" width="10" height="290" fill="#26302a"/>
<path d="M120 130L308 130" stroke="#a3e635" stroke-width="1.5" marker-end="url(#sq-async)"/><text x="130" y="124" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">reset(scope, streamId, sequence, agents[], attention[])</text>
<path d="M320 150L508 150" stroke="#e7ece8" stroke-width="1.5" marker-end="url(#sq-sync)"/><text x="330" y="144" fill="#d4d4d8" font-family="ui-monospace,monospace" font-size="10">ingest into replay cache; broadcast frame</text>
<path d="M520 170L708 170" stroke="#a3e635" stroke-width="1.5" marker-end="url(#sq-async)"/><text x="530" y="164" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">session-cli fact</text>
<path d="M720 190L898 190" stroke="#e7ece8" stroke-width="1.5" marker-end="url(#sq-sync)"/><text x="730" y="184" fill="#d4d4d8" font-family="ui-monospace,monospace" font-size="10">apply: replace scope, mark reset seen</text>
<text x="730" y="206" fill="#8b938c" font-family="system-ui,sans-serif" font-size="10">consumers re-render from selectors</text>
<path d="M120 240L308 240" stroke="#a3e635" stroke-width="1.5" marker-end="url(#sq-async)"/><text x="130" y="234" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">agent.upsert(rowKey, sequence n+1, row)</text>
<path d="M320 260L508 260" stroke="#e7ece8" stroke-width="1.5" marker-end="url(#sq-sync)"/><path d="M520 280L708 280" stroke="#a3e635" stroke-width="1.5" marker-end="url(#sq-async)"/>
<path d="M720 300L898 300" stroke="#e7ece8" stroke-width="1.5" marker-end="url(#sq-sync)"/><text x="730" y="294" fill="#d4d4d8" font-family="ui-monospace,monospace" font-size="10">apply if sequence &gt; last; minimal refresh</text>
<path d="M120 340L308 340" stroke="#a3e635" stroke-width="1.5" marker-end="url(#sq-async)"/><text x="130" y="334" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">attention.remove(rowKey, sequence n+2)</text>
<path d="M320 360L508 360" stroke="#e7ece8" stroke-width="1.5" marker-end="url(#sq-sync)"/><path d="M520 380L708 380" stroke="#a3e635" stroke-width="1.5" marker-end="url(#sq-async)"/>
<path d="M720 400L898 400" stroke="#e7ece8" stroke-width="1.5" marker-end="url(#sq-sync)"/><text x="730" y="394" fill="#d4d4d8" font-family="ui-monospace,monospace" font-size="10">needs-you card leaves; activity receipt</text>
<path d="M120 430L308 430" stroke="#a3e635" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#sq-async)"/><text x="130" y="424" fill="#f5c451" font-family="ui-monospace,monospace" font-size="10">stale event (sequence ≤ last) → ignored at the store; a new streamId → next reset rebuilds</text>
<text x="24" y="492" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="11" font-weight="600">Legend</text>
<line x1="80" y1="489" x2="120" y2="489" stroke="#e7ece8" stroke-width="1.5" marker-end="url(#sq-sync)"/><text x="128" y="493" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">synchronous call</text>
<line x1="250" y1="489" x2="290" y2="489" stroke="#a3e635" stroke-width="1.5" marker-end="url(#sq-async)"/><text x="298" y="493" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">asynchronous message (NDJSON line, socket frame)</text>
<text x="24" y="510" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Each fleet device is its own scope with its own reset on its own ssh timeline; hasSeenReset is per scope (PHNX-2735).</text>
</svg>
<figcaption>The store is a projection. It contains no lifecycle logic and never becomes a source of truth.</figcaption>
</figure>

Exactly one elected window starts the long-lived child, and only while some window reports demand: a visible dashboard or sidebar, or a tracked agent tab whose identity the stream has not resolved yet. When no window demands it the producer is torn down after a 5 s debounce, so an idle window contributes no watcher. The leader normalizes newline-delimited events, keeps a replay cache so a window that gains demand paints current rows without waiting, and broadcasts each event to followers over the monitor socket. A child that keeps dying is respawned with exponential backoff up to 30 s, and its process group is torn down before a restart so an ssh descendant can never outlive it.

`feed watch` is the only producer of three things: session rows, `attention.*` (the sole input to needs-you), and `activity.append`. The cheaper `agents sessions watch --json --local` journal tail carries none of the attention or activity events and drops every remote session unless something replaces the fleet fan-out; switching to it is not a drop-in and stays blocked on the CLI side.

The row that reaches the sidebar carries the summarizer's `goal`, `checkpoints`, `summaryChecklist`, and `summaryState`, and the daemon-computed `request`, `timeline`, and `files`. `src/core/remoteSessions.ts` normalizes all of them at the boundary (2,000 request characters, 8 timeline steps, 8 file rows) and returns `undefined` for anything the CLI did not send, so an older CLI degrades to the documented fallbacks (request → `userPromptClean` → topic; timeline → `checkpoints`; files → nothing) instead of a guess.

The glance fields ride the same row: `title` (best source first), `model`, `failures` (newest 20, failed and blocked), `activityHistogram` (48 fixed buckets plus user-turn times, for the seek bar), `userTurns`, `subagents`, artifact `title`s joined from `.artifact.json` sidecars, and image `attachments` the CLI materialized under `~/.agents/.cache/attachments/`. Artifacts carry `editedAtMs` for newest-first sorting. The sidebar webview's other image root is the home directory, fixed when the view is created (changing roots reloads a webview); it renders a thumbnail only for an image artifact the row names under home for a session on this machine. A remote session's artifacts show as file-type tiles; clicking one copies that single file into `~/.agents/.cache/remote-artifacts/<device>/` with one `agents ssh <device> --argv` call and opens the local copy in the Reader, because a `vscode-remote://` URI fails without a Remote-SSH connection. A request's pasted images resolve by file name in this machine's `~/.agents/.history/attachments/`, where the CLI saves them, so they show for remote sessions too. The request carries the owner's Gravatar (`sha256(email)`, `d=404`, as artifacts-cli uses) over their initial. Each field is absent on an older CLI, and the sidebar then shows counts without lists, or nothing. Three timeline filters (agent messages, tool calls, reasoning) are too large for every row: each is one `agents sessions <id> --include <role> --json` call on an explicit click, cached in the webview per session and filter (marked stale with a Refresh link once newer activity arrives), never on selection or on a timer, and offered only for a session on this machine because `agents sessions` reads the local index. The host answers only a request whose session id is still the panel's subject; a failed load is shown and retried on the next click, never cached.

Failure semantics: a missing CLI binary is a visible prerequisite failure; a malformed feed event is rejected and reported without corrupting the current scope; loss of the leader triggers election and replay; missing facts render as unknown or degraded, and zero is reserved for known zero; a follower that has never observed a `reset` for a scope renders that scope as degraded; resolved attention cannot reappear from an older snapshot; a historical Previous row cannot reclaim a terminal already rebound to another live session on the same owner host.

<a id="lifecycle"></a>

## Terminal lifecycle

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 400" role="img" aria-label="UML state diagram of an agent terminal tab: Opening, Active, Identified, Persisted, Restored, Closed, Stopped, with the rebind self-transition on Identified">
<title>Agent terminal state machine</title>
<desc>States are rounded rectangles, the initial pseudo-state is a filled circle, transitions are labeled with the event that causes them. Identified has a self-transition for a newer session reusing the tab.</desc>
<defs><marker id="st-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="398" rx="16" fill="#09090b" stroke="#3f3f46"/>
<text x="24" y="30" fill="#a1a1aa" font-family="system-ui,sans-serif" font-size="12">UML STATE MACHINE · ONE AGENT TAB</text>
<circle cx="60" cy="110" r="9" fill="#e7ece8"/>
<g font-family="system-ui,sans-serif" font-size="13" fill="#e7ece8" text-anchor="middle">
<rect x="110" y="88" width="130" height="44" rx="14" fill="#161a18" stroke="#3f3f46"/><text x="175" y="115" font-size="13">Opening</text>
<rect x="300" y="88" width="130" height="44" rx="14" fill="#161a18" stroke="#3f3f46"/><text x="365" y="115" font-size="13">Active</text>
<rect x="490" y="88" width="150" height="44" rx="14" fill="#12211a" stroke="#a3e635"/><text x="565" y="115" font-size="13">Identified</text>
<rect x="710" y="88" width="130" height="44" rx="14" fill="#161a18" stroke="#3f3f46"/><text x="775" y="115" font-size="12.6">Persisted</text>
<rect x="710" y="230" width="130" height="44" rx="14" fill="#161a18" stroke="#3f3f46"/><text x="775" y="257" font-size="13">Restored</text>
<rect x="300" y="300" width="130" height="44" rx="14" fill="#161a18" stroke="#3f3f46"/><text x="365" y="327" font-size="13">Closed</text>
<rect x="490" y="300" width="150" height="44" rx="14" fill="#161a18" stroke="#3f3f46"/><text x="565" y="327" font-size="13">Stopped</text>
</g>
<path d="M69 110L108 110" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#st-a)"/>
<path d="M240 110L298 110" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#st-a)"/><text x="243" y="96" fill="#8b938c" font-family="ui-monospace,monospace" font-size="9">terminals.register</text>
<path d="M430 110L488 110" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#st-a)"/><text x="432" y="96" fill="#8b938c" font-family="ui-monospace,monospace" font-size="9">stream row claims id</text>
<path d="M640 110L708 110" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#st-a)"/><text x="646" y="96" fill="#8b938c" font-family="ui-monospace,monospace" font-size="9">persistNow</text>
<path d="M565 88C540 40 590 40 570 86" stroke="#a3e635" stroke-width="1.4" fill="none" marker-end="url(#st-a)"/><text x="600" y="56" fill="#a3e635" font-family="ui-monospace,monospace" font-size="9">sole live claim changes → rebind</text>
<path d="M775 132L775 228" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#st-a)"/><text x="784" y="185" fill="#8b938c" font-family="ui-monospace,monospace" font-size="9">window reload / extension restart</text>
<path d="M710 252C640 252 620 160 600 134" stroke="#a1a1aa" stroke-width="1.4" fill="none" marker-end="url(#st-a)"/><text x="612" y="215" fill="#8b938c" font-family="ui-monospace,monospace" font-size="9">agents sessions resume; stream rebinds</text>
<path d="M365 132L365 298" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#st-a)"/><text x="372" y="220" fill="#8b938c" font-family="ui-monospace,monospace" font-size="9">user closes tab</text>
<path d="M530 132C480 200 420 260 400 298" stroke="#a1a1aa" stroke-width="1.4" fill="none" marker-end="url(#st-a)"/><text x="455" y="260" fill="#8b938c" font-family="ui-monospace,monospace" font-size="9">user closes tab</text>
<path d="M430 322L488 322" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#st-a)"/><text x="434" y="290" fill="#8b938c" font-family="ui-monospace,monospace" font-size="9">TerminalExitReason.User only</text>
<text x="650" y="327" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">= one agents sessions stop &lt;id&gt;</text>
<text x="24" y="366" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Reload and restore are never a close. Two distinct live claims stay ambiguous; start time is not ownership.</text>
<text x="24" y="384" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Source: src/vscode/terminals.vscode.ts (registry), src/core/sessions.persist.ts (metadata), src/vscode/terminalReadiness.ts (close vs reload).</text>
</svg>
<figcaption>The stream is authoritative for identity and status; local launch facts bridge only the interval before the first row.</figcaption>
</figure>

An editor terminal has an extension-local id (`CL-<ts>-<n>`) before the harness reveals its native session id. Launch metadata and stream facts converge on the terminal registry; once correlated, the canonical CLI session id drives status, labels, resume, fork, stop, and dashboard links. Labels have two classes: a canonical session-derived title and an explicit user label; the user label wins because it is presentation intent.

Correlation is not launch-only. A user may stop session A and start session B in the same terminal, so the stable observer terminal id can appear on both rows while the feed settles. On each pushed reset or agent-row change the extension reconciles tracked tabs before the status bar or sidebar refreshes: it ignores Previous rows, treats two distinct live claims as ambiguous within the same observer-device and execution-host scope, and keeps the existing binding during the overlap. When A is removed, B becomes the sole claim and the tab rebinds; a later historical A upsert marked Previous cannot revert it. A terminal-selected sidebar subject stores the terminal's stable id and follows it across the rebind; a Fleet-selected subject stays tied to its session.

The shell's `AGENT_TERMINAL_ID` remains stable across `agents.clear` and harness
restarts. Every open tab with that id gets a `live-terminals.json` entry
(`src/vscode/foreman.registry.ts`) carrying the `terminalId`, the harness `kind`
from the prefix in `PRESENTED_AGENTS`, and the shell pid. The launch `sessionId` is
present only when the extension minted one (Claude); Codex, Grok and the rest pick
their id after start, and the CLI joins those tabs by `terminalId`. Readers dedupe by
`terminalId`. A window's slice is pruned once its `at` is older than 10 minutes
even when its pids are alive: live windows rewrite it every 4 minutes, and a reload
writes under a new window id. Shell start time never proves session ownership.
Reload restores a session id from the exact persisted terminal-id record before
using the shell's frozen `AGENT_SESSION_ID`; it does not scan processes, read
transcripts, or pick a recent same-prefix session. Focus hydration identifies
unresolved tabs; corrections to established bindings run on pushed stream facts.

`agents.setSessionId` accepts `{ terminalId?: string }`, defaults to the active
agent terminal, and prefills the current id. It uses the existing canonical-id
and hydration validators, calls the registry's `setSessionId`, and persists
immediately. A manual id holds until a different session appears for that terminal;
it survives reload. The tab persists the selected id and every superseded canonical
id. Stream reconciliation filters those superseded claims for that tab before
applying the same Previous, observer-device, execution-host, and ambiguity rules.
A different eligible live claim replaces the binding and clears the override.
Clear uses the same mechanism to exclude the pre-clear session. An exact persisted
record is authoritative even when its id is empty, so reload leaves a cleared tab
unbound until a different session appears. This uses only pushed stream facts;
it starts no watcher, poller, subprocess, or transcript read.

Restoration metadata (`~/.swarmify/agents/windows/<hash>.yaml`, one file per window named by its workspace file or folder and replaced atomically, so no window can rewrite another's tabs: terminal id, prefix, session id, host, label, auto-label, harness, recovery harness, version, pid) is enough to reopen a tab through the CLI's resume path. Restore reopens one tab per session and none for a session the window already shows (`restorePlan`, `src/core/sessions.persist.ts`); a tab leaves the file the moment it closes for any reason but window shutdown. The scan snapshots the file before registering anything, so a write during a slow scan cannot erase tabs still waiting to be reopened. An empty or corrupt window file restores nothing; it never falls back to the old shared file. A session another live window shows is not reopened (`liveWindows`: the pid answers and the file was written since boot). Restore creates each tab hidden and shows it once its process runs: an editor-located terminal opened while the window is still starting is resolved as a text file and shows "The editor could not be opened". An agent terminal whose pty never came back is closed and its session reopens as a live tab. Restored, resumed and reloaded tabs run the resume as the tab's own process (`agentTabShell`), never typed at a prompt. Limits: a corrupt or empty window file restores nothing (its tabs are lost once, never replaced by the old shared file's); saving an untitled workspace changes its key, so its tabs are not restored that once; two windows on the same folder or workspace (which the editor normally prevents) share one file. On the first launch after the upgrade, each first-folder key of the old shared file is handed to one window only. It is never proof that a process is alive and never a transcript cache. Reload and user close are distinct: reload preserves the session; a genuine user close (`TerminalExitReason.User`, `src/vscode/terminalReadiness.ts`) issues one `agents sessions stop`.

<a id="launch"></a>

## Launch command composition

Every `Agents: New <Harness>` variant routes through one engine (`src/core/launchTarget.ts` → `src/core/agents.ts` `buildAgentLaunchCommand`). The setting `agents.launch.defaultTarget` (`auto` default, `local`, `ask`) decides the plain command; the five explicit variants pin one axis each and never both.

| Variant | Emits | Never emits |
|---|---|---|
| `New <Harness>` (target `auto`) | `agents run <h> --interactive --device auto --cwd <workspace> --strategy balanced --mode auto` | a prompt |
| `(Pick Host)` | `--device <name> --cwd <workspace> --strategy balanced --mode auto` | the account picker, `--device auto` |
| `(Pick Account)` | `<h>@ --interactive --device auto --cwd <workspace> --mode auto` | `--strategy`, a pinned version |
| `(Auto)` | `--device auto --cwd <workspace> --strategy balanced --mode auto`, ignoring the configured target | a prompt |
| `(Pick Project)` | `--device auto --project <slug> --strategy balanced --mode auto` | `--cwd`, `--remote-cwd`, a host prompt |
| pinned version (no host) | `<h>@<version> --interactive --local --cwd <workspace> --mode auto` | `--device auto`, `--strategy` |
| `(Local)` / target `local` / Pick Host This Machine | `--local --cwd <workspace> --strategy balanced --mode auto` | `--device` |

Bare interactive runs auto-place in agents-cli 1.22.118, so local placement must be explicit. Hostless version pins also emit `--local` to preserve their local intent; an explicit host takes precedence.

Flag order is fixed by `buildAgentLaunchCommand`: agent spec, `--interactive`, `--device` or `--local`, `--cwd` or `--project`, `--session-id` (Claude), `--strategy`, `--model`, `--mode`; `src/core/launchTarget.test.ts` asserts these strings without a workspace. `--strategy balanced` is set for every variant except the account picker (`src/core/launchTarget.ts` `strategy: options.accountPicker ? undefined : 'balanced'`) and is dropped for a pinned version, where the CLI would ignore it. The exclusions are thrown as errors inside `buildAgentLaunchCommand`: `cwd` with `remoteCwd`, `project` with either cwd form, the account picker with a pinned version, the account picker with a strategy. `--cwd` is emitted once, independent of placement, because the terminal's inherited `process.cwd()` can differ from the active folder. `--session-id` is emitted for Claude only. Ordinary launches never derive a target from `agents projects view <cwd>`: that command is a containment attribution lookup and a shared root can belong to several child projects (PHNX-3970). Native-mode launches are wrapped by `wrapNativeAgentCommand` so exit code 0 closes the tab and the CLI's ssh-loss codes (255, 254) read as a recoverable reconnect rather than a crash.

<a id="attention"></a>

## Needs-you attention as pure projection

The Fleet "Needs you" lane is a projection of the CLI attention rows the stream carries (`RemoteAttention` in `src/core/remoteSessions.ts`, joined onto their session in `sessionPresentationStore.sessions()`). Membership is `attention.state === 'open'`. Order comes from `attention.kind` through `ATTENTION_KIND_RANK` in `ui/settings/components/mission-control/floorModel.ts`: question, permission, plan_review, declared, failure, stall, review, most-stuck-first within a kind. An interactive hand-back renders as a decision card carrying the harness's own choices; a failure as a failure card; a stall or review as a plain row. A stall is a CLI signal: `FloorPhase` carries no `stalled` member, and `phaseFromStatus` is a straight rename of the CLI-reported status for an unindexed local tab. `PHASE_PROGRESS_RANK` orders phases on the Sessions surface and is not the needs-you ranker. A tab the stream has not indexed carries no attention and never enters the lane from the client side.

Project attribution follows the same rule. `sessionProjects.ts` resolves a session's project only from hints the projected row carries (cwd or worktree path, the CLI's repo word, the PR's `owner/repo` slug, then branch, worktree slug, or team) through `matchLinearProject` in `src/shared/linearProjects.ts`, whose containment fallback is word-wise. A session no hint can attribute is the labeled Unassigned bucket with its reason; a manual assignment is a local presentation override.

The rest of the dashboard composes the same way. Session rows describe conversations and progress; attention facts keep the exact question, choices, and resolution lifecycle; activity facts supply chronological evidence such as plans, pull requests, teams, and artifacts. The dashboard may group, filter, sort, and decorate them, may hide background work by presentation policy without removing it from the model, and must never infer a new canonical status from transcript text or process scans. Device, project, and ticket views still arrive through separate bounded CLI reads and do not live in the presentation store. Optimistic UI is limited to transient feedback; durable changes arrive back through the feed.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Flowchart: an attention row on the stream passes a membership filter on state open, is ranked by ATTENTION_KIND_RANK, and renders as a decision card, a failure card, or a plain row">
<title>Needs-you projection</title>
<desc>ISO 5807 flowchart. Parallelogram: input from the stream. Diamond: decision. Rectangle: process. The three outputs are the card types the lane renders.</desc>
<defs><marker id="ny-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="16" fill="#09090b" stroke="#3f3f46"/>
<text x="24" y="30" fill="#a1a1aa" font-family="system-ui,sans-serif" font-size="12">FLOWCHART · THE EXTENSION CLASSIFIES NOTHING</text>
<path d="M40 70L210 70L190 126L20 126Z" fill="#12211a" stroke="#a3e635"/><text x="48" y="94" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">attention row</text><text x="48" y="112" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">RemoteAttention row</text>
<path d="M330 60L410 98L330 136L250 98Z" fill="#161a18" stroke="#3f3f46"/><text x="330" y="94" fill="#e7ece8" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">state ===</text><text x="330" y="108" fill="#e7ece8" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">'open'?</text>
<rect x="460" y="70" width="190" height="56" rx="6" fill="#161a18" stroke="#3f3f46"/><text x="472" y="92" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">rank by kind</text><text x="472" y="110" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">ATTENTION_KIND_RANK</text>
<rect x="720" y="40" width="250" height="44" rx="6" fill="#161a18" stroke="#5ad6c0"/><text x="732" y="58" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">decision card</text><text x="732" y="74" fill="#8b938c" font-family="system-ui,sans-serif" font-size="9">question · permission · plan_review · declared</text>
<rect x="720" y="100" width="250" height="44" rx="6" fill="#161a18" stroke="#ff6b6b"/><text x="732" y="118" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">failure card</text><text x="732" y="134" fill="#8b938c" font-family="system-ui,sans-serif" font-size="10">failure</text>
<rect x="720" y="160" width="250" height="44" rx="6" fill="#161a18" stroke="#3f3f46"/><text x="732" y="178" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">plain row</text><text x="732" y="194" fill="#8b938c" font-family="system-ui,sans-serif" font-size="10">stall · review</text>
<path d="M210 98L248 98" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#ny-a)"/>
<path d="M410 98L458 98" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#ny-a)"/><text x="414" y="92" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="9">yes</text>
<path d="M330 136L330 200L440 200" stroke="#a1a1aa" stroke-width="1.4" fill="none" marker-end="url(#ny-a)"/><text x="336" y="170" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="9">no</text><text x="446" y="204" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">not in the lane</text>
<path d="M650 90L718 62" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#ny-a)"/><path d="M650 98L718 122" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#ny-a)"/><path d="M650 106L718 182" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#ny-a)"/>
<text x="24" y="226" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Rank order: question, permission, plan_review, declared, failure, stall, review; most-stuck-first within a kind.</text>
<text x="24" y="241" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Border color names the card type only. A resolved row never returns from an older snapshot.</text>
</svg>
<figcaption>Membership and order are read off the row. No heartbeat threshold, no transcript, no process scan.</figcaption>
</figure>

<a id="findings"></a>

## Findings

The watchdog bridge and MCP client share the validated NDJSON contract in
`src/mcp/watchdogProtocol.ts`; a newline, not EOF, completes a request or reply.
Bridge teardown returns its completion promise to the leader gate, which retains
ownership until pending startup and socket shutdown finish. The bridge never
moves a successor's socket to repair ownership after the fact.

Both leader sockets (monitor broadcast and watchdog) bind through `listenOwned`
in `src/monitor/endpoint.ts`: listen on a private path, then `link()` it to the
shared path, which fails instead of replacing a live server. A leftover path is
removed only when nothing accepts on it. Close unlinks the shared path only
while it is still this server's inode, and destroys every accepted connection
so teardown never waits on a peer. Because the path is reachable before
`MonitorHost.start()` settles, the host re-evaluates demand reported in that
window once it runs.

Monitor frames are structurally validated before delivery. A complete valid
frame has the same result whether received whole, coalesced, or fragmented.
Incomplete-frame buffering remains unbounded: the CLI producer defines no maximum
reset size, so a consumer-only cap would silently lose legitimate session facts.
A shared producer/consumer size contract is required before adding that bound.

Cloud dispatch validates webview requests in `settingsActions.ts` before building
CLI arguments. The host runs those arguments with VS Code `ProcessExecution`,
without shell interpolation, in a task terminal that retains CLI prompts and
following. The CLI owns budget enforcement; the extension does not detach the
request or impose a submission timeout. Shared configuration updates reject
malformed existing content rather than replacing it with an empty object.

The module graph was measured on this branch on 2026-09-11 with the `code:refactor` module scanner (its `modules.json` lives in the session artifacts and is not committed): 140 of 156 TypeScript files under `src/` parsed, 7 directory modules, 12 import edges, 2 cycles, 1 god module. Eleven of the twelve edges run between the five source modules and are all drawn below; the twelfth is `monitor/testdata` importing `monitor` three times, which is test fixtures and is listed in the footnote instead.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 510" role="img" aria-label="Module dependency graph of src: eleven import edges between the five source modules, with the three back-edges that close two cycles drawn dashed in red">
<title>Measured module graph, src/, depth 2</title>
<desc>Boxes are directory modules with file and line counts from modules.json. Every arrow is one edge from modules.json labeled with its import count. Red dashed arrows are the back-edges that close the two cycles. The twelfth edge, monitor/testdata importing monitor, is test fixtures and is stated in the footnote rather than drawn.</desc>
<defs><marker id="mg-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker><marker id="mg-r" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#ff6b6b"/></marker></defs>
<rect x="1" y="1" width="998" height="508" rx="16" fill="#09090b" stroke="#3f3f46"/>
<text x="24" y="30" fill="#a1a1aa" font-family="system-ui,sans-serif" font-size="12">OBSERVED · src/ · modules.json 2026-09-11 · 11 of 12 edges drawn · arrow label = import count</text>
<g font-family="system-ui,sans-serif" fill="#e7ece8">
<rect x="60" y="70" width="240" height="70" rx="8" fill="#161a18" stroke="#f5c451" stroke-width="2"/><text x="74" y="94" font-size="14" font-weight="600">vscode</text><text x="74" y="112" font-size="10" fill="#8b938c">35 files · 21,897 LOC · cohesion 0.31</text><text x="74" y="128" font-size="10" fill="#8b938c">fan-out 153 · extension.ts 5,659 LOC</text>
<rect x="420" y="90" width="240" height="60" rx="8" fill="#161a18" stroke="#3f3f46"/><text x="434" y="112" font-size="14" font-weight="600">shared</text><text x="434" y="130" font-size="10" fill="#8b938c">4 files · 236 LOC · re-exports for ui/</text>
<rect x="730" y="70" width="240" height="70" rx="8" fill="#161a18" stroke="#3f3f46"/><text x="744" y="94" font-size="14" font-weight="600">monitor</text><text x="744" y="112" font-size="10" fill="#8b938c">13 files · 2,811 LOC · cohesion 0.80</text><text x="744" y="128" font-size="10" fill="#8b938c">leader, broadcast, stream, readiness</text>
<rect x="420" y="200" width="240" height="70" rx="8" fill="#12211a" stroke="#a3e635" stroke-width="2"/><text x="434" y="224" font-size="14" font-weight="600">core</text><text x="434" y="242" font-size="10" fill="#8b938c">80 files · 13,044 LOC · cohesion 0.90</text><text x="434" y="258" font-size="10" fill="#8b938c">fan-in 146 · god module by size</text>
<rect x="60" y="330" width="240" height="70" rx="8" fill="#161a18" stroke="#3f3f46"/><text x="74" y="354" font-size="14" font-weight="600">mcp</text><text x="74" y="372" font-size="10" fill="#8b938c">3 files · 644 LOC</text><text x="74" y="388" font-size="10" fill="#8b938c">watchdog bridge + MCP server</text>
</g>
<path d="M300 78L728 78" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#mg-a)"/><text x="470" y="72" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="11">vscode→monitor 11</text>
<path d="M300 112L418 118" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#mg-a)"/><text x="308" y="104" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="11">vscode→shared 2</text>
<path d="M300 134L418 214" stroke="#a1a1aa" stroke-width="2.2" marker-end="url(#mg-a)"/><text x="312" y="186" fill="#e7ece8" font-family="ui-monospace,monospace" font-size="11" font-weight="700">vscode→core 138</text>
<path d="M520 200L520 152" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#mg-a)"/><text x="430" y="178" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="11">core→shared 5</text>
<path d="M600 150L600 198" stroke="#ff6b6b" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#mg-r)"/><text x="614" y="178" fill="#ff6b6b" font-family="ui-monospace,monospace" font-size="11">shared→core 2</text>
<path d="M730 128L662 208" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#mg-a)"/><text x="668" y="228" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="11">monitor→core 4</text>
<path d="M655 198L728 118" stroke="#ff6b6b" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#mg-r)"/><text x="736" y="162" fill="#ff6b6b" font-family="ui-monospace,monospace" font-size="11">core→monitor 1</text>
<path d="M120 140L120 328" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#mg-a)"/><text x="28" y="240" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="11">vscode→mcp 2</text>
<path d="M200 330L200 142" stroke="#ff6b6b" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#mg-r)"/><text x="208" y="240" fill="#ff6b6b" font-family="ui-monospace,monospace" font-size="11">mcp→vscode 1</text>
<path d="M300 350L430 272" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#mg-a)"/><text x="318" y="306" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="11">mcp→core 2</text>
<path d="M300 382C620 470 930 330 860 142" stroke="#a1a1aa" stroke-width="1.4" fill="none" marker-end="url(#mg-a)"/><text x="560" y="440" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="11">mcp→monitor 1</text>
<text x="24" y="462" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="11" font-weight="600">Legend</text>
<line x1="80" y1="459" x2="120" y2="459" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#mg-a)"/><text x="128" y="463" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">imports, with the count from modules.json</text>
<line x1="420" y1="459" x2="460" y2="459" stroke="#ff6b6b" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#mg-r)"/><text x="468" y="463" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">back-edge that closes a cycle (core↔monitor↔shared, mcp↔vscode)</text>
<text x="24" y="482" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Not drawn: the twelfth edge, monitor/testdata→monitor ×3 (test fixtures, 4 files), and testing (1 file, no edges).</text>
<text x="24" y="497" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">16 files unparsed by the scanner. ui/ is outside this graph.</text>
</svg>
<figcaption>core is the shape the rule wants: 80 pure files with fan-in 146 and one outbound dependency that should not exist. vscode is the problem: 35 files, 21,897 lines, cohesion 0.31.</figcaption>
</figure>

**What the graph says.** `core` is healthy in kind and wrong in one edge: it imports `monitor` once (a type-only path through `src/monitor/protocol.ts` for `SessionCliFactPayload` in the presentation store) and `shared` imports `core` twice while `core` imports `shared` five times, which closes the `core ↔ monitor ↔ shared` cycle. `mcp ↔ vscode` is the second cycle: `src/mcp/watchdog-bridge.ts` imports `getAllTerminals` from `src/vscode/terminals.vscode.ts` while `vscode` imports `mcp` twice. `vscode` is the god area by size, not by fan-in: three files hold 12,090 of its 21,897 lines (`extension.ts` 5,659; `settings.vscode.ts` 3,625 with a 100-plus-case message router; `agentPanel.vscode.ts` 2,806 with inline webview HTML), and dynamic `import()` is what keeps the cycles compiling.

**Watchdog boundary update (2026-09-13).** The graph above is the historical
2026-09-11 measurement. The editor-specific watchdog adapter now lives in
`src/vscode/watchdogBridge.vscode.ts`, beside the terminal registry it uses.
The dependency is now `vscode → mcp` for the wire protocol; `src/mcp` no longer
imports `vscode` or the terminal registry. The earlier callback proposal below
is superseded for this boundary: relocating the existing adapter needs no new
interface. Socket framing, leadership teardown, terminal delivery, and the MCP
server's emitted path are unchanged. Other cycles remain separate work.

**Known debt.** These violate the thin-client rule. Touching one means deleting it or shrinking it, never adding to it.

| Path | Violation | Fate |
|---|---|---|
| `src/vscode/remoteSessions.vscode.ts` `fetchRemoteSessionLabelSource` | a client-side `agents sessions <id> --json` fetch for the label and topic, which are already on the stream row; still called from `src/vscode/extension.ts` | delete now |
| `src/core/prewarm.simple.ts` | still spawns `opencode session list` on every OpenCode tab open (the second, `workspaceState` crash-recovery mapping was deleted; the per-window file is the one restore store) | delete once the CLI daemon owns restore |
| `src/vscode/settings.vscode.ts` `watchForPlan` | polls `agents sessions <id> --json` for the plan (rate-bounded, PHNX-3817) | delete once the CLI carries `plan` on `SessionWatchRow` (PHNX-3819) |
| `src/monitor/sessionParse.ts` | resolves session-root directories for the readiness detector's file scan; obsolete parsing helpers were deleted in #74 | replace the remaining file scan with CLI-provided fields |
| `src/vscode/terminalReadiness.ts` recursive `fs.watch` on transcript roots | transcript watcher | replace with a daemon readiness signal |
| `src/monitor/readinessDetector.ts` | extension-invented lifecycle classifier (ps and pgrep loops) | move the signal into the CLI daemon, project it on the stream |
| `src/vscode/agentPanel.vscode.ts` | `messageCount` and `recentFiles` are not on the stream and are dropped from the instant paint | add them to `SessionWatchRow`; never a lazy enrich |
| `src/vscode/foreman.*` | realtime voice over an OpenAI key held by the extension | tolerated until the CLI offers a voice path |
| Dashboard device, project, and ticket reads | separate bounded CLI reads outside the stream | move onto the stream when the CLI projects them |

Wave 1 of PHNX-4044 (released as 0.9.371) removed 31 dead files and 49 dead exports, installed the knip gate, dropped `node-pty` and `@vscode/webview-ui-toolkit`, collapsed twelve shell quoters onto `shellQuote` and three binary resolvers onto `agentsBin.ts`, and derived the UI harness tables from the CLI catalog with a drift test.

Gemini's executable integration is deleted: no CLI probes, setup commands, prompt-pack paths, watchdog registration, prewarming, transcript parsing, terminal recognition, or UI choice. `agents.cli.ts` still mirrors the CLI's legacy id; stale launch choices are rejected. The context-alias writer rejects the retired `GEMINI.md` basename even when explicitly requested by an old configuration, without touching existing files or narrowing other aliases.

**Direction (proposal, not observation).** Wave 2 breaks the two cycles and splits the three large files: move `SessionCliFactPayload` and the protocol types under `core` so `core` has zero outbound edges; give `watchdog-bridge.ts` a terminal-list callback instead of importing `vscode`; extract launch, status bar, URI handling, first-run, and monitor bootstrap from `extension.ts`; split the `settings.vscode.ts` router into per-domain handlers; move the sidebar's inline webview HTML and script to files under `ui/`; retire the four tests that assert on source text once the behavior they guard is structural. Wave 3 generates `package.json` `contributes.commands` and `keybindings` from `harnessLaunchRegistrations` with a drift test, so adding a harness stops being four hand-written JSON blocks. The target graph has one edge direction: `vscode → monitor → core ← shared`, `mcp → core`.

<a id="evidence"></a>

## Evidence

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 200" role="img" aria-label="Build, test, and release pipeline: knip gate, compile, package, install locally, or release to Marketplace and Open VSX from the box holding the vs-marketplace secrets">
<title>Build, test, release</title>
<defs><marker id="bp-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="198" rx="16" fill="#09090b" stroke="#3f3f46"/>
<text x="24" y="30" fill="#a1a1aa" font-family="system-ui,sans-serif" font-size="12">FLOWCHART · scripts/ ARE THE ONLY ENTRY POINTS</text>
<g font-family="system-ui,sans-serif" font-size="12" fill="#e7ece8">
<rect x="24" y="60" width="168" height="56" rx="6" fill="#161a18" stroke="#3f3f46"/><text x="36" y="82" font-weight="600">bun test</text><text x="36" y="100" fill="#8b938c" font-size="11">1,853 tests · 165 files</text>
<rect x="212" y="60" width="168" height="56" rx="6" fill="#12211a" stroke="#a3e635"/><text x="224" y="82" font-weight="600">bun run lint:dead</text><text x="224" y="100" fill="#8b938c" font-size="11">knip gate, fails the build</text>
<rect x="400" y="60" width="168" height="56" rx="6" fill="#161a18" stroke="#3f3f46"/><text x="412" y="82" font-weight="600">bun run compile</text><text x="412" y="100" fill="#8b938c" font-size="11">tsc + vite (ui/)</text>
<rect x="588" y="60" width="168" height="56" rx="6" fill="#161a18" stroke="#3f3f46"/><text x="600" y="82" font-weight="600">vsce package</text><text x="600" y="100" fill="#8b938c" font-size="11">dist/swarm-ext-&lt;v&gt;.vsix</text>
<path d="M796 60L976 60L976 116L796 116L776 88Z" fill="#161a18" stroke="#3f3f46"/><text x="808" y="82" font-weight="600">install.sh / release.sh</text><text x="808" y="100" fill="#8b938c" font-size="11">local · Marketplace + Open VSX</text>
</g>
<path d="M192 88L210 88" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#bp-a)"/><path d="M380 88L398 88" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#bp-a)"/><path d="M568 88L586 88" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#bp-a)"/><path d="M756 88L778 88" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#bp-a)"/>
<text x="212" y="140" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">scripts/build.sh &lt;version&gt; runs the three middle steps; the version stamp is restored on exit</text>
<text x="24" y="162" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">release.sh &lt;x.y.z&gt; --confirm routes itself to the box holding the vs-marketplace secrets (--device pins it, --here refuses to route)</text>
<text x="24" y="176" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">and requires a CHANGELOG section for the version. Publisher swarmify, name swarm-ext: frozen; changing either orphans the</text>
<text x="24" y="190" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Marketplace listing and breaks the swarm-ext:// authority the CLI emits.</text>
</svg>
<figcaption>Never hand-roll vsce publish or ovsx publish. release.sh owns version stamping, gates, and routing.</figcaption>
</figure>

The UI build runs `bun run typecheck` before either Vite bundle. Its TypeScript
configuration includes tests and source imported through `@shared`, so shared
helpers must satisfy `noUncheckedIndexedAccess` and `verbatimModuleSyntax` as
well as the extension's compiler configuration. Vite transpilation alone is not
the type-check gate. Run `cd ui && bun run typecheck` to check that boundary
without producing a bundle.

| Check | Command | Baseline on this branch (2026-09-11) |
|---|---|---|
| Unit and boundary tests | `bun test --timeout 30000` from the root | 1,853 tests, 165 files, 6 failures, all in `ui/` when run from the root (same as `origin/main`); `cd ui && bun test` for the UI suite on its own |
| Dead code | `bun run lint:dead` | clean apart from knip's own configuration hints |
| Agent integration | `EXT_AGENT_INTEGRATION=1 bun run test:agent-integration` | needs the `agents` binary on the box; hits it for real |
| Package | `scripts/build.sh <version>` | VSIX in `dist/` |
| Install locally | `scripts/install.sh` | installs the VSIX into the local editor |
| Release | `scripts/release.sh <x.y.z> --confirm` | dry run without `--confirm` |

Tests sit beside their source and exercise real command boundaries. The only sanctioned double is `src/testing/vscodeDouble.ts`; a hand-rolled partial double breaks other files in the same bun run, and `src/testing/vscodeDouble.test.ts` enforces this. Four tests assert on source text of specific files (`autoLabelHydration`, `statusBarIdentity.spawnStorm`, `agentPanel.webview-syntax`, `pollTimers.replacement`); read what invariant each protects before touching it. The proof that matters for a release is the installed extension: `Agents: New Claude` opens a tab with a live prompt, one `agents feed watch` child serves two windows, and a Fleet row click starts no process.
