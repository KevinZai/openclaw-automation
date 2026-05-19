#!/usr/bin/env bash
# hermes-pre-update-check.sh
# Verifies Hermes installed version matches the pin file before allowing updates.
# Exits 1 if drift detected — wrap any auto-update path in this gate.
#
# Pin file: ~/.hermes/.version-pin
#   line 1: hermes CLI version (e.g. v0.13.0)
#   line 2: build/release tag (e.g. 2026.5.7)
#
# Usage:
#   bash ~/clawd/scripts/hermes-pre-update-check.sh        # check & report
#   bash ~/clawd/scripts/hermes-pre-update-check.sh --quiet # silent unless drift

set -euo pipefail

PIN_FILE="${HOME}/.hermes/.version-pin"
QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

log() { [[ $QUIET -eq 0 ]] && echo "$@" || true; }

if [[ ! -f "$PIN_FILE" ]]; then
  echo "ERROR: Hermes version pin file missing: $PIN_FILE" >&2
  echo "  Create with: printf 'v0.13.0\\n2026.5.7\\n' > $PIN_FILE" >&2
  exit 1
fi

PINNED_VERSION=$(sed -n '1p' "$PIN_FILE" | tr -d ' \t\r\n')
PINNED_BUILD=$(sed -n '2p' "$PIN_FILE" | tr -d ' \t\r\n')

if ! command -v hermes >/dev/null 2>&1; then
  echo "ERROR: hermes binary not found in PATH" >&2
  exit 1
fi

# `hermes --version` output: "Hermes Agent v0.13.0 (2026.5.7)"
RAW=$(hermes --version 2>&1 | head -1)
CURRENT_VERSION=$(echo "$RAW" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)
CURRENT_BUILD=$(echo "$RAW" | grep -oE '\([0-9]{4}\.[0-9]+\.[0-9]+\)' | tr -d '()')

log "Hermes version check:"
log "  pinned : $PINNED_VERSION ($PINNED_BUILD)"
log "  current: $CURRENT_VERSION ($CURRENT_BUILD)"

DRIFT=0
if [[ "$CURRENT_VERSION" != "$PINNED_VERSION" ]]; then
  echo "DRIFT: hermes version $CURRENT_VERSION != pinned $PINNED_VERSION" >&2
  DRIFT=1
fi
if [[ -n "$PINNED_BUILD" && "$CURRENT_BUILD" != "$PINNED_BUILD" ]]; then
  echo "DRIFT: hermes build $CURRENT_BUILD != pinned $PINNED_BUILD" >&2
  DRIFT=1
fi

if [[ $DRIFT -eq 1 ]]; then
  echo "" >&2
  echo "Hermes drifted from pin. Either:" >&2
  echo "  1. Rollback to pinned version, OR" >&2
  echo "  2. Update pin: printf '%s\\n%s\\n' \"$CURRENT_VERSION\" \"$CURRENT_BUILD\" > $PIN_FILE" >&2
  echo "" >&2
  echo "Hermes is pinned per migration plan — autoupdate is disabled." >&2
  exit 1
fi

log "OK: hermes matches pin."
exit 0
