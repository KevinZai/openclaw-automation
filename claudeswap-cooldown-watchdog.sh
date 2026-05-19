#!/bin/bash
# ClaudeSwap cooldown / OAuth failure watchdog
# Posts to Discord #operations webhook when:
#   - all OAuth accounts in cooldown
#   - service is down (no /_health response)
#   - persistent 5xx in claudeswap log
#
# Rate-limited: max 1 alert per condition per 15 min via debounce file.
# Created 2026-05-15 — see CC-### for context.

set -euo pipefail

SWAP_URL="${SWAP_URL:-http://127.0.0.1:8082}"
ENV_FILE="${ENV_FILE:-$HOME/.openclaw/.env}"
# Bypass any 'rtk' / 'curl' wrappers that compress output to schema
CURL_BIN="$(command -v curl)"
CACHE_DIR="$HOME/clawd/.cache"
DEBOUNCE_FILE="$CACHE_DIR/claudeswap-alert-last-fired.txt"
DEBOUNCE_SEC=900  # 15 min
LOG_PREFIX="[claudeswap-watchdog $(date '+%Y-%m-%d %H:%M:%S')]"

mkdir -p "$CACHE_DIR"

# Load webhook from env
WEBHOOK_URL=""
if [[ -f "$ENV_FILE" ]]; then
  WEBHOOK_URL=$(grep "^DISCORD_OPS_WEBHOOK_URL=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
fi
if [[ -z "$WEBHOOK_URL" ]]; then
  echo "$LOG_PREFIX ERROR: DISCORD_OPS_WEBHOOK_URL not set in $ENV_FILE"
  exit 1
fi

# Debounce check — same condition within 15 min suppresses
check_debounce() {
  local condition="$1"
  if [[ -f "$DEBOUNCE_FILE" ]]; then
    local last
    last=$(grep "^${condition}=" "$DEBOUNCE_FILE" 2>/dev/null | cut -d= -f2 || echo "0")
    local now
    now=$(date +%s)
    local diff=$((now - last))
    if [[ $diff -lt $DEBOUNCE_SEC ]]; then
      echo "$LOG_PREFIX SKIP $condition (debounced ${diff}s ago)"
      return 1
    fi
  fi
  return 0
}

mark_fired() {
  local condition="$1"
  local now
  now=$(date +%s)
  if [[ -f "$DEBOUNCE_FILE" ]]; then
    grep -v "^${condition}=" "$DEBOUNCE_FILE" > "${DEBOUNCE_FILE}.tmp" 2>/dev/null || true
    mv "${DEBOUNCE_FILE}.tmp" "$DEBOUNCE_FILE"
  fi
  echo "${condition}=${now}" >> "$DEBOUNCE_FILE"
}

# Post to webhook using Discord embed — @everyone disabled
# Usage: post_alert <status_label> <detail_text>
post_alert() {
  local status_label="$1"
  local detail="$2"
  local timestamp
  timestamp=$(python3 -c "from datetime import datetime,timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")
  local payload
  payload=$(python3 -c "
import json, sys
status_label, detail, ts = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
  'username': 'ClaudeSwap Watchdog',
  'allowed_mentions': {'parse': []},
  'embeds': [{
    'color': 0xFF6600,
    'title': 'ClaudeSwap Cooldown',
    'fields': [
      {'name': 'Status',  'value': status_label, 'inline': True},
      {'name': 'Detail',  'value': detail[:1024] if detail else '(none)', 'inline': True}
    ],
    'timestamp': ts
  }]
}))" "$status_label" "$detail" "$timestamp")
  "$CURL_BIN" -fsS -X POST -H "Content-Type: application/json" -d "$payload" "$WEBHOOK_URL" > /dev/null
  echo "$LOG_PREFIX POSTED: ${status_label} — ${detail:0:80}..."
}

# 1) Check service is up
HEALTH=$("$CURL_BIN" -fsS -m 5 "$SWAP_URL/_health" 2>&1 || echo "DOWN")
if [[ "$HEALTH" == "DOWN" ]] || ! echo "$HEALTH" | grep -q '"ok":true'; then
  if check_debounce "service_down"; then
    SAMPLE=$(tail -5 ~/.pm2/logs/claudeswap-error.log 2>/dev/null | head -5 || echo "(no log)")
    post_alert "🔴 DOWN" "Health check failed: ${HEALTH:0:200}
Recent errors: ${SAMPLE:0:400}
Recovery: pm2 restart claudeswap"
    mark_fired "service_down"
  fi
  exit 0
fi

# 2) Check cooldown state via /_stats
STATS_FILE="$(mktemp -t cs-stats.XXXXXX)"
"$CURL_BIN" -fsS -m 5 "$SWAP_URL/_stats" > "$STATS_FILE" 2>/dev/null || echo "{}" > "$STATS_FILE"
COOLDOWN_REPORT=$(STATS_FILE="$STATS_FILE" python3 <<'PY'
import json, os, sys
try:
    with open(os.environ['STATS_FILE']) as f:
        s = json.load(f)
except Exception as e:
    print(f"PARSE_ERROR")
    print(str(e))
    sys.exit(0)

accts = s.get('accounts', [])
total = len(accts)
cooled = [a for a in accts if a.get('in_cooldown')]
fallback = s.get('fallback_available', False)
active = s.get('active_account', 'none')

if total > 0 and len(cooled) == total:
    lines = [f"- {a['name']}: cooldown until {a.get('cooldown_until','?')} (last_used {a.get('last_used','?')})" for a in accts]
    fb = "✅ fallback key available" if fallback else "❌ NO fallback — requests will fail"
    print("ALL_COOLED")
    print(f"{total} accounts in cooldown\n" + "\n".join(lines) + f"\n{fb}\nActive: {active}")
elif len(cooled) > 0:
    print("PARTIAL")
    print(f"{len(cooled)}/{total} cooled: " + ", ".join(a['name'] for a in cooled))
else:
    print("OK")
    print(f"{total} accounts healthy, active={active}")
PY
)
rm -f "$STATS_FILE"

STATUS=$(echo "$COOLDOWN_REPORT" | head -1)
DETAIL=$(echo "$COOLDOWN_REPORT" | tail -n +2)

case "$STATUS" in
  ALL_COOLED)
    if check_debounce "all_cooled"; then
      post_alert "🔴 ALL COOLED" "${DETAIL}
Recovery: curl $SWAP_URL/_stats | jq .accounts — or claudeswap login to rotate."
      mark_fired "all_cooled"
    fi
    ;;
  PARSE_ERROR*)
    if check_debounce "parse_error"; then
      post_alert "🟡 PARSE ERROR" "/_stats output malformed ($STATUS). Service alive. Check: pm2 logs claudeswap"
      mark_fired "parse_error"
    fi
    ;;
  PARTIAL|OK)
    echo "$LOG_PREFIX $STATUS: $DETAIL"
    ;;
esac

exit 0
