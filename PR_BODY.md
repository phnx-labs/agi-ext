# PHNX-4218: Active Terminal sidebar

Active Terminal now preserves complete filenames in compact path labels, exposes session identity in a persistent Details disclosure, and renders CLI-provided outputs as typed Artifacts. The header shows the optional account slot label with the email on hover. Its short ID copies the full ID through the host clipboard; terminal subjects offer the existing parallel PR’s `agents.setSessionId` command. Focus and Resume use 18px icon buttons.

Files and Artifacts use a tested pure host-side path formatter. Paths stay unchanged for opening and hover text. Owned Claude scratch becomes `scratchpad/<filename>`; other scratch and home paths are compacted, and directory elision never cuts the basename. The eight supplied real scratch paths are covered by tests. PR numbers reuse the existing tested core PR parser. Plans come exclusively from the CLI row’s `planFile`; local PLAN.md reads, the obsolete Plan card and dead recent-files renderer are removed. File and URL rows use native buttons; timeline entries toggle between short and complete text.

The webview syntax, theme and render-order protections remain. CHANGELOG and PRD describe the behavior; `docs/render.sh` regenerated PRD.html and ARCH.html. No owned files from the parallel worker or package.json were changed. No commits, Git writes, installs or GitHub actions were performed.

## Verification

Final full root run, `bun test --timeout 30000` (exit 1):

```text
 1910 pass
 6 skip
 9 fail
 6140 expect() calls
Ran 1925 tests across 172 files. [28.59s]
```

All nine failures originate in `src/vscode/settingsActions.test.ts` while creating fixtures, before their assertions:

```text
error: EROFS: read-only file system, mkdtemp
.../.agents/scratch/settings-actions-...
```

Eight are shared-configuration tests; one is the cloud-dispatch argv test. That source was not changed. The first run also exposed a stale header text-button assertion; it was updated to protect the icons and accessible labels. After final cleanup, all affected-source tests passed:

```text
 58 pass
 0 fail
 217 expect() calls
Ran 58 tests across 4 files. [68.00ms]
```

`cd ui && bun test` (exit 0):

```text
 557 pass
 0 fail
 1433 expect() calls
Ran 557 tests across 51 files. [641.00ms]
```

`bunx tsc --noEmit -p .`: exit 0, no diagnostics.

`bun run lint:dead`: exit 0:

```text
$ knip
Configuration hints (10)
```

The ten configuration hints identify existing redundant entry/ignore patterns; no dead-code findings. `git diff --check` passes. `docs/render.sh` exits 0; it emits provenance metadata and existing architecture-table warnings.

## Visual evidence and limits

Headless Chromium rendered the actual extracted panel HTML with the supplied session c0d7375b, version 2.1.280, gmail/account email, PR #3716, eight real scratch files, one document and CLI planFile. Both 380×1100 images were read and inspected after correcting icon contrast:

- Light: `/tmp/phnx-4218-panel-light.png`
- Dark: `/tmp/phnx-4218-panel-dark.png`
- Reproducible harness: `/tmp/phnx-panel-render.ts`
- HTML: `/tmp/phnx-4218-panel-light.html`, `/tmp/phnx-4218-panel-dark.html`

The requested `.agents/scratch/` location is read-only in this sandbox (`EROFS`); `/tmp` holds the captures instead. Theme palettes are representative VS Code variable sets, not screenshots of an installed editor. The browser harness verified label/email hover, eight files, PR number, Details persistence across snapshots, copy confirmation, timeline expansion/collapse, openPath/openUrl messages, terminal action arguments, and hidden pencil for Fleet subjects. Both rendered DOMs contain:

```text
PASS: label, email hover, eight files, PR number, Details persistence, copy, expansion, openPath, openUrl, terminal action, Fleet pencil hidden
```

The host clipboard and installed extension were not exercised in VS Code. Set Session ID depends on the parallel PR’s command registration; this PR only invokes its ID with `{ terminalId }`. Dispatcher owns independent review, commit, PR delivery and verification of both merged changes.

## Changed files and size

```text
7	0	CHANGELOG.md
18	18	docs/ARCH.html
9	8	docs/PRD.html
2	0	docs/PRD.md
3	0	src/core/sessionPresentationStore.test.ts
4	2	src/core/sessionPresentationStore.ts
36	10	src/vscode/agentPanel.render.test.ts
85	203	src/vscode/agentPanel.vscode.ts
1	1	src/vscode/agentPanel.webview-syntax.test.ts
30	0	src/core/displayPath.ts
26	0	src/core/displayPath.test.ts
Total: +221 / -242, net -21

```

Counts include the two new source/test files and generated docs, exclude this untracked handoff and scratch files.

Proposed commit message:

```text
feat(sidebar): clarify session identity and CLI artifacts (PHNX-4218)
```

## Review fixes

Addressed the independent review of PR #91 without changing the files owned by PR #92, package.json, Git metadata or dependencies.

- The pencil awaits `agents.setSessionId` and catches command failures with a concise warning. A host-routing test executes the actual message and action methods with the repository’s VS Code double, asserts `{ terminalId }`, tests rejection handling and verifies Fleet subjects cannot invoke it.
- Path formatting recognizes Linux and macOS Claude scratch, normalizes Windows separators, and preserves the full basename. Snapshot path options use the existing host-identity resolver to suppress local-home compaction for remote rows. The formatter also accepts an explicit host home; current normalized CLI rows supply no home field, so remote absolute paths remain un-tilded.
- Details restores the clickable branch and changed-file pill through the existing Source Control message wiring and CSS. Removed unused worktree-row CSS; CHANGELOG records the move.
- Artifact types map directly from CLI buckets to ARTIFACT, PLAN, REPORT and DOC. PR and ticket behavior is unchanged.
- Timeline buttons contain only phrasing content. Expansion is persisted in webview state by session ID, timestamp and source, so a step’s changing text does not reset expansion.
- Updated PRD and rendered it with `docs/render.sh`; unchanged ARCH rendering was restored to avoid a provenance-only diff.

Verification against the review-fix working tree:

```text
bun test --timeout 30000: 1916 pass, 6 skip, 9 fail (1931 tests / 172 files)
cd ui && bun test: 557 pass, 0 fail (557 tests / 51 files)
bunx tsc --noEmit -p .: exit 0
bun run lint:dead: exit 0; 10 existing configuration hints, no dead-code findings
bun test src/vscode/agentPanel.render.test.ts src/vscode/agentPanel.webview-syntax.test.ts:
  27 pass, 0 fail
git diff --check: exit 0
```

The nine full-suite failures remain fixture creation errors in unchanged `settingsActions.test.ts`: `EROFS: read-only file system, mkdtemp` under the repository’s `.agents/scratch/`. They occur before assertions.

Re-ran `/tmp/phnx-panel-render.ts`. Both rendered DOMs report:

```text
PASS: label, email hover, eight files, PR number, Details persistence, branch, dirty count, SCM actions, REPORT bucket, copy, expansion persistence, valid timeline HTML, openPath, openUrl, terminal action, Fleet pencil hidden
```

Inspected both regenerated screenshots: `/tmp/phnx-4218-panel-light.png` and `/tmp/phnx-4218-panel-dark.png`. The snap launcher failed to create a DBus scope; the installed Chromium binary rendered successfully with an explicit bounded temporary profile. It could read `/tmp`, so copying HTML elsewhere was unnecessary. These are representative theme renders of the actual webview template, not installed-editor captures. The host-routing test covers command invocation; running #92’s actual command inside VS Code remains dispatcher verification after #92 merges.

`git diff --stat` versus HEAD (excludes untracked PR_BODY.md):

```text
 CHANGELOG.md                         |  4 ++++
 docs/PRD.html                        | 15 ++++++------
 docs/PRD.md                          |  2 ++
 src/core/displayPath.test.ts         | 17 ++++++++++++++
 src/core/displayPath.ts              | 11 ++++++---
 src/vscode/agentPanel.render.test.ts | 41 +++++++++++++++++++++++++++++++--
 src/vscode/agentPanel.vscode.ts      | 44 +++++++++++++++++++++---------------
 7 files changed, 104 insertions(+), 30 deletions(-)
```

Delivery stage: review fixes implemented and verified in the worktree; no commit, push, PR edit, merge, install or release performed. Dispatcher owns delivery.
