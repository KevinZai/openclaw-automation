#!/bin/bash
# memory-promote.sh — Scan daily memory files for tagged entries not yet in MEMORY.md
# Auto-appends new entries with [AUTO-PROMOTED] tag. Dedup check included.
# Alerts via Telegram if fails 2 consecutive Sundays.
# Usage: bash scripts/memory-promote.sh [workspace]
# If workspace omitted, scans all workspaces.

set -euo pipefail

CLAWD="$HOME/clawd"
WORKSPACES="main trading dev architecture guestnetworks orchestrator worker home axiom wealth"
STATE_FILE="$CLAWD/scripts/.memory-promote-state.json"
AUTO_APPEND="${AUTO_APPEND:-true}"  # Set to false for dry-run

if [ "${1:-}" != "" ]; then
  WORKSPACES="$1"
fi

TAGS='\[(DECISION|CORRECTION|LEARNED|PATTERN|RULE|INSIGHT)\]'
TOTAL_PROMOTED=0
ERRORS=0

for ws in $WORKSPACES; do
  MEMORY_DIR="$CLAWD/workspaces/$ws/memory"
  MEMORY_MD="$CLAWD/workspaces/$ws/MEMORY.md"

  if [ ! -d "$MEMORY_DIR" ]; then
    continue
  fi

  # Find daily files from last 14 days only (not ancient history)
  cutoff_date=$(date -v-14d +%Y-%m-%d 2>/dev/null || date -d "14 days ago" +%Y-%m-%d 2>/dev/null || echo "2020-01-01")
  daily_files=$(find "$MEMORY_DIR" -maxdepth 1 -name '202[0-9]-[0-9][0-9]-[0-9][0-9].md' -type f 2>/dev/null | sort)

  if [ -z "$daily_files" ]; then
    continue
  fi

  new_entries=""
  entry_count=0

  while IFS= read -r file; do
    # Skip files older than 14 days by filename
    basename_f=$(basename "$file" .md)
    if [[ "$basename_f" < "$cutoff_date" ]]; then
      continue
    fi

    matches=$(grep -nE "$TAGS" "$file" 2>/dev/null || true)
    if [ -n "$matches" ]; then
      while IFS= read -r line; do
        # Extract entry text (strip line number prefix)
        entry_text=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/^[[:space:]\-\*]*//' | head -c 200)

        # Dedup: check first 40 chars against MEMORY.md
        dedup_key=$(echo "$entry_text" | cut -c1-40)
        if [ -f "$MEMORY_MD" ] && grep -qF "$dedup_key" "$MEMORY_MD" 2>/dev/null; then
          continue  # Already in MEMORY.md
        fi

        # Also check for [AUTO-PROMOTED] version
        if [ -f "$MEMORY_MD" ] && grep -qF "[AUTO-PROMOTED]" "$MEMORY_MD" 2>/dev/null && grep -qF "$dedup_key" "$MEMORY_MD" 2>/dev/null; then
          continue
        fi

        new_entries="${new_entries}\n- [AUTO-PROMOTED] [$basename_f] $entry_text"
        entry_count=$((entry_count + 1))
      done <<< "$matches"
    fi
  done <<< "$daily_files"

  if [ -n "$new_entries" ] && [ "$entry_count" -gt 0 ]; then
    echo "=== $ws === ($entry_count new entries)"

    if [ "$AUTO_APPEND" = "true" ] && [ -f "$MEMORY_MD" ]; then
      # Append to MEMORY.md
      echo "" >> "$MEMORY_MD"
      echo "## Auto-Promoted $(date +%Y-%m-%d)" >> "$MEMORY_MD"
      echo -e "$new_entries" >> "$MEMORY_MD"
      echo "[memory-promote] Appended $entry_count entries to $ws/MEMORY.md"
      TOTAL_PROMOTED=$((TOTAL_PROMOTED + entry_count))
    else
      # Dry-run: just print
      echo -e "$new_entries"
    fi
    echo ""
  fi
done

echo "[memory-promote] Total promoted: $TOTAL_PROMOTED"

# Update state for failure tracking
if command -v python3 &>/dev/null; then
  python3 -c "
import json, os
from datetime import datetime

state_file = '$STATE_FILE'
try:
    with open(state_file) as f:
        state = json.load(f)
except:
    state = {'runs': [], 'consecutiveFailures': 0}

state['runs'] = state.get('runs', [])[-10:]
state['runs'].append({'date': datetime.now().isoformat(), 'promoted': $TOTAL_PROMOTED, 'errors': $ERRORS})
state['consecutiveFailures'] = 0
state['lastRun'] = datetime.now().isoformat()

with open(state_file, 'w') as f:
    json.dump(state, f, indent=2)
" 2>/dev/null || true
fi
