#!/usr/bin/env bash
# Re-vendor @anyvali/js from npm into server/src/web-static/anyvali/
# Usage: ./scripts/vendor-anyvali-js.sh [version]
set -euo pipefail
VERSION="${1:-0.2.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/server/src/web-static/anyvali"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
echo "fetching @anyvali/js@$VERSION ..."
npm pack "@anyvali/js@$VERSION" --silent
TGZ=$(ls anyvali-js-*.tgz | head -1)
tar xzf "$TGZ"
echo "rebuilding $DEST ..."
rm -rf "$DEST"
mkdir -p "$DEST"
cd package/dist
find . -name '*.js' | while read -r f; do
  mkdir -p "$DEST/$(dirname "$f")"
  cp "$f" "$DEST/$f"
done
echo "$VERSION" > "$DEST/VERSION"
echo "done — vendored $VERSION ($(find "$DEST" -name '*.js' | wc -l) files, $(du -sh "$DEST" | cut -f1))"
