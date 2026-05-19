#!/usr/bin/env bash
# bookmark-pipeline-watchdog.sh — Hourly health check for the X→raindrop→discord chain.
#
# Checks (any failure → exit 1 + log + optional Telegram alert):
#   1. ~/.birdclaw/birdclaw.sqlite mtime — last X scrape must be within $X_STALE_HOURS
#   2. ~/clawd/logs/birdclaw-raindrop-sync.log tail — last successful sync within $SYNC_STALE_HOURS
#   3. ~/clawd/logs/bookmark-sync.log tail — last poll within $POLL_STALE_HOURS
#
# Idempotent + cron-safe. Recommended cron:
#   0 * * * * /Users/ai/clawd/scripts/bookmark-pipeline-watchdog.sh >> /Users/ai/clawd/logs/bookmark-watchdog.log 2>&1
#
# Env (optional):
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — if both set, alerts post to Telegram
#
# Owner: Worker 6, 2026-05-14

set -uo pipefail

SQLITE="${BIRDCLAW_SQLITE:-$HOME/.birdclaw/birdclaw.sqlite}"
SYNC_LOG="${SYNC_LOG:-$HOME/clawd/logs/birdclaw-raindrop-sync.log}"
POLL_LOG="${POLL_LOG:-$HOME/clawd/logs/bookmark-sync.log}"
WATCHDOG_LOG="${WATCHDOG_LOG:-$HOME/clawd/logs/bookmark-watchdog.log}"

X_STALE_HOURS="${X_STALE_HOURS:-4}"
SYNC_STALE_HOURS="${SYNC_STALE_HOURS:-4}"
POLL_STALE_HOURS="${POLL_STALE_HOURS:-1}"

mkdir -p "$(dirname "$WATCHDOG_LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$WATCHDOG_LOG"; }

ERRORS=()

age_hours() {
  # Print integer hours since file mtime; 99999 if missing.
  local f="$1"
  if [[ ! -e "$f" ]]; then
    echo 99999
    return
  fi
  local mtime
  mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
  local now
  now=$(date +%s)
  echo $(( (now - mtime) / 3600 ))
}

# Check 1: sqlite freshness (X scrape watermark)
sqlite_age=$(age_hours "$SQLITE")
if (( sqlite_age > X_STALE_HOURS )); then
  ERRORS+=("birdclaw.sqlite stale: ${sqlite_age}h since last X scrape (threshold ${X_STALE_HOURS}h)")
fi

# Check 2: raindrop sync log freshness
sync_age=$(age_hours "$SYNC_LOG")
if (( sync_age > SYNC_STALE_HOURS )); then
  ERRORS+=("birdclaw-raindrop-sync.log stale: ${sync_age}h (threshold ${SYNC_STALE_HOURS}h)")
fi

# Check 3: bookmark-sync (poll) log freshness
poll_age=$(age_hours "$POLL_LOG")
if (( poll_age > POLL_STALE_HOURS )); then
  ERRORS+=("bookmark-sync.log stale: ${poll_age}h (threshold ${POLL_STALE_HOURS}h)")
fi

# Check 4: recent ERROR/FATAL in sync log tails (last 50 lines, last 6h window via timestamps is too fragile — just grep)
if [[ -f "$SYNC_LOG" ]]; then
  if tail -50 "$SYNC_LOG" | grep -qiE 'fatal|error|exception' 2>/dev/null; then
    last_err=$(tail -50 "$SYNC_LOG" | grep -iE 'fatal|error|exception' | tail -1)
    ERRORS+=("recent error in raindrop-sync.log: ${last_err:0:120}")
  fi
fi

if (( ${#ERRORS[@]} == 0 )); then
  log "OK sqlite=${sqlite_age}h sync=${sync_age}h poll=${poll_age}h"
  exit 0
fi

# Failure path
msg="BOOKMARK PIPELINE FAILURE: ${#ERRORS[@]} issue(s)"
for e in "${ERRORS[@]}"; do
  msg="$msg | $e"
done
log "FAIL $msg"

# Optional Telegram alert
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  curl -fsS --max-time 10 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=${msg}" >/dev/null 2>&1 \
    && log "alert sent to Telegram" \
    || log "Telegram alert failed"
fi

exit 1
