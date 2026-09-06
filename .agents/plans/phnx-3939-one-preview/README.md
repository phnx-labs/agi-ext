# PHNX-3939 — one session preview: evidence

Captures of the shipped sidebar, for the PR and for later comparison.

| File | What it shows |
|---|---|
| `sidebar-before.png` | ext 0.9.364: the header card, "No checklist yet", Refresh. The store had no producer, so every guarded card was skipped. |
| `sidebar-active.png` | After: Focus/Resume, Goal, Request with its fold, Timeline with the live now-line and the earlier counter, Checklist, Files, reply field. |
| `sidebar-stream-degraded.png` | The presentation store has seen no `reset` for the subject's scope — the panel says so and names the command it expects. |
| `sidebar-timeline-unavailable.png` | A harness the CLI cannot fold, with its reason. |

The "after" captures render the REAL webview shell — the CSS and inline script are
extracted verbatim from `src/vscode/agentPanel.vscode.ts` — fed rows projected
through `normalizeActiveSession` from `src/core/testdata/session-rows.fold.json`,
which is the fold prototype's output for four live sessions across three harnesses.
The harness that produced them is `.agents/scratch/render-preview.ts` (scratch,
not committed); the same rows drive the render tests beside the source.

The plan this implements: `~/.agents/artifacts/2026-09-06/agi-sidebar-timeline/plan.html`.
