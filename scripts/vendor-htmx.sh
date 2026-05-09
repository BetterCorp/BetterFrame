#!/usr/bin/env bash
# Re-vendor htmx into server/src/web-static/htmx.min.js
set -euo pipefail
VERSION="${1:-2.0.10}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/server/src/web-static/htmx.min.js"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
echo "fetching htmx.org@$VERSION ..."
npm pack "htmx.org@$VERSION" --silent
TGZ=$(ls htmx.org-*.tgz | head -1)
tar xzf "$TGZ" package/dist/htmx.min.js
cp package/dist/htmx.min.js "$DEST"
echo "done — vendored htmx@$VERSION ($(wc -c < "$DEST") bytes)"
