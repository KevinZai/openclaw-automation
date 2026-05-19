#!/usr/bin/env bash
# cost-check-intraday.sh — Midday cost check, alert if over budget pace
# Cron: 0 13 * * * (1 PM daily — midday check)
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$HOME/.bun/bin:$PATH"
LOG="/Users/ai/clawd/logs/cost-intraday.log"
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)
DAILY_BUDGET=10  # $10/day budget

# Query openclaw for today's spend (if available)
SPEND=$(openclaw status --json 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    cost=d.get('cost',{}).get('today',0)
    print(f'{cost:.2f}')
except:
    print('0.00')
" 2>/dev/null)

SPEND=${SPEND:-0.00}
echo "$TIMESTAMP spend=\$$SPEND budget=\$$DAILY_BUDGET" >> "$LOG"

# Alert if over 60% of daily budget by midday (on pace to exceed)
THRESHOLD=$(echo "$DAILY_BUDGET * 0.6" | bc 2>/dev/null || echo "6.00")
if [ "$(echo "$SPEND > $THRESHOLD" | bc 2>/dev/null)" = "1" ]; then
  MSG="💸 Cost alert: \$$SPEND spent by midday (budget: \$$DAILY_BUDGET/day). On pace to exceed."
  echo "$TIMESTAMP ALERT: $MSG" >> "$LOG"

  if curl -sf --max-time 2 http://127.0.0.1:18789/health >/dev/null 2>&1; then
    openclaw message send --channel discord --message "$MSG" --silent 2>/dev/null
  fi
fi
