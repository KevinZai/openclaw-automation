#!/usr/bin/env bash
# hermes-daily-snapshot.sh — daily snapshot of ~/.hermes + ~/.hermes-* profiles
# Retains 7 days. Runs 05:00 ET via crontab.
set -euo pipefail

SNAPSHOT_ROOT="${HOME}/clawd/archive/hermes-snapshots"
DATE=$(date +%Y-%m-%d)
DEST="${SNAPSHOT_ROOT}/${DATE}"
RETENTION_DAYS=7
LOG="${HOME}/clawd/logs/hermes-snapshot.log"

mkdir -p "${SNAPSHOT_ROOT}" "$(dirname "${LOG}")"

{
  echo "===== $(date -Iseconds) snapshot start ====="

  if [ -d "${DEST}" ]; then
    echo "snapshot already exists for ${DATE}, skipping"
    exit 0
  fi

  mkdir -p "${DEST}"

  # Snapshot default profile (skip large caches / sessions to keep size manageable)
  rsync -a \
    --exclude='cache/' \
    --exclude='audio_cache/' \
    --exclude='checkpoints/' \
    --exclude='sessions/' \
    --exclude='*.log' \
    "${HOME}/.hermes/" "${DEST}/default/" 2>&1 | tail -5 || true

  # Snapshot named profiles
  for profile_dir in "${HOME}"/.hermes-*; do
    [ -d "${profile_dir}" ] || continue
    name=$(basename "${profile_dir}" | sed 's/^\.hermes-//')
    rsync -a \
      --exclude='cache/' \
      --exclude='audio_cache/' \
      --exclude='checkpoints/' \
      --exclude='sessions/' \
      --exclude='*.log' \
      "${profile_dir}/" "${DEST}/${name}/" 2>&1 | tail -5 || true
  done

  # Prune snapshots older than RETENTION_DAYS
  find "${SNAPSHOT_ROOT}" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" -exec rm -rf {} + 2>/dev/null || true

  echo "snapshot complete: ${DEST}"
  du -sh "${DEST}"
  echo "===== $(date -Iseconds) snapshot end ====="
} >> "${LOG}" 2>&1
