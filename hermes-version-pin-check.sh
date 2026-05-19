#!/usr/bin/env bash
# hermes-version-pin-check.sh — abort unintended Hermes upgrades.
# Compares ~/.hermes/.version-pin against `hermes --version` and refuses to
# proceed unless --allow-upgrade is passed. Wrap `hermes update` invocations
# with this check.
set -euo pipefail

PIN_FILE="${HOME}/.hermes/.version-pin"
CURRENT=$(hermes --version 2>&1 | head -1 || echo "unknown")

if [ ! -f "${PIN_FILE}" ]; then
  echo "[hermes-version-pin] no pin found — creating from current version"
  echo "${CURRENT}" > "${PIN_FILE}"
  exit 0
fi

PINNED=$(cat "${PIN_FILE}")

if [ "${PINNED}" != "${CURRENT}" ]; then
  echo "[hermes-version-pin] MISMATCH"
  echo "  pinned:  ${PINNED}"
  echo "  current: ${CURRENT}"
  if [ "${1:-}" = "--allow-upgrade" ]; then
    echo "[hermes-version-pin] --allow-upgrade passed; updating pin"
    echo "${CURRENT}" > "${PIN_FILE}"
    exit 0
  fi
  echo "[hermes-version-pin] aborting. Pass --allow-upgrade to proceed."
  exit 1
fi

echo "[hermes-version-pin] OK (${PINNED})"
