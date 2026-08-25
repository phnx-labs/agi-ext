# AGI EXT architecture

These documents explain how the extension presents agents-cli state and turns user
intent into CLI actions. They are design references, not setup guides or command
catalogues.

1. [Architecture](architecture.md) — ownership, process boundaries, and the extension
   host/webview split.
2. [Session projection](session-projection.md) — the single live stream and cross-window
   presentation model.
3. [Terminal lifecycle](terminal-lifecycle.md) — editor tabs, persistence, restoration,
   and user-driven actions.
4. [Fleet dashboard](fleet-dashboard.md) — how CLI-owned fleet and attention state become
   a visual control surface.

The owning CLI mechanisms are documented in the
[agents-cli architecture](https://github.com/phnx-labs/agi-cli/tree/main/cli/docs).

