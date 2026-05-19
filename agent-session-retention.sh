#!/usr/bin/env bash
# agent-session-retention.sh — Tiered retention for OpenClaw agent session JSONLs.
#
# Policy (proposed, not yet scheduled):
#   - Active (<= 30d):  leave in place
#   - Archive (30-90d): gzip in-place (.jsonl → .jsonl.gz), 5-10x compression
#   - Delete (> 90d):   trash (NOT rm), 30-day Trash safety net
#
# Idempotent + safe by default. Pass --execute to actually act; default is --dry-run.
# DO NOT cron-install without Kevin's approval.
#
# Recommended cron (once approved):
#   0 4 * * 0  /Users/ai/clawd/scripts/agent-session-retention.sh --execute >> /Users/ai/clawd/logs/agent-session-retention.log 2>&1
#
# Owner: Worker 6, 2026-05-14 (CC-750 follow-on)

set -euo pipefail

SESSIONS_ROOT="${SESSIONS_ROOT:-$HOME/.openclaw/agents}"
LOG_FILE="${LOG_FILE:-$HOME/clawd/logs/agent-session-retention.log}"
ARCHIVE_DAYS="${ARCHIVE_DAYS:-30}"
DELETE_DAYS="${DELETE_DAYS:-90}"
MODE="dry-run"

for arg in "$@"; do
  case "$arg" in
    --execute) MODE="execute" ;;
    --dry-run) MODE="dry-run" ;;
    --help|-h)
      grep -E '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_FILE" >&2; }

if [[ ! -d "$SESSIONS_ROOT" ]]; then
  log "FATAL: sessions root not found: $SESSIONS_ROOT"
  exit 2
fi

mkdir -p "$(dirname "$LOG_FILE")"

log "=== agent-session-retention start mode=$MODE archive>${ARCHIVE_DAYS}d delete>${DELETE_DAYS}d ==="

# Pass 1: gzip files older than ARCHIVE_DAYS (but not already gzipped, not yet in delete tier)
archived=0
while IFS= read -r -d '' f; do
  archived=$((archived+1))
  if [[ "$MODE" == "execute" ]]; then
    gzip -q "$f" && log "gzip: $f"
  else
    log "DRY: gzip $f"
  fi
done < <(find "$SESSIONS_ROOT" -type f -name '*.jsonl' -mtime "+$ARCHIVE_DAYS" -mtime "-$DELETE_DAYS" -print0 2>/dev/null)

# Pass 2: delete (via trash) files older than DELETE_DAYS (.jsonl or .jsonl.gz)
deleted=0
while IFS= read -r -d '' f; do
  deleted=$((deleted+1))
  if [[ "$MODE" == "execute" ]]; then
    if command -v trash >/dev/null 2>&1; then
      trash "$f" && log "trash: $f"
    else
      log "WARN: trash CLI missing, skipping delete: $f"
    fi
  else
    log "DRY: trash $f"
  fi
done < <(find "$SESSIONS_ROOT" -type f \( -name '*.jsonl' -o -name '*.jsonl.gz' \) -mtime "+$DELETE_DAYS" -print0 2>/dev/null)

log "=== done archived=$archived deleted=$deleted mode=$MODE ==="
