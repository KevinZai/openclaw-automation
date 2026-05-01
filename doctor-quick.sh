#!/usr/bin/env bash
# Part of openclaw-automation — https://github.com/KevinZai/openclaw-automation
# doctor-quick.sh — fast health probe for OpenClaw + disk + channels.
# Designed for `openclaw cron` every 15 min. Writes compact one-line status
# to /tmp/openclaw/doctor-quick.log and posts to Discord if any check fails.
# Non-blocking: never runs `openclaw doctor --fix`.

set -euo pipefail
LOG=/tmp/openclaw/doctor-quick.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null
TS=$(date +%Y-%m-%dT%H:%M:%S%z)
STATUS="OK"
DETAILS=""

# 1. Disk check — alert if root usage >= 90%
DISK_PCT=$(df / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [[ -n "$DISK_PCT" && "$DISK_PCT" -ge 90 ]]; then
  STATUS="WARN"
  DETAILS+="disk=${DISK_PCT}% "
else
  DETAILS+="disk=${DISK_PCT}% "
fi

# 2. Gateway port check (loopback 18789)
if lsof -iTCP:18789 -sTCP:LISTEN -P -n 2>/dev/null | grep -q LISTEN; then
  DETAILS+="gw=up "
else
  STATUS="FAIL"
  DETAILS+="gw=DOWN "
fi

# 3. HTTP probe
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/ 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "401" || "$HTTP_CODE" == "403" ]]; then
  DETAILS+="http=${HTTP_CODE} "
else
  [[ "$STATUS" != "FAIL" ]] && STATUS="WARN"
  DETAILS+="http=${HTTP_CODE} "
fi

# Portable timeout: gtimeout (coreutils) if available, else Perl fallback, else no-op
_tmo() {
  local secs="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then perl -e 'my $s=shift; eval{local $SIG{ALRM}=sub{exit 124};alarm $s;exec @ARGV;};exit 124' "$secs" "$@"
  else "$@"
  fi
}

# 4. Channel probe — up = configured+running+probe.ok ; down = configured and not up
if command -v openclaw >/dev/null 2>&1; then
  CHAN_OUT=$(_tmo 20 openclaw channels status --probe --json 2>/dev/null || true)
  read -r UP DOWN <<<"$(printf '%s' "$CHAN_OUT" | python3 -c 'import json,sys
try:
  d=json.loads(sys.stdin.read() or "{}")
  cs=d.get("channels",{}) or {}
  up=down=0
  for _,c in cs.items():
    if not c.get("configured"): continue
    probe_ok=(c.get("probe") or {}).get("ok") is True
    if c.get("running") and probe_ok and not c.get("lastError"): up+=1
    else: down+=1
  print(up,down)
except Exception as e: print(0,0)')"
  UP=${UP:-0}; DOWN=${DOWN:-0}
  DETAILS+="chan_up=${UP} chan_down=${DOWN} "
  if [[ "$DOWN" -gt 0 && "$STATUS" == "OK" ]]; then STATUS="WARN"; fi
fi

# 5. Auth freshness — count profiles with expired/stale status (ignores ghost profiles removed from config)
AUTH_EXPIRED=$(_tmo 30 openclaw doctor 2>&1 | grep -cE ': expired \(0m\)' || true)
AUTH_EXPIRED=${AUTH_EXPIRED:-0}
DETAILS+="auth_expired=${AUTH_EXPIRED} "
if [[ "$AUTH_EXPIRED" -gt 0 && "$STATUS" == "OK" ]]; then STATUS="WARN"; fi

LINE="${TS} ${STATUS} ${DETAILS}"
echo "$LINE" | tee -a "$LOG"

# Discord alert for FAIL or WARN with disk/gw problems
if [[ "$STATUS" == "FAIL" || ( "$STATUS" == "WARN" && ( "$DISK_PCT" -ge 90 || "$AUTH_EXPIRED" -gt 0 ) ) ]]; then
  WEBHOOK="${DISCORD_ALERT_WEBHOOK:-}"
  if [[ -n "$WEBHOOK" ]]; then
    PAYLOAD=$(printf '{"content":"[oc-doctor-quick] %s — %s"}' "$STATUS" "$DETAILS")
    curl -s -H 'Content-Type: application/json' -d "$PAYLOAD" "$WEBHOOK" >/dev/null 2>&1 || true
  fi
fi
