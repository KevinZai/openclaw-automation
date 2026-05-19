#!/usr/bin/env bash
# cron-error-watchdog.sh — Improvement #2 from 2026-05-13 audit campaign.
# Runs every 6h via cron. Greps `openclaw cron list` for "error" status.
# Posts to Discord #🚨alerts if any errors found. Self-excludes (won't alert about its own failure cycle).
# Idempotent: only alerts if errors are NEW (cache last alert digest).
set -uo pipefail

LOG=~/clawd/logs/cron-error-watchdog.log
CACHE=~/clawd/scripts/.cron-error-watchdog.cache
DISCORD_CHANNEL_ALERTS="${DISCORD_CHANNEL_ALERTS:-1480676421457416306}"  # comms-log fallback if no dedicated alerts channel
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog tick" >> "$LOG"

ERRORS=$(openclaw cron list 2>&1 | grep " error " || true)
ERR_COUNT=$(echo "$ERRORS" | grep -c " error " 2>/dev/null || echo 0)

if [ "$ERR_COUNT" -eq 0 ]; then
  echo "  ✅ 0 cron errors" >> "$LOG"
  exit 0
fi

# Build a digest of the error set (job names only — ignore timing churn)
DIGEST=$(echo "$ERRORS" | awk '{print $2}' | sort -u | md5)

# Compare to last digest — only alert on NEW error sets
LAST_DIGEST=$(cat "$CACHE" 2>/dev/null || echo "")
if [ "$DIGEST" = "$LAST_DIGEST" ]; then
  echo "  ⏸️  $ERR_COUNT errors but digest unchanged — skip alert" >> "$LOG"
  exit 0
fi
echo "$DIGEST" > "$CACHE"

# Build the alert body (top 10 erroring jobs)
JOBS=$(echo "$ERRORS" | awk '{$1=""; print substr($0,2,80)}' | head -10)
BODY=$(printf "🚨 OpenClaw cron errors: %d job(s)\\n\\n%s\\n\\n(Digest: %s)" "$ERR_COUNT" "$JOBS" "${DIGEST:0:8}")

if [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "  ⚠️  no DISCORD_BOT_TOKEN — alert NOT posted: $ERR_COUNT errors" >> "$LOG"
  echo "$BODY" >> "$LOG"
  exit 0
fi

# Post to Discord
HTTP=$(curl -s -o /tmp/cron-watchdog-resp -w "%{http_code}" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ALERTS}/messages" \
  -d "$(jq -n --arg c "$BODY" '{content: $c}')")

if [ "$HTTP" = "200" ]; then
  echo "  📨 alerted Discord ($ERR_COUNT errors, digest ${DIGEST:0:8})" >> "$LOG"
else
  echo "  ❌ Discord post failed (HTTP $HTTP): $(cat /tmp/cron-watchdog-resp 2>/dev/null | head -c 200)" >> "$LOG"
fi
