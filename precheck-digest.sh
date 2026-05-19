#!/usr/bin/env bash
# Description:  Check if discrawl.db or QMD index were updated in the last 7 days
# Gates:        digest cron (generate daily/weekly digest from Discord + memory index)
# Expected savings: ~30% — both sources update frequently, but not always together
set -euo pipefail

DISCRAWL_DB="$HOME/.discrawl/discrawl.db"
QMD_INDEX="$HOME/.cache/qmd/index.sqlite"
WINDOW_MINS=10080  # 7 days

DISCRAWL_CHANGED=$(find "$HOME/.discrawl" -name "discrawl.db" -mmin -"$WINDOW_MINS" 2>/dev/null | head -1)
QMD_CHANGED=$(find "$HOME/.cache/qmd" -name "index.sqlite" -mmin -"$WINDOW_MINS" 2>/dev/null | head -1)

if echo "$DISCRAWL_CHANGED" | grep -q . || echo "$QMD_CHANGED" | grep -q .; then
  REASON=""
  [ -n "$DISCRAWL_CHANGED" ] && REASON="${REASON}discrawl.db "
  [ -n "$QMD_CHANGED" ]     && REASON="${REASON}qmd-index"
  echo "precheck-digest: FIRE — updated in last 7d: ${REASON% }"
  exit 0
fi

echo "precheck-digest: SKIP — neither discrawl.db nor QMD index updated in 7 days"
exit 1
