#!/usr/bin/env bash
# Render docs/PRD.md and docs/ARCH.md beside their sources with artifacts-cli.
# The repository is public: artifacts-cli stamps the rendering device (name, tailnet
# address) and session id into a page unless the source sits under .agents/artifacts/,
# so each source is rendered from such a copy and the HTML carries no device details.
set -euo pipefail
DOCS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ARTIFACTS_NO_LINK_PREVIEWS=1
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/.agents/artifacts"
for doc in PRD ARCH; do
  cp "$DOCS_DIR/$doc.md" "$STAGE/.agents/artifacts/$doc.md"
  artifacts check "$STAGE/.agents/artifacts/$doc.md"
  artifacts render "$STAGE/.agents/artifacts/$doc.md" --out "$DOCS_DIR/$doc.html"
done
