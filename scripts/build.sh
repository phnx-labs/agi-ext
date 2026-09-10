#!/bin/bash

set -e

# Check if version argument is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <version>"
    echo "Example: $0 1.0.0"
    exit 1
fi

VERSION=$1

# Validate version format (basic check)
if ! [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: Version must be in format X.Y.Z (e.g., 1.0.0)"
    exit 1
fi

echo "Building swarm-ext v${VERSION}..."

# Get the project root directory
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
DIST_DIR="$PROJECT_ROOT/dist"

# Version stamping is build input, not a source edit. Restore package.json on
# every exit so a release clone remains reusable after both success and failure.
PACKAGE_JSON_BACKUP="$(mktemp "${TMPDIR:-/tmp}/ext-package-json.XXXXXX")"
cp "$PROJECT_ROOT/package.json" "$PACKAGE_JSON_BACKUP"
restore_package_json() {
    cp "$PACKAGE_JSON_BACKUP" "$PROJECT_ROOT/package.json"
    rm -f "$PACKAGE_JSON_BACKUP"
}
trap restore_package_json EXIT

# Update version in package.json
echo "Updating version to ${VERSION}..."
node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));pkg.version='${VERSION}';fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n')"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    bun install
fi

# Check for dead code (knip gate: ensure all exports are used)
echo "Checking for unused exports and dead modules..."
bun run lint:dead

# Compile TypeScript
echo "Compiling TypeScript..."
bun run compile

# Package extension
echo "Creating dist directory..."
mkdir -p "$DIST_DIR"

echo "Packaging extension..."
VSIX_OUT="$DIST_DIR/swarm-ext-${VERSION}.vsix"
bunx @vscode/vsce package --out "$VSIX_OUT"

# Integrity guard: the extension `require()`s these at activation time (yaml in
# core/agentInventory, sessions.persist, swarmifyConfig; ws in foreman.audio;
# sql.js in sessions.vscode for Cursor chat previews).
# If vsce ever prunes them from the VSIX the extension throws on activate() and
# EVERY `agents.*` command becomes "command not found" (this shipped once as
# 0.9.293). Fail the build here rather than let a dependency-less package
# escape to the marketplace.
echo "Verifying packaged runtime dependencies..."
VSIX_FILES="$(unzip -Z1 "$VSIX_OUT")"
MISSING=""
# Exact-line literal match (-xF): the deps contain regex metachars (sql.js) and
# we want the top-level entry, not a substring.
for dep in yaml sql.js ws; do
    if ! printf '%s\n' "$VSIX_FILES" | grep -qxF "extension/node_modules/${dep}/package.json"; then
        MISSING="${MISSING} ${dep}"
    fi
done
if [ -n "$MISSING" ]; then
    echo "Error: VSIX is missing runtime dependencies:${MISSING}" >&2
    echo "       Run 'bun install' in $PROJECT_ROOT and rebuild — a dependency-less" >&2
    echo "       package fails to activate (every agents.* command 'not found')." >&2
    rm -f "$VSIX_OUT"
    exit 1
fi
echo "Runtime dependencies present in VSIX (yaml, sql.js, ws)."

echo "Build complete: $VSIX_OUT"
