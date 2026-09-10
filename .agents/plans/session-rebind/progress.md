# PHNX-3939 session rebind checklist

- [x] Recover the referenced Codex session and separate its completed PR #57 scope.
- [x] Check open PRs, branches, worktrees, and primary-checkout state for duplicate work.
- [x] Fetch `origin/main` and create the linked `fix/session-rebind` worktree.
- [x] Trace CLI stream identity through terminal hydration, status bar, and Active Terminal subject selection.
- [x] Capture live `agents feed watch --json` evidence for the available `SessionWatchRow` ordering fields.
- [x] Add a failing A → B same-terminal regression including a late stale-A event and owner-host isolation.
- [x] Implement the canonical stream-to-terminal rebind and update behavior documentation/changelog.
- [x] Run focused tests, repository compile, and full suite.
- [ ] Commit, push, open the PR, and post PHNX-3939 proof.
- [x] Obtain independent non-author review; resolve findings without merging or releasing.
