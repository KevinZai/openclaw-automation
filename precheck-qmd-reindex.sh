#!/usr/bin/env bash
# Description:  Check if any workspace markdown files changed in last 24 hours
# Gates:        qmd-reindex cron (rebuild QMD memory index from workspace docs)
# Expected savings: ~70% — most hours have no workspace edits
set -euo pipefail

WORKSPACE_DIR="$HOME/clawd/workspaces"
WINDOW_MINS=1440  # 24 hours

CHANGED=$(find "$WORKSPACE_DIR" -name "*.md" -mmin -"$WINDOW_MINS" -type f 2>/dev/null | head -1)

if echo "$CHANGED" | grep -q .; then
  echo "precheck-qmd-reindex: FIRE — workspace markdown files modified in last 24h"
  exit 0
fi

echo "precheck-qmd-reindex: SKIP — no workspace markdown changes in last 24h"
exit 1
