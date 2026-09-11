#!/usr/bin/env bash
# Render docs/PRD.md and docs/ARCH.md beside their sources with artifacts-cli.
set -euo pipefail
DOCS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ARTIFACTS_NO_LINK_PREVIEWS=1
for doc in PRD ARCH; do
  artifacts check "$DOCS_DIR/$doc.md"
  artifacts render "$DOCS_DIR/$doc.md" --out "$DOCS_DIR/$doc.html"
done
