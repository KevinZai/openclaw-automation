#!/usr/bin/env bash
# Description:  Check if Obsidian vault has files newer than last daily-brief entry
set -euo pipefail
# Gates:        vault-sync cron (sync Obsidian notes into clawd shared refs)
# Expected savings: ~60% — vault only changes when Kevin actively writes notes

VAULT_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Kevin-Vault"
BRIEF_DIR="$HOME/clawd/shared/daily-brief"

# Find newest file in vault (exclude .obsidian config dir)
NEWEST_VAULT=$(find "$VAULT_DIR" -not -path "*/.obsidian/*" -type f -newer /dev/null -printf "%T@ %p\n" 2>/dev/null \
  | sort -rn | head -1 | awk '{print $1}' | cut -d. -f1)

# Find newest daily-brief file mtime as the "last sync" marker
NEWEST_BRIEF=$(find "$BRIEF_DIR" -name "*.md" -type f -printf "%T@ %p\n" 2>/dev/null \
  | sort -rn | head -1 | awk '{print $1}' | cut -d. -f1)

# macOS stat fallback (no -printf support; use -print0 + while to handle spaces in path)
if [ -z "$NEWEST_VAULT" ]; then
  NEWEST_VAULT=$(find "$VAULT_DIR" -not -path "*/.obsidian/*" -type f -print0 2>/dev/null \
    | while IFS= read -r -d '' f; do stat -f "%m" "$f" 2>/dev/null; done \
    | sort -rn | head -1)
  NEWEST_BRIEF=$(find "$BRIEF_DIR" -name "*.md" -type f -print0 2>/dev/null \
    | while IFS= read -r -d '' f; do stat -f "%m" "$f" 2>/dev/null; done \
    | sort -rn | head -1)
fi

if [ -z "$NEWEST_VAULT" ]; then
  echo "precheck-vault-sync: FIRE — vault unreadable, running sync to be safe"
  exit 0
fi

if [ -z "$NEWEST_BRIEF" ] || [ "${NEWEST_VAULT:-0}" -gt "${NEWEST_BRIEF:-0}" ]; then
  echo "precheck-vault-sync: FIRE — vault newer than last daily-brief (vault=${NEWEST_VAULT} brief=${NEWEST_BRIEF})"
  exit 0
fi

echo "precheck-vault-sync: SKIP — vault unchanged since last sync"
exit 1
