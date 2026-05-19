#!/bin/bash
# 2-layer cron wrapper — bash pre-check, fires OC cron only when needed
# Usage: 2layer-cron-wrapper.sh <cron-id> <check-command>
#
# Layer 1: Runs the check-command (pure bash, zero tokens)
# Layer 2: If check exits 0 (action needed), fires openclaw cron run
#
# Example:
#   2layer-cron-wrapper.sh abc123 "test $(df / | tail -1 | awk '{print $5}' | tr -d '%') -gt 85"
#   → Only fires the disk-space cron if usage > 85%

export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

CRON_ID="$1"
shift
CHECK_CMD="$*"
LOG="/Users/ai/clawd/logs/2layer-cron.log"
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)

if [ -z "$CRON_ID" ] || [ -z "$CHECK_CMD" ]; then
  echo "Usage: $0 <cron-id> <check-command>"
  exit 1
fi

# Layer 1: Bash pre-check (zero tokens)
if eval "$CHECK_CMD" >/dev/null 2>&1; then
  # Action needed — fire Layer 2
  echo "$TIMESTAMP FIRE cron=$CRON_ID check=PASS" >> "$LOG"
  openclaw cron run "$CRON_ID" 2>/dev/null
else
  # Nothing to do — skip silently
  echo "$TIMESTAMP SKIP cron=$CRON_ID check=IDLE" >> "$LOG"
fi
