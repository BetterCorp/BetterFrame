#!/usr/bin/env bash
#
# BetterFrame kiosk prototype — pairs with server, pulls bundle, displays cameras.
# Requires: curl, jq, gst-launch-1.0
#
# Usage: ./prototype.sh [server-url]
#   If no URL given, auto-discovers via localhost → betterframe.local → frame.betterportal.cloud
#
set -euo pipefail

STATE_DIR="${HOME}/.betterframe-kiosk"
KEY_FILE="${STATE_DIR}/kiosk.key"
SERVER_FILE="${STATE_DIR}/server.url"
BUNDLE_FILE="${STATE_DIR}/bundle.json"

mkdir -p "$STATE_DIR"

# ---- Discovery ---------------------------------------------------------------

discover_server() {
  if [[ -n "${1:-}" ]]; then
    echo "$1"
    return
  fi

  # Saved from previous run
  if [[ -f "$SERVER_FILE" ]]; then
    local saved
    saved=$(cat "$SERVER_FILE")
    if curl -sf "${saved}/healthz" >/dev/null 2>&1; then
      echo "$saved"
      return
    fi
  fi

  local candidates=(
    "http://localhost:18081"
    "http://betterframe.local:18081"
    "https://frame.betterportal.cloud"
  )

  for url in "${candidates[@]}"; do
    echo "  trying ${url}..." >&2
    if curl -sf --connect-timeout 3 "${url}/healthz" >/dev/null 2>&1; then
      echo "$url" > "$SERVER_FILE"
      echo "$url"
      return
    fi
  done

  echo "ERROR: could not find BetterFrame server" >&2
  exit 1
}

# ---- Pairing -----------------------------------------------------------------

pair_with_server() {
  local server="$1"
  local hostname
  hostname=$(hostname)
  local hw_model
  hw_model=$(cat /proc/device-tree/model 2>/dev/null || echo "unknown")

  echo "Requesting pairing code..."
  local resp
  resp=$(curl -sf -X POST "${server}/api/pair/initiate" \
    -H "Content-Type: application/json" \
    -d "{\"proposed_name\":\"${hostname}\",\"hardware_model\":\"${hw_model}\",\"capabilities\":[\"rtsp\",\"gstreamer\"]}")

  local code
  code=$(echo "$resp" | jq -r '.code')
  local expires
  expires=$(echo "$resp" | jq -r '.expires_at')

  echo ""
  echo "============================================"
  echo ""
  echo "  PAIRING CODE:  ${code}"
  echo ""
  echo "  Enter this code in the BetterFrame admin"
  echo "  Expires: ${expires}"
  echo ""
  echo "============================================"
  echo ""

  # Poll until admin confirms
  echo "Waiting for admin to confirm..."
  local tmpfile
  tmpfile=$(mktemp)
  while true; do
    local http_code
    http_code=$(curl -s -w "%{http_code}" -o "$tmpfile" -X POST "${server}/api/pair/claim" \
      -H "Content-Type: application/json" \
      -d "{\"code\":\"${code}\"}" 2>/dev/null || echo "000")

    if [[ "$http_code" == "200" ]]; then
      local kiosk_key
      kiosk_key=$(jq -r '.kiosk_key' "$tmpfile")
      local kiosk_name
      kiosk_name=$(jq -r '.kiosk_name' "$tmpfile")

      echo "$kiosk_key" > "$KEY_FILE"
      chmod 600 "$KEY_FILE"
      rm -f "$tmpfile"

      echo "Paired as: ${kiosk_name}"
      return
    fi

    sleep 2
  done
  rm -f "$tmpfile"
}

# ---- Bundle ------------------------------------------------------------------

fetch_bundle() {
  local server="$1"
  local key
  key=$(cat "$KEY_FILE")

  echo "Fetching bundle..."
  curl -sf "${server}/api/kiosk/bundle" \
    -H "Authorization: Bearer ${key}" \
    > "$BUNDLE_FILE"

  local cam_count
  cam_count=$(jq '.cameras | length' "$BUNDLE_FILE")
  echo "Bundle received: ${cam_count} camera(s)"
}

# ---- GStreamer ----------------------------------------------------------------

launch_cameras() {
  local pids=()

  local cam_count
  cam_count=$(jq '.cameras | length' "$BUNDLE_FILE")

  if [[ "$cam_count" -eq 0 ]]; then
    echo "No cameras in bundle. Waiting..."
    sleep 30
    return
  fi

  for i in $(seq 0 $((cam_count - 1))); do
    local name
    name=$(jq -r ".cameras[$i].name" "$BUNDLE_FILE")
    local type
    type=$(jq -r ".cameras[$i].type" "$BUNDLE_FILE")

    local rtsp_uri=""

    if [[ "$type" == "rtsp" ]]; then
      # Use direct RTSP URL, or first stream's URI
      rtsp_uri=$(jq -r ".cameras[$i].rtsp_url // empty" "$BUNDLE_FILE")
      if [[ -z "$rtsp_uri" ]]; then
        rtsp_uri=$(jq -r ".cameras[$i].streams[0].rtsp_uri // empty" "$BUNDLE_FILE")
      fi
    else
      # ONVIF — use first discovered stream URI
      rtsp_uri=$(jq -r ".cameras[$i].streams[0].rtsp_uri // empty" "$BUNDLE_FILE")
    fi

    if [[ -z "$rtsp_uri" ]]; then
      echo "  [${name}] no RTSP URI, skipping"
      continue
    fi

    echo "  [${name}] launching: ${rtsp_uri}"

    # Try hardware decode first (Pi5 V4L2), fall back to software
    gst-launch-1.0 \
      rtspsrc location="$rtsp_uri" latency=300 protocols=tcp \
      ! rtph264depay \
      ! h264parse \
      ! queue max-size-buffers=1 leaky=downstream \
      ! avdec_h264 \
      ! videoconvert \
      ! autovideosink sync=false \
      2>/dev/null &
    pids+=($!)
  done

  if [[ ${#pids[@]} -eq 0 ]]; then
    echo "No cameras could be launched"
    sleep 10
    return
  fi

  echo ""
  echo "Displaying ${#pids[@]} camera(s). Press Ctrl+C to stop."

  # Wait for any to exit
  wait -n "${pids[@]}" 2>/dev/null || true
}

# ---- Heartbeat ---------------------------------------------------------------

start_heartbeat() {
  local server="$1"
  local key
  key=$(cat "$KEY_FILE")

  while true; do
    curl -sf -X POST "${server}/api/kiosk/heartbeat" \
      -H "Authorization: Bearer ${key}" \
      -H "Content-Type: application/json" \
      -d '{"kiosk_app_version":"prototype-0.1"}' \
      >/dev/null 2>&1 || true
    sleep 60
  done
}

# ---- Main --------------------------------------------------------------------

main() {
  echo "BetterFrame Kiosk Prototype"
  echo ""

  # Discover server
  echo "Discovering server..."
  local server
  server=$(discover_server "${1:-}")
  echo "Server: ${server}"

  # Pair if needed
  if [[ ! -f "$KEY_FILE" ]]; then
    pair_with_server "$server"
  else
    echo "Already paired (key in ${KEY_FILE})"
  fi

  # Fetch bundle
  fetch_bundle "$server"

  # Start heartbeat in background
  start_heartbeat "$server" &

  # Launch cameras
  launch_cameras

  # Cleanup
  kill $(jobs -p) 2>/dev/null || true
}

trap 'kill $(jobs -p) 2>/dev/null; exit' INT TERM
main "$@"
