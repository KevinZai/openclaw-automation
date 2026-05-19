#!/usr/bin/env bash
# cleanup-tmp.sh — Remove /tmp/openclaw-* and other temp dirs older than 24h
# Cron: 30 2 * * * (2:30 AM daily)
# P1 — Maintenance
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

LOG="/Users/ai/clawd/logs/cleanup-tmp.log"
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)

log() { echo "$TIMESTAMP $1" >> "$LOG"; }

PATTERNS=("/tmp/openclaw-*" "/tmp/mc-*" "/tmp/clawd-*" "/tmp/qmd-*")
TOTAL=0

for pattern in "${PATTERNS[@]}"; do
  COUNT=$(find "$pattern" -maxdepth 0 -mtime +1 2>/dev/null | wc -l | tr -d ' ')
  if [ "$COUNT" -gt 0 ]; then
    find "$pattern" -maxdepth 0 -mtime +1 -exec rm -rf {} + 2>/dev/null
    TOTAL=$((TOTAL + COUNT))
  fi
done

log "Removed $TOTAL stale tmp entries"
