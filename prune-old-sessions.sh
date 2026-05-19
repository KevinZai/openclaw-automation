#!/usr/bin/env bash
# prune-old-sessions.sh — Delete session JSONL files older than 30 days
# Cron: 0 1 * * * (1 AM daily)
# P1 — Maintenance
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

LOG="/Users/ai/clawd/logs/prune-sessions.log"
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)
SESSIONS_DIR="$HOME/.openclaw/agents"
RETENTION_DAYS=30

log() { echo "$TIMESTAMP $1" >> "$LOG"; }

if [ ! -d "$SESSIONS_DIR" ]; then
  log "Sessions dir not found: $SESSIONS_DIR"
  exit 0
fi

COUNT=$(find "$SESSIONS_DIR" -name "*.jsonl" -mtime +"$RETENTION_DAYS" 2>/dev/null | wc -l | tr -d ' ')
SIZE=$(find "$SESSIONS_DIR" -name "*.jsonl" -mtime +"$RETENTION_DAYS" -exec du -ch {} + 2>/dev/null | tail -1 | cut -f1 || echo "0")

if [ "$COUNT" -gt 0 ]; then
  find "$SESSIONS_DIR" -name "*.jsonl" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null
  log "Pruned $COUNT session files ($SIZE freed, older than ${RETENTION_DAYS}d)"
else
  log "No sessions to prune (none older than ${RETENTION_DAYS}d)"
fi
