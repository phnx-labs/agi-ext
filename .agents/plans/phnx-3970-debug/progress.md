# PHNX-3970 execution checklist

- [x] Inspect the owner screenshot from zion.
- [x] Read the existing ticket and PR, including review and merge state.
- [x] Trace workspace selection, project inference, launch command, CLI resolution, and installed bundle.
- [x] Verify the regression introduction with its source diff and coverage gap.
- [x] Converge independent read-only diagnosis (Codex confirmed; Claude authentication unavailable).
- [x] Refresh the existing fix against current main and cover any confirmed gaps.
- [x] Run launch regression checks and extension compile (135 focused pass; full branch/main same nine failures).
- [x] Render and inspect the visual diagnosis and plan, then open it on zion (1440px dark/light, 390px mobile; no overflow or console errors).
- [ ] Obtain a non-author review of the final patch and resolve findings.
- [ ] Rebase-merge and release through repository scripts after the requested plan review.
- [ ] Verify the installed, active extension's real root and nested launch flows.

Current stage: owner approved delivery; implementation verified, independent final review and release next.
