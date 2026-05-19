#!/usr/bin/env bash
# obsidian-sync-watchdog.sh — Improvement #8 from 2026-05-13 audit campaign.
#
# Runs every 6h via cron. Checks freshness markers for each cron'd Obsidian
# vault sync script. Posts a Discord alert if any sync hasn't succeeded
# within STALE_HOURS (default 24h).
#
# Pattern mirrors cron-error-watchdog.sh:
#   - log to ~/clawd/logs/obsidian-sync-watchdog.log
#   - cache md5 digest of stale-set; only alert when set CHANGES
#   - Discord channel via $DISCORD_CHANNEL_ALERTS env (fallback comms-log)
#   - Soft-fail if $DISCORD_BOT_TOKEN missing (log-only)
#
# Design notes:
#   - Macos BSD `stat -f %m <file>` for mtime (epoch seconds)
#   - We DO NOT fire any sync — read-only freshness check
#   - Each sync script gets a single most-trustworthy marker (state file
#     preferred over log mtime; log mtime acceptable when no state file)

set -uo pipefail

LOG=~/clawd/logs/obsidian-sync-watchdog.log
CACHE=~/clawd/scripts/.obsidian-sync-watchdog.cache
STALE_HOURS="${STALE_HOURS:-24}"
DISCORD_CHANNEL_ALERTS="${DISCORD_CHANNEL_ALERTS:-1480676421457416306}"
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"

mkdir -p "$(dirname "$LOG")"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog tick (stale_hours=$STALE_HOURS)" >> "$LOG"

NOW=$(date +%s)
STALE_SECS=$((STALE_HOURS * 3600))

# ── Marker map ─────────────────────────────────────────────────────
# Format: "label|path"
#   label  — short script name shown in alert
#   path   — file whose mtime indicates last successful run (or last
#            attempted run; for log-mtime markers we trust crond ran it)
#
# Keep this list in sync with crontab entries that touch the vault.
MARKERS=(
  "vault-sync/sync.sh|/Users/ai/clawd/tools/vault-sync/.last-sync-ts"
  "vault-sync/incremental-sync.sh|/Users/ai/clawd/tools/vault-sync/.last-sync-ts"
  "vault-sync/git-backup.sh|/Users/ai/clawd/logs/vault-git-backup.log"
  "scripts/sync-to-obsidian.sh|/Users/ai/clawd/logs/sync-to-obsidian.log"
  "scripts/sync-obsidian-docs.sh|/Users/ai/clawd/logs/sync-obsidian-docs.log"
  "scripts/gbrain-sync.sh|/Users/ai/clawd/logs/gbrain-sync.log"
  "scripts/bookmark-sync.cjs|/Users/ai/clawd/logs/bookmark-sync.log"
  "scripts/birdclaw-raindrop-sync.cjs|/Users/ai/clawd/scripts/.birdclaw-bridge-state.json"
)

STALE_LIST=""
STALE_COUNT=0
MISSING_LIST=""
MISSING_COUNT=0

for entry in "${MARKERS[@]}"; do
  LABEL="${entry%%|*}"
  MARKER="${entry##*|}"

  if [ ! -e "$MARKER" ]; then
    MISSING_LIST+="  - $LABEL  (marker missing: $MARKER)"$'\n'
    MISSING_COUNT=$((MISSING_COUNT + 1))
    echo "  ❓ $LABEL — marker $MARKER not found" >> "$LOG"
    continue
  fi

  MTIME=$(stat -f %m "$MARKER" 2>/dev/null || echo 0)
  AGE_SECS=$((NOW - MTIME))
  AGE_HOURS=$((AGE_SECS / 3600))

  if [ "$AGE_SECS" -gt "$STALE_SECS" ]; then
    HUMAN=$(date -r "$MTIME" '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)
    STALE_LIST+="  - $LABEL  (${AGE_HOURS}h stale, last $HUMAN)"$'\n'
    STALE_COUNT=$((STALE_COUNT + 1))
    echo "  ⚠️  $LABEL — ${AGE_HOURS}h stale (last $HUMAN)" >> "$LOG"
  else
    echo "  ✅ $LABEL — ${AGE_HOURS}h fresh" >> "$LOG"
  fi
done

TOTAL_STALE=$((STALE_COUNT + MISSING_COUNT))
if [ "$TOTAL_STALE" -eq 0 ]; then
  echo "  ✅ all ${#MARKERS[@]} markers fresh" >> "$LOG"
  exit 0
fi

# ── Idempotency: only alert when stale-set DIGEST changes ──────────
DIGEST=$(printf "%s%s" "$STALE_LIST" "$MISSING_LIST" | md5)
LAST_DIGEST=$(cat "$CACHE" 2>/dev/null || echo "")
if [ "$DIGEST" = "$LAST_DIGEST" ]; then
  echo "  ⏸️  $TOTAL_STALE stale ($STALE_COUNT old, $MISSING_COUNT missing) — digest unchanged, skip alert" >> "$LOG"
  exit 0
fi
echo "$DIGEST" > "$CACHE"

# ── Build alert body ───────────────────────────────────────────────
BODY=$(printf "📉 Obsidian sync watchdog — %d sync(s) stale (>%dh)\\n\\n" "$TOTAL_STALE" "$STALE_HOURS")
if [ "$STALE_COUNT" -gt 0 ]; then
  BODY+=$(printf "**Stale (%d):**\\n%s" "$STALE_COUNT" "$STALE_LIST")
fi
if [ "$MISSING_COUNT" -gt 0 ]; then
  BODY+=$(printf "\\n**Missing markers (%d):**\\n%s" "$MISSING_COUNT" "$MISSING_LIST")
fi
BODY+=$(printf "\\n(Digest: %s · log: ~/clawd/logs/obsidian-sync-watchdog.log)" "${DIGEST:0:8}")

if [ -z "$DISCORD_BOT_TOKEN" ]; then
  echo "  ⚠️  no DISCORD_BOT_TOKEN — alert NOT posted ($TOTAL_STALE stale)" >> "$LOG"
  printf "%s\n" "$BODY" >> "$LOG"
  exit 0
fi

HTTP=$(curl -s -o /tmp/obsidian-watchdog-resp -w "%{http_code}" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ALERTS}/messages" \
  -d "$(jq -n --arg c "$BODY" '{content: $c}')")

if [ "$HTTP" = "200" ]; then
  echo "  📨 alerted Discord ($TOTAL_STALE stale, digest ${DIGEST:0:8})" >> "$LOG"
else
  echo "  ❌ Discord post failed (HTTP $HTTP): $(cat /tmp/obsidian-watchdog-resp 2>/dev/null | head -c 200)" >> "$LOG"
fi
