# PR #62 description draft

## Summary

- Reconcile tracked editor terminals from accepted session-stream reset/upsert/remove facts before status-bar and sidebar refreshes.
- Keep two distinct live sessions claiming one observer terminal ambiguous regardless of row order or `startedAtMs`; retain the registry's current binding until one live claim is removed.
- Exclude `previous: true` rows from live terminal ownership, so B remains bound if historical A returns after removal.
- Track a terminal-selected sidebar subject by the terminal's stable ID across A → B; keep explicit Fleet selection tied to the selected session.
- Remove the local session-state lookup from focus hydration so an awaited file result cannot overwrite a stream-driven binding. Stream reconciliation does not arm label polling.

## Verification

- Focused tests cover B-upsert → A-remove → historical-Previous-A, reset with Previous A plus duplicate B rows, order-independent ambiguity, the real two-tab sidebar reproduction, status identity, and disabled stream-path label polling.
- `bun test src/core/sessionPresentationStore.test.ts src/core/sessionIdHydrate.test.ts src/vscode/agentPanel.subject.test.ts src/vscode/autoLabelHydration.test.ts` — 56 passed, 0 failed.
- `bun test` — 1,871 passed, 6 skipped, 0 failed across 167 files.
- `bun run compile:ext` — passed (`tsc -p ./`).

No VSCodium restart/reload, install, release, or editor action was performed.
