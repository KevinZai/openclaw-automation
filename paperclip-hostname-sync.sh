#!/usr/bin/env bash
# paperclip-hostname-sync.sh — Ensure Paperclip's allowedHostnames matches
# every paperclip hostname mapped in pm2-caddy-sync.sh's SERVICE_MAP.
#
# Self-healing for the "Caddy maps host → :3100 but Paperclip rejects with
# 403 because server.allowedHostnames is empty" failure mode.
#
# Idempotent — safe to run on every cron tick. Only logs when work happens.
#
# Invoked at the tail of pm2-caddy-sync.sh (also safe standalone).

set -euo pipefail

PARENT_SCRIPT="${PARENT_SCRIPT:-/Users/ai/clawd/scripts/pm2-caddy-sync.sh}"
PAPERCLIP_DIR="${PAPERCLIP_DIR:-/Users/ai/clawd/tools/paperclip}"
PAPERCLIP_CONFIG="${PAPERCLIP_CONFIG:-/Users/ai/.paperclip/instances/default/config.json}"
LOG_FILE="${LOG_FILE:-/Users/ai/clawd/logs/paperclip-hostname-sync.log}"

mkdir -p "$(dirname "$LOG_FILE")"

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }
warn() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN: $*" >> "$LOG_FILE"; }

# Preflight: bail quietly (exit 0) if anything is missing — we don't want
# this helper to break the parent cron job under partial-install conditions.
[[ -f "$PARENT_SCRIPT" ]]    || { warn "parent script missing: $PARENT_SCRIPT"; exit 0; }
[[ -f "$PAPERCLIP_CONFIG" ]] || { warn "paperclip config missing: $PAPERCLIP_CONFIG"; exit 0; }
[[ -d "$PAPERCLIP_DIR" ]]    || { warn "paperclip dir missing: $PAPERCLIP_DIR"; exit 0; }
command -v pnpm   &>/dev/null || { warn "pnpm not in PATH"; exit 0; }
command -v python3 &>/dev/null || { warn "python3 not in PATH"; exit 0; }

# Extract hostnames mapped to paperclip from the parent script's SERVICE_MAP.
# Match only un-commented "paperclip|host|port" lines inside the array.
# (Bash 3.2 compatible — no `mapfile`.)
WANT_HOSTS=()
while IFS= read -r host; do
  [[ -n "$host" ]] && WANT_HOSTS+=("$host")
done < <(
  grep -E '^[[:space:]]*"paperclip\|[^|]+\|[0-9]+"' "$PARENT_SCRIPT" \
    | sed -E 's/^[[:space:]]*"paperclip\|([^|]+)\|.*/\1/' \
    | sort -u
)

if [[ ${#WANT_HOSTS[@]} -eq 0 ]]; then
  exit 0  # no paperclip mappings — nothing to do, no log spam
fi

# Read current allowedHostnames once.
CURRENT_HOSTS="$(python3 -c '
import json, sys
with open(sys.argv[1]) as f: d = json.load(f)
for h in (d.get("server", {}).get("allowedHostnames") or []):
    print(h)
' "$PAPERCLIP_CONFIG")"

added=0
for host in "${WANT_HOSTS[@]}"; do
  if grep -Fxq "$host" <<< "$CURRENT_HOSTS"; then
    continue  # already present, no-op (silent)
  fi

  # CLI is idempotent — safe even if a race added it between read and run.
  if ( cd "$PAPERCLIP_DIR" && pnpm paperclipai allowed-hostname "$host" ) \
       >/dev/null 2>>"$LOG_FILE"; then
    log "added allowedHostname: $host"
    ((added++)) || true
  else
    warn "failed to add allowedHostname: $host"
  fi
done

# Only emit a summary line when something actually changed.
[[ $added -gt 0 ]] && log "sync complete — $added host(s) added (config picks up on next request; no restart)"

exit 0
