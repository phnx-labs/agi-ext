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
- **One-shot verbs**: launch, resume, fork, stop, answer are each one
  `agents …` command, run once per gesture. The CLI daemon is the only scheduler.

## Layout

```
src/core     pure presentation logic, no vscode import
src/monitor  stream leader, demand gate, broadcast, readiness (debt)
src/vscode   commands, terminals, the two sidebars, URI handler
src/shared   pure session presentation the sidebars' webview scripts reuse, e.g. sessionCards.ts
ui/editor    Reader custom editors (React)
scripts/     build.sh / install.sh / release.sh: the only entry points
```

## Entry points

`bun test --timeout 30000` (suite; ui/ from `ui/`) · `bun run lint:dead` (knip, wired into
`scripts/build.sh`) · `bun scripts/gen-docs.ts` (regenerates `docs/reference.{html,json}`
from `package.json` and `ui/`; `--check`, run by `scripts/build.sh` and the suite, fails while
they are stale) · `scripts/build.sh <ver>` (VSIX) · `scripts/install.sh` (local) ·
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
  `unavailable` reason; it never fakes an empty card. One named exception: a timeline filter
  too large for every row (agent messages, tool calls, reasoning) is one
  `sessions <id> --include <role> --json` call on an explicit click (the chip, or
  Refresh once newer activity arrives), never on selection or a timer, and only for a
  session on this machine (`loadTimelineFilter`). A second: clicking an artifact the row
  names for a remote session copies that one file into
  `~/.agents/.cache/remote-artifacts/<device>/` with one `agents ssh <device> --argv`
  call (`localArtifactUri`); any other path, or one that leaves that folder, is refused.
  The Project panel opens an artifact through the same path: `openListedArtifact`
  (`src/vscode/sessionCardActions.ts`) finds the row by session id AND host and copies only
  an artifact that row lists. Nothing loads on selection.
  A third: clicking a ticket in the Project panel's Tickets tab reads that one ticket with
  `linear tasks <ID> --json` (`ProjectPanelController.ticketDetail`), on the click only, never
  on a timer; its Comment button is one `linear update <ID> --comment=<text>` argv.
  A fourth: the Project panel's goal lines are one `linear goals --json` read when the panel
  shows (at most once a minute) or on Refresh (`ProjectView.loadGoals`); never per tab or per click.
  A fifth: merging a PR reads that one PR (`agents projects prs <name> --json --repo R
  --number N`) on the click for its head commit and whether you may bypass protection
  (`src/vscode/prMerge.vscode.ts`). A Review row's Merge is one click with the Settings
  method after an in-page "Undo · 5" (`mergeNow`), and only at the head commit the list read; the sidebar's Merge ▾ reads again after its
  dialog (`mergeWithMenu`); `--admin` only after its own warning dialog.
  A sixth: ticket tiles show the title and state a Linear read in this window already returned
  (`src/core/ticketFaces.ts`); the Issues read (`linear tasks --project <linear> --json`)
  also runs when Sessions shows, under the same once-a-minute cache. A tile never reads Linear.
  A seventh: the Project panel's project menu is one `agents projects list --json` read when
  it opens (the same list, cached a minute in `src/vscode/projectRegistry.vscode.ts`, also
  feeds the repository-path stopgap when Sessions or the resume picker first draws); Review reads `agents projects prs list <name> --json --repo <r>` per repository in
  parallel, drawn as each answers.
  The reply box's mic (and the Lead's, which reuses it) is the one place the extension runs
  tools that are not the CLI: on the click, `ffmpeg` records the default microphone and `whisper-cli` transcribes on this machine
  (`src/vscode/dictation.vscode.ts`); nothing is sent anywhere.
  A request's pasted images are looked up by file name in this machine's
  `~/.agents/.history/attachments/`, where the CLI saved them.
  An eighth: ⌘K's artifact index (`src/vscode/searchPalette.vscode.ts`) runs
  `artifacts list --json`, reads the first 512 KB of the rendered HTML beside each source
  (title and `agents://session/<id>`; re-read only on a new mtime) and `sessions artifacts <id> --json`
  for this machine's newest sessions, in the background when the picker opens, at most
  once a minute; the picker never waits on it.
  A ninth: Settings > Devices is one `agents devices list --json` read when Settings shows
  (at most once a minute), on Refresh, and after a checkbox or star; each checkbox or star is
  one `agents devices enable|disable` or `agents devices config <name> auto-launch.preferred`
  argv (`deviceSettingArgv`, `src/core/panelSettings.ts`). It draws the CLI's `autoSkip`; it
  never decides placement.
- Both sidebars patch their content in place on every update (`patchChildren`, `PATCH_SCRIPT`
  in `src/shared/sessionCards.ts`); the Active Session sidebar builds the reply box once; reassigning `root.innerHTML`
  per update made it jitter and erased what the owner was typing. A reused node keeps its
  listeners, so bindings go through `bindOnce` and read their data-* values on click.
  A card carries `data-key` (pairs it with its own node) and `data-h` (an unchanged hash is
  not patched); every thumbnail is `<img data-thumb>` filled from `THUMB_SCRIPT`'s 480 px
  cache, never a full-size `src` (the flicker in the 2026-10-13 video;
  `sessionCards.patch.test.ts` runs the real patch in happy-dom).
- The Active Session sidebar is the one preview: a Project panel session click sets its
  subject (`setAgentPanelSubjectFromProject`), brings the session's tab forward only when that
  tab is in this window, and spawns or resumes nothing. No per-selection fetch.
- Launch composition lives in `buildAgentLaunchCommand` (`src/core/agents.ts`) and
  `harnessLaunchRegistrations` (`src/core/launchTarget.ts`): `--cwd` is the exact open
  workspace, emitted once for every variant except Pick Project, which emits `--project`;
  the `harness@` account picker never combines with `--strategy` or a pinned version; the
  extension never scores devices or accounts and never resolves a target through
  `agents projects view <cwd>`.
- The front tab and every tab number come from `src/vscode/frontTab.vscode.ts`: both tab
  events feed `onDidChangeFrontTab`, and a tab maps to its terminal by identity
  (`assignTabs`, `src/core/tabIndex.ts`), never by label alone.
- A session has one name, `streamTitle` (`src/core/projectPanel.ts`), on its tab, card,
  status bar and the Active Session sidebar. The extension generates no title and reports
  none back to the CLI; Rename Session types Claude's own `/rename`.
- Terminal rebind runs only on pushed reset/row facts, scoped to observer device and host;
  start time is not ownership; a `previous: true` row cannot reclaim a tab
  (`src/vscode/terminals.vscode.ts`, `src/core/remoteSessions.ts`).
- The Lead is agents-cli's process; the extension is a thin client (`src/core/lead.ts`,
  `src/vscode/lead.vscode.ts`, `src/vscode/leadTab.vscode.ts`). Ask and Confirm are each one
  `agents lead ask|confirm --json` child, one turn at a time per window, killed after 120 s
  of silence or 15 min, or when the window closes; Esc never stops a turn.
  The Lead tab reads `agents lead history|status --json` when it opens and on Refresh, never
  on a timer. `~/.agents/lead/surface.json` is shared with FastWispr: while it says
  `bubble`, ⌥Space is FastWispr's (`agents.lead.bubble` gates the keybinding); the extension
  never creates `~/.agents/lead` just to watch it. A held ⌥Space is one press (`PressGate`),
  and the Lead's mic never takes over the reply box's recording (`nextMic`,
  a pure transition in `src/core/leadInput.ts`). Tests run
  against the fake CLI in `src/core/testdata/lead-bin/agents`.
- Closing a tab sends `agents ps stop <id>` only on `TerminalExitReason.User`
  (`src/vscode/terminalReadiness.ts`); reload and restore never kill a session.
- Your move is only an open ask, stall or failure (`sessionStateOf`, `ballOf` in
  `src/shared/sessionState.ts`); a finished turn that asked nothing is Idle. Asks order by
  the CLI's attention `urgency` (`urgencyOf`; absent reads normal), then longest wait, then
  `ATTENTION_KIND_RANK`; the extension never computes urgency. A stall is a CLI signal,
  `FloorPhase` has no `stalled` member. Idle plus a non-empty feed `pending` is Waiting (the
  agent's ball, never Your move); `subAgentCount` is cumulative and never decides liveness.
- A card answers an ask with one `agents feed answer <attention.key> --choice|--text … --json`
  after a 5 s Undo in the page (`answerArgv`, `src/core/projectPanel.ts`), only for a key the
  stream shows open. The extension posts no notifications of its own; banners are the AGI Menu's.
- Project attribution is the CLI's own `confirmedProject` (`projectSessions`,
  `src/core/projectPanel.ts`); the extension never guesses a project from a cwd. One stopgap
  until agents-cli aliases ship: a row whose checkout is one of the project's own repository
  paths is listed too, only when its `confirmedProject` is empty or no registered project's
  name (`projectFallback`); a session another live project claims stays there. The Project
  panel and the resume picker apply the same rule. Delete it when the feed resolves old names.
- One shell quoter (`shellQuote`, `src/core/shellQuote.ts`) and one binary resolver
  and exec path for `agents` and the standalone `sessions`/`secrets` it installs
  (`resolveAgentsBin`, `runCliArgs`, `runAgents`, `src/core/agentsBin.ts`).
- Harness ids, labels, prefixes derive from `src/core/agents.cli.ts` and `PRESENTED_AGENTS`
  in `src/core/agents.ts`; no hand-written list anywhere else, `ui/editor` included.
- `src/core` never imports `vscode`; the only test double is `src/testing/vscodeDouble.ts`.
- A missing CLI noun is an upgrade error, never a filesystem fallback.

## Design

The owner runs hundreds of sessions and catches up by glancing. Every surface answers "what is
going on, where, and what came out of it" in one look; text explains only what a picture can't.

- **Glance, then detail, with nothing moving.** A card always shows the same preview: title,
  a status pill (a question's wait ticking in it), where it runs, the question or the agent's
  latest words in two lines, previews of images, and chips with each service's own mark.
  Hover only reveals icons; a card never grows under the pointer (owner video, 2026-10-12).
  The question opens to its full text on a click on it. Everything else a session made lives
  in the Active Session sidebar.
- **Show, don't label.** App icons (VSCodium, Ghostty) plus the workspace name (`agents`,
  `agents-cli`), never "This window" or "Window 2". Thumbnails for images, chips for PRs and
  tickets, a dot-plus-word pill for state (color is never the only signal).
- **Inputs are not outputs.** What the user attached is part of their message and is marked
  "attached". Artifacts are what the agent made: PRs, folders under `.agents/artifacts/`,
  plans, pages, rendered images. A count of edited files is neither.
- **One card style.** Outlined 1 px hairline cards with even gaps; no colored side borders (the
  one exception: the selected card's gold rail, so selection never looks like hover), no
  drop shadows (shadows are for menus, popovers and the floating reply, which sits over the
  panel). Hover shifts tone in place; nothing lifts.
  Gaps inside a card are at most half the gap between cards.
- **Motion only for liveness and arrival.** The Working dot breathes, a question's dot rings
  slowly, and a question that just arrived glows three times; everything stops under
  `prefers-reduced-motion`. Nothing flashes for as long as it waits.
- **Sort, show, group in one ⇅ menu** with checkmarks, as in the AGI Menu. Group headers carry
  the icon, a count and one dot per state, so a folded group still says what is inside.
  Your move (asks · idle) is pinned above every grouping, a question first.
- **A click selects and brings its tab forward; it never resumes.** A card click shows the
  session and fronts its tab when the tab is in this window; switching tabs moves the
  selection back. Anything else is an explicit icon: focus (↗), resume (▶), close (×). The list manages the user's tabs: × closes the tab
  (with Undo; it asks first only when the agent is working or waiting), multi-select closes
  several.
- **Prototype first, with real data.** A visual change starts as a prototype built from the
  live stream and the owner's real sessions, opened for them, rendered and inspected by you,
  before any extension code. Mock data and screenshots you did not look at prove nothing.

## Known debt

The thin-client violations still in the tree are listed with their fate in `docs/ARCH.md`
("Findings"): `watchForPlan`,
`sessionParse.ts`, the transcript `fs.watch`, `readinessDetector.ts`. Touching one means
deleting or shrinking it, never extending it.
Five tests assert on source text (`autoLabelHydration`: stream rebind before the sidebars
refresh; `statusBarIdentity.spawnStorm`: identity only from the store;
`agentPanel.webview-syntax`: the sidebar script parses and uses theme tokens;
`pollTimers.replacement`: no poll timer in the sidebar; `extension.vscode`: resume opens an
editor tab); read what each protects first.

## Conventions

- `AGENTS.md` is canonical; `CLAUDE.md` is a symlink to it. Edit only `AGENTS.md`.
- Worktree under `.agents/worktrees/<slug>/` + PR for every change; never commit to `main`.
- No stubs, no fallbacks, no second scheduler, no mocks beyond `vscodeDouble`.
  A DOM implementation (happy-dom) for running real webview scripts in tests is not a mock.
- Every user-visible change updates `CHANGELOG.md`; a behavior change updates `docs/PRD.md`
  or `docs/ARCH.md` in the same PR, then `docs/render.sh`.
