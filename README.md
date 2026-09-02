# Agents

Orchestrate Claude, Codex, Antigravity, and Cursor in parallel — from one IDE. Open source. Free.

Technical design: [AGI EXT architecture](docs/README.md).

Turn your editor into a command center for orchestrating Claude, Codex, Antigravity, and Cursor in parallel. Each agent runs as a full-screen editor tab. Each agent can spawn sub-agents. You orchestrate — approving plans, monitoring execution, shipping faster.

## Why an IAE?

Text editors became IDEs when coding got complex. Now that AI agents do the coding, your environment needs to evolve again. When you're running 10+ orchestrators each spinning 10+ agents, terminals and TUIs collapse. You need an environment built for that scale.

This extension turns your IDE into an IAE:

- **Full-screen terminals** - Agents run as editor tabs, not buried panels. See your code and agent side-by-side.
- **Session persistence** - Close VS Code, reopen it, your agent tabs come back exactly where you left off.
- **Approval gates** - You approve plans before agents execute. Control without bottleneck.
- **Keyboard-first** - 12+ shortcuts for spawning, switching, labeling, and reviewing agents. No mouse needed.

## Workflow: Task, Plan, Approve

1. **Task** - Describe what you need with `/swarm` inside the IDE.
2. **Plan** - The orchestrator drafts a distribution: who codes, who debugs, who researches.
3. **Approve** - You gate execution. Agents run only after your approval.

## Quick Start

1. Install the extension from VS Code Marketplace
2. Press `Cmd+Shift+A` to spawn your first agent
3. Open the Dashboard (`Cmd+Shift+F`) to configure auto-start

### agents-dbg Mac App

Install the private Mac app through the Homebrew tap:

```bash
brew install --cask muqsitnawaz/tap/agents-dbg
```

The public install script uses that tap and launches the installed app:

```bash
curl -fsSL https://raw.githubusercontent.com/phnx-labs/agents-cli/main/scripts/install-agents-dbg.sh | sh
```

## Navigation

| Shortcut | Action |
| --- | --- |
| `Cmd+Shift+A` | Spawn a new agent through agi-cli automatic routing |
| `Cmd+Shift+L` | Label agent by task |
| `Cmd+Shift+C` | Continue agent from selection |
| `Cmd+Shift+X` | Clear and restart agent |
| `Cmd+Shift+D` | Dispatch a task |
| `Cmd+Shift+F` | Open Dashboard (configure) |
| `Cmd+Shift+I` | Focus agent (quick picker) |
| `Cmd+Shift+H` | Horizontal split (tmux-style) |
| `Cmd+Shift+V` | Vertical split (tmux-style) |

## Features

### Agent Terminals

Spawn any agent as a full-screen editor tab. Built-in support for Claude Code, Codex, Antigravity, OpenCode, and Cursor. Add custom agents through settings.

**Where a new agent runs** is `agents.launch.defaultTarget`: `auto` (default — agents-cli picks the device), `local` (this machine), or `ask` (prompt every time). Under `auto`, mark your compute boxes once with `agents devices role <name> worker` and every `Agents: New <Harness>` rotates over those workers instead of the machine you are sitting at. The device and the version/account are both chosen for you — the account by balanced rotation, which skips signed-out and rate-limited ones — so the command opens an agent without a prompt. `Agents: New <Harness> (Pick Host)` is the explicit route: it asks for the device first and then shows that device's versions/accounts to choose from. `Agents: New <Harness> (Auto)` chooses both automatically, ignoring the configured target. `Agents: New <Harness> (Pick Project)` never asks for a host — it picks the device and account automatically, like `(Auto)` — but first shows a quickpick of your projects and lands the agent in the chosen project's path on the auto-selected worker.

### Session Persistence

Every open agent terminal is fully restorable. Session ID, icon, and custom labels are saved to disk in real-time. VS Code crashes? Restart? All your agent tabs come back exactly as they were.

Automatic tab titles follow the canonical session name from the fleet stream.
A remote tab may briefly show its first meaningful prompt, then replaces it when
the harness generates a name or the session is renamed; a label set with
`Cmd+Shift+L` remains authoritative.

### Task Management

- **Labels** - Tag agents by task (`Cmd+Shift+L`). Status bar shows active agent and label.
- **Tasks** - Renders tasks returned by agi-cli; the extension does not parse task files or query trackers itself.
- **Session history** - Browse CLI-provided sessions from the dashboard and resume through `agents sessions resume`.
- **Fork a session** - `Agents: Fork`, `Agents: Fork (Recap)`, and `Agents: Fork (Pick Host)` delegate the copy and identity semantics to `agents sessions fork <id>`, which resolves the source across the fleet and launches a recap-seeded same-harness sibling. The original is left untouched; Fork and Fork (Recap) behave identically since the verb is always recap-seeded.
- **Fork pairs in the Recap ledger** - a fork and the session it came from finish as two rows that share no id. AGI EXT remembers the edge and reunites them: one side-by-side row in Recap, parent on the left, fork on the right, each stamped with the machine it ran on and its own duration/cost/PR.
- **Agents: Resume** - The picker performs one bounded CLI listing when opened, then sends only the chosen canonical IDs to `agents sessions resume <id> --vscodium`.
- **Resume variants** - `Agents: Resume (Pick Session)` lists only abandoned sessions — detached, backgrounded, parked, or idle, nothing currently open anywhere — and resumes each on the device it was created on. `Agents: Resume (Pick Host)` reopens the active tab's session on a device you pick (same harness, same version). `Agents: Resume (Pick Harness)` continues the active tab's session in a different harness on the same device, replaying the transcript through the universal `/continue` flow. `Agents: Resume (Best Profile)` rotates the active tab to the signed-in account with the most usage headroom (`Cmd+Shift+Alt+J`).

### Active Session sidebar

The activity-bar sidebar is a work brief for the focused agent: the original
request and attachments, runtime and token usage, checklist progress, created
plans/artifacts, ticket and PR links, spawned-team summary, and current activity.
Recent files are available as a compact disclosure under Deliverables. Generic
slash-command buttons, saved prompts, duplicate worktree/CWD navigation, and the
separate Issues view are deliberately absent; those belong to their owning
command, dashboard, Source Control, or tracker surfaces. All live facts ride the
CLI session stream, so switching tabs does not start a transcript scan or poll.

### Fleet

The dashboard's mission control. Fleet opens on the session list with
**All · Active · Idle · Blocked · Favorites**, search, sort, and a header-level
**Dispatch** action. The status chips and Group by Status share the same
CLI-projected phase/attention taxonomy; grouping by Project, Device, Status, or
None re-buckets the entire list, including Previous sessions. Previous history
defaults to at most 50 sessions active in the last seven days and pages older
history ten rows at a time; bulk Resume applies only to shown resumable rows.

A **Project** control sits beside Group and Sort: a searchable list of every project
in view with its session count, plus **All projects** and **Unassigned** as
first-class picks. Choosing one scopes the rows *and* the status-chip counts to it,
and the pick is remembered. A session's project comes from the hints its stream row
already carries — working directory or worktree path, the CLI's repo word, the PR's
`owner/repo` slug, then branch, worktree slug, or team — so cloud and remote runs are
attributed without a local checkout. Runs that genuinely have no repo land in a
labeled **Unassigned** group that states why (“cloud & no-repo runs — no cwd to
match”) instead of an empty header, with **+ assign project** on each row and
**assign all** on the group header to file them by hand.

Each row uses the harness logo without repeating its name. Expanding it shows the
CLI-indexed full first user turn as **Your request** (with **See more** for long
requests), or labels an older CLI's topic fallback honestly as **Request summary**.
Ended-session timing reads “Ran … · ended … ago” with the absolute range on hover,
and names its device once as “Runs on …”. Ticket, PR, and repository pills navigate;
branch pills copy. The single compact **Resume** targets the owning device, while
right-clicking it offers **Resume on a different device…** from the already-loaded
fleet roster; that path delegates transcript transport and liveness to
`agents sessions migrate`, then focuses the target in the same editor terminal.
The left navigation and right detail panel start closed; selecting a session opens
its detail in place. Background/headless runs remain hidden by default in the agent
feed; use the **Background** toggle when you need them.

**Needs you** projects the CLI feed's canonical attention ledger. Cards retain
the exact choices and source; answered items leave the count immediately while
the activity lane keeps a compact resolution receipt. The extension does not
inspect transcripts or independently poll GitHub to decide what needs a person.

Agent cards surface outputs such as PRs, spawned teams, created tickets, and plan
artifacts. `.html` and `ref-*.md` plans detected in session output, worktree
files, or attachments appear as one-click preview chips. Screenshots and other
session attachments appear as thumbnail artifacts that click through to the host
preview. The expanded project and host sidebar can be resized by dragging its
right edge.

Selecting a session opens a detail card at parity with the CLI's `agents sessions`
picker: the version · model · account header, timing and cost, per-file changes,
the tool mix, tests, errors, and PR/ticket links. It is fetched once per selection
via a one-shot `agents sessions preview --json` — the CLI computes every field; the
extension only renders it, never parsing a transcript itself.

### Foreman Voice Orb

Talk to your fleet. Tap the orb in the dashboard and ask "what's running?", "what's left this cycle?", or "dispatch RUSH-557 to the cloud" — a realtime voice model answers out loud with live floor state, and it can dispatch tickets, spawn agents, and file Linear issues for you. Tap to talk, tap again to stop, or press-and-hold to talk only while pressed. A silent-mode toggle under the orb switches replies to text-only transcript.

### AI Git Commits

Generate commit messages from staged changes with `Cmd+Shift+G`. Learns from your commit style, then stages, commits, and pushes in one action.

### Additional Features

- **Auto-start** - Configure which agents launch when VS Code opens
- **Default models** - Set preferred model per agent type
- **Shell terminals** - Spawn plain shells alongside agents (`Cmd+Shift+S`)
- **Reader** - Notion-style `.md` editor (TipTap) plus sandboxed HTML preview for artifacts-cli pages; Command Palette: `Agents: Reader (Enable)` / `Agents: Reader (Disable)`
- **Notifications** - Native macOS notifications when agents need attention

## For Teams

- Shared dashboard keeps approvals and assignments visible.
- Consistent agent distribution prevents over- or under-staffing tasks.
- Approval gates make it easy for leads to review before code runs.

## Requirements

- VS Code or Cursor
- Agent CLIs installed (`claude`, `codex`, `antigravity`, `cursor-agent`, `opencode`)
- OpenAI API key (optional, for commit generation and the Foreman voice orb)
- ffmpeg (optional, for the Foreman voice orb: `brew install ffmpeg`)

## Related Packages

- [@swarmify/agents-cli](https://www.npmjs.com/package/@swarmify/agents-cli) - Moved to its own repository

## License

MIT
