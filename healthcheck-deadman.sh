#!/usr/bin/env bash
# healthcheck-deadman.sh — Dead-man's switch for clawd-healthcheck
# Alerts if healthcheck.log hasn't been updated in 35+ minutes
# Cron: */30 * * * * /bin/bash /Users/ai/clawd/scripts/healthcheck-deadman.sh
set -euo pipefail

LOG="/Users/ai/clawd/logs/healthcheck.log"
MAX_AGE_SECONDS=2100  # 35 minutes

source ~/.openclaw/.env 2>/dev/null || true

send_alert() {
  local msg="$1"
  echo "$(date +%Y-%m-%dT%H:%M:%S) DEADMAN ALERT: $msg"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=6418588155" \
      -d "text=⚠️ DEADMAN: $msg" > /dev/null
  fi
}

if [[ ! -f "$LOG" ]]; then
  send_alert "healthcheck.log does not exist. Cron or script may be broken."
  exit 1
fi

last_modified=$(stat -f %m "$LOG" 2>/dev/null)
now=$(date +%s)
age=$(( now - last_modified ))

if (( age > MAX_AGE_SECONDS )); then
  age_min=$(( age / 60 ))
  send_alert "healthcheck.log not updated in ${age_min}+ minutes. Cron may be broken."
  exit 1
fi

echo "$(date +%Y-%m-%dT%H:%M:%S) OK: healthcheck.log updated ${age}s ago"
