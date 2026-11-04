#!/bin/sh
set -eu

load_secret() {
  name="$1"
  eval "file=\${${name}_FILE:-}"
  if [ -n "$file" ]; then
    [ -r "$file" ] || { echo "$name secret file is not readable" >&2; exit 1; }
    export "$name=$(cat "$file")"
  fi
}

for name in BF_PG_PASSWORD BF_FIRMWARE_SIGNING_KEY BF_CLIENT_FIRMWARE_PUBLIC_KEY BF_FIRMWARE_IMPORT_API_KEY BF_OTA_IMPORT_API_KEY BF_MQTT_PASSWORD BF_NODERED_MANAGER_SECRET; do
  load_secret "$name"
done

export BF_PG_HOST="${BF_PG_HOST:-postgres}"
export BF_PG_PORT="${BF_PG_PORT:-5432}"
export BF_PG_DB="${BF_PG_DB:-betterframe}"
export BF_PG_USER="${BF_PG_USER:-betterframe}"
: "${BF_PG_PASSWORD:?BF_PG_PASSWORD is required}"
export BF_PG_PASSWORD
export BF_BP_ENABLED="${BF_BP_ENABLED:-false}"
if [ "$BF_BP_ENABLED" = "true" ]; then
  : "${BF_BP_CONTROL_PLANE_URL:?BF_BP_CONTROL_PLANE_URL is required when BP is enabled}"
fi
export BF_BP_CONTROL_PLANE_URL="${BF_BP_CONTROL_PLANE_URL:-https://not-configured.invalid}"
export BF_BP_HOST="${BF_BP_HOST:-127.0.0.1}"
export BF_BP_INSTALLATION_ID="${BF_BP_INSTALLATION_ID:-betterportal}"
export BF_BP_EXISTING_TENANT_BINDINGS="${BF_BP_EXISTING_TENANT_BINDINGS:-[]}"
export BF_SANDBOX_MODE="${BF_SANDBOX_MODE:-false}"
export BF_ADMIN_HOST="${BF_ADMIN_HOST:-0.0.0.0}"
export BF_FLEET_API_ENABLED="${BF_FLEET_API_ENABLED:-true}"
export BF_COORDINATOR_ENABLED="${BF_COORDINATOR_ENABLED:-true}"
export BF_ENABLE_DEMO_TENANT="${BF_ENABLE_DEMO_TENANT:-false}"
export BF_KIOSK_LOG_RETENTION_HOURS="${BF_KIOSK_LOG_RETENTION_HOURS:-24}"
export BF_PG_POOL_MAX="${BF_PG_POOL_MAX:-10}"
export BF_NODERED_URL="${BF_NODERED_URL:-http://nodered:1880}"
export BF_SELF_URL="${BF_SELF_URL:-http://server:18080}"
export BF_FIRMWARE_SIGNING_KEY="${BF_FIRMWARE_SIGNING_KEY:-}"
export BF_CLIENT_FIRMWARE_PUBLIC_KEY="${BF_CLIENT_FIRMWARE_PUBLIC_KEY:-}"
export BF_FIRMWARE_SIGNING_KEY_BASE64="$(printf '%s' "$BF_FIRMWARE_SIGNING_KEY" | base64 | tr -d '\n')"
export BF_CLIENT_FIRMWARE_PUBLIC_KEY_BASE64="$(printf '%s' "$BF_CLIENT_FIRMWARE_PUBLIC_KEY" | base64 | tr -d '\n')"
export BF_FIRMWARE_IMPORT_API_KEY="${BF_FIRMWARE_IMPORT_API_KEY:-}"
export BF_OTA_IMPORT_API_KEY="${BF_OTA_IMPORT_API_KEY:-}"
export BF_MQTT_URL="${BF_MQTT_URL:-}"
export BF_MQTT_USERNAME="${BF_MQTT_USERNAME:-}"
export BF_MQTT_PASSWORD="${BF_MQTT_PASSWORD:-}"
export BF_MQTT_TOPIC_PREFIX="${BF_MQTT_TOPIC_PREFIX:-betterframe}"

envsubst < /home/bsb/sec-config.template.yaml > /home/bsb/sec-config.yaml
chmod 600 /home/bsb/sec-config.yaml
chown -R 1000:1000 /var/lib/betterframe 2>/dev/null || true

if [ -f /root/entrypoint.sh ]; then exec /root/entrypoint.sh "$@"; fi
if [ -f /usr/local/bin/entrypoint.sh ]; then exec /usr/local/bin/entrypoint.sh "$@"; fi
if [ -f /home/bsb/entrypoint.sh ]; then exec /home/bsb/entrypoint.sh "$@"; fi
exec node /home/bsb/lib/index.js "$@"
