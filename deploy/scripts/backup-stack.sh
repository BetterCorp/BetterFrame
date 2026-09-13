#!/usr/bin/env bash
# Run from the Compose project directory. Requires age, tar, and Docker Compose.
# A passphrase is entered directly into age; it is never placed in arguments.
set -euo pipefail
umask 077

if [ "$#" -ne 1 ]; then echo "usage: $0 /absolute/path/backup.tar.age" >&2; exit 2; fi
output="$1"
case "$output" in /*) ;; *) echo "output must be an absolute path" >&2; exit 2;; esac
if [ -e "$output" ] || [ -e "${output}.partial" ]; then echo "output already exists" >&2; exit 2; fi
for tool in docker age tar; do command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 2; }; done
docker compose version >/dev/null
staging="$(mktemp -d)"
restart_services=()
cleanup() {
  result=$?
  trap - EXIT
  if [ "${#restart_services[@]}" -gt 0 ]; then
    docker compose start "${restart_services[@]}" || result=1
  fi
  rm -rf -- "$staging"
  rm -f -- "${output}.partial"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

server_id="$(docker compose ps --all --quiet server)"
nodered_id="$(docker compose ps --all --quiet nodered)"
for container_id in "$server_id" "$nodered_id"; do
  if [ -z "$container_id" ] || [[ "$container_id" == *$'\n'* ]]; then
    echo "exactly one server and one nodered container are required" >&2; exit 2
  fi
done
for service in server nodered; do
  container_id="$(docker compose ps --all --quiet "$service")"
  if [ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true ]; then
    restart_services+=("$service")
  fi
done

echo "Stopping server and Node-RED while capturing a consistent stack backup." >&2
docker compose stop server nodered
docker compose exec -T postgres sh -c 'exec pg_dump --format=custom --username="$POSTGRES_USER" --dbname="${POSTGRES_DB:-$POSTGRES_USER}"' > "$staging/postgres.dump"
test -s "$staging/postgres.dump"
mkdir "$staging/server-data" "$staging/nodered-data"
docker cp -a "$server_id:/var/lib/betterframe/." "$staging/server-data/"
docker cp -a "$nodered_id:/data/." "$staging/nodered-data/"
test -s "$staging/server-data/secret.key"
printf 'BetterFrame stack backup v1\nCreated UTC: %s\nDatabase format: pg_dump custom\n' "$(date -u +%FT%TZ)" > "$staging/MANIFEST.txt"

# Restart promptly; encryption can take longer and may wait for passphrase input.
if [ "${#restart_services[@]}" -gt 0 ]; then
  docker compose start "${restart_services[@]}"
  restart_services=()
fi
tar --numeric-owner -C "$staging" -cf - MANIFEST.txt postgres.dump server-data nodered-data | age --passphrase -o "${output}.partial"
mv -- "${output}.partial" "$output"
echo "Encrypted backup written to $output. Test recovery in a fresh deployment." >&2
