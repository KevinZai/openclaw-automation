#!/usr/bin/env bash
# disk-monitor.sh — Tiered disk-pressure reclamation.
# Runs daily 0800 via crontab. Tiers escalate by usage %.
#
#   Tier 1 (≥85%): WARN only (log + Discord)
#   Tier 2 (≥92%): WARN + prune git worktrees >7d + move 1+ archive dirs → Extreme Pro
#   Tier 3 (≥96%): Tier 2 + clean rebuildable caches + empty Trash + gzip old JSONL
#   Tier 4 (≥98%): PANIC — Tier 3 + move largest output file → Extreme Pro, exit 1
#
# Flags: --dry-run (no actions, log-only) · --verbose (extra logging)
# Backups of this script: ~/clawd/scripts/disk-monitor.sh.backup-YYYYMMDD-HHMMSS
# Idempotent and safe to re-run.
set -uo pipefail

DRY_RUN=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --verbose) VERBOSE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

LOG="$HOME/clawd/logs/disk-monitor.log"
mkdir -p "$(dirname "$LOG")"

DISCORD_CHANNEL="${DISCORD_CHANNEL_ALERTS:-1480676421457416306}"
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
EXT_PRO="/Volumes/Extreme Pro/clawd-live"
EXT_BACKUPS="$EXT_PRO/backups"
EXT_ARCHIVE="$EXT_PRO/archive"

# Safety caps
MAX_WORKTREES_PRUNED=20
WORKTREE_AGE_DAYS=7
ARCHIVE_AGE_DAYS=30
JSONL_AGE_DAYS=30

TS() { date '+%Y-%m-%d %H:%M:%S'; }
log()  { echo "[$(TS)] $*" >> "$LOG"; }
vlog() { [ "$VERBOSE" -eq 1 ] && log "  [v] $*"; return 0; }
mode_prefix() { [ "$DRY_RUN" -eq 1 ] && echo "[DRY-RUN] " || echo ""; }

# Pretty bytes from a number of bytes
human() {
  awk -v b="${1:-0}" 'BEGIN{
    split("B K M G T",u," ");
    for(i=1;b>=1024 && i<5;i++) b/=1024;
    printf "%.1f%s", b, u[i]
  }'
}

USE_PCT=$(df -h /System/Volumes/Data | tail -1 | awk '{gsub(/%/,"",$5); print $5}')
FREE=$(df -h /System/Volumes/Data | tail -1 | awk '{print $4}')

TIER=0
if [ "$USE_PCT" -ge 98 ]; then TIER=4
elif [ "$USE_PCT" -ge 96 ]; then TIER=3
elif [ "$USE_PCT" -ge 92 ]; then TIER=2
elif [ "$USE_PCT" -ge 85 ]; then TIER=1
fi

log "disk: ${USE_PCT}% used / ${FREE} free → Tier ${TIER}$([ "$DRY_RUN" -eq 1 ] && echo " (DRY-RUN)")"

ACTIONS_TAKEN=()
BYTES_FREED=0

add_action() { ACTIONS_TAKEN[${#ACTIONS_TAKEN[@]}]="$1"; }
add_freed()  { BYTES_FREED=$((BYTES_FREED + ${1:-0})); }

#######################################
# Tier 2 actions
#######################################
do_tier2() {
  log "  🔴 Tier 2 actions starting"

  # --- A. Prune stale git worktrees ---
  local pruned=0
  local skipped=0
  local wt_root="$HOME/clawd/.claude/worktrees"
  if [ -d "$wt_root" ]; then
    local now_epoch
    now_epoch=$(date +%s)
    local threshold=$((WORKTREE_AGE_DAYS * 86400))

    # Use `command git` to bypass any rtk wrapper
    local wt_list
    wt_list=$(command git -C "$HOME/clawd" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')

    while IFS= read -r wt_path; do
      [ -z "$wt_path" ] && continue
      # Only prune worktrees inside the managed dir
      case "$wt_path" in
        "$wt_root"/*) : ;;
        *) continue ;;
      esac
      # Don't prune ourselves
      [ "$wt_path" = "$PWD" ] && { vlog "skip own worktree: $wt_path"; continue; }

      if [ "$pruned" -ge "$MAX_WORKTREES_PRUNED" ]; then
        vlog "hit prune cap ($MAX_WORKTREES_PRUNED), stopping"
        break
      fi

      # Age check via mtime of the worktree dir
      if [ ! -d "$wt_path" ]; then
        vlog "worktree path missing: $wt_path"
        continue
      fi
      local mtime
      mtime=$(stat -f%m "$wt_path" 2>/dev/null || echo "$now_epoch")
      local age=$((now_epoch - mtime))
      if [ "$age" -lt "$threshold" ]; then
        skipped=$((skipped + 1))
        vlog "skip young worktree: $wt_path (age $((age / 86400))d)"
        continue
      fi

      local size_b
      size_b=$(du -sk "$wt_path" 2>/dev/null | awk '{print $1*1024}')

      if [ "$DRY_RUN" -eq 1 ]; then
        log "  [DRY-RUN] would prune worktree: $wt_path (age $((age / 86400))d, $(human "$size_b"))"
        pruned=$((pruned + 1))
        continue
      fi

      # Unlock first (worktrees may be locked); ignore errors
      command git -C "$HOME/clawd" worktree unlock "$wt_path" >/dev/null 2>&1 || true
      if command git -C "$HOME/clawd" worktree remove --force "$wt_path" >/dev/null 2>&1; then
        log "  ✅ pruned worktree: $wt_path (age $((age / 86400))d, $(human "$size_b"))"
        pruned=$((pruned + 1))
        add_freed "$size_b"
      else
        log "  ⚠️  failed to prune worktree: $wt_path"
      fi
    done <<< "$wt_list"

    # Cleanup stale worktree admin entries
    [ "$DRY_RUN" -eq 0 ] && command git -C "$HOME/clawd" worktree prune >/dev/null 2>&1 || true
  fi
  if [ "$pruned" -gt 0 ]; then
    add_action "pruned ${pruned} worktree(s) >${WORKTREE_AGE_DAYS}d"
  fi
  vlog "worktree summary: pruned=${pruned} skipped=${skipped}"

  # --- B. Move archive dirs >30d → Extreme Pro ---
  if [ -d "$EXT_BACKUPS" ] && [ -d "$HOME/clawd/archive" ]; then
    local moved=0
    local old_arc
    old_arc=$(find "$HOME/clawd/archive" -maxdepth 1 -mindepth 1 -mtime "+${ARCHIVE_AGE_DAYS}" -type d 2>/dev/null)
    while IFS= read -r d; do
      [ -z "$d" ] && continue
      local size_b
      size_b=$(du -sk "$d" 2>/dev/null | awk '{print $1*1024}')
      if [ "$DRY_RUN" -eq 1 ]; then
        log "  [DRY-RUN] would move archive: $d → $EXT_BACKUPS/ ($(human "$size_b"))"
        moved=$((moved + 1))
        continue
      fi
      if mv "$d" "$EXT_BACKUPS/" 2>/dev/null; then
        log "  ✅ moved archive: $(basename "$d") ($(human "$size_b"))"
        moved=$((moved + 1))
        add_freed "$size_b"
      else
        log "  ⚠️  failed to move archive: $d"
      fi
    done <<< "$old_arc"
    [ "$moved" -gt 0 ] && add_action "moved ${moved} archive dir(s) >${ARCHIVE_AGE_DAYS}d → Extreme Pro"
  else
    log "  ⚠️  Extreme Pro not mounted or no clawd/archive — skipping archive eviction"
  fi

  # --- C. LCM WAL checkpoint (cheap, always safe) ---
  if [ -f "$HOME/.openclaw/lcm.db" ]; then
    local wal_before wal_after reclaimed
    wal_before=$(stat -f%z "$HOME/.openclaw/lcm.db-wal" 2>/dev/null || echo 0)
    if [ "$DRY_RUN" -eq 0 ]; then
      sqlite3 "$HOME/.openclaw/lcm.db" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
    fi
    wal_after=$(stat -f%z "$HOME/.openclaw/lcm.db-wal" 2>/dev/null || echo 0)
    reclaimed=$((wal_before - wal_after))
    if [ "$reclaimed" -gt $((5 * 1024 * 1024)) ]; then
      log "  ✅ LCM WAL checkpoint: $(human "$reclaimed") reclaimed"
      add_action "LCM WAL: $(human "$reclaimed")"
      add_freed "$reclaimed"
    else
      vlog "LCM WAL: only $(human "$reclaimed") (skip)"
    fi
  fi

  # --- D. Prune ~/.openclaw/tmp dirs >7d (kept from old script) ---
  if [ -d "$HOME/.openclaw/tmp" ]; then
    local old_count
    old_count=$(find "$HOME/.openclaw/tmp" -maxdepth 1 -mindepth 1 -mtime +7 2>/dev/null | wc -l | tr -d ' ')
    if [ "$old_count" -gt 0 ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        log "  [DRY-RUN] would trash ${old_count} tmp dirs >7d"
      else
        find "$HOME/.openclaw/tmp" -maxdepth 1 -mindepth 1 -mtime +7 -exec trash {} + 2>/dev/null
        log "  ✅ trashed ${old_count} tmp dirs >7d"
      fi
      add_action "${old_count} tmp dirs >7d"
    fi
  fi
}

#######################################
# Tier 3 actions
#######################################
clean_cache() {
  local path="$1"
  [ -d "$path" ] || { vlog "cache miss: $path"; return; }
  local size_b
  size_b=$(du -sk "$path" 2>/dev/null | awk '{print $1*1024}')
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [DRY-RUN] would clean cache: $path ($(human "$size_b"))"
    return
  fi
  # Use find delete to remove cache contents (keep the dir itself for apps)
  find "$path" -mindepth 1 -delete 2>/dev/null || true
  log "  ✅ cleaned cache: $path ($(human "$size_b") nominal)"
  add_freed "$size_b"
}

do_tier3() {
  log "  🚨 Tier 3 actions starting"

  # --- E. Rebuildable caches ---
  clean_cache "$HOME/Library/Caches/com.anthropic.claudefordesktop"
  clean_cache "$HOME/Library/Caches/Yarn"
  clean_cache "$HOME/Library/Caches/npm"
  clean_cache "$HOME/Library/Caches/pip"
  add_action "cleaned anthropic/Yarn/npm/pip caches"

  # --- F. Empty Trash ---
  local trash_size_b
  trash_size_b=$(du -sk "$HOME/.Trash" 2>/dev/null | awk '{print $1*1024}')
  if [ -d "$HOME/.Trash" ] && [ "${trash_size_b:-0}" -gt 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [DRY-RUN] would empty Trash ($(human "$trash_size_b"))"
    else
      # rm -rf is reliable here; osascript fails non-interactively
      rm -rf "$HOME"/.Trash/* "$HOME"/.Trash/.[!.]* 2>/dev/null || true
      log "  ✅ emptied Trash ($(human "$trash_size_b"))"
      add_freed "$trash_size_b"
    fi
    add_action "emptied Trash $(human "$trash_size_b")"
  else
    vlog "Trash empty or missing"
  fi

  # --- G. Gzip old JSONL session files (>30d) ---
  local jsonl_count=0
  local jsonl_bytes=0
  local old_jsonl
  old_jsonl=$(find "$HOME/.claude/projects" -type f -name '*.jsonl' -mtime "+${JSONL_AGE_DAYS}" 2>/dev/null)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Skip if a .gz sibling already exists (idempotent)
    [ -f "${f}.gz" ] && continue
    local sz
    sz=$(stat -f%z "$f" 2>/dev/null || echo 0)
    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [DRY-RUN] would gzip: $f ($(human "$sz"))"
    else
      if gzip -q "$f" 2>/dev/null; then
        jsonl_bytes=$((jsonl_bytes + sz))
      fi
    fi
    jsonl_count=$((jsonl_count + 1))
  done <<< "$old_jsonl"
  if [ "$jsonl_count" -gt 0 ]; then
    log "  ✅ gzipped ${jsonl_count} JSONL >${JSONL_AGE_DAYS}d"
    add_action "gzipped ${jsonl_count} JSONL files"
    add_freed "$jsonl_bytes"
  fi
}

#######################################
# Tier 4 actions
#######################################
do_tier4() {
  log "  🆘 Tier 4 PANIC actions starting"

  # --- H. Move largest output file → Extreme Pro/archive ---
  if [ -d "$EXT_ARCHIVE" ] && [ -d "$HOME/clawd/output" ]; then
    local largest
    largest=$(find "$HOME/clawd/output" -type f -size +10M 2>/dev/null \
      | xargs -I{} stat -f "%z %N" "{}" 2>/dev/null \
      | sort -rn \
      | head -1 \
      | awk '{$1=""; sub(/^ /,""); print}')
    if [ -n "$largest" ] && [ -f "$largest" ]; then
      local sz
      sz=$(stat -f%z "$largest" 2>/dev/null || echo 0)
      local dest_dir="$EXT_ARCHIVE/output-panic-$(date +%Y%m%d)"
      if [ "$DRY_RUN" -eq 1 ]; then
        log "  [DRY-RUN] would PANIC-move: $largest → $dest_dir/ ($(human "$sz"))"
      else
        mkdir -p "$dest_dir"
        if mv "$largest" "$dest_dir/" 2>/dev/null; then
          log "  ✅ PANIC-moved: $(basename "$largest") → Extreme Pro ($(human "$sz"))"
          add_freed "$sz"
        fi
      fi
      add_action "PANIC-moved largest output: $(basename "$largest") ($(human "$sz"))"
    else
      log "  ⚠️  no large file in clawd/output to evict"
    fi
  else
    log "  ⚠️  Extreme Pro/archive missing — skipping PANIC eviction"
  fi
}

#######################################
# Discord alert
#######################################
post_discord() {
  local urgent="$1"
  [ -z "$DISCORD_BOT_TOKEN" ] && { vlog "no DISCORD_BOT_TOKEN — skip alert"; return; }
  command -v curl >/dev/null 2>&1 || { vlog "no curl"; return; }
  command -v jq   >/dev/null 2>&1 || { vlog "no jq"; return; }

  local prefix=""
  [ "$urgent" -eq 1 ] && prefix="🆘 @Kevin URGENT — "

  local actions_str="No auto-actions (below Tier 2)."
  if [ ${#ACTIONS_TAKEN[@]} -gt 0 ]; then
    actions_str="Actions:"
    local i
    for ((i=0; i<${#ACTIONS_TAKEN[@]}; i++)); do
      actions_str="${actions_str}\n• ${ACTIONS_TAKEN[$i]}"
    done
  fi

  local body
  body=$(printf "%s💾 Disk monitor: **%d%%** used / %s free — Tier %d%s\nFreed this run: ~%s\n\n%s" \
    "$prefix" "$USE_PCT" "$FREE" "$TIER" \
    "$([ "$DRY_RUN" -eq 1 ] && echo " (DRY-RUN)")" \
    "$(human "$BYTES_FREED")" \
    "$actions_str")

  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [DRY-RUN] would post Discord alert"
    return
  fi

  curl -s -o /dev/null \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -X POST "https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages" \
    -d "$(jq -n --arg c "$body" '{content: $c}')" 2>/dev/null
  log "  📨 Discord alert posted"
}

#######################################
# Main
#######################################
case "$TIER" in
  0) : ;;  # below 85% — quiet
  1) log "  ⚠️  Tier 1 WARN (≥85%)" ;;
  2) do_tier2 ;;
  3) do_tier2; do_tier3 ;;
  4) do_tier2; do_tier3; do_tier4 ;;
esac

# Recheck disk
if [ "$TIER" -ge 2 ]; then
  USE_PCT_AFTER=$(df -h /System/Volumes/Data | tail -1 | awk '{gsub(/%/,"",$5); print $5}')
  FREE_AFTER=$(df -h /System/Volumes/Data | tail -1 | awk '{print $4}')
  log "  📊 after: ${USE_PCT_AFTER}% used / ${FREE_AFTER} free / ~$(human "$BYTES_FREED") freed this run"
fi

# Alert at ≥85% or any action taken
if [ "$TIER" -ge 1 ] || [ ${#ACTIONS_TAKEN[@]} -gt 0 ]; then
  post_discord "$([ "$TIER" -ge 4 ] && echo 1 || echo 0)"
fi

# Exit 1 on Tier 4 so cron mail catches it
[ "$TIER" -ge 4 ] && exit 1
exit 0
