#!/usr/bin/env bash
# Part of openclaw-automation — https://github.com/KevinZai/openclaw-automation
# LLM Fleet Audit — runs bi-weekly to check provider health and model freshness
# Registered in crontab: 0 9 1,15 * * ~/clawd/scripts/llm-fleet-audit.sh >> ~/clawd/logs/llm-fleet-audit.log 2>&1
# Zero LLM cost — only API metadata endpoints

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="${CLAWD_DIR:-$HOME/clawd}/scripts"
LOG_DIR="${CLAWD_DIR:-$HOME/clawd}/logs"
STATE_FILE="${SCRIPT_DIR}/.llm-audit-state.json"
RESULTS_FILE="${SCRIPT_DIR}/llm-audit-results.txt"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

# Load secrets (Telegram, Cloudflare, etc.)
# shellcheck source=/dev/null
[[ -f ~/.openclaw/.env ]] && source ~/.openclaw/.env

mkdir -p "$LOG_DIR"

NOW=$(date '+%Y-%m-%d %H:%M')
TODAY=$(date '+%Y-%m-%d')

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# ── Helpers ───────────────────────────────────────────────────────────────────

# Returns HTTP status code for a URL; empty string on connection error
http_code() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$1" 2>/dev/null || echo "000"
}

# GETs JSON body; empty string on failure
json_get() {
  curl -s --max-time 15 "$@" 2>/dev/null || echo ""
}

# Counts top-level array items in JSON; 0 if malformed
count_array() {
  local json="$1" path="${2:-.}"
  echo "$json" | jq -r "${path} | length" 2>/dev/null || echo "0"
}

# ── Previous state ────────────────────────────────────────────────────────────
prev_state="{}"
[[ -f "$STATE_FILE" ]] && prev_state=$(cat "$STATE_FILE")

prev_count() {
  local provider="$1"
  echo "$prev_state" | jq -r ".${provider}.models // 0" 2>/dev/null || echo "0"
}

# ── Provider checks ───────────────────────────────────────────────────────────

# Groq
check_groq() {
  local resp
  resp=$(json_get -H "Authorization: Bearer ${GROQ_API_KEY:-}" \
    "https://api.groq.com/openai/v1/models")
  local count
  count=$(count_array "$resp" ".data")
  if [[ "$count" -gt 0 ]]; then
    echo "ok|$count"
  else
    echo "down|0"
  fi
}

# Cloudflare Workers AI
check_cloudflare() {
  local cf_account="${CLOUDFLARE_ACCOUNT_ID:-}"
  if [[ -z "$cf_account" ]]; then
    echo "skip|0"
    return
  fi
  local resp
  resp=$(json_get -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}" \
    "https://api.cloudflare.com/client/v4/accounts/${cf_account}/ai/models/search")
  local ok
  ok=$(echo "$resp" | jq -r ".success // false" 2>/dev/null || echo "false")
  local count
  count=$(count_array "$resp" ".result")
  if [[ "$ok" == "true" && "$count" -gt 0 ]]; then
    echo "ok|$count"
  elif [[ "$ok" == "false" ]]; then
    echo "auth|$count"
  else
    echo "down|0"
  fi
}

# Cerebras
check_cerebras() {
  local resp
  resp=$(json_get -H "Authorization: Bearer ${CEREBRAS_API_KEY:-}" \
    "https://api.cerebras.ai/v1/models")
  local count
  count=$(count_array "$resp" ".data")
  if [[ "$count" -gt 0 ]]; then
    echo "ok|$count"
  else
    echo "down|0"
  fi
}

# OpenRouter (count free models — id contains ":free")
check_openrouter() {
  local resp
  resp=$(json_get "https://openrouter.ai/api/v1/models")
  local total free_count
  total=$(count_array "$resp" ".data")
  free_count=$(echo "$resp" | jq '[.data[]? | select(.id | test(":free"))] | length' 2>/dev/null || echo "0")
  if [[ "$total" -gt 0 ]]; then
    echo "ok|${free_count}"   # report free model count
  else
    echo "down|0"
  fi
}

# Ollama (local)
check_ollama() {
  local resp
  resp=$(json_get "http://localhost:11434/api/tags")
  local count
  count=$(count_array "$resp" ".models")
  if [[ "$count" -gt 0 ]]; then
    echo "ok|$count"
  elif [[ -n "$resp" ]]; then
    echo "ok|0"   # running but no models pulled
  else
    echo "down|0"
  fi
}

# HuggingFace free router
check_huggingface() {
  local code
  code=$(http_code "https://router.huggingface.co/models")
  case "$code" in
    200) echo "ok|0" ;;
    402) echo "exhausted|0" ;;
    401|403) echo "auth|0" ;;
    000) echo "down|0" ;;
    *)   echo "down|0" ;;
  esac
}

# ── Token stack checks ────────────────────────────────────────────────────────

check_rtk() {
  local out
  out=$(rtk gain 2>/dev/null | head -3 || echo "")
  if [[ -n "$out" ]]; then
    # Extract savings line, e.g. "Tokens saved: 688M"
    local savings
    savings=$(echo "$out" | grep -oE '[0-9]+[KMG]? (tokens|saved)' | head -1 || echo "active")
    echo "ok|${savings:-active}"
  else
    echo "down|"
  fi
}

check_service() {
  local url="$1" name="$2"
  local code
  code=$(http_code "$url")
  if [[ "$code" == "200" || "$code" == "204" ]]; then
    echo "ok"
  elif [[ "$code" == "000" ]]; then
    echo "down"
  else
    echo "degraded (HTTP $code)"
  fi
}

# ── Run all checks ────────────────────────────────────────────────────────────
log "Starting LLM fleet audit"

GROQ_RESULT=$(check_groq)
CF_RESULT=$(check_cloudflare)
CEREBRAS_RESULT=$(check_cerebras)
OPENROUTER_RESULT=$(check_openrouter)
OLLAMA_RESULT=$(check_ollama)
HF_RESULT=$(check_huggingface)

RTK_RESULT=$(check_rtk)
HEADROOM_RESULT=$(check_service "http://localhost:6767/health" "Headroom")
PORTKEY_GW_RESULT=$(check_service "http://localhost:8790/health" "Portkey GW")
PORTKEY_CACHE_RESULT=$(check_service "http://localhost:8791/health" "Portkey Cache")
CLAUDESWAP_CODE=$(http_code "http://localhost:8082")
if [[ "$CLAUDESWAP_CODE" =~ ^[23] ]]; then
  CLAUDESWAP_RESULT="ok"
elif [[ "$CLAUDESWAP_CODE" == "000" ]]; then
  CLAUDESWAP_RESULT="down"
else
  CLAUDESWAP_RESULT="degraded (HTTP $CLAUDESWAP_CODE)"
fi

# ── Parse counts ──────────────────────────────────────────────────────────────
parse_status() { echo "${1%%|*}"; }
parse_count()  { echo "${1##*|}"; }

GROQ_STATUS=$(parse_status "$GROQ_RESULT")
GROQ_COUNT=$(parse_count "$GROQ_RESULT")

CF_STATUS=$(parse_status "$CF_RESULT")
CF_COUNT=$(parse_count "$CF_RESULT")

CEREBRAS_STATUS=$(parse_status "$CEREBRAS_RESULT")
CEREBRAS_COUNT=$(parse_count "$CEREBRAS_RESULT")

OR_STATUS=$(parse_status "$OPENROUTER_RESULT")
OR_COUNT=$(parse_count "$OPENROUTER_RESULT")

OLLAMA_STATUS=$(parse_status "$OLLAMA_RESULT")
OLLAMA_COUNT=$(parse_count "$OLLAMA_RESULT")

HF_STATUS=$(parse_status "$HF_RESULT")

RTK_STATUS=$(parse_status "$RTK_RESULT")
RTK_INFO=$(parse_count "$RTK_RESULT")

# ── Model freshness check (>20% change flags review) ─────────────────────────
ALERTS=()
NEW_STATE="{}"

check_freshness() {
  local provider="$1" cur_count="$2" cur_status="$3"
  local prev
  prev=$(prev_count "$provider")

  # Update new state
  NEW_STATE=$(echo "$NEW_STATE" | jq \
    --arg p "$provider" \
    --argjson m "$cur_count" \
    --arg s "$cur_status" \
    '. + {($p): {"models": $m, "status": $s}}' 2>/dev/null || echo "$NEW_STATE")

  # Skip freshness check if provider is down or count is 0
  [[ "$cur_status" == "down" || "$cur_status" == "auth" || "$cur_status" == "skip" ]] && return
  [[ "$cur_count" -eq 0 || "$prev" -eq 0 ]] && return

  # Calculate % change
  local diff pct
  diff=$(( cur_count - prev ))
  # Use awk for float math (bash integers only)
  pct=$(awk "BEGIN { printf \"%.0f\", ($diff / $prev) * 100 }")
  pct_abs=${pct#-}   # absolute value

  if [[ "$pct_abs" -gt 20 ]]; then
    ALERTS+=("${provider}: model count changed ${pct:+$pct}% (${prev} → ${cur_count}) — review needed")
  fi
}

check_freshness "groq"       "${GROQ_COUNT:-0}"      "$GROQ_STATUS"
check_freshness "cloudflare" "${CF_COUNT:-0}"        "$CF_STATUS"
check_freshness "cerebras"   "${CEREBRAS_COUNT:-0}"  "$CEREBRAS_STATUS"
check_freshness "openrouter" "${OR_COUNT:-0}"        "$OR_STATUS"
check_freshness "ollama"     "${OLLAMA_COUNT:-0}"    "$OLLAMA_STATUS"

# Collect down/auth providers as alerts
for entry in \
  "Groq:$GROQ_STATUS" \
  "Cloudflare:$CF_STATUS" \
  "Cerebras:$CEREBRAS_STATUS" \
  "OpenRouter:$OR_STATUS" \
  "Ollama:$OLLAMA_STATUS" \
  "HuggingFace:$HF_STATUS" \
  "RTK:$RTK_STATUS" \
  "Headroom:$HEADROOM_RESULT" \
  "Portkey-GW:$PORTKEY_GW_RESULT" \
  "Portkey-Cache:$PORTKEY_CACHE_RESULT" \
  "ClaudeSwap:$CLAUDESWAP_RESULT"
do
  name="${entry%%:*}"
  status="${entry##*:}"
  case "$status" in
    down)      ALERTS+=("${name}: DOWN") ;;
    auth)      ALERTS+=("${name}: auth failed") ;;
    exhausted) ALERTS+=("${name}: free tier exhausted (402)") ;;
    degraded*) ALERTS+=("${name}: ${status}") ;;
  esac
done

# ── Save updated state ────────────────────────────────────────────────────────
echo "$NEW_STATE" | jq --arg d "$TODAY" '. + {lastAudit: $d}' > "$STATE_FILE" 2>/dev/null || true

# ── Render line ───────────────────────────────────────────────────────────────
status_icon() {
  case "$1" in
    ok)        echo "✅" ;;
    skip)      echo "⏭ " ;;
    down)      echo "❌" ;;
    auth)      echo "🔑" ;;
    exhausted) echo "⚠️ " ;;
    degraded*) echo "⚠️ " ;;
    *)         echo "❓" ;;
  esac
}

fmt_provider() {
  local name="$1" status="$2" count="$3" label="${4:-models}"
  local icon
  icon=$(status_icon "$status")
  local prev
  prev=$(prev_count "$(echo "$name" | tr '[:upper:]' '[:lower:]')")
  local delta=""
  if [[ "$count" -gt 0 && "$prev" -gt 0 && "$count" -ne "$prev" ]]; then
    local d=$(( count - prev ))
    [[ "$d" -gt 0 ]] && delta=" (+${d})" || delta=" (${d})"
  fi
  local count_str=""
  [[ "$count" -gt 0 ]] && count_str=" ${count} ${label}${delta}"
  printf "  %-16s %s %s%s\n" "${name}:" "$icon" "$status" "$count_str"
}

# ── Write results file ────────────────────────────────────────────────────────
{
printf "LLM Fleet Audit — %s\n" "$NOW"
printf "═══════════════════════════════════\n\n"

printf "PROVIDERS\n"
fmt_provider "Groq"       "$GROQ_STATUS"      "${GROQ_COUNT:-0}"   "models"
fmt_provider "Cloudflare" "$CF_STATUS"        "${CF_COUNT:-0}"     "models"
fmt_provider "Cerebras"   "$CEREBRAS_STATUS"  "${CEREBRAS_COUNT:-0}" "models"
fmt_provider "OpenRouter" "$OR_STATUS"        "${OR_COUNT:-0}"     "free models"
fmt_provider "Ollama"     "$OLLAMA_STATUS"    "${OLLAMA_COUNT:-0}" "models"
fmt_provider "HuggingFace" "$HF_STATUS"       "0"                  ""
echo ""

printf "TOKEN STACK\n"
if [[ "$RTK_STATUS" == "ok" ]]; then
  printf "  %-16s ✅ %s\n" "RTK:" "${RTK_INFO:-active}"
else
  printf "  %-16s ❌ down\n" "RTK:"
fi
printf "  %-16s %s %s\n" "Headroom:"      "$(status_icon "$HEADROOM_RESULT")"      "$HEADROOM_RESULT"
printf "  %-16s %s %s\n" "Portkey GW:"    "$(status_icon "$PORTKEY_GW_RESULT")"    "$PORTKEY_GW_RESULT"
printf "  %-16s %s %s\n" "Portkey Cache:" "$(status_icon "$PORTKEY_CACHE_RESULT")" "$PORTKEY_CACHE_RESULT"
printf "  %-16s %s %s\n" "ClaudeSwap:"    "$(status_icon "$CLAUDESWAP_RESULT")"    "$CLAUDESWAP_RESULT"
echo ""

printf "ALERTS\n"
if [[ "${#ALERTS[@]}" -eq 0 ]]; then
  printf "  ✅ No issues detected\n"
else
  for alert in "${ALERTS[@]}"; do
    printf "  ⚠️  %s\n" "$alert"
  done
fi
echo ""
printf "State saved: %s\n" "$STATE_FILE"
} > "$RESULTS_FILE"

cat "$RESULTS_FILE"
log "Audit complete — ${#ALERTS[@]} alert(s)"

# ── Telegram alert (only if issues found) ────────────────────────────────────
if [[ "${#ALERTS[@]}" -gt 0 ]]; then
  BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  CHAT_ID="${TELEGRAM_CHAT_ID}"

  if [[ -n "$BOT_TOKEN" && -n "$CHAT_ID" ]]; then
    ALERT_LINES=$(printf '%s\n' "${ALERTS[@]}")
    ALERT_MSG="LLM Fleet Audit (${TODAY}) — ${#ALERTS[@]} issue(s):
${ALERT_LINES}"

    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" \
      --data-urlencode "text=🔍 ${ALERT_MSG}" \
      -d "parse_mode=HTML" > /dev/null 2>&1
    log "Telegram alert sent"
  else
    log "TELEGRAM_BOT_TOKEN not set — skipping alert"
  fi
fi
