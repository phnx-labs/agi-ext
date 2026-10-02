# AGI EXT

The VS Code / VSCodium extension for [agents-cli](https://github.com/phnx-labs/agi-cli).
It turns the editor into an integrated agents environment: every coding agent runs as an
editor tab, the Active Session sidebar shows what the focused agent is doing, and the Fleet
dashboard lists every session on every machine and lets you answer the ones that need you.

The extension is a presentation layer. agents-cli owns every fact and every mechanism; the
extension renders one `agents feed watch --json` stream and turns each gesture into exactly
one CLI verb. That is the whole architecture rule.

Published on the Marketplace and Open VSX as `swarmify.swarm-ext` (display name "Agents").
The publisher and name are frozen: changing either orphans the listing and breaks the
`swarm-ext://` URI authority the CLI emits.

## Docs

- [docs/PRD.md](docs/PRD.md) ([rendered](docs/PRD.html)): what the extension must do and
  how each user journey should feel.
- [docs/ARCH.md](docs/ARCH.md) ([rendered](docs/ARCH.html)): how it works, the measured
  module graph, known debt, and the direction.
- [AGENTS.md](AGENTS.md): the contract for coding agents working in this repo.
- [CHANGELOG.md](CHANGELOG.md): every released version; `scripts/release.sh` requires a
  section for the version it publishes.

Re-render the docs after editing with `docs/render.sh` (needs `artifacts` on PATH).

## Layout

```
src/core       pure presentation logic, no vscode import (launch composition, store, models)
src/monitor    elected stream leader, demand gate, cross-window broadcast
src/vscode     commands, terminals, sidebar, webview bridge, URI handler
src/mcp        watchdog socket bridge and the MCP server it serves by path
src/shared     re-exports the ui/ bundle imports through the @shared alias
ui/settings    Fleet dashboard (React, Vite)
ui/editor      Reader: Markdown editor and HTML viewer
assets/ icons/ extension artwork and the file-icon theme
scripts/       build.sh, install.sh, release.sh: the only entry points
```

## Develop

```bash
bun install
bun run compile:ext          # typecheck + bundle the extension host
bun test --timeout 30000     # the suite; ui/ tests also run from ui/ with `bun test`
bun run lint:dead            # knip; scripts/build.sh runs it before compile
scripts/install.sh           # build a VSIX and install it into the local editor
```

Requires Bun, Node, and an installed `agents` CLI on PATH (the extension reads everything
through it). Tests sit beside their source and exercise real command boundaries; the only
sanctioned double is `src/testing/vscodeDouble.ts`. Agent-integration tests
(`bun run test:agent-integration`) need the `agents` binary and hit it for real.

## Release

```bash
scripts/build.sh <x.y.z>               # packaged .vsix in dist/, version stamp restored on exit
scripts/release.sh <x.y.z>             # dry run
scripts/release.sh <x.y.z> --confirm   # publish to Marketplace + Open VSX
```

`release.sh` routes itself to the machine holding the `vs-marketplace` secrets bundle
(`--device <name>` pins it, `--here` refuses to route) and refuses to publish a version
without a `CHANGELOG.md` section. Never hand-roll `vsce publish` or `ovsx publish`.

## License

MIT
