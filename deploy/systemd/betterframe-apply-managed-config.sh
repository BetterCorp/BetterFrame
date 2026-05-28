#!/bin/sh
set -eu

cmd="${1:-}"
case "$cmd" in
  timezone)
    tz="${2:-}"
    case "$tz" in
      ""|/*|*..*|*\\*|*[!A-Za-z0-9_/+.-]*)
        echo "invalid timezone: $tz" >&2
        exit 2
        ;;
    esac
    if [ ! -f "/usr/share/zoneinfo/$tz" ]; then
      echo "timezone not found: $tz" >&2
      exit 3
    fi
    exec timedatectl set-timezone "$tz"
    ;;
  *)
    echo "usage: $0 timezone <IANA-zone>" >&2
    exit 2
    ;;
esac
