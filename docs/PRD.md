---
kind: report
title: AGI EXT product requirements
summary: "What the VS Code / VSCodium extension for agents-cli must do, for whom, and how each user journey should feel, with the journeys drawn."
status: "Internal requirements"
project: agi-ext
repository: phnx-labs/agi-ext
tracking: PHNX-4044
date: "2026-09-11"
facts:
  - "Publisher identity is frozen: swarmify.swarm-ext"
  - "Every fact on screen comes from one agents feed watch stream"
  - "A row click in Fleet costs zero subprocesses"
links:
  - https://github.com/phnx-labs/agi-ext
  - https://linear.app/getrush/issue/PHNX-4044
---

## What this is

AGI EXT is the VS Code and VSCodium extension for [agents-cli](https://github.com/phnx-labs/agi-cli). It turns an open-source editor into an integrated agents environment: every coding agent (Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok, Kimi, Droid) runs as a full editor tab, the Active Session sidebar shows what the focused agent is doing, and the Fleet dashboard lists every session on every machine you own and lets you answer the ones that need you. The editor becomes the place you steer a fleet from, the way it used to be the place you typed code.

The extension is a presentation layer. agents-cli owns every fact (sessions, devices, accounts, attention, activity) and every mechanism (launch, placement, resume, fork, stop, scheduling, watchdog). The extension renders what the CLI streams and turns a gesture into exactly one CLI verb. That split is the product's one architecture rule and the source of almost every requirement below.

It is for developers who already run several agents at once, usually across more than one machine, and who want to see and steer that work without leaving the editor. It is a private repository shipped publicly on the Marketplace and Open VSX under the frozen identity `swarmify.swarm-ext`.

## Summary

Open the editor, press one chord, and an agent starts on the right machine with the right account, in the folder you have open. Look at the sidebar and know what it asked, what it did, and what is left. Open Fleet and see every agent everywhere, answer the ones waiting on you, and dispatch the next ticket. Close the laptop, come back, and the tabs are exactly where you left them. None of that starts a poller, parses a transcript, or invents a status.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 420" role="img" aria-label="Product overview: a developer in the editor, the extension's surfaces, the agents CLI, and the fleet of devices running harnesses">
<title>AGI EXT product overview</title>
<desc>Conceptual product overview. The developer works in one editor window whose agent tabs, sidebar, and Fleet dashboard are rendered by the extension. The extension consumes one feed stream from the agents CLI and issues one-shot CLI verbs. The CLI places work on fleet devices where the real harness binaries run.</desc>
<defs><marker id="ov-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker><marker id="ov-g" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a3e635"/></marker></defs>
<rect x="1" y="1" width="998" height="418" rx="16" fill="#09090b" stroke="#3f3f46"/>
<text x="28" y="34" fill="#a1a1aa" font-family="system-ui,sans-serif" font-size="12">PRODUCT OVERVIEW · CONCEPTUAL, NOT A DEPLOYMENT DIAGRAM</text>
<g>
<circle cx="70" cy="140" r="16" fill="none" stroke="#e7ece8" stroke-width="2"/>
<path d="M70 156V200M70 170L48 190M70 170L92 190M45 215L70 200L95 215" fill="none" stroke="#e7ece8" stroke-width="2" stroke-linecap="round"/>
<text x="70" y="248" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="13" text-anchor="middle">Developer</text>
</g>
<rect x="150" y="60" width="380" height="300" rx="12" fill="#111312" stroke="#5ad6c0"/>
<text x="168" y="86" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="15" font-weight="600">Editor window (VS Code / VSCodium)</text>
<text x="168" y="104" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11">rendered by AGI EXT</text>
<rect x="168" y="120" width="230" height="64" rx="8" fill="#161a18" stroke="#26302a"/>
<text x="180" y="142" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="13" font-weight="600">Agent tabs</text>
<text x="180" y="160" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">one terminal per agent, restorable</text>
<text x="180" y="176" fill="#8b938c" font-family="system-ui,sans-serif" font-size="12">status bar: label · host</text>
<rect x="410" y="120" width="104" height="64" rx="8" fill="#161a18" stroke="#26302a"/>
<text x="422" y="142" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="13" font-weight="600">Sidebar</text>
<text x="422" y="160" fill="#8b938c" font-family="system-ui,sans-serif" font-size="12">the one</text>
<text x="422" y="176" fill="#8b938c" font-family="system-ui,sans-serif" font-size="12">preview</text>
<rect x="168" y="198" width="346" height="72" rx="8" fill="#161a18" stroke="#26302a"/>
<text x="180" y="220" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="13" font-weight="600">Fleet dashboard</text>
<text x="180" y="238" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">every session on every device · needs-you · dispatch</text>
<text x="180" y="256" fill="#8b938c" font-family="system-ui,sans-serif" font-size="12">a row click costs zero subprocesses</text>
<rect x="168" y="284" width="346" height="56" rx="8" fill="#161a18" stroke="#26302a"/>
<text x="180" y="306" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="13" font-weight="600">Reader · Autogit · Foreman orb</text>
<text x="180" y="324" fill="#8b938c" font-family="system-ui,sans-serif" font-size="12">artifact viewers · AI commits · voice control</text>
<path d="M100 170L148 170" stroke="#a1a1aa" stroke-width="1.6" marker-end="url(#ov-a)"/>
<text x="108" y="162" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="10">input</text>
<rect x="640" y="120" width="170" height="150" rx="12" fill="#12211a" stroke="#a3e635"/>
<text x="656" y="146" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="15" font-weight="600">agents CLI</text>
<text x="656" y="166" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11">owns every fact</text>
<text x="656" y="182" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11">and every mechanism</text>
<text x="656" y="208" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">sessions · devices</text>
<text x="656" y="226" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">accounts · attention</text>
<text x="656" y="244" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">daemon · watchdog</text>
<path d="M640 160L532 160" stroke="#a3e635" stroke-width="1.8" marker-end="url(#ov-g)"/>
<text x="536" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">feed watch</text>
<path d="M532 230L638 230" stroke="#a1a1aa" stroke-width="1.6" marker-end="url(#ov-a)"/>
<text x="540" y="246" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="10">one-shot verbs</text>
<rect x="840" y="70" width="140" height="270" rx="12" fill="#111312" stroke="#3f3f46"/>
<text x="848" y="96" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="14" font-weight="600">Fleet devices</text>
<rect x="848" y="112" width="114" height="46" rx="6" fill="#161a18" stroke="#26302a"/>
<text x="858" y="131" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">this laptop</text>
<text x="858" y="148" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">claude · codex</text>
<rect x="848" y="168" width="114" height="46" rx="6" fill="#161a18" stroke="#26302a"/>
<text x="858" y="187" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">worker box</text>
<text x="858" y="204" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">opencode · grok</text>
<rect x="848" y="224" width="114" height="46" rx="6" fill="#161a18" stroke="#26302a"/>
<text x="858" y="243" fill="#d4d4d8" font-family="system-ui,sans-serif" font-size="12">worker box</text>
<text x="858" y="260" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">cursor · droid</text>
<text x="848" y="300" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">real harness binaries</text>
<text x="848" y="316" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">placed by the CLI</text>
<path d="M810 195L838 195" stroke="#a1a1aa" stroke-width="1.6" marker-end="url(#ov-a)"/>
<text x="812" y="187" fill="#a1a1aa" font-family="ui-monospace,monospace" font-size="10">ssh</text>
<text x="28" y="400" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Lime arrow: the single live stream every surface reads. Gray arrows: user gestures and the one-shot commands they become.</text>
</svg>
<figcaption>One editor window, one stream in, one verb out. The extension never talks to a device or a harness directly.</figcaption>
</figure>

## Goals

**An agent starts from the editor without a prompt.** `Agents: New <Harness>` opens a tab and the agent is running on a fleet worker with a balanced account in the open workspace. Check: press Cmd+Shift+A on a workspace, watch the tab open with `agents run <harness> --interactive --device auto --cwd <workspace> --strategy balanced --mode auto` and a live prompt inside it, with no picker shown.

**The editor never invents a status.** Every phase, needs-you flag, label, and timeline step shown comes from a row the CLI streamed. Check: with the stream stopped, the sidebar says "Waiting for the session stream…" and names the command it expects instead of showing an empty card.

**Seeing costs nothing.** Selecting a Fleet row, switching tabs, and opening the sidebar spawn no process. Check: `ps` shows exactly one `agents feed watch --json` child for all windows while a dashboard or sidebar is visible, and none when neither is.

**Tabs survive the editor.** Reload, crash, or quit and the agent tabs come back bound to their live sessions. Check: reload the window with three agent tabs open; three tabs return with their labels, and none of the sessions were stopped.

**Every session everywhere is one list.** Fleet shows local, remote, cloud, and finished sessions with the same row shape and the same needs-you rule. Check: a session started on a worker box by another machine appears in Fleet with its host in the row and Resume targeting that host.

**A person can answer from where they are.** A permission, question, or plan review shows in Fleet with the exact choices the harness offered and one click answers it. Check: trigger a permission prompt in a tab; the card lists the same options as the terminal; picking one clears the card when the CLI removes the attention row.

## Non-goals

**No scheduler in the extension.** Nothing in the extension launches, resumes, kills, injects, or rotates anything on a timer. The CLI daemon is the only scheduler. A second scheduler in a UI process caused the resume storms and the 31 percent idle CPU incident the current design exists to end.

**No transcript parsing or local state reads for facts.** The extension does not read `~/.claude/projects`, terminal registries, or session state files to decide anything the stream can carry. Remaining readers (`src/monitor/sessionParse.ts`, the recursive `fs.watch` in `src/vscode/terminalReadiness.ts`, `src/monitor/readinessDetector.ts`) are recorded debt, scheduled for deletion, never extended.

**No second platform.** The extension does not score devices or accounts, resolve project paths, decide fork identity, or reproduce resume compatibility. Each of those has one owner in the CLI and the extension calls it.

**No detail rail in Fleet.** Fleet is a list. The Active Session sidebar is the one session preview. A persisted rail preference produced a blank third-width column on open, and two previews of one session drifted.

**No Gemini integration.** The extension has no Gemini launch definition, installer, watchdog registration, prewarm configuration, transcript parser, or context-file alias target. Opening a workspace never creates `GEMINI.md`, even when an old explicit alias mapping requests it. Existing files remain untouched. Other configured aliases still work. The CLI catalog snapshot retains legacy ids solely to match the CLI protocol, not to install or offer the retired harness.

**No local-first execution path or silent fallback.** A launch under the default target goes to the fleet worker pool. A missing CLI noun is an upgrade error, never a filesystem fallback.

**No API keys held by the extension beyond the Foreman orb.** Autogit generates commit messages through `agents run claude --model haiku`; the `agents.openaiApiKey` setting exists only for the realtime voice model.

## Findings

Three observations from running the extension shaped these requirements more than any design preference.

An always-on session watcher was removed in August 2026 because it pinned about 31 percent of a CPU core and leaked ssh fan-out to feed a view nobody had open. Restoring it behind a demand gate, so the single producer exists only while a dashboard, sidebar, or unresolved tab needs it, is what made the stream affordable again. The same month a side-channel fetch per row produced the CPU incident recorded as agi-cli#3019; that is why a missing field goes onto the CLI row and never into a client fetch.

A persisted "detail rail open" preference in Fleet restored a blank third-width column on open with nothing selected, and two previews of one session (the rail and the sidebar) drifted from each other. Removing the rail and making the sidebar the one preview removed the whole class of defect.

Ordinary launches once resolved the workspace through `agents projects view <cwd>`, and the first weak match in a monorepo silently sent the terminal to a child project's default path. Emitting the exact open workspace as `--cwd` and reserving `--project` for the explicit Pick Project command fixed it, and a recovery mapping that was machine-global instead of per-workspace produced a multi-window resume storm on reload. Both are now invariants enforced in code and tests.

## Start an agent in a tab

You are in a workspace and want an agent working on it now, without deciding where it runs or which account it uses.

You press Cmd+Shift+A, or pick `Agents: New Claude` (or any presented harness) from the palette. The extension reads the one setting that matters, `agents.launch.defaultTarget`, and builds one command. Under the default `auto` that command is `agents run claude --interactive --device auto --cwd <workspace> --strategy balanced --mode auto` (the tests in `src/core/launchTarget.test.ts` assert the same string without the workspace). The workspace is passed exactly as opened: a monorepo root stays the root and a nested project folder stays that folder, locally and remotely. A tab opens named `CL` and the CLI places the run on a device from the worker pool, rotating the account by usage headroom.

When you want to choose one axis and let the CLI balance the other, the harness has five explicit variants. `(Local)` emits `--local --cwd <workspace> --strategy balanced --mode auto`, pinning the launch to the editor’s machine regardless of the configured target. Local defaults and Pick Host’s This Machine choice also emit `--local`. A hostless version pin emits `--local` and omits `--strategy`; an explicit host still wins. `(Pick Host)` prompts for the device and emits `--device <name> --cwd <workspace> --strategy balanced --mode auto`. `(Pick Account)` emits `claude@ --interactive --device auto --cwd <workspace> --mode auto`, with no `--strategy`, so the CLI routes to a picker-eligible worker and shows that device's account picker in the tab; a signed-out account can be chosen and authenticates in place. `(Auto)` chooses both without a prompt, ignoring the configured target, and emits the same `--device auto --cwd <workspace> --strategy balanced --mode auto` as the default. `(Pick Project)` is the only variant that replaces the workspace: it shows a project quickpick and emits `--device auto --project <slug> --strategy balanced --mode auto`, and the CLI resolves the project's configured path on the chosen worker. `--strategy balanced` rides every automatic-placement variant; only the account picker and a pinned version drop it.

What should happen: within a second a terminal tab exists, the status bar shows the agent's label and, when it runs elsewhere, the executing host shortened to its unique suffix. The tab title takes the canonical session name once the stream reports it. The picker and `--strategy` never appear together; `--project` and `--cwd` never appear together. These exclusions are enforced by `buildAgentLaunchCommand` in `src/core/agents.ts`.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Journey: start an agent in a tab. User lane on top, extension and CLI lane below.">
<defs><marker id="j1a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="12" fill="#09090b" stroke="#3f3f46"/>
<text x="20" y="28" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">USER JOURNEY · START AN AGENT</text>
<text x="20" y="72" fill="#5ad6c0" font-family="ui-monospace,monospace" font-size="10">YOU</text>
<rect x="70" y="48" width="200" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="72" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Press Cmd+Shift+A</text><text x="72" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">or New &lt;Harness&gt; (variant)</text>
<rect x="370" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="382" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Answer one prompt at most</text><text x="382" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">host, account, or project</text>
<rect x="680" y="48" width="290" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="692" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Type into the running agent</text><text x="692" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">tab titled CL, host in status bar</text>
<path d="M320 73L368 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j1a)"/><path d="M630 73L678 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j1a)"/>
<line x1="20" y1="120" x2="980" y2="120" stroke="#26302a" stroke-dasharray="4 4"/>
<text x="20" y="166" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">EXT</text><text x="20" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">CLI</text>
<rect x="60" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="72" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Build one command</text><text x="72" y="176" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">agents run claude --interactive</text><text x="72" y="188" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">--device auto --cwd &lt;workspace&gt;</text><text x="72" y="200" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">--strategy balanced --mode auto</text>
<rect x="370" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="382" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">CLI places the run</text><text x="382" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">worker pool, balanced account,</text><text x="382" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">cwd re-rooted on the host</text>
<rect x="680" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="692" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Stream row arrives</text><text x="692" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">tab binds to the session id, title takes</text><text x="692" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">the canonical name, sidebar renders</text>
<path d="M170 98L200 138" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j1a)"/><path d="M350 172L368 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j1a)"/><path d="M660 172L678 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j1a)"/><path d="M835 138L850 100" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j1a)"/>
<text x="20" y="236" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Every automatic-placement variant carries --strategy balanced. Pick Account uses claude@ and no strategy. Pick Project adds --project and drops --cwd.</text>
</svg>
<figcaption>The extension never scores a device or an account. It pins at most one axis and hands the rest to the CLI.</figcaption>
</figure>

## Come back after a reload or a crash

You closed the editor, or it crashed, with agent tabs open. You want them back exactly as they were, and you want none of the agents killed by the reload itself.

You reopen the workspace. The extension reads the persisted tab metadata for that workspace (terminal id, harness prefix, session id, host, label, pinned version) and reopens each tab through the CLI's resume path. Each restored tab then rebinds from the live stream: the first row that claims the tab's terminal id on the same observer device and host is the tab's session.

What should happen: every tab returns with its label and icon; the status bar and sidebar follow the restored session once the stream reports it; the agent process was never signaled. Closing a tab by hand is different: only a real user close (`TerminalExitReason.User`) issues `agents sessions stop <id>`. A reload is never treated as a close. Each window keeps its tabs in its own file, so a second window can neither resurrect a tab you closed nor erase this window's tabs; restore opens one tab per session, keeps each tab's device, and skips a session the window already shows.

Where this is still debt: `src/core/prewarm.simple.ts` still lists OpenCode sessions on tab open, slated for deletion once the CLI daemon owns restore.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Journey: return after a reload. User lane on top, extension and CLI lane below.">
<defs><marker id="j2a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="12" fill="#09090b" stroke="#3f3f46"/>
<text x="20" y="28" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">USER JOURNEY · RELOAD OR CRASH</text>
<text x="20" y="72" fill="#5ad6c0" font-family="ui-monospace,monospace" font-size="10">YOU</text>
<rect x="60" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="72" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Editor reloads or crashes</text><text x="72" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">three agent tabs were open</text>
<rect x="370" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="382" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Reopen the workspace</text><text x="382" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">nothing else to do</text>
<rect x="680" y="48" width="290" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="692" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Same three tabs, same labels</text><text x="692" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">agents still running</text>
<path d="M320 73L368 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j2a)"/><path d="M630 73L678 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j2a)"/>
<line x1="20" y1="120" x2="980" y2="120" stroke="#26302a" stroke-dasharray="4 4"/>
<text x="20" y="166" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">EXT</text><text x="20" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">CLI</text>
<rect x="60" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="72" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Persisted tab metadata</text><text x="72" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">terminal id, prefix, session id, host,</text><text x="72" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">label, version; no stop was sent</text>
<rect x="370" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="382" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Reopen through resume</text><text x="382" y="180" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">agents sessions resume &lt;id&gt;</text><text x="382" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">per workspace, never machine-global</text>
<rect x="680" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="692" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Rebind from the stream</text><text x="692" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">first sole live claim on the tab's terminal</text><text x="692" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">id binds it; a Previous row cannot</text>
<path d="M180 98L200 138" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j2a)"/><path d="M350 172L368 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j2a)"/><path d="M660 172L678 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j2a)"/><path d="M835 138L850 100" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j2a)"/>
<text x="20" y="236" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Only a real user close sends agents sessions stop. Reload and restore are never a close.</text>
</svg>
<figcaption>Persisted metadata is enough to reopen a tab. It is never proof that a process is alive and never a transcript cache.</figcaption>
</figure>

## See what an agent is doing

The active agent tab shows a copy icon and the first eight characters of its session ID. Hover exposes the full ID and remote host; clicking copies the full canonical ID. Switching to a text editor or a plain terminal clears the session tooltip. Remote attach titles omit host-only placeholders; execution host identity comes from structured stream facts, never task text.

You have several tabs and you want to know, for the one you are looking at, what you asked, what it has done, and whether it is stuck, without scrolling its terminal.

You focus an agent tab, or click a row in Fleet. The Active Session sidebar (the `agentsPanel.terminal` view) takes that session as its subject; the last of the two triggers wins. A focused tab whose harness has not reported its session id yet (Codex, Grok) is still the subject: the sidebar shows that tab, never the previously focused one, and renders its row once the stream binds the id or you set it with Set Session ID for Terminal. The sidebar renders synchronously from the warm presentation store, top to bottom. A compact header leads with the harness icon and the session's title (your `/rename`, else the CLI's generated title), then the running model, account and host. Its `⋯` menu opens a drawer inside the card with the short session id (copy, and a pencil to rebind the tab, offered even before the harness reports an id), chips for project, branch, a `worktree` badge only when the agent works in a linked worktree, the start time, tokens, and the raw identity lines; the drawer remembers whether it is open. Under the header one line states where the session is from the CLI row's phase: "Working 1d 2h · active 2 min ago", or "Needs you", "Your turn · ran 26h", "Ended", "Stopped", "Unknown", with when it last moved; the word is the same one the Project panel and Fleet use (`sessionStateOf`). When the harness has an open ask, a needs-you card sits under the header with its own words, how long it has waited, and Reply and Focus. Failed and policy-blocked tool calls stay behind one quiet line ("⚠ 6 failed · 12 blocked") that appears only when there are any and opens to the list. What the session produced comes next, before what was asked (PHNX-4289). Artifacts leads as a gallery: the newest image the session made fills the card width as a large preview, captioned with its title (the CLI's sidecar title, else the file name), its type and how long ago it changed; the other images follow as a two-up grid of tiles with a one-line caption, and files with no preview (pages, documents) close the card as compact tiles marked with a type glyph. Previews are downscaled once in the webview and cached; a tile opens the file (a plan or report as an editor tab in the Agents Reader beside the agent that wrote it; for an agent on another machine the file is copied here first, so it opens without a remote connection). The session's other PRs and its ticket sit under the gallery as links. Sort (latest edited first by default, oldest, name) and a Group by app toggle sit under the heading; grouped, the card shows the folders by app (Finder, GitHub, Linear), each a strip of thumbnails that its caret opens into a grid, with ↗ to reveal it in Finder. The heading folds the whole section to one line with the newest thumbnails, the apps involved and when the newest changed; these choices persist. The Pull request card follows when the session has a PR, read at a glance rather than in words: a ring for where it stands (spinning while checks run, closed with a check when ready, red when failing or conflicting, dashed for a draft), `#number title`, one status word (Ready, Checks running, Failing, Conflicts, Changes requested, Draft, Merged, Closed) and the session's branch. Under it one icon strip: a bar with one segment per check colored passed, running, failed or skipped with `passed/total` beside it, a review glyph (an outline when there is no review, green when approved, red when changes are requested) and a merge glyph (green when mergeable, red on conflicts); each icon carries its words in its tooltip and accessible label. Clicking the bar unfolds the checks by name, each with a link to its run. When the PR's checks turn green while you watch, the ring closes into a check once (not under reduced motion). The card offers Open on GitHub and at most one action decided from the row (Merge when ready, Merge when green while checks run), confirmed in a dialog and run as one `agents projects prs merge|automerge … --sha <head>` pinned to the head commit shown, never `--admin`; without a head commit on the row it offers no action and says why. Then the goal and the request. Request shows your avatar (fetched from Gravatar by a hash of your email) and name, your sentence, thumbnails of images you pasted (also when the agent runs on another machine), and the whole turn behind a fold. The Timeline opens with a seek bar of tool activity across the whole session, idle stretches collapsed into labeled gaps and markers for your messages, subagents and the open ask; clicking a bar jumps to that moment. When the session has more than one stretch of work, a chip per stretch (named by when it began) narrows the strip, the steps and the You and Failed lists to that stretch; bars outside it dim, and Clear range returns to the whole session. A stretch whose steps are older than the row's last few says so instead of looking empty. A turn the harness wrote for itself (a background task's `<task-notification>`, a `<system-reminder>`) is never shown as your message, as a step, or as the agent's current activity, and its marker leaves the strip so marker N and turn N stay the same turn. Filter chips swap the default summary (newest three steps, the live line, failures and milestones) for your messages, the failures, or, one `agents sessions <id> --include` call per click, the agent's messages, tool calls or reasoning. With a range chosen on a local session, Show tool calls loads the calls once and draws them as a zoomed lane over the range. Then the Checklist; the changed files with the true total, as a tree in which a folder with a single child folder folds into one row, or as a flat list (the choice persists), marked with Source Control's A, M and D; Subagents, each row showing its type (and model, when reported), how long it ran (or has been running) and its tool count before you open it, running ones first and finished ones beyond the newest three folded behind one line, opening to what it was asked (when reported), its verdict and a link to its transcript; current activity; and a reply field last. The status bar shows the active tab's label and, for a remote session, its host.

What should happen: switching tabs paints instantly with no await, fetch, or lazy enrichment. On an older CLI the cards degrade honestly: request falls back to the cleaned prompt and then the topic, timeline falls back to checkpoints, and the Files card does not appear. Two states are never faked: when no reset has been seen for the subject's scope the Timeline says "Waiting for the session stream…" and names the command; when the CLI reports the timeline unavailable it says so with the CLI's reason.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Journey: see what an agent is doing. User lane on top, extension and CLI lane below.">
<defs><marker id="j3a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="12" fill="#09090b" stroke="#3f3f46"/>
<text x="20" y="28" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">USER JOURNEY · SEE WHAT AN AGENT IS DOING</text>
<text x="20" y="72" fill="#5ad6c0" font-family="ui-monospace,monospace" font-size="10">YOU</text>
<rect x="60" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="72" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Focus a tab or click a row</text><text x="72" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">two triggers, last wins</text>
<rect x="370" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="382" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Read the sidebar</text><text x="382" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">request, timeline, checklist, files</text>
<rect x="680" y="48" width="290" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="692" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Reply, Focus, or Resume</text><text x="692" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">from the sidebar footer and header</text>
<path d="M320 73L368 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j3a)"/><path d="M630 73L678 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j3a)"/>
<line x1="20" y1="120" x2="980" y2="120" stroke="#26302a" stroke-dasharray="4 4"/>
<text x="20" y="166" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">EXT</text><text x="20" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">CLI</text>
<rect x="60" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="72" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Subject = session row</text><text x="72" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">presentation state only, never</text><text x="72" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">persisted; works with no local tab</text>
<rect x="370" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="382" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Synchronous paint</text><text x="382" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">every card is a copy off the warm store:</text><text x="382" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">no await, no fetch, no transcript read</text>
<rect x="680" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="692" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Honest degradation</text><text x="692" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">no reset yet: "Waiting for the session</text><text x="692" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">stream…"; unavailable: the CLI's reason</text>
<path d="M180 98L200 138" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j3a)"/><path d="M350 172L368 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j3a)"/><path d="M660 172L678 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j3a)"/><path d="M515 138L500 100" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j3a)"/>
<text x="20" y="236" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">The zero-overhead guarantee: a tab switch or a row click starts no CLI process.</text>
</svg>
<figcaption>The sidebar is the one session preview. Fleet has no detail rail.</figcaption>
</figure>

## Manage a project from the left sidebar

You run several agents on one project and want the project's state in view while the right sidebar shows the session you are in: what is open, which sessions stopped, which PRs are ready, what is next.

The Project panel is one sidebar view with four icon tabs: Overview, Sessions, Pull requests and Tickets. The active tab shows its label (and, for Sessions, how many have something to read), a badge on the Sessions icon counts sessions that need you as of the last time Sessions was shown (the stream runs only while Sessions is visible), arrow keys move between tabs, the panel remembers the active tab per workspace, and each tab keeps its scroll while the panel is open. Only the active tab loads. Its project is the one containing the open workspace folder (`agents projects status --path <folder> --json`), or the one you choose with Switch Project, remembered per workspace. Overview shows the project's progress, a bar of its open tickets by state (Doing, In Review, Todo, Backlog) with counts, and the current milestone with its due date; when no milestone is current it says so and how many open tickets have none. Sessions lists every session of the project from the session stream already in memory, filtered on the CLI's `confirmedProject`, so it starts no process; the stream is demanded only while Sessions is the visible tab, and it redraws when the stream changes. Each session is a card: its title and how long since it last moved; the last thing you asked it, with thumbnails of images you pasted (looked up by name in this machine's attachment store; one opens the full image in an editor tab); where the agent is now in its own words, two lines from its newest timeline step; its question in an amber box when it is asking you; the command it is running when working; and chips for its PR with its check color, its ticket, its worktree or branch, and files changed. The device is in the tooltip only. Its state is the icon at the left and the group it sits in, named the same on every surface (`sessionStateOf`, `src/shared/sessionState.ts`): Needs you (an open ask, or the CLI's `input_required`), Stopped (orphaned, crashed, abandoned, failed or stalled), Working, Your turn (the agent replied and waits for your next message), Unknown (a live process whose transcript the CLI could not read) and Ended (the process exited, which says nothing about whether the work is finished). Sessions are grouped by state and place: Needs you, Stopped, In your tabs (live and attached to an editor tab: the CLI's `context` is terminal and its `presence` is not background or parked), Background (live with no attached tab: a headless run, a team member, a cloud task, or a session sent to the background, each named by a chip), then Ended. An ended session whose tab is still open in this window shows "tab open · agent not running", and clicking it resumes the session rather than showing the leftover shell. Sessions that never said anything fold into one line at the end. Clicking a card goes to the session: its tab in this window comes forward; if the CLI says a tab in another window holds it, `agents ps focus <id> --attach-only` brings that tab forward; otherwise it opens in a new editor tab with the CLI's resume command for its device. Hovering shows which (Focus or Open), and the other sidebar points at the session in every case. Pull requests lists every open PR across the project's repos (`agents projects prs list <name> --json`) with a ring for its checks (turning, a check, red, dashed for a draft) and the default branch's state, with recently merged ones listed below. Tickets lists the project's open Linear tickets (`linear tasks --project <linear> --json`) grouped by state, Doing first, each with priority bars. Overview, Pull requests and Tickets read their verb when their tab is shown, at most once a minute, or on Refresh; nothing polls.

What should happen: a slow read paints "Loading…" in its own view and never blocks the others; a failed read shows the CLI's error in that view; a project with no Linear project says how to link one.

## Answer a request from Fleet

Some agent, on some machine, is waiting on you. You want to see exactly what it asked and answer it from the editor.

You open the dashboard (Cmd+Shift+F). The Needs you lane lists every attention row the CLI feed marks open, ranked question, permission, plan review, declared, failure, stall, review, most-stuck first within a kind. An interactive hand-back renders as a decision card carrying the harness's own choices; a failure renders as a failure card; a stall or review as a plain row. You click a choice, or type a reply.

What should happen: the answer goes to the CLI as one verb and the card leaves the lane only when the feed removes the attention row, never optimistically. The activity lane keeps a compact receipt of the resolution. The extension classifies nothing: membership is `attention.state === 'open'`, the reason is `attention.kind`, and a stall is a CLI signal. A tab the stream has not indexed yet carries no attention and cannot enter the lane from the client side.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Journey: answer a needs-you request. User lane on top, extension and CLI lane below.">
<defs><marker id="j4a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="12" fill="#09090b" stroke="#3f3f46"/>
<text x="20" y="28" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">USER JOURNEY · ANSWER A REQUEST</text>
<text x="20" y="72" fill="#5ad6c0" font-family="ui-monospace,monospace" font-size="10">YOU</text>
<rect x="60" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="72" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Open Fleet (Cmd+Shift+F)</text><text x="72" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Needs you lane at the top</text>
<rect x="370" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="382" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Read the exact question</text><text x="382" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">and the harness's own choices</text>
<rect x="680" y="48" width="290" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="692" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Click a choice or type</text><text x="692" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">the card leaves when the CLI says so</text>
<path d="M320 73L368 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j4a)"/><path d="M630 73L678 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j4a)"/>
<line x1="20" y1="120" x2="980" y2="120" stroke="#26302a" stroke-dasharray="4 4"/>
<text x="20" y="166" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">EXT</text><text x="20" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">CLI</text>
<rect x="60" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="72" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Pure projection</text><text x="72" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">membership = attention.state open;</text><text x="72" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">order = attention.kind rank</text>
<rect x="370" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="382" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">One verb</text><text x="382" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">the answer is sent once; no retry timer,</text><text x="382" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">no optimistic removal</text>
<rect x="680" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="692" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Feed removes the row</text><text x="692" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">attention.remove clears the card; the</text><text x="692" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">activity lane keeps a receipt</text>
<path d="M180 98L200 138" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j4a)"/><path d="M350 172L368 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j4a)"/><path d="M660 172L678 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j4a)"/><path d="M835 138L850 100" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j4a)"/>
<text x="20" y="236" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Resolved attention cannot reappear from an older snapshot. A stalled agent is a CLI fact, never a client heartbeat guess.</text>
</svg>
<figcaption>The CLI decides what needs a person. The extension shows it and carries the answer back.</figcaption>
</figure>

## Resume, fork, or move a session

You want to continue an earlier conversation, branch it into a sibling, or carry it to another machine or harness.

For resume you run `Agents: Resume Session…` (Cmd+Shift+Alt+R) and pick a session by name: no ids, no terminal. It lists this window's project's sessions on every machine, newest first, from the session stream already in memory (scoped by the CLI's `confirmedProject`, like the Project sidebar). Each row shows the title, the machine, your last message, the agent's last line, how long ago, and OPEN when a tab already shows it; typing filters by title or message. A row is still usable with only its id, title, machine and last activity. Enter runs `agents.resumeSession`: a tab already showing the session comes to the front, else the CLI opens the live agent in the window that owns the project. One VSCodium notification says where it went ("Opened … in svatlas", "Focused … in svatlas", or the reason it could not); nothing is printed inside the tab. Fleet's Resume button and the side panel's Focus and ↻ run the same action. Resume's right-click menu on a Previous Fleet row moves the session to another device (`agents sessions migrate`). `Resume (Pick Host)` reopens the active tab's session on a device you pick, same harness and version. `Resume (Pick Harness)` continues the active tab's session in a different harness on the same device through the universal `/continue` flow. `Resume (Best Profile)` (Cmd+Shift+Alt+J) rotates the active tab to the signed-in account with the most headroom.

For fork you run `Agents: Fork`, `Fork (Recap)`, or `Fork (Pick Host)`; all delegate to `agents sessions fork <id>`, which resolves the source across the fleet and launches a recap-seeded same-harness sibling. The original is untouched. Fleet's Recap ledger reunites a fork and its parent as one side-by-side row, each stamped with the machine it ran on and its own duration, cost, and PR.

For moving a session, right-click a Fleet row's Resume and choose a different device from the already-loaded roster; the extension delegates transport and liveness to `agents sessions migrate` and then focuses the target in the same editor terminal.

What should happen: each action is one command, the extension resolves only the selection, and the new tab rebinds from the stream. The extension never reproduces resume compatibility, account selection, placement, or fork identity rules.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Journey: resume, fork, or migrate a session. User lane on top, extension and CLI lane below.">
<defs><marker id="j5a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="12" fill="#09090b" stroke="#3f3f46"/>
<text x="20" y="28" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">USER JOURNEY · RESUME · FORK · MIGRATE</text>
<text x="20" y="72" fill="#5ad6c0" font-family="ui-monospace,monospace" font-size="10">YOU</text>
<rect x="60" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="72" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Pick the verb</text><text x="72" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Resume, Fork, or Resume on a device…</text>
<rect x="370" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="382" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Pick the session or device</text><text x="382" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">from one bounded listing</text>
<rect x="680" y="48" width="290" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="692" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Continue in the new tab</text><text x="692" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">the original is untouched</text>
<path d="M320 73L368 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j5a)"/><path d="M630 73L678 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j5a)"/>
<line x1="20" y1="120" x2="980" y2="120" stroke="#26302a" stroke-dasharray="4 4"/>
<text x="20" y="166" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">EXT</text><text x="20" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">CLI</text>
<rect x="60" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="72" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Resolve the selection only</text><text x="72" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">canonical id, target device, harness</text><text x="72" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">from the roster already loaded</text>
<rect x="370" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="382" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">One owning verb</text><text x="382" y="180" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">agents sessions resume | fork | migrate</text><text x="382" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">the CLI owns identity and transport</text>
<rect x="680" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="692" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">New row on the stream</text><text x="692" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">the tab binds to it; Recap reunites a</text><text x="692" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">fork with its parent side by side</text>
<path d="M180 98L200 138" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j5a)"/><path d="M350 172L368 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j5a)"/><path d="M660 172L678 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j5a)"/><path d="M835 138L850 100" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j5a)"/>
<text x="20" y="236" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Fork and Fork (Recap) behave identically: the CLI verb is always recap-seeded.</text>
</svg>
<figcaption>Every lifecycle action is a selection plus one CLI command.</figcaption>
</figure>

## Dispatch a ticket from Fleet

You have a ticket and want an agent on it, on a worker, without opening a terminal yourself.

From the Fleet header you press Dispatch (or Cmd+Shift+D). The dispatch panel takes the ticket or a free-text task, the harness, the mode, and where to run it, and hands the CLI one `agents run` command. The new session appears in the list as a row when the stream reports it, attributed to its project from the hints the row carries: working directory or worktree path first, then the CLI's repo word, the PR's owner and repo, then branch, worktree slug, or team.

What should happen: the panel never scores devices or accounts; it composes flags the CLI already accepts. A session no hint can attribute lands in a labeled Unassigned group that states why, with a per-row and per-group assign action that is a local presentation override, never a fetch or a guess. The Project control beside Group and Sort scopes rows and status-chip counts to one project and remembers the pick.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Journey: dispatch a ticket from Fleet. User lane on top, extension and CLI lane below.">
<defs><marker id="j6a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="12" fill="#09090b" stroke="#3f3f46"/>
<text x="20" y="28" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">USER JOURNEY · DISPATCH A TICKET</text>
<text x="20" y="72" fill="#5ad6c0" font-family="ui-monospace,monospace" font-size="10">YOU</text>
<rect x="60" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="72" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Press Dispatch in Fleet</text><text x="72" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">or Cmd+Shift+D</text>
<rect x="370" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="382" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Ticket, harness, mode, where</text><text x="382" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">one panel, one submit</text>
<rect x="680" y="48" width="290" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="692" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Row appears under its project</text><text x="692" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">or under a labeled Unassigned</text>
<path d="M320 73L368 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j6a)"/><path d="M630 73L678 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j6a)"/>
<line x1="20" y1="120" x2="980" y2="120" stroke="#26302a" stroke-dasharray="4 4"/>
<text x="20" y="166" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">EXT</text><text x="20" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">CLI</text>
<rect x="60" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="72" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Compose flags the CLI accepts</text><text x="72" y="180" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">agents run &lt;harness&gt; --mode … --device …</text><text x="72" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">no device or account scoring here</text>
<rect x="370" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="382" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">CLI places and starts it</text><text x="382" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">worker pool, account rotation,</text><text x="382" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">session id minted by the CLI</text>
<rect x="680" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="692" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Attribute from row hints</text><text x="692" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">cwd → repo word → PR slug → branch;</text><text x="692" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">a prompt is never mined</text>
<path d="M180 98L200 138" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j6a)"/><path d="M350 172L368 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j6a)"/><path d="M660 172L678 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j6a)"/><path d="M835 138L850 100" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j6a)"/>
<text x="20" y="236" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Project attribution uses matchLinearProject with word-wise containment, so "crush-cli" is never filed under "Rush".</text>
</svg>
<figcaption>Dispatch is a form over the CLI's own flags. Attribution is a projection of the row.</figcaption>
</figure>

## Reuse a terminal for a new session

You exit the agent in a tab and start another one in the same terminal. You expect the tab, the status bar, and the sidebar to follow the new session without opening a new tab.

You type `exit` or quit the agent, then launch another in the same Agents terminal. For a moment two stream rows may both claim the tab's stable observer terminal id. The extension treats two distinct live claims as ambiguous and keeps the existing binding. Once the old session is removed from the stream, or returns only as a Previous row, the new session is the sole live claim and the tab rebinds to it.

What should happen: no tab switch is needed; the status bar and the Active Session sidebar follow the new session, and a terminal-selected sidebar subject follows the exact terminal id across the rebind while a Fleet-selected subject stays tied to its session. Start time is never an ownership signal. Reconciliation runs only on pushed reset and agent-row facts, never on a poll or a local state-file read, and it stays scoped to the terminal's observer device and execution host.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Journey: reuse a terminal for a new session. User lane on top, extension and CLI lane below.">
<defs><marker id="j7a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="12" fill="#09090b" stroke="#3f3f46"/>
<text x="20" y="28" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">USER JOURNEY · REUSE A TERMINAL</text>
<text x="20" y="72" fill="#5ad6c0" font-family="ui-monospace,monospace" font-size="10">YOU</text>
<rect x="60" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="72" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Exit session A in the tab</text><text x="72" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">the shell stays open</text>
<rect x="370" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="382" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Start session B there</text><text x="382" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">same terminal, no new tab</text>
<rect x="680" y="48" width="290" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="692" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Status bar and sidebar show B</text><text x="692" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">without a tab switch</text>
<path d="M320 73L368 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j7a)"/><path d="M630 73L678 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j7a)"/>
<line x1="20" y1="120" x2="980" y2="120" stroke="#26302a" stroke-dasharray="4 4"/>
<text x="20" y="166" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">EXT</text><text x="20" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">CLI</text>
<rect x="60" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="72" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Two live claims: ambiguous</text><text x="72" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">A and B both carry the terminal id;</text><text x="72" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">the existing binding stays</text>
<rect x="370" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="382" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">A leaves the stream</text><text x="382" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">agent.remove, or previous: true;</text><text x="382" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">B is now the sole live claim</text>
<rect x="680" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="692" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Rebind on the pushed fact</text><text x="692" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">registry, status bar, sidebar follow B;</text><text x="692" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">a later Previous A cannot revert it</text>
<path d="M180 98L200 138" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j7a)"/><path d="M350 172L368 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j7a)"/><path d="M660 172L678 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j7a)"/><path d="M835 138L850 100" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j7a)"/>
<text x="20" y="236" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Reconciliation runs only on pushed reset and row facts, scoped to observer device and execution host. No poll, no state file.</text>
</svg>
<figcaption>Session start time is not ownership. The stream's removal of the old row is.</figcaption>
</figure>

## Commit with Autogit

You have staged or working changes and want a commit message in your own style, committed and pushed, in one action.

You press Cmd+Shift+G. The extension reads the git extension's repository state, builds the diff and the status summary while honoring the `agents.ignoreFiles` patterns, and asks `agents run claude --model haiku` for a message shaped by your `agents.commitMessageExamples`. It stages, commits, and pushes unless `agents.disableAutocommit` or `agents.disableAutopush` say otherwise.

What should happen: one keystroke, one generated message, one commit. The timeout is `agents.commitGenTimeoutMs`. No OpenAI key is involved; Autogit stopped using it when message generation moved to the CLI.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Journey: commit with Autogit. User lane on top, extension and CLI lane below.">
<defs><marker id="j8a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="12" fill="#09090b" stroke="#3f3f46"/>
<text x="20" y="28" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">USER JOURNEY · AUTOGIT</text>
<text x="20" y="72" fill="#5ad6c0" font-family="ui-monospace,monospace" font-size="10">YOU</text>
<rect x="60" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="72" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Press Cmd+Shift+G</text><text x="72" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">or the SCM title button</text>
<rect x="370" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="382" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Wait a few seconds</text><text x="382" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">bounded by commitGenTimeoutMs</text>
<rect x="680" y="48" width="290" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="692" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Committed and pushed</text><text x="692" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">unless a disable setting is on</text>
<path d="M320 73L368 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j8a)"/><path d="M630 73L678 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j8a)"/>
<line x1="20" y1="120" x2="980" y2="120" stroke="#26302a" stroke-dasharray="4 4"/>
<text x="20" y="166" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">EXT</text><text x="20" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">CLI</text>
<rect x="60" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="72" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Diff and status from git ext</text><text x="72" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">ignoreFiles applied; staged and</text><text x="72" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">unstaged changes summarized</text>
<rect x="370" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="382" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Message from the CLI</text><text x="382" y="180" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">agents run claude --model haiku</text><text x="382" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">styled by commitMessageExamples</text>
<rect x="680" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="692" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Stage, commit, push</text><text x="692" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">disableAutocommit stops after the message;</text><text x="692" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">disableAutopush stops after the commit</text>
<path d="M180 98L200 138" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j8a)"/><path d="M350 172L368 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j8a)"/><path d="M660 172L678 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j8a)"/><path d="M835 138L850 100" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j8a)"/>
<text x="20" y="236" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">No OpenAI key is used for commits. The agents.openaiApiKey setting exists only for the Foreman voice orb.</text>
</svg>
<figcaption>Autogit is one gesture that becomes one CLI call and one git transaction.</figcaption>
</figure>

## Read an artifact in the Reader

An agent produced a plan or a report as Markdown or HTML and you want to read it like a document, not as source.

You enable the Reader once with `Agents: Reader (Enable)`. From then on `.md` files can open in the Notion-style editor (TipTap, with a frontmatter panel, outline, slash commands, callouts, toggles, file attachments) and `.html` files open in a sandboxed viewer. Both are registered as optional custom editors, so the default text editor stays available. `.html` and `ref-*.md` plans detected in session output, worktree files, or attachments also appear as one-click preview chips on Fleet cards, and screenshots as thumbnails that click through to the host preview.

What should happen: the HTML viewer never runs the page's scripts against the editor; it renders inside the webview sandbox. A link in the page with an `agents:`, `http(s):` or `mailto:` address opens outside the editor, the same as a browser click: an artifact's "Open session" chip focuses the tab running that session. Other addresses never leave the viewer. Images and attachments dropped into the Markdown editor land in the `agents.editor.assetFolder` folder next to the document. `Agents: Reader (Disable)` restores the default association.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250" role="img" aria-label="Journey: read an artifact in the Reader. User lane on top, extension lane below.">
<defs><marker id="j9a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#a1a1aa"/></marker></defs>
<rect x="1" y="1" width="998" height="248" rx="12" fill="#09090b" stroke="#3f3f46"/>
<text x="20" y="28" fill="#8b938c" font-family="ui-monospace,monospace" font-size="11" letter-spacing="2">USER JOURNEY · READ AN ARTIFACT</text>
<text x="20" y="72" fill="#5ad6c0" font-family="ui-monospace,monospace" font-size="10">YOU</text>
<rect x="60" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="72" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Enable the Reader once</text><text x="72" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Agents: Reader (Enable)</text>
<rect x="370" y="48" width="260" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="382" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Open a plan chip or file</text><text x="382" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">from Fleet or the explorer</text>
<rect x="680" y="48" width="290" height="50" rx="8" fill="#161a18" stroke="#5ad6c0"/><text x="692" y="70" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Read and annotate</text><text x="692" y="88" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">Markdown edits save in place</text>
<path d="M320 73L368 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j9a)"/><path d="M630 73L678 73" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j9a)"/>
<line x1="20" y1="120" x2="980" y2="120" stroke="#26302a" stroke-dasharray="4 4"/>
<text x="20" y="166" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">EXT</text><text x="20" y="178" fill="#a3e635" font-family="ui-monospace,monospace" font-size="10">CLI</text>
<rect x="60" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="72" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Custom editors registered</text><text x="72" y="180" fill="#8b938c" font-family="ui-monospace,monospace" font-size="10">agents.markdownEditor · agents.htmlReader</text><text x="72" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">priority option: the text editor stays</text>
<rect x="370" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="382" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Sandboxed webview</text><text x="382" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">HTML renders in the webview sandbox;</text><text x="382" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">TipTap editor for Markdown</text>
<rect x="680" y="140" width="290" height="64" rx="8" fill="#12211a" stroke="#a3e635"/><text x="692" y="162" fill="#e7ece8" font-family="system-ui,sans-serif" font-size="12" font-weight="600">Assets beside the document</text><text x="692" y="180" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">dropped images go to agents.editor.assetFolder</text><text x="692" y="196" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">(default .assets)</text>
<path d="M180 98L200 138" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j9a)"/><path d="M350 172L368 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j9a)"/><path d="M660 172L678 172" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j9a)"/><path d="M835 138L850 100" stroke="#a1a1aa" stroke-width="1.4" marker-end="url(#j9a)"/>
<text x="20" y="236" fill="#8b938c" font-family="system-ui,sans-serif" font-size="11">The Reader is opt-in and reversible. It never becomes the default association for a workspace that did not enable it.</text>
</svg>
<figcaption>The Reader turns agent output into something you read, without leaving the editor.</figcaption>
</figure>

## Requirements

**Stream contract.** Exactly one `agents feed watch --json` child exists per machine for all editor windows, owned by the elected leader window, and only while some window demands it: a visible Fleet dashboard or Active Session sidebar, or a tracked agent tab whose identity the stream has not resolved. When no window demands it the producer is torn down after a short grace period. Every window reads a broadcast projection of that stream. A reset replaces a scope; upserts and removes apply only when newer; a stale event is ignored; a follower that has never seen a reset renders as degraded, never as an authoritative empty state. If a field the UI needs is missing from the stream, the fix is to add it to the CLI's row, never a side-channel fetch. That side channel caused the 2026-08-25 CPU incident.

**One-shot verbs.** Launch, resume, fork, stop, migrate, dispatch, merge, and answer are each built with the owning CLI noun and run once per user action. A merge from the sidebar is re-decided by the host from its own snapshot, confirmed in a modal, and pinned to the head SHA. No retry timers, no caches of CLI output beyond a short in-flight guard. Closing a tab tears the agent down only on a real user close.

**Fail loud.** A missing CLI binary is a visible prerequisite failure. A missing CLI noun is an upgrade error. A malformed feed event is rejected and reported without corrupting the current scope. No filesystem fallback fills a gap.

**Active Terminal details and outputs.** The header shows the account slot label when supplied by the CLI, with the account email on hover. Clicking the short session ID copies the full ID; every terminal subject, including one whose harness has not reported an id yet, also offers Set Session ID for Terminal. Focus and Resume are compact icon buttons. The `⋯` menu remembers its disclosure state and shows harness/version, full ID, cwd, branch and host. Files and Artifacts use host-formatted paths that preserve the complete filename, shorten owned scratch to its session-relative path, and expose full paths on hover. Artifacts contains numbered PRs, the CLI row’s planFile, documents and Linear issues; no local PLAN.md discovery occurs. File and URL rows support keyboard activation, and timeline rows expand in place.

**Theme.** The Active Terminal panel fills the viewport with the sidebar background, including empty space beneath short content. Over that ground it is drawn in the Rush register (`rush/DESIGN.md`, Day and Altitude), the same visual language as getrush.ai and artifacts-cli: section labels in Jost capitals, the interface in Inter, ids and numbers in the editor's monospace font, cards as glass with a one-pixel edge over a faint sky. A dark editor theme gets Altitude (white glass, zinc type), a light one gets Day (ivory glass, ink type), and a high-contrast theme keeps VS Code's own colors and borders. Gold marks only the primary action; status is a dot, a badge or a word, never a filled button; links are the text color, underlined. Every color comes from one token block keyed on the theme kind VS Code sets on the webview, and Jost and Inter ship inside the extension, so the panel loads no remote font.

**Latency.** Opening the sidebar, switching tabs, and selecting a Fleet row spawn zero subprocesses; the sidebar paints from the warm store synchronously. The Fleet list keeps search, filters, grouping, the row Resume button, and the expand-in-place card and nothing that fetches per selection. A row names its machine and working folder beside the title, then your latest message (`You ›`) and the agent's latest reply (`Agent ›`), both from the stream row; expanded, it adds the full latest reply and the sidebar's own Artifacts and Timeline cards for that session, drawn from the module both surfaces share (`src/shared/sessionCards.ts`), so filters, time chips and the gallery behave the same in both places; a click inside them names its session to the host, and an artifact of a remote session opens by the same one-file copy the sidebar uses. A row the stream gives no reply or timeline shows neither rather than a placeholder, and each row is as tall as the lines it renders. Previous history defaults to at most 50 sessions active in the last seven days and pages older history ten rows at a time; after a longer gap it shows up to ten most-recently-active Previous sessions rather than an empty band.

**Launch composition.** `--cwd` is emitted once, independently of device selection, for ordinary, Auto, Pick Host, Pick Account, local, and version-pinned launches, carrying the exact open workspace. Only Pick Project emits `--project`, and it never emits `--cwd`. `--strategy balanced` is emitted for every automatic-placement variant (default, Auto, Pick Host, Pick Project, local) and dropped for exactly two: the account picker (`harness@`), which is mutually exclusive with a strategy, and a pinned version, where the CLI ignores it. Ordinary launches never derive a target from `agents projects view <cwd>`.

**Identity.** Publisher `swarmify` and name `swarm-ext` in `package.json` never change; the `swarm-ext://` URI the CLI emits names `swarmify.swarm-ext` as its authority, and the URI handler serves `/focus` (raise a tab), `/inject` (deliver text into a live terminal by session id), and `/spawn` (open an editor tab running a supplied command such as `claude --resume <id>`, which the agents-cli terminal engine's `vscodium-agent` backend uses to resume a session into this editor). A `/spawn` opens only in a window whose folders contain its `project` (a request without one is refused) and focuses the window's existing tab for that session rather than opening a second. `agents.resumeSession(<id>)` is the extension's one entry point for the same thing: it focuses this window's tab or has the CLI open the session in its project's window, and returns the ack status; with a `nonce` the window writes `~/.swarmify/agents/spawn-acks/<nonce>.json` saying `opened`, `focused-existing`, `wrong-window`, or `failed`, so the CLI reports what happened instead of assuming. Display names may change freely.

**Multi-window.** Opening a second dashboard must not double long-lived watchers, transcript parsing, or schedulers. Followers recover replayable session and attention state from the leader's replay cache. Devices, projects, and tickets are still separate bounded CLI reads until the stream owns them; that is recorded debt.

**Harness roster.** The presented harnesses, their labels, prefixes, and install info derive from the CLI catalog through one shared module with a drift test; no hand-written harness list exists in the UI. Gemini is not presented.

## Evidence

The suite runs with `bun test --timeout 30000` from the repository root and exercises real command boundaries; the only sanctioned double is `src/testing/vscodeDouble.ts`. The baseline on this branch is 1,853 tests across 165 files with 6 failures, all in the UI package when run from the root, unchanged from `origin/main`. `bun run lint:dead` (knip) runs inside `scripts/build.sh` and fails the build on any unused file, export, type, or dependency. `scripts/build.sh <version>` must produce a VSIX, and a local `scripts/install.sh` followed by `Agents: New Claude` must open a tab with a live prompt. Agent-integration tests (`bun run test:agent-integration`) require the `agents` binary on the box and hit it for real.

The checks that matter for the journeys are the ones an agent or a person runs against the installed extension: one `agents feed watch` child across two windows; zero processes on a row click; tabs restored after reload with no session stopped; a permission card that shows the terminal's own options and clears on the feed's removal; a Pick Account launch that shows the worker's own picker.

## Open decisions

Whether restore should move entirely into the CLI daemon, which would delete `prewarm.simple.ts` and the per-window restore file, is decided in principle (yes) and blocked on the CLI carrying a restore projection. Whether `messageCount` and `recentFiles` return to the sidebar depends on the CLI adding them to the stream row; a lazy enrich is not an option. Whether the dashboard's device, project, and ticket reads move onto the stream is deferred until the CLI projects them. Switching the stream to `agents sessions watch --json --local` is rejected until the CLI side lands, because `feed watch` is the only producer of attention and activity events and the only fleet fan-out. The Foreman voice orb keeps its OpenAI dependency until the CLI offers a realtime voice path; that is the one feature that does not fit the thin-client rule and it is explicitly tolerated.

The Active Terminal Details disclosure includes branch and changed-file buttons that open Source Control. Timeline expansion persists across stream updates. Artifact types follow CLI buckets; remote paths never borrow the editor host’s home directory.
