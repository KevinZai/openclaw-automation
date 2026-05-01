#!/usr/bin/env bash
# Part of openclaw-automation — https://github.com/KevinZai/openclaw-automation
# weekly-cost-summary.sh — 7-day spend rollup vs $50/week budget → Telegram
# Cron: 5 9 * * 1 (Monday 9:05 AM, offset 5min from linear-weekly-pulse)
# P1 — Cost monitoring
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

LOG="${CLAWD_DIR:-$HOME/clawd}/logs/weekly-cost-summary.log"
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)
WEEKLY_BUDGET=50
REPORTS_DIR="${CLAWD_DIR:-$HOME/clawd}/shared/reports"

mkdir -p "$REPORTS_DIR"

source ~/.openclaw/.env 2>/dev/null || true

log() { echo "$TIMESTAMP $1" >> "$LOG"; }

send_telegram() {
  [ -z "${TELEGRAM_BOT_TOKEN:-}" ] && return
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID:-}" \
    -d "text=$1" \
    -d "parse_mode=Markdown" > /dev/null 2>&1
}

COST_TRACKER="${CLAWD_DIR:-$HOME/clawd}/skills/cost-tracker/scripts/track.py"
COST_JSON=$(python3 "$COST_TRACKER" --days 7 --by-model --format json 2>/dev/null)

if [ -z "$COST_JSON" ]; then
  log "ERROR: No cost data from tracker"
  send_telegram "⚠️ Weekly cost summary failed — no data from cost tracker"
  exit 1
fi

TOTAL=$(echo "$COST_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d.get(\"total_cost\",0):.2f}')" 2>/dev/null || echo "0.00")
MSGS=$(echo "$COST_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message_count',0))" 2>/dev/null || echo "0")
CACHE=$(echo "$COST_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d.get(\"cache_savings\",0):.2f}')" 2>/dev/null || echo "0.00")

PCT=$(python3 -c "print(f'{float(\"$TOTAL\")/float(\"$WEEKLY_BUDGET\")*100:.0f}')" 2>/dev/null || echo "?")
WEEK=$(date -v-7d '+%b %d' 2>/dev/null || date -d '7 days ago' '+%b %d')
TODAY=$(date '+%b %d')

STATUS_EMOJI="✅"
[ "$(echo "$TOTAL > $WEEKLY_BUDGET" | bc 2>/dev/null)" = "1" ] && STATUS_EMOJI="🚨"
[ "$(echo "$TOTAL > $(echo "$WEEKLY_BUDGET * 0.8" | bc)" | bc 2>/dev/null)" = "1" ] && STATUS_EMOJI="⚠️"

TOP_MODELS=$(echo "$COST_JSON" | python3 -c "
import sys,json
d=json.load(sys.stdin)
models=sorted(d.get('by_model',{}).items(), key=lambda x: x[1].get('total_cost',0), reverse=True)[:3]
for name,data in models:
    short=name.split('/')[-1] if '/' in name else name
    print(f'• {short}: \${data[\"total_cost\"]:.2f}')
" 2>/dev/null || echo "• no model data")

MSG="$STATUS_EMOJI *Weekly Cost* ($WEEK–$TODAY)

$TOP_MODELS
──────────────
*Total:* \$$TOTAL / \$$WEEKLY_BUDGET ($PCT%)
*Messages:* $MSGS | *Cache saved:* \$$CACHE"

log "Weekly summary: \$$TOTAL / \$$WEEKLY_BUDGET"
send_telegram "$MSG"

# Write report file
echo "# Weekly Cost Report — $TODAY
Total: \$$TOTAL / \$$WEEKLY_BUDGET budget ($PCT%)
Messages: $MSGS
Cache savings: \$$CACHE
Generated: $TIMESTAMP" > "$REPORTS_DIR/weekly-cost-$(date +%Y-%m-%d).md"
