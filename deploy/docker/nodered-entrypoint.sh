#!/usr/bin/env sh
# Seed /data/settings.js on first boot. The /data named volume overlays
# anything we COPY into /data during image build, so the file has to be
# planted after the volume mounts.
#
# Runs as root, fixes /data ownership + any stale directories left by
# previous bind-mount attempts, then drops to the node-red user.
set -eu

DATA=/data
TPL=/usr/src/bf-settings.js
TARGET="$DATA/settings.js"

# Clear stale path if a previous broken bind-mount left a directory where
# we expect a file.
if [ -d "$TARGET" ]; then
  echo "[bf-nodered] $TARGET is a directory (stale bind mount?). Removing."
  rm -rf "$TARGET"
fi

if [ ! -f "$TARGET" ]; then
  echo "[bf-nodered] seeding $TARGET from $TPL"
  cp "$TPL" "$TARGET"
fi

# Ensure the volume + seeded file are owned by node-red.
chown -R node-red:root "$DATA" 2>/dev/null || true

# Drop to the node-red user before launching. nodered/node-red is Debian
# based; we installed gosu in the Dockerfile for this.
exec gosu node-red:node-red npm start --cache /data/.npm -- --userDir /data "$@"
