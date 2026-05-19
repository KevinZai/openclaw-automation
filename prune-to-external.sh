#!/usr/bin/env bash
# prune-to-external — MOVE old backups to external HD, NEVER delete.
# Per Kevin policy 2026-05-18: backups always preserved on /Volumes/Extreme Pro/
#
# Usage:
#   bash scripts/prune-to-external.sh            # dry-run (default)
#   bash scripts/prune-to-external.sh --apply    # actually move
#   bash scripts/prune-to-external.sh --target lcm|gbrain|all  # scope
#
# Targets:
#   lcm     — LCM backups older than 2 days
#   gbrain  — gbrain DB backups (corrupted state, replaced by fresh import)
#   all     — both of the above
#
# Move destination: /Volumes/Extreme Pro/mac-mini-offload/local-pruned/<category>/

set -uo pipefail

APPLY=0
TARGET="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    --help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done

EXT_BASE="/Volumes/Extreme Pro/mac-mini-offload/local-pruned"

# Sanity: external drive mounted?
if [[ ! -d "/Volumes/Extreme Pro" ]]; then
  echo "❌ /Volumes/Extreme Pro NOT mounted — refusing to proceed (would lose data)"
  exit 1
fi

# Sanity: target dir on external?
mkdir -p "$EXT_BASE/lcm" "$EXT_BASE/gbrain"
echo "Target: $EXT_BASE/"
echo "Mode: $([ $APPLY -eq 1 ] && echo APPLY || echo DRY-RUN)"
echo ""

# ── LCM backups older than 2 days ─────────────────────────────
prune_lcm() {
  echo "=== LCM backups (older than 2d) ==="
  local count=0 total_bytes=0
  for f in /Users/ai/.openclaw/lcm.db.backup-lcm-sanitizer-*; do
    [[ ! -f "$f" ]] && continue
    # mtime older than 2 days?
    if [[ $(find "$f" -mtime +2 -print 2>/dev/null) ]]; then
      local size=$(du -h "$f" | cut -f1)
      local bytes=$(stat -f %z "$f")
      echo "  $size  $(basename "$f")"
      if [[ "$APPLY" -eq 1 ]]; then
        mv "$f" "$EXT_BASE/lcm/" && echo "    → moved to $EXT_BASE/lcm/"
      fi
      count=$((count + 1))
      total_bytes=$((total_bytes + bytes))
    fi
  done
  echo "  $count files, $((total_bytes / 1024 / 1024))MB"
}

# ── gbrain replaced backups (corrupted) ───────────────────────
prune_gbrain() {
  echo ""
  echo "=== gbrain corrupted/pre-nuke backups (kept after fresh import) ==="
  for d in /Users/ai/.gbrain/brain.pglite.corrupted-* /Users/ai/.gbrain/brain.pglite.backup-* ; do
    [[ ! -d "$d" ]] && continue
    local size=$(du -sh "$d" | cut -f1)
    echo "  $size  $(basename "$d")"
    if [[ "$APPLY" -eq 1 ]]; then
      # Only move if fresh brain has substantial data (heuristic: >100M)
      local fresh_size=$(du -sm ~/.gbrain/brain.pglite 2>/dev/null | cut -f1)
      if [[ "$fresh_size" -lt 100 ]]; then
        echo "    ⚠️  skipped — fresh brain only $fresh_size MB (not enough confidence to move backup)"
        continue
      fi
      mv "$d" "$EXT_BASE/gbrain/" && echo "    → moved to $EXT_BASE/gbrain/"
    fi
  done
}

# ── Execute ───────────────────────────────────────────────────
case "$TARGET" in
  lcm) prune_lcm ;;
  gbrain) prune_gbrain ;;
  all) prune_lcm; prune_gbrain ;;
  *) echo "unknown target: $TARGET" >&2; exit 2 ;;
esac

echo ""
if [[ "$APPLY" -eq 0 ]]; then
  echo "🟡 DRY-RUN — pass --apply to move files."
  echo "   Files MOVED (not deleted). Restore: mv \"\$EXT_BASE/<cat>/<file>\" /Users/ai/..."
fi
df -h /System/Volumes/Data | tail -1
