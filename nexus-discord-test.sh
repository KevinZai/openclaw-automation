#!/usr/bin/env bash
# nexus-discord-test.sh — quick smoke test for the Nexus webhook sidecar.
#
# Usage:
#   ./nexus-discord-test.sh "hello world"
#   ./nexus-discord-test.sh                  # sends a default timestamped ping

set -euo pipefail

MSG="${1:-sidecar test from nexus-discord-test.sh @ $(date -Iseconds)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SENDER="${SCRIPT_DIR}/nexus-discord-send.cjs"

if [[ ! -f "$SENDER" ]]; then
  echo "error: $SENDER not found" >&2
  exit 1
fi

# Source OC env if creds aren't already exported.
if [[ -z "${DISCORD_NEXUS_WEBHOOK_URL:-}" && -z "${DISCORD_NEXUS_WEBHOOK_ID:-}" ]]; then
  if [[ -f "$HOME/.openclaw/.env" ]]; then
    set -a; . "$HOME/.openclaw/.env"; set +a
  fi
fi

# JSON-encode the message safely.
PAYLOAD=$(node -e 'process.stdout.write(JSON.stringify({content: process.argv[1]}))' "$MSG")
echo "$PAYLOAD" | node "$SENDER"
