#!/usr/bin/env bash
# Description:  Count tagged memory entries ([DECISION] [LEARNED] [CORRECTION] [PATTERN])
#               across recent workspace memory files (last 7 days)
# Gates:        memory-compact cron (promote tagged entries into long-term memory)
# Expected savings: ~50% — quiet periods generate fewer than 3 tagged entries
set -euo pipefail

WORKSPACE_DIR="$HOME/clawd/workspaces"
WINDOW_MINS=10080  # 7 days
MIN_ENTRIES=3

# Find memory files modified in window
MEMORY_FILES=$(find "$WORKSPACE_DIR" -path "*/memory/*.md" -mmin -"$WINDOW_MINS" -type f 2>/dev/null)

if [ -z "$MEMORY_FILES" ]; then
  echo "precheck-memory-compact: SKIP — no recent memory files found"
  exit 1
fi

# Count tagged entries across all recent memory files
TAG_COUNT=$(echo "$MEMORY_FILES" | xargs grep -h '\[DECISION\]\|\[LEARNED\]\|\[CORRECTION\]\|\[PATTERN\]' 2>/dev/null | wc -l | tr -d ' ')

if [ "${TAG_COUNT:-0}" -ge "$MIN_ENTRIES" ]; then
  echo "precheck-memory-compact: FIRE — ${TAG_COUNT} tagged entries found across recent memory files"
  exit 0
fi

echo "precheck-memory-compact: SKIP — only ${TAG_COUNT:-0} tagged entries (threshold: ${MIN_ENTRIES})"
exit 1
