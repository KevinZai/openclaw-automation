#!/usr/bin/env bash
# tank-supervise — Hermes-Tank's primary diagnostic.
# Called by Tank's hermes crons. Outputs structured findings.
# Usage: bash scripts/tank-supervise.sh [--json] [--check <gateway|cron|oauth|disk|backup|all>]

set -uo pipefail

JSON=0
CHECK="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --check) CHECK="$2"; shift 2 ;;
    --help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done

LOG="${HOME}/clawd/logs/tank-supervise.log"
mkdir -p "$(dirname "$LOG")"

# ── Output formatting ─────────────────────────────────────────
RESULTS=()
add() {
  local check="$1" sev="$2" msg="$3"
  RESULTS+=("$check|$sev|$msg")
  printf '[%s] %s %s — %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$check" "$sev" "$msg" >> "$LOG"
}

# ── Check: Gateway health ─────────────────────────────────────
check_gateway() {
  local status=$(openclaw gateway status 2>&1 | grep -E 'Runtime|state' | head -1 || echo "unknown")
  if echo "$status" | grep -q 'running'; then
    add "gateway" "🟢" "alive: $status"
  else
    add "gateway" "🔴" "DOWN: $status"
  fi
  local recent_timeouts=$(grep -c 'GatewayTransportError' "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" 2>/dev/null || echo 0)
  if [[ "$recent_timeouts" -gt 5 ]]; then
    add "gateway-timeouts" "🟠" "$recent_timeouts timeouts today (threshold 5)"
  fi
}

# ── Check: Cron errors ────────────────────────────────────────
check_cron() {
  local errored=$(openclaw cron list 2>/dev/null | grep -cE '\berror\b' || echo 0)
  if [[ "$errored" -eq 0 ]]; then
    add "cron" "🟢" "0 crons in error state"
  elif [[ "$errored" -lt 3 ]]; then
    add "cron" "🟡" "$errored crons in error (acceptable)"
  else
    add "cron" "🟠" "$errored crons in error state (TRIAGE NEEDED)"
    openclaw cron list 2>/dev/null | grep -E '\berror\b' | head -5 | awk '{printf "    %s %s\n", $1, $2}' >> "$LOG"
  fi
}

# ── Check: OAuth health ───────────────────────────────────────
check_oauth() {
  local log_file="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
  local oauth_failures=$(grep -cE '(401|token refresh|OAuth.*failed|expired)' "$log_file" 2>/dev/null || echo 0)
  if [[ "$oauth_failures" -eq 0 ]]; then
    add "oauth" "🟢" "no OAuth failures today"
  else
    add "oauth" "🟠" "$oauth_failures OAuth events today; check 'openclaw models list'"
  fi
  # Codex auth file freshness
  if [[ -f ~/.codex/auth.json ]]; then
    local age_days=$(( ($(date +%s) - $(stat -f %m ~/.codex/auth.json)) / 86400 ))
    if [[ "$age_days" -gt 7 ]]; then
      add "codex-auth" "🟡" "auth.json $age_days days old; rotation may be near"
    fi
  fi
}

# ── Check: Disk pressure ──────────────────────────────────────
check_disk() {
  local free_gb=$(df -g /System/Volumes/Data | tail -1 | awk '{print $4}')
  if [[ "$free_gb" -gt 20 ]]; then
    add "disk" "🟢" "$free_gb GB free"
  elif [[ "$free_gb" -gt 10 ]]; then
    add "disk" "🟡" "$free_gb GB free (watch — consider 'bash scripts/prune-to-external.sh --apply')"
  else
    add "disk" "🟠" "$free_gb GB free (PRESSURE — run 'bash scripts/prune-to-external.sh --apply' to MOVE backups to Extreme Pro. NEVER 'rm' backups — Constitution Rule 21)"
  fi
}

# ── Check: Backup health ──────────────────────────────────────
check_backup() {
  local backup_dir="/Volumes/Extreme Pro/clawd-live/backups"
  if [[ ! -d "$backup_dir" ]]; then
    add "backup" "🔴" "backup dir not mounted: $backup_dir"
    return
  fi
  local newest=$(ls -t "$backup_dir"/clawd-*.tar.gz 2>/dev/null | head -1)
  if [[ -z "$newest" ]]; then
    add "backup" "🔴" "no clawd backup found in $backup_dir"
    return
  fi
  local age_h=$(( ($(date +%s) - $(stat -f %m "$newest")) / 3600 ))
  local size_mb=$(du -m "$newest" | awk '{print $1}')
  if [[ "$age_h" -lt 30 && "$size_mb" -gt 100 ]]; then
    add "backup" "🟢" "latest: $(basename "$newest"), age=${age_h}h, size=${size_mb}MB"
  elif [[ "$age_h" -gt 30 ]]; then
    add "backup" "🟠" "latest backup is ${age_h}h old (>24h threshold)"
  fi
}

# ── Run requested checks ─────────────────────────────────────
case "$CHECK" in
  gateway) check_gateway ;;
  cron) check_cron ;;
  oauth) check_oauth ;;
  disk) check_disk ;;
  backup) check_backup ;;
  all) check_gateway; check_cron; check_oauth; check_disk; check_backup ;;
  *) echo "unknown check: $CHECK" >&2; exit 2 ;;
esac

# ── Output ───────────────────────────────────────────────────
if [[ "$JSON" -eq 1 ]]; then
  printf '['
  local first=1
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r c s m <<< "$r"
    [[ "$first" -eq 0 ]] && printf ','
    printf '{"check":"%s","severity":"%s","message":"%s"}' "$c" "$s" "$m"
    first=0
  done
  printf ']\n'
else
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r c s m <<< "$r"
    printf '%s %-20s %s\n' "$s" "$c" "$m"
  done
fi

# Exit code: 0 if all green/yellow, 1 if any orange/red
for r in "${RESULTS[@]}"; do
  IFS='|' read -r _ s _ <<< "$r"
  if [[ "$s" == "🔴" || "$s" == "🟠" ]]; then
    exit 1
  fi
done
exit 0
