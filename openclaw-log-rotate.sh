#!/bin/bash
# OpenClaw log rotation — runs daily at 23:55, gzips yesterday's log, keeps 7d retention.
# Added 2026-05-15 because /tmp/openclaw/openclaw-YYYY-MM-DD.log can hit 100MB+/day.

set -euo pipefail

LOG_DIR="/tmp/openclaw"
YESTERDAY=$(date -v-1d +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)

# Gzip yesterday's log if it exists and isn't already compressed
if [ -f "$LOG_DIR/openclaw-${YESTERDAY}.log" ]; then
  gzip -f "$LOG_DIR/openclaw-${YESTERDAY}.log"
  echo "$(date -Iseconds) gzipped $LOG_DIR/openclaw-${YESTERDAY}.log"
fi

# Delete .log.gz files older than 7 days
find "$LOG_DIR" -name "openclaw-*.log.gz" -mtime +7 -delete 2>/dev/null || true
echo "$(date -Iseconds) retention prune complete"

# Sanity: warn if today's log is already >50MB (would benefit from level=warn instead of info)
if [ -f "$LOG_DIR/openclaw-${TODAY}.log" ]; then
  size=$(stat -f%z "$LOG_DIR/openclaw-${TODAY}.log" 2>/dev/null || echo 0)
  if [ "$size" -gt 52428800 ]; then
    echo "$(date -Iseconds) WARN today's log is ${size}B — consider lowering OC logging.level to 'warn'" >&2
  fi
fi
