#!/usr/bin/env bash
# Weekly output cleanup — purges scratch >7 days, archives daily-briefs >30 days
# Crontab: 0 2 * * 0 ~/clawd/scripts/output-cleanup.sh

set -euo pipefail
LOG="$HOME/clawd/scripts/output-cleanup.log"
echo "=== Output cleanup: $(date) ===" >> "$LOG"

# 1. Purge scratch/ dirs older than 7 days
for ws in ~/clawd/workspaces/*/scratch; do
  [ -d "$ws" ] || continue
  count=$(find "$ws" -type f -mtime +7 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -gt 0 ]; then
    find "$ws" -type f -mtime +7 -delete 2>/dev/null
    echo "  Purged $count files from $(basename $(dirname $ws))/scratch/" >> "$LOG"
  fi
done

# 2. Archive daily-briefs older than 30 days
BRIEFS="$HOME/clawd/shared/daily-brief"
ARCHIVE="$HOME/clawd/shared/daily-brief/archive"
if [ -d "$BRIEFS" ]; then
  mkdir -p "$ARCHIVE"
  count=$(find "$BRIEFS" -maxdepth 1 -type f -mtime +30 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -gt 0 ]; then
    find "$BRIEFS" -maxdepth 1 -type f -mtime +30 -exec mv {} "$ARCHIVE/" \; 2>/dev/null
    echo "  Archived $count daily briefs older than 30 days" >> "$LOG"
  fi
fi

# 3. Remove empty dirs in output/
find ~/clawd/output -type d -empty -delete 2>/dev/null

echo "  Done." >> "$LOG"
