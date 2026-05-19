#!/usr/bin/env bash
# check-hd-mount.sh — Alert if External HD unmounted for >24h
# Cron: 0 */6 * * * (every 6 hours)
# Cooldown: re-alerts at most once per 7 days after the initial 24h trigger.
set -euo pipefail

MOUNT_PATH="/Volumes/Extreme Pro/clawd-live/"
MARKER="/tmp/clawd-hd-last-seen"
ALERT_STATE="${HOME}/.openclaw/hd-mount-alert-state"
MAX_AGE=86400       # 24 hours — minimum absence before first alert
ALERT_COOLDOWN=604800  # 7 days — minimum gap between repeated alerts

if [ -d "$MOUNT_PATH" ]; then
  touch "$MARKER"
  # HD is back — reset alert state so the next absence starts fresh
  rm -f "$ALERT_STATE"
  exit 0
fi

# Not mounted — check how long it's been gone
if [ ! -f "$MARKER" ]; then
  ELAPSED=$((MAX_AGE + 1))
else
  LAST_SEEN=$(stat -f %m "$MARKER" 2>/dev/null)
  NOW=$(date +%s)
  ELAPSED=$((NOW - LAST_SEEN))
fi

# Only alert if absent long enough
if [ "$ELAPSED" -lt "$MAX_AGE" ]; then
  exit 0
fi

# Cooldown: skip if we already alerted within the last 7 days
if [ -f "$ALERT_STATE" ]; then
  LAST_ALERT=$(stat -f %m "$ALERT_STATE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  SINCE_ALERT=$((NOW - LAST_ALERT))
  if [ "$SINCE_ALERT" -lt "$ALERT_COOLDOWN" ]; then
    exit 0
  fi
fi

# Guard: skip if Telegram token is not available
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  # Try loading from .env as a fallback (it may be regenerated from 1Password)
  # shellcheck source=/dev/null
  [ -f "${HOME}/.openclaw/.env" ] && source "${HOME}/.openclaw/.env"
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  exit 0
fi

# Send alert and record the time to enforce cooldown
touch "$ALERT_STATE"
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=6418588155" \
  -d "text=⚠️ External HD unmounted for >24h. Backups accumulating on internal disk." \
  > /dev/null 2>&1 || true
