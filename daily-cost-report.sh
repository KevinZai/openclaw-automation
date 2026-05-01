#!/bin/bash
# Part of openclaw-automation — https://github.com/KevinZai/openclaw-automation
# Daily Cost Report - Sends yesterday's API spend to Telegram
# Runs at 8 AM daily via cron

set -euo pipefail

COST_TRACKER="${CLAWD_DIR:-$HOME/clawd}/skills/cost-tracker/scripts/track.py"
LOG_FILE="${CLAWD_DIR:-$HOME/clawd}/logs/daily-cost-report.log"

# Load secrets from .env — || true prevents abort if .env is mid-rotation
source ~/.openclaw/.env || true

# Telegram config
BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$LOG_FILE"
}

send_telegram() {
  local message="$1"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${message}" \
    -d "parse_mode=Markdown" > /dev/null 2>&1
}

# Get yesterday's date
YESTERDAY=$(date -v-1d '+%Y-%m-%d' 2>/dev/null || date -d 'yesterday' '+%Y-%m-%d')

log "Generating report for $YESTERDAY"

# Get cost data as JSON
COST_JSON=$(python3 "$COST_TRACKER" --days 1 --by-model --format json 2>/dev/null)

if [[ -z "$COST_JSON" ]]; then
  log "ERROR: No cost data available"
  exit 1
fi

# Parse JSON for key metrics
TOTAL_COST=$(echo "$COST_JSON" | jq -r '.total_cost')
TOTAL_TOKENS=$(echo "$COST_JSON" | jq -r '.total_tokens')
MSG_COUNT=$(echo "$COST_JSON" | jq -r '.message_count')
CACHE_SAVINGS=$(echo "$COST_JSON" | jq -r '.cache_savings')

# Get top 3 models by cost
TOP_MODELS=$(echo "$COST_JSON" | jq -r '
  .by_model | to_entries | sort_by(-.value.total_cost) | .[0:3] |
  map("• \(.key | split("/")[1]): $\(.value.total_cost | . * 100 | round / 100) (\(.value.count) msgs)")
  | join("\n")
')

# Format message
MESSAGE="📊 *Yesterday's API Costs* ($YESTERDAY)

$TOP_MODELS
─────────────────
*Total:* \$$(printf "%.2f" "$TOTAL_COST")
*Tokens:* $(printf "%'d" "$TOTAL_TOKENS" | sed 's/,/ /g')
*Messages:* $MSG_COUNT
*Cache Saved:* \$$(printf "%.2f" "$CACHE_SAVINGS")"

# Send
send_telegram "$MESSAGE"
log "Report sent: \$$TOTAL_COST"

echo "Report sent successfully"
