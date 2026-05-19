#!/usr/bin/env bash
# oc-weekly-vacuum.sh — VACUUM OpenClaw SQLite memory DBs to reclaim dead pages.
# Runs weekly; skips DBs held by active writers (gateway stays up).
# Writes summary to ~/clawd/logs/oc-vacuum-YYYY-MM-DD.log.

set -euo pipefail
LOG_DIR="$HOME/clawd/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/oc-vacuum-$(date +%Y-%m-%d).log"

{
  echo "=== VACUUM run $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  MEM_DIR="$HOME/.openclaw/memory"
  LCM_DB="$HOME/.openclaw/lcm.db"

  vacuum_one() {
    local db="$1"
    [[ ! -f "$db" ]] && return 0
    local size_before
    size_before=$(stat -f %z "$db" 2>/dev/null || stat -c %s "$db" 2>/dev/null)
    # Use pragma to test lock. timeout=5000ms.
    if ! sqlite3 -cmd ".timeout 5000" "$db" "PRAGMA quick_check;" >/dev/null 2>&1; then
      echo "SKIP (locked/corrupt) $db"
      return 0
    fi
    if sqlite3 -cmd ".timeout 5000" "$db" "VACUUM;" 2>&1; then
      local size_after
      size_after=$(stat -f %z "$db" 2>/dev/null || stat -c %s "$db" 2>/dev/null)
      local delta=$((size_before - size_after))
      echo "OK $db  before=${size_before}B  after=${size_after}B  freed=${delta}B"
    else
      echo "FAIL $db (vacuum errored)"
    fi
  }

  # Per-agent memory DBs
  for db in "$MEM_DIR"/*.sqlite; do
    [[ -f "$db" ]] || continue
    vacuum_one "$db"
  done

  # LCM long-context DB
  vacuum_one "$LCM_DB"

  # Clean up orphan temp files (>1h old)
  find "$MEM_DIR" -name '*.sqlite.tmp-*' -mmin +60 -print -delete 2>/dev/null || true

  echo "=== DONE ==="
} >>"$LOG" 2>&1

# Tail last 10 lines to stdout for cron logs
tail -n 10 "$LOG"
