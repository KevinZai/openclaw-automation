#!/bin/bash
# pause-aware-cron-wrapper.sh — budget-aware 2-layer cron wrapper
#
# Extends 2layer-cron-wrapper with a pre-check for agent pause flags.
# Drop-in wrapper for any cron that invokes an OpenClaw agent cron job.
#
# Usage:
#   pause-aware-cron-wrapper.sh <agent-id> <cron-id> [check-command]
#
# Examples:
#   # Fire neo cron 4c9de701 only if neo is not paused (no pre-check)
#   pause-aware-cron-wrapper.sh neo 4c9de701
#
#   # Fire tank cron with an additional bash pre-check
#   pause-aware-cron-wrapper.sh tank 761936f8 "test $(df / | awk 'NR==2 {print $5}') != 100%"
#
# How to wire into an existing cron:
#   BEFORE: openclaw cron run <cron-id>
#   AFTER:  /Users/ai/clawd/scripts/pause-aware-cron-wrapper.sh <agent-id> <cron-id>
#
# The pause flag is set by agent-budget-tracker.cjs --enforce when an agent
# exceeds 150% of its hard cap. Flags are removed at 01:00 daily.

export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

AGENT_ID="$1"
CRON_ID="$2"
shift 2
CHECK_CMD="$*"

PAUSE_FLAGS_DIR="/Users/ai/clawd/tools/cost-tracker/pause-flags"
LOG="/Users/ai/clawd/logs/budget-tracker.log"
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)

if [ -z "$AGENT_ID" ] || [ -z "$CRON_ID" ]; then
  echo "Usage: $0 <agent-id> <cron-id> [check-command]"
  exit 1
fi

# ── Step 1: Pause flag check ───────────────────────────────────────────────

PAUSE_FLAG="${PAUSE_FLAGS_DIR}/${AGENT_ID}.paused"
if [ -f "$PAUSE_FLAG" ]; then
  echo "$TIMESTAMP SKIP agent=$AGENT_ID cron=$CRON_ID reason=budget_paused" >> "$LOG"
  echo "Agent ${AGENT_ID} paused (budget cap). Skipping cron ${CRON_ID}." >&2
  exit 0
fi

# ── Step 2: Optional bash pre-check (zero tokens) ─────────────────────────

if [ -n "$CHECK_CMD" ]; then
  if ! eval "$CHECK_CMD" >/dev/null 2>&1; then
    echo "$TIMESTAMP SKIP agent=$AGENT_ID cron=$CRON_ID reason=precheck_idle" >> "$LOG"
    exit 0
  fi
fi

# ── Step 3: Fire the cron ─────────────────────────────────────────────────

echo "$TIMESTAMP FIRE agent=$AGENT_ID cron=$CRON_ID" >> "$LOG"
openclaw cron run "$CRON_ID" 2>/dev/null
