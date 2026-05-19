#!/usr/bin/env bash
# sync-to-obsidian.sh — Manual sync of finalized clawd refs to Obsidian vault.
#
# Per Kevin's policy: save locally first, copy to Obsidian only when finalized.
# This script is RUN ON DEMAND, not on cron.
#
# Targets a flat "clawd" subfolder under 08-Agents/ in Kevin-Vault (iCloud).
# Adds a header banner noting the file is a synced copy.

set -euo pipefail
VAULT="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Kevin-Vault"
TARGET="$VAULT/08-Agents/clawd"
mkdir -p "$TARGET/runbooks"

SOURCES=(
  "$HOME/clawd/shared/LLM-ROUTING.md::LLM-ROUTING.md"
  "$HOME/clawd/shared/TEAM-DIRECTORY.md::TEAM-DIRECTORY.md"
  "$HOME/clawd/shared/refs/FREE-FLEET-CAPACITY-2026-05-11.md::FREE-FLEET-CAPACITY.md"
  "$HOME/clawd/shared/refs/FREE-FLEET-BACKLOG.md::FREE-FLEET-BACKLOG.md"
  "$HOME/clawd/CLAUDE.md::CLAUDE-PLATFORM-OVERVIEW.md"
)

RUNBOOKS=(
  "$HOME/clawd/scripts/openai-leak-guard.sh::openai-leak-guard.md"
  "$HOME/clawd/scripts/fleet-status.sh::fleet-status.md"
  "$HOME/clawd/scripts/curate-free-fleet.cjs::curate-free-fleet.md"
  "$HOME/clawd/scripts/bookmark-poll.cjs::bookmark-poll.md"
)

banner() {
  cat <<EOF
> ⚠️ **Synced from clawd repo — read-only mirror.** Source of truth: \`$1\`
> Last sync: $(date '+%Y-%m-%d %H:%M %Z') by sync-to-obsidian.sh

EOF
}

synced=0
for entry in "${SOURCES[@]}"; do
  src=${entry%%::*}; dest=${entry##*::}
  if [ -f "$src" ]; then
    {
      banner "$src"
      cat "$src"
    } > "$TARGET/$dest"
    synced=$((synced+1))
    echo "✓ $dest"
  else
    echo "✗ skip $dest (source missing: $src)"
  fi
done

for entry in "${RUNBOOKS[@]}"; do
  src=${entry%%::*}; dest=${entry##*::}
  if [ -f "$src" ]; then
    {
      banner "$src"
      echo '```bash'
      cat "$src"
      echo '```'
    } > "$TARGET/runbooks/$dest"
    synced=$((synced+1))
    echo "✓ runbooks/$dest"
  fi
done

# Write an index page
cat > "$TARGET/_README.md" <<EOF
# clawd → Obsidian Sync

This folder mirrors finalized clawd platform docs into the Kevin-Vault.

**Last sync:** $(date '+%Y-%m-%d %H:%M %Z')

## Documents
$(for entry in "${SOURCES[@]}"; do echo "- [[${entry##*::}]]"; done)

## Runbooks
$(for entry in "${RUNBOOKS[@]}"; do echo "- [[runbooks/${entry##*::}]]"; done)

## Refresh
Run: \`bash ~/clawd/scripts/sync-to-obsidian.sh\`
EOF

echo "---"
echo "Synced $synced files → $TARGET"
echo "Index: $TARGET/_README.md"
