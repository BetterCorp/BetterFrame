#!/usr/bin/env sh
# Seed /data/settings.js with our BF defaults on first boot.
# /data is volume-mounted, so the COPY in the Dockerfile gets hidden
# unless we plant a copy after the mount comes up.
set -eu

DATA=/data
TPL=/usr/src/bf-settings.js

if [ ! -f "$DATA/settings.js" ]; then
  echo "[bf-nodered] seeding $DATA/settings.js from $TPL"
  cp "$TPL" "$DATA/settings.js"
fi

# Exec the upstream nodered entrypoint args verbatim.
exec npm start --cache /data/.npm -- --userDir /data "$@"
