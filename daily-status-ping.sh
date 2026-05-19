#!/bin/bash
# daily-status-ping.sh — Quick daily status check
# Runs via OpenClaw cron (daily 8 AM)
set -euo pipefail

DATE=$(date +%Y-%m-%d)

# Quick health check of all critical services
HEALTH=""
for svc in "3100:Paperclip" "18789:OpenClaw" "5678:n8n" "4681:CloudCLI" "4680:Fleet" "3004:MissionControl"; do
  IFS=: read port name <<< "$svc"
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:$port" 2>/dev/null) || code="ERR"
  if [ "$code" = "200" ]; then
    HEALTH="$HEALTH\n- $name: UP"
  elif [ "$code" = "000" ] || [ "$code" = "ERR" ]; then
    HEALTH="$HEALTH\n- $name: DOWN (no response)"
  else
    HEALTH="$HEALTH\n- $name: DOWN (HTTP $code)"
  fi
done

# Count active Paperclip issues
ACTIVE=$(curl -s --max-time 3 "http://localhost:3100/api/companies/d852cff2-1645-4c48-ae14-010bd8230444/issues" 2>/dev/null | python3 -c "
import sys,json
issues=json.load(sys.stdin)
active=[i for i in issues if i.get('status') not in ('done','cancelled')]
print(len(active))
" 2>/dev/null || echo "DEGRADED")

# PM2 status
ONLINE=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; procs=json.load(sys.stdin); online=sum(1 for p in procs if p['pm2_env']['status']=='online'); print(f'{online}/{len(procs)}')" 2>/dev/null || echo "?")

UP_COUNT=$(echo -e "$HEALTH" | grep -c "UP" || echo "0")
echo "[$DATE] Services: $UP_COUNT/6 UP | PM2: $ONLINE | Active issues: $ACTIVE"

# Write to daily brief (always emit, even in degraded state)
BRIEF_DIR="/Users/ai/clawd/shared/daily-brief"
mkdir -p "$BRIEF_DIR"
DEGRADED_MARKER=""
if echo "$HEALTH" | grep -q "DOWN" || [ "$ACTIVE" = "DEGRADED" ] || [ "$ONLINE" = "?" ]; then
  DEGRADED_MARKER="\n> **DEGRADED** — one or more probes failed; partial data shown."
fi
printf "# Daily Status — %s%s\n\n## Services\n%b\n\n## Metrics\n- PM2: %s online\n- Active Paperclip issues: %s\n\n---\n*Auto-generated*\n" \
  "$DATE" "$(echo -e "$DEGRADED_MARKER")" "$(echo -e "$HEALTH")" "$ONLINE" "$ACTIVE" \
  > "$BRIEF_DIR/status-$DATE.md"
exit 0
