# AGI EXT

The VS Code / VSCodium extension for agents-cli. This repo is ONLY the extension: the CLI,
daemon, session index, and every mechanism live in agi-cli. The extension is a presentation
layer over one `agents feed watch --json` stream; every user action leaves it as exactly one
CLI verb. Product requirements: `docs/PRD.md`. Architecture, module graph, debt: `docs/ARCH.md`.

> Publisher identity is FROZEN: `publisher: swarmify`, `name: swarm-ext` in `package.json`.
> `swarmify.swarm-ext` is the authority in the `swarm-ext://` URI the CLI emits.

## Core concepts

- **Session**: a harness conversation the CLI indexes, identified by its canonical CLI id.
  A tab has an extension-local terminal id (`CL-<ts>-<n>`) until the stream reveals the session.
- **Stream row** (`SessionWatchRow`): the CLI's projection of one session (phase, label, host,
  request, timeline, files, goal, checklist). Every fact on screen comes from a row.
- **Attention / needs-you**: the CLI's open attention items with the harness's own choices.
  The extension never classifies; membership is `attention.state === 'open'`.
- **Leader and followers**: one elected editor window owns the stream child and broadcasts it
  over a Unix socket; other windows follow. The child exists only while some window demands it.
- **Presentation store**: each window's projection of the stream (rows, attention, activity,
  per-scope reset state). Selectors derive views; it holds no lifecycle logic.
- **Terminal identity**: the registry binds a `vscode.Terminal` to its session from stream
  facts; two live claims on one terminal are ambiguous until the stream removes one.
- **One-shot verbs**: launch, resume, fork, stop, migrate, dispatch, answer are each one
  `agents …` command, run once per gesture. The CLI daemon is the only scheduler.

## Layout

```
src/core     pure presentation logic, no vscode import
src/monitor  stream leader, demand gate, broadcast, readiness (debt)
src/vscode   commands, terminals, sidebar, webview bridge, URI handler
src/mcp      watchdog socket bridge + MCP server loaded by path
src/shared   re-exports ui/ imports through the @shared alias
ui/settings  Fleet dashboard (React); ui/editor  Reader custom editors
app/         agents-dbg Electron shell over the same floor UI
scripts/     build.sh / install.sh / release.sh: the only entry points
```

## Entry points

`bun test --timeout 30000` (suite; ui/ from `ui/`) · `bun run lint:dead` (knip, wired into
`scripts/build.sh`) · `scripts/build.sh <ver>` (VSIX) · `scripts/install.sh` (local) ·
`scripts/release.sh <ver> --confirm` (Marketplace + Open VSX; routes to the box holding the
`vs-marketplace` secrets; needs a CHANGELOG section). Never hand-roll `vsce`/`ovsx publish`.

## Invariants (source of truth in the file named)

- Exactly one `agents feed watch --json` child per machine, spawned by the leader only while
  a window demands it: `MonitorHost` in `src/monitor/host.ts`, `SessionStreamDemand` in
  `src/monitor/sessionDemand.ts` (enforced: `host.demand.test.ts`). The always-on version cost
  31% CPU and leaked ssh fan-out; a side-channel fetch caused the 2026-08-25 CPU incident.
- A reset replaces a scope; an event applies only if its sequence is newer; `hasSeenReset` is
  per scope: `SessionPresentationStore.apply` in `src/core/sessionPresentationStore.ts`.
- A missing field goes onto the CLI's `SessionWatchRow`, never into a client fetch, transcript
  read, or lazy enrich. The sidebar (`src/vscode/agentPanel.vscode.ts`) renders synchronously
  from the store and honestly shows "Waiting for the session stream…" or the CLI's
  `unavailable` reason; it never fakes an empty card.
- Fleet is a list, the sidebar is the one preview: a row click posts `session.select` and
  spawns nothing. No detail rail, no `rightOpen` pref, no per-selection fetch.
- Launch composition lives in `buildAgentLaunchCommand` (`src/core/agents.ts`) and
  `harnessLaunchRegistrations` (`src/core/launchTarget.ts`): `--cwd` is the exact open
  workspace, emitted once for every variant except Pick Project, which emits `--project`;
  the `harness@` account picker never combines with `--strategy` or a pinned version; the
  extension never scores devices or accounts and never resolves a target through
  `agents projects view <cwd>`.
- Terminal rebind runs only on pushed reset/row facts, scoped to observer device and host;
  start time is not ownership; a `previous: true` row cannot reclaim a tab
  (`src/vscode/terminals.vscode.ts`, `src/core/remoteSessions.ts`).
- Closing a tab sends `agents sessions stop <id>` only on `TerminalExitReason.User`
  (`src/vscode/terminalReadiness.ts`); reload and restore never kill a session.
- Needs-you order is `ATTENTION_KIND_RANK` in `ui/settings/components/mission-control/floorModel.ts`;
  a stall is a CLI signal, `FloorPhase` has no `stalled` member.
- Project attribution uses only row hints through `matchLinearProject`
  (`src/shared/linearProjects.ts`); no hint means the labeled Unassigned bucket, never a guess.
- One shell quoter (`shellQuote`, `src/core/deviceDispatchShell.ts`) and one binary resolver
  and exec path (`resolveAgentsBin`, `runAgents`, `src/core/agentsBin.ts`).
- Harness ids, labels, prefixes derive from `src/core/agents.cli.ts` and `PRESENTED_AGENTS`
  in `src/core/agents.ts` through `src/shared/agents.ts`; no hand-written list in `ui/`.
- `src/core` never imports `vscode`; the only test double is `src/testing/vscodeDouble.ts`.
- A missing CLI noun is an upgrade error, never a filesystem fallback.

## Known debt

The thin-client violations still in the tree are listed with their fate in `docs/ARCH.md`
("Findings"): `fetchRemoteSessionLabelSource`, prewarm restore mapping, `watchForPlan`,
`sessionParse.ts`, the transcript `fs.watch`, `readinessDetector.ts`, gemini remnants, the
Foreman OpenAI dependency. Touching one means deleting or shrinking it, never extending it.
Four tests assert on source text (`autoLabelHydration`, `statusBarIdentity.spawnStorm`,
`agentPanel.webview-syntax`, `pollTimers.replacement`); read what each protects first.

## Conventions

- `AGENTS.md` is canonical; `CLAUDE.md` is a symlink to it. Edit only `AGENTS.md`.
- Worktree under `.agents/worktrees/<slug>/` + PR for every change; never commit to `main`.
- No stubs, no fallbacks, no second scheduler, no mocks beyond `vscodeDouble`.
- Every user-visible change updates `CHANGELOG.md`; a behavior change updates `docs/PRD.md`
  or `docs/ARCH.md` in the same PR, then `docs/render.sh`.
