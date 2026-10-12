# 0.9.362 — Fleet view no longer opens with a blank detail rail

**Ticket:** PHNX-3938 (folds in PHNX-3592, "empty right panel")
**Merged:** `3c37dc2` fix + `981c62e` review follow-up

## What shipped

The right-hand detail rail no longer paints a blank ~⅓-width column when the
extension opens. `rightOpen` is a persisted layout pref that is re-saved `true`
every time a session detail opens, but the selection itself is not persisted — so
on the next open the rail restored open with nothing selected and rendered the
"Select an agent or issue…" placeholder over dead space.

The rail is now gated on `rightOpen` **and** an actual selection
(`center === 'host' ? selectedHostId : selectedFloorAgent`). On open the session
list uses the full width; clicking a session still opens the rail exactly as
before. The unreachable empty placeholder was removed.

## Before / after

| | |
|---|---|
| **Before** — blank right column on every open | `before-empty-rail.png` |
| **After** — full-width session list (verified on the installed 0.9.362 build in VS Code) | `after-full-width.jpg` |

The "after" shot is the real packaged `.vsix` installed into VS Code, not a preview
harness — the Fleet list spans the full width with no empty detail column.

## Verification

- `bun test` (ext) and `cd ui && bun test` (ui) green on `main`.
- Built `swarm-ext-0.9.362.vsix` (node-pty native verified), installed into VS Code,
  opened the Fleet view — no empty rail, list full-width.
