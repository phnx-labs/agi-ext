# AGI EXT

The VS Code / VSCodium extension for [agents-cli](https://github.com/phnx-labs/agi-cli):
agent terminals as editor tabs, the Fleet dashboard, dispatch, and the
`swarm-ext://` endpoint. This repo is ONLY the extension. The CLI, daemon,
session index, and every mechanism live in agi-cli.

> Publisher identity is FROZEN: publisher `swarmify`, name `swarm-ext`
> (`package.json`). Never change either — it would orphan the Marketplace
> listing, and `swarmify.swarm-ext` is the authority in the `swarm-ext://` URI
> the CLI emits. Display name ("Agents"), dashboard name (AGI EXT), and
> everything else may change freely.

## The one architecture rule — thin client, single stream

Staff-level component and data-flow documentation lives in [`docs/`](docs/README.md).
Keep extension-owned design here; the CLI repository documents only the cross-repository
ownership contract.

agents-cli owns all state and all mechanisms: sessions, devices, accounts,
teams, watchdog, routines, lifecycle, scheduling. This extension is a
presentation layer. Concretely:

1. **One subprocess owns live state.** The elected leader window spawns exactly
   one `agents feed watch --json` child (`src/monitor/sessionCliStream.ts`);
   every window and tab reads its broadcast projection
   (`src/core/sessionPresentationStore.ts`). No other code may poll session
   state. If a field you need is missing from the stream, add it to the CLI's
   `SessionWatchRow` (backfill from the index, the way `version` landed) — do
   NOT add a side-channel fetch here. That side channel is how the 2026-08-25
   CPU incident happened (agi-cli#3019, RUSH-3184).
2. **User actions are one-shot CLI verbs.** Resume, fork, stop, dispatch,
   merge: build the command with the owning CLI noun, run it once per user
   action, done. No retries-on-a-timer, no caches of CLI output beyond a
   short-TTL in-flight guard.
3. **The extension must never own**: an action scheduler or timer that acts
   (spawn/resume/kill/inject/rotate — the CLI daemon is the only scheduler),
   a transcript parser or watcher, a lifecycle/readiness classifier, a
   candidate/session-id cache, or a raw agents-config reader.
4. **Fail loud.** A missing CLI noun is an upgrade error, never a filesystem
   fallback.

Launch location follows explicit user intent. Ordinary New, Auto, and Pick Host
commands preserve the active workspace as the portable `--cwd`, including when
that path is a monorepo root shared by several managed projects. Only the explicit
Pick Project command emits `--project` and lets the CLI resolve that project's
configured path. Never derive an ordinary launch target from `agents projects
view <cwd>`: that command is a containment attribution lookup, and a shared root
can belong to multiple child projects.

The Sessions dashboard follows that same stream contract. Its full first-user
request comes from `SessionWatchRow.firstUserMessage`; status filters and grouping
use only the projected phase/attention fields; alternate-device Resume reuses the
already-loaded device roster and the CLI's one-shot migration/recovery verbs. Never fill any
of these with a transcript read, lifecycle probe, or a second device/session fetch.

Project attribution obeys the same rule. `sessionProjects.ts` resolves a session's
project ONLY from hints the projected row already carries — cwd/worktree path first,
then the CLI's repo word, the PR's `owner/repo` slug, and finally branch / worktree
slug / team, matched with the shared `matchLinearProject` — whose containment fallback
is word-wise, so a repo that merely spells a short project name inside another word
("crush-cli" vs "Rush") is never filed under it. Weak hints bind only to a
project already established by another row or by the managed-projects roster the pane
holds; a prompt/label is never mined. A session no hint can attribute is `''` — the
labeled **Unassigned** bucket with its reason — never a blank header, and never a
guess. Do not add a fetch, a transcript read, or a repo probe to fill it: put the
missing fact on the CLI row, or let the user assign it by hand (a local presentation
override, like pinned favorites).

The `agentsPanel.terminal` activity-bar view is the focused session's work card,
not a command catalog or tracker browser. It leads with a clean **◈ Goal**, live
**Progress** checkpoints, and an **always-on Checklist** (`goal` / `checkpoints` /
`summaryChecklist` + `summaryState` on the session row, PHNX-3939), then the raw
**Request**/attachments demoted into a collapsible section, runtime and tokens,
artifacts/delivery links, delegated-team summary, and current activity — all from
the normalized session stream. Keep recent files secondary. The Goal/Progress/
Checklist fill is a synchronous field copy off the warm `sessionPresentationStore`
(Goal falls back to topic, Checklist to the live TodoWrite list) — never an `await`,
fetch, or lazy enrich on tab-switch; that is the owner's zero-overhead guarantee.
Do not reintroduce Quick Actions, Quick Prompts, worktree/CWD navigation, an Issues
view, or a filesystem/transcript fallback to fill missing card fields; add missing
facts to the CLI row instead.

## Known debt — scheduled for deletion, do NOT extend

These violate the rule above. They exist; they are tracked; touching one means
deleting it or shrinking it, never adding to it.

| Path | Violation | Fate |
|---|---|---|
| `src/vscode/remoteSessions.vscode.ts` `fetchRemoteSessionLabelSource` | label/topic are already on the stream | DELETE now |
| `src/vscode/prewarm.vscode.ts`, `src/core/prewarm.simple.ts` | `prewarm.vscode.ts` no longer spawns harness binaries — it is pure crash-recovery mapping storage, and its storm bug (machine-global recovery state → multi-window resume storm) is FIXED: state is now per-workspace `workspaceState` (PHNX-3768). `prewarm.simple.ts` still `spawn`s `opencode session list` on every OpenCode tab open (the candidate-cache violation). Both still slated for removal once the CLI daemon owns restore | DELETE |
| `src/vscode/settings.vscode.ts` `watchForPlan` | polls `agents sessions <id> --json` for the plan (rate-bounded via backoff in PHNX-3817, but still a side-channel session-state fetch) | DELETE once the CLI carries `plan` on the feed-watch `SessionWatchRow` (PHNX-3819) |
| `src/monitor/sessionParse.ts` | parses raw `~/.claude/projects` transcripts | replace with CLI-provided fields |
| `src/vscode/terminalReadiness.ts` recursive `fs.watch` on transcript roots | transcript watcher | replace with a daemon readiness signal |
| `src/monitor/readinessDetector.ts` | ext-invented lifecycle classifier (ps/pgrep loops) | move the signal into the CLI daemon, project it on the stream |
| `src/vscode/agentPanel.vscode.ts` `buildSnapshot` | the transcript re-parse + `agents sessions --include tools` / `agents teams status` spawns are gone (PHNX-3517: renders synchronously from the warm `sessionPresentationStore` stream) | remaining: `messageCount` + `recentFiles` are not on the stream, so they're dropped from the instant paint — bring them back as a lazy enrich of the active tab only (`fetchSessionPreview`), never on tab-switch |
| `src/vscode/foreman.sources.ts` `runJson` | second agents-bin resolver bypassing `src/core/agentsBin.ts` | fold into `agentsBin.ts` |
| gemini anywhere (`src/core/agents.ts` `newGemini`, prewarm config) | harness is hard-deprecated in the CLI | DELETE |

## Layout

```
src/core       Presentation-only pure functions (no vscode import)
src/monitor    Elected stream leader + cross-window broadcast
src/vscode     VS Code commands, terminals, URI endpoint, webview bridge
ui/settings    React dashboard (webview)
ui/editor      Custom document viewers
app/           agents-dbg Electron debug app
assets/ icons/ Extension artwork
scripts/       build.sh / install.sh / release.sh — the ONLY entry points
```

## Build, test, release — scripts are the contract

```bash
bun install
bun run compile:ext        # typecheck + bundle
bun test                   # suite (vscode double: src/testing/vscodeDouble.ts)

scripts/build.sh <version>              # packaged .vsix
scripts/install.sh                      # local dev install
scripts/release.sh <x.y.z> [--confirm]  # Marketplace + Open VSX (dry-run without --confirm)
```

Never hand-roll `vsce publish` / `ovsx publish` — `release.sh` owns version
stamping, gates, and self-routing to the box holding the `vs-marketplace`
secrets bundle (`--device <name>` pins it, `--here` refuses to route).

Tests sit beside source and exercise real command boundaries — no mocking
beyond the shared `vscodeDouble` (a hand-rolled partial double breaks OTHER
files in the same bun run; `src/testing/vscodeDouble.test.ts` enforces this).

## Conventions

- `AGENTS.md` (this file) is canonical; `CLAUDE.md` is a symlink to it. Edit
  AGENTS.md only.
- Every user-visible change updates `CHANGELOG.md` and, when behavior changes,
  this file and `README.md`.
- Closing an agent tab tears the agent down via `agents sessions stop <id>` —
  only on a real user close (`TerminalExitReason.User`); reload/restore must
  not kill sessions (`src/vscode/terminalReadiness.ts`).
- Worktree + PR for every change; never commit to `main` directly.
