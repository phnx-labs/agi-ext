## Behavior

Restarting an agent in the same terminal can adopt the new live session without
changing focus. The existing pushed-stream reconciliation already replaces an
established binding once the old claim is removed or marked Previous; this change
publishes the stable shell terminalId so the CLI can make that association, and
preserves the rebound session across reload.

Clear preserves the terminal registry entry and shell identity. It persists the superseded session ids so an old projected row cannot
reclaim the cleared tab, including after reload. New live rows remain subject to observer-device and host
scope, Previous exclusion, and ambiguous-claim rejection. Existing bindings remain
unchanged during a live-claim overlap; unidentified tabs remain unbound.

Add `agents.setSessionId`, “Agents: Set Session ID for Terminal”, accepting
`{ terminalId?: string }` and defaulting to the active agent terminal. The input is
prefilled, uses existing canonicalSessionId/needsSessionIdHydrate validation, and
updates through setSessionId with immediate persistence. Focus and unrelated
facts do not replace a manual binding; a different eligible live session can replace it.

Reload uses the exact persisted terminal-id record before the frozen launch env.
Remove process, transcript, and same-prefix recency recovery from the reload scan.
No new polling, client fetches, transcript reads, or close/stop behavior changes.

## Validation

- `bun test --timeout 30000`: **1908 pass, 6 skip, 9 fail**, 6115 assertions,
  1923 tests / 172 files, 29.35 seconds. All nine failures are EROFS at the existing
  `.agents/scratch` test directory in `src/vscode/settingsActions.test.ts`.
- The affected unmodified settingsActions test file from writable scratch:
  **38 pass, 0 fail**, 56 assertions. This verifies the failures are scratch-path
  restrictions; the required root invocation remains red in this sandbox.
- Targeted binding, hydration, registry, close, and extension-wiring checks:
  **44 pass, 0 fail**, 94 assertions / 5 files.
- `cd ui && bun test`: **557 pass, 0 fail**, 1433 assertions / 51 files.
- `bunx tsc --noEmit -p .`: exit 0, no diagnostics.
- `bun run lint:dead`: exit 0; 10 configuration hints, no dead-code findings.
- `docs/render.sh`: exit 0; regenerated PRD.html and ARCH.html. Existing metadata
  and table-shape warnings remain. `git diff --check`: exit 0.
- Prior independent review requested changes; the fixes below await dispatcher review.

## Remaining verification

Dispatcher: verify a real TUI restart in an editor with the accompanying CLI
terminalId/child-session change. Confirm status bar, sidebar, persisted reload,
manual binding, Clear, and User-only close/stop behavior through the real flow.
No install, release, commit, or remote operation was performed here.

Rendered docs were generated but not visually inspected: local headless Chromium
could not initialize its sandboxed profile, and bounded Firefox captures timed
out. Browser processes started for these checks were stopped or timed out.

## Original PR changed files (before review fixes)

12 implementation/test/documentation files: **340 additions, 163 deletions,
net +177 LOC**, including the new untracked test and excluding this PR body.

- CHANGELOG.md
- docs/ARCH.md, docs/ARCH.html, docs/PRD.html
- package.json
- src/core/remoteAutoLabel.ts
- src/core/sessionIdHydrate.ts
- src/core/sessionPresentationStore.ts
- src/vscode/extension.ts
- src/vscode/foreman.registry.ts
- src/vscode/terminals.vscode.ts
- src/vscode/terminals.binding.test.ts

The parallel worker's src/vscode/agentPanel.vscode.ts is untouched.

Proposed commit: `fix: preserve terminal identity across agent restarts (PHNX-4218)`

Tracking: PHNX-4218


## Review fixes

- Deleted row revisions and the manual revision gate entirely. Each manual Set
  or Clear persists `{ sessionId, replaced }` in the tab's YAML session record,
  accumulating every superseded canonical id across repeated overrides.
- Filter superseded claims per terminal before ambiguity detection in pushed
  stream reconciliation. Re-sent A upserts/resets cannot undo A→B; a new eligible
  live C replaces B and clears the override. Previous, host/observer scoping,
  and two eligible live claims retain their existing rules.
- Exact persisted records are authoritative even when empty. Non-Claude Clear
  survives reload without falling back to frozen `AGENT_SESSION_ID`.
- Replaced the extension source-slice assertion with registry/planner/YAML-store
  behavior checks. Added re-sent old rows, new C, simulated reload, non-Claude
  Clear/reload, and accumulated superseded-id coverage.
- Updated CHANGELOG and ARCH wording and regenerated the documentation HTML.

Verification for review fixes:

- Root `bun test --timeout 30000`: **1908 pass, 6 skip, 9 fail**, 6115 assertions,
  1923 tests across 172 files (29.35 seconds). All nine failures reproduce in
  unchanged `settingsActions.test.ts`: `EROFS` creating `.agents/scratch/settings-actions-*`.
- UI `bun test`: **557 pass, 0 fail**, 1433 assertions, 51 files.
- Targeted binding/hydration/auto-label tests: **27 pass, 0 fail**, 51 assertions.
- TypeScript: exit 0, no diagnostics. Dead-code lint: exit 0, no findings;
  ten existing configuration hints.
- `docs/render.sh` and `git diff --check`: exit 0.

Net diff versus this worktree's HEAD: **11 files changed, 127 insertions(+),
101 deletions(-), net +26 lines**.
`PR_BODY.md` remains untracked and is excluded from `git diff --stat`.
No commit, install, remote request, or edit to `src/vscode/agentPanel.vscode.ts`.
Real editor/TUI behavior remains for the dispatcher to verify.
