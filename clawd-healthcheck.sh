#!/bin/bash
# Part of openclaw-automation — https://github.com/KevinZai/openclaw-automation
# clawd-healthcheck.sh — unified health monitoring
# Replaces 9 overlapping monitoring crons (doctor-quick, check-pm2-online,
# check-ports, check-disk-space, proxy-watchdog, proactive-error-scan,
# precheck-heartbeat)
# Runs every 15 minutes via crontab
# Logs to ~/clawd/logs/healthcheck.log

# Note: pm2-caddy-sync.sh and cache-keepalive.sh are intentionally NOT
# consolidated here — caddy-sync mutates the Caddyfile and cache-keepalive
# is maintenance (cache warming), not health monitoring.

set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

LOG="${CLAWD_DIR:-$HOME/clawd}/logs/healthcheck.log"
ALERT_FILE="/tmp/clawd-health-alerts"
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S)
DISCORD_COMMS_LOG="${DISCORD_COMMS_LOG:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
PAPERCLIP="http://localhost:3100"
GATEWAY="http://localhost:18789"

# Auto-restart safe PM2 services (from openclaw-doctor-quick.sh)
SAFE_RESTART=("paperclip" "openclaw-nerve" "command-center" "anthropic-lb" "links-server" "clawmetry" "docs-wiki" "claudeswap" "headroom-proxy")
# Services expected to be stopped — do not alert on these
EXPECTED_STOPPED=("freqtrade" "port-guard" "vault-sync" "vault-git-backup" "gateway-watchdog")
# Minimum PM2 online processes before alerting
PM2_MIN_EXPECTED="${PM2_MIN_EXPECTED:-15}"

# ─── Helpers ─────────────────────────────────────────────────────────────────

ts() { date +"%Y-%m-%dT%H:%M:%S"; }

log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

add_alert() {
  echo "$1" >> "$ALERT_FILE"
  log "ALERT: $1"
}

send_telegram() {
  local msg="$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=${msg}" > /dev/null 2>&1 || true
  fi
}

send_discord() {
  local msg="$1"
  openclaw message send \
    --channel discord \
    --target "$DISCORD_COMMS_LOG" \
    --message "$msg" \
    --silent 2>/dev/null || true
}

# Send alert via both Telegram (always) and Discord (if gateway is up).
# Falls back gracefully if either is unavailable.
send_alerts() {
  local msg="$1"
  send_telegram "$msg"
  if curl -sf --max-time 2 "$GATEWAY/health" >/dev/null 2>&1; then
    send_discord "$msg"
  fi
}

restart_pm2_service() {
  local name="$1"
  pm2 restart "$name" 2>/dev/null || true
  sleep 2
  local new_status
  new_status=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys
for d in json.load(sys.stdin):
    if d['name'] == '$name':
        print(d['pm2_env']['status'])
" 2>/dev/null)
  echo "${new_status:-unknown}"
}

is_safe_restart() {
  local name="$1"
  for s in "${SAFE_RESTART[@]}"; do
    [ "$s" = "$name" ] && return 0
  done
  return 1
}

is_expected_stopped() {
  local name="$1"
  for s in "${EXPECTED_STOPPED[@]}"; do
    [ "$s" = "$name" ] && return 0
  done
  return 1
}

# ─── Check 1: Disk Space ─────────────────────────────────────────────────────
# Alert if usage >= 85% OR free space < 5 GB.
# Mirrors: check-disk-space.sh

check_disk() {
  local threshold=85
  local usage free_raw free_gb

  usage=$(df -h /System/Volumes/Data 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
  free_raw=$(df -h /System/Volumes/Data 2>/dev/null | tail -1 | awk '{print $4}')
  # Convert free to GB for the < 5GB check (handles Gi/G/Ti suffixes)
  free_gb=$(df -g /System/Volumes/Data 2>/dev/null | tail -1 | awk '{print $4}')

  log "disk: usage=${usage:-?}% free=${free_raw:-?} (${free_gb:-?}G)"

  if [ "${usage:-0}" -ge "$threshold" ] 2>/dev/null; then
    add_alert "DISK: ${usage}% used (threshold ${threshold}%) — ${free_raw} free"
  elif [ "${free_gb:-99}" -lt 5 ] 2>/dev/null; then
    add_alert "DISK: Low free space — only ${free_raw} remaining"
  fi
}

# ─── Check 2: PM2 Services ───────────────────────────────────────────────────
# Check online count and auto-restart errored safe services.
# Mirrors: check-pm2-online.sh + openclaw-doctor-quick.sh PM2 section

check_pm2() {
  local stats online_count errored_list
  # Output format uses newline-separated fields so that multi-word errored/stopped
  # lists are not truncated by space-based regex parsing.
  stats=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    procs = json.load(sys.stdin)
    online  = [p['name'] for p in procs if p['pm2_env']['status'] == 'online']
    errored = [p['name'] for p in procs if p['pm2_env']['status'] == 'errored']
    stopped = [p['name'] for p in procs if p['pm2_env']['status'] == 'stopped']
    print(f'online={len(online)}')
    print(f'total={len(procs)}')
    print(f'errored_count={len(errored)}')
    print('errored_names=' + '|'.join(errored))
    print(f'stopped_count={len(stopped)}')
except Exception as e:
    print(f'error:{e}')
" 2>/dev/null || echo "error:pm2-jlist-failed")

  log "pm2: $(echo "$stats" | tr '\n' ' ')"

  online_count=$(echo "$stats" | grep -oE 'online=[0-9]+' | grep -oE '[0-9]+' || echo "0")
  # Extract pipe-delimited errored names, then convert to space-delimited for iteration
  local errored_raw
  errored_raw=$(echo "$stats" | grep '^errored_names=' | sed 's/^errored_names=//')
  errored_list=$(echo "$errored_raw" | tr '|' ' ' | xargs)

  if [ "${online_count:-0}" -lt "$PM2_MIN_EXPECTED" ] 2>/dev/null; then
    add_alert "PM2: only ${online_count} processes online (expected >=${PM2_MIN_EXPECTED})"
  fi

  if [ -n "${errored_list:-}" ] && [ "${errored_list}" != "" ]; then
    local restarts="" still_errored=""
    for svc in $errored_list; do
      is_expected_stopped "$svc" && continue
      if is_safe_restart "$svc"; then
        local new_status
        new_status=$(restart_pm2_service "$svc")
        if [ "$new_status" = "online" ]; then
          restarts="${restarts} ${svc}"
          log "pm2: auto-restarted $svc -> online"
        else
          still_errored="${still_errored} ${svc}"
        fi
      else
        still_errored="${still_errored} ${svc}"
      fi
    done
    [ -n "${still_errored}" ] && add_alert "PM2 errored (no auto-restart):${still_errored}"
    [ -n "${restarts}" ] && log "pm2: healed:${restarts}"
  fi
}

# ─── Check 3: Critical Ports ─────────────────────────────────────────────────
# HTTP probe critical service ports.
# Mirrors: check-ports.sh + openclaw-doctor-quick.sh gateway/paperclip checks

check_ports() {
  local -a PORT_MAP=(
    "18789:OpenClaw-Gateway"
    "3100:Paperclip"
    "5678:n8n"
    "8082:ClaudeSwap"
    "6767:Headroom-Proxy"
    "8790:Portkey-Gateway"
    "3004:Mission-Control"
    "4680:Fleet-Commander"
  )

  local down=() up=()

  for entry in "${PORT_MAP[@]}"; do
    local port name code
    port="${entry%%:*}"
    name="${entry##*:}"
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${port}" 2>/dev/null)
    if [[ "$code" =~ ^(200|301|302|401|403|404)$ ]]; then
      up+=("$name")
    else
      down+=("$name($code)")
    fi
  done

  log "ports: ${#up[@]}/${#PORT_MAP[@]} up down=[${down[*]:-none}]"

  if [ "${#down[@]}" -gt 0 ]; then
    add_alert "PORTS DOWN: ${down[*]}"
  fi
}

# ─── Check 4: Proxy Health (ClaudeSwap + Headroom) ───────────────────────────
# Targeted health probes with auto-restart for proxy services.
# Mirrors: proxy-watchdog.sh

check_proxies() {
  local -a PROXIES=(
    "claudeswap:8082:/v1/models"
    "headroom-proxy:6767:/health"
  )

  for entry in "${PROXIES[@]}"; do
    local name port path code
    IFS=: read -r name port path <<< "$entry"
    code=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://127.0.0.1:${port}${path}" --max-time 5 2>/dev/null)
    if [ "$code" = "000" ] || [ "$code" = "502" ] || [ "$code" = "503" ]; then
      log "proxy: $name down (HTTP $code) — attempting restart"
      local new_status
      new_status=$(restart_pm2_service "$name")
      if [ "$new_status" != "online" ]; then
        add_alert "PROXY DOWN: $name (:$port) restart failed (status: $new_status)"
      else
        log "proxy: $name restarted -> online"
      fi
    else
      log "proxy: $name ok (HTTP $code)"
    fi
  done
}

# ─── Check 5: OpenClaw Gateway ───────────────────────────────────────────────
# Deep gateway health probe + recent error log scan.
# Mirrors: openclaw-doctor-quick.sh gateway check + precheck-heartbeat.sh

check_gateway() {
  local gw_response
  gw_response=$(curl -sf --max-time 5 "$GATEWAY/health" 2>/dev/null || echo "")

  if echo "$gw_response" | grep -q '"ok":true'; then
    log "gateway: ok"
  else
    add_alert "GATEWAY DOWN or unhealthy (response: ${gw_response:-no response})"
  fi

  # Scan recent gateway logs for errors
  local gw_log="$HOME/clawd/logs/gateway.log"
  if [ -f "$gw_log" ]; then
    local error_count
    error_count=$(tail -200 "$gw_log" 2>/dev/null \
      | grep -ciE '"logLevelName":"ERROR"|FATAL|CRIT' || echo "0")
    if [ "${error_count:-0}" -gt 5 ]; then
      add_alert "GATEWAY LOG: ${error_count} recent error entries"
    else
      log "gateway: log errors=${error_count:-0} (last 200 lines)"
    fi
  fi
}

# ─── Check 6: Caddy ──────────────────────────────────────────────────────────
# Verify Caddy reverse proxy process is running.
# Extracted from pm2-caddy-sync.sh + openclaw-doctor-quick.sh

check_caddy() {
  if pgrep -x caddy >/dev/null 2>&1; then
    log "caddy: running"
  else
    add_alert "CADDY: process not found"
  fi
}

# ─── Check 7: Proactive Error Scan ───────────────────────────────────────────
# Check PM2 errored count and gateway errors — create Paperclip ticket if high.
# Mirrors: proactive-error-scan.sh (OC cron errors check removed — too noisy)

check_errors_and_ticket() {
  local errored_count gw_errors

  errored_count=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
errored = [d['name'] for d in data if d['pm2_env']['status'] == 'errored']
print(len(errored))
" 2>/dev/null || echo "0")

  local gw_log_today
  gw_log_today="$HOME/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
  gw_errors=$(tail -100 "$gw_log_today" 2>/dev/null | grep -c '"logLevelName":"ERROR"' || echo "0")

  log "error-scan: pm2_errored=${errored_count} gw_errors=${gw_errors}"

  # Only create a Paperclip ticket on significant issues (avoid noise)
  if [ "${errored_count:-0}" -gt 2 ] || [ "${gw_errors:-0}" -gt 5 ]; then
    local body="Auto-detected at $TIMESTAMP: PM2 errored=${errored_count} gateway_errors=${gw_errors}"
    curl -s --max-time 10 -X POST "$PAPERCLIP/api/issues" \
      -H "Content-Type: application/json" \
      -d "{\"title\":\"[AUTO] System errors $TIMESTAMP\",\"description\":\"${body}\",\"priority\":\"high\"}" \
      >> "$LOG" 2>&1 || true
  fi
}

# ─── Check 8: File Permissions (SEC-12) ──────────────────────────────────────
# Ensure sensitive config files have correct permissions.
# Gateway SIGUSR1 resets openclaw.json to world-readable; auto-fix silently.
# Mirrors: post-restart-perms.sh (now automated)

check_file_permissions() {
  local config="$HOME/.openclaw/openclaw.json"
  if [ ! -f "$config" ]; then
    log "perms: $config not found — skipping"
    return 0
  fi

  local perms
  perms=$(stat -f "%Lp" "$config" 2>/dev/null || stat -c "%a" "$config" 2>/dev/null || echo "unknown")

  if [ "$perms" = "600" ]; then
    log "perms: openclaw.json ok (600)"
  else
    chmod 600 "$config" 2>/dev/null && log "perms: openclaw.json fixed ${perms}->600" \
      || add_alert "PERMS: failed to chmod openclaw.json (current: ${perms})"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  # Reset alert accumulator
  rm -f "$ALERT_FILE"

  log "=== clawd-healthcheck start ==="

  # Run all checks — failures are logged but do not abort the script
  check_disk        || log "check_disk: exception (exit $?)"
  check_pm2         || log "check_pm2: exception (exit $?)"
  check_ports       || log "check_ports: exception (exit $?)"
  check_proxies     || log "check_proxies: exception (exit $?)"
  check_gateway     || log "check_gateway: exception (exit $?)"
  check_caddy       || log "check_caddy: exception (exit $?)"
  check_errors_and_ticket  || log "check_errors_and_ticket: exception (exit $?)"
  check_file_permissions   || log "check_file_permissions: exception (exit $?)"

  # Summarize and notify
  if [ -f "$ALERT_FILE" ] && [ -s "$ALERT_FILE" ]; then
    local alert_count alert_summary
    alert_count=$(wc -l < "$ALERT_FILE" | tr -d ' ')
    alert_summary=$(paste -sd ' | ' "$ALERT_FILE")
    local msg="[clawd-healthcheck] $alert_count alert(s): $alert_summary"
    log "SUMMARY: $msg"
    send_alerts "$msg"
  else
    log "=== clawd-healthcheck OK (no alerts) ==="
  fi

  # Trim log to last 2000 lines
  if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ]; then
    tail -1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi

  rm -f "$ALERT_FILE"
}

main
