#!/bin/bash
# OpenClaw Gateway launcher — CC-743 Keychain migration.
#
# Sourced by ai.openclaw.gateway.plist instead of node directly.
# Pulls bootstrap secrets from macOS user Keychain (no plist inline secrets).
#
# Setup (one-time, before activation):
#   security add-generic-password -a "$USER" -s "openclaw-gog-keyring"        -w '<GOG_KEYRING_PASSWORD value>'
#   security add-generic-password -a "$USER" -s "openclaw-op-service-account" -w '<OP_SERVICE_ACCOUNT_TOKEN value>'
#
# Why: gateway needs GOG_KEYRING_PASSWORD (gnome-keyring unlock for op) +
# OP_SERVICE_ACCOUNT_TOKEN (1Password service account bootstrap) BEFORE
# `op` CLI can be used — so they can't be op:// references. Keychain breaks
# the chicken-and-egg without inlining cleartext secrets in launchd plist.
#
# Failure mode: if either secret is missing in Keychain, gateway exits 1.
# launchd KeepAlive will retry — fix by re-adding the missing entry.

set -euo pipefail

SECURITY=/usr/bin/security
NODE=/Users/ai/.openagents/nodejs/bin/node
GATEWAY_JS=/Users/ai/.openagents/nodejs/lib/node_modules/openclaw/dist/index.js
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

err() { echo "[gateway-launcher] $*" >&2; }

read_keychain() {
  local svc="$1"
  "$SECURITY" find-generic-password -a "$USER" -s "$svc" -w 2>/dev/null || true
}

GOG_KEYRING_PASSWORD="$(read_keychain openclaw-gog-keyring)"
OP_SERVICE_ACCOUNT_TOKEN="$(read_keychain openclaw-op-service-account)"

missing=()
[ -z "$GOG_KEYRING_PASSWORD" ]      && missing+=("openclaw-gog-keyring")
[ -z "$OP_SERVICE_ACCOUNT_TOKEN" ]  && missing+=("openclaw-op-service-account")

if [ "${#missing[@]}" -gt 0 ]; then
  err "ERROR: missing Keychain entries: ${missing[*]}"
  err "Setup:"
  for svc in "${missing[@]}"; do
    err "  security add-generic-password -a \"\$USER\" -s \"$svc\" -w '<value>'"
  done
  exit 1
fi

export GOG_KEYRING_PASSWORD
export OP_SERVICE_ACCOUNT_TOKEN

exec "$NODE" "$GATEWAY_JS" gateway --port "$PORT"
