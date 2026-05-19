#!/usr/bin/env bash
# Sync canonical ~/clawd/shared/*.md into Obsidian Vault 09-Tools/OpenClaw/
set -euo pipefail

SHARED="$HOME/clawd/shared"
VAULT="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Kevin-Vault/09-Tools/OpenClaw"

mkdir -p "$VAULT"

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ -f "$src" ]]; then
    cp "$src" "$dst"
    echo "  copied: $(basename "$src") -> $(basename "$dst")"
  else
    echo "  SKIP: $src not found"
  fi
}

copy_if_exists "$SHARED/OWNERS-MANUAL.md"              "$VAULT/00-OWNERS-MANUAL.md"
copy_if_exists "$SHARED/CHEAT-SHEET.md"                "$VAULT/01-CHEAT-SHEET.md"
copy_if_exists "$SHARED/PORT-REGISTRY.md"              "$VAULT/02-PORT-REGISTRY.md"
copy_if_exists "$SHARED/TEAM-DIRECTORY.md"             "$VAULT/03-TEAM-DIRECTORY.md"
copy_if_exists "$SHARED/LLM-ROUTING-QUICKREF.md"       "$VAULT/04-LLM-ROUTING.md"
copy_if_exists "$SHARED/INTER-AGENT-PROTOCOL.md"       "$VAULT/05-INTER-AGENT-PROTOCOL.md"
copy_if_exists "$SHARED/refs/MULTI-AGENT-ORCHESTRATION.md" "$VAULT/06-MULTI-AGENT-ORCHESTRATION.md"
copy_if_exists "$SHARED/refs/SYSTEM-FLOW-MAP.md"       "$VAULT/07-SYSTEM-FLOW-MAP.md"

# Update README timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
sed -i '' "s/last sync [0-9-]* [0-9:]*/last sync $TIMESTAMP/" "$VAULT/README.md" 2>/dev/null || true

echo "synced $(ls "$VAULT" | wc -l | tr -d ' ') files to Obsidian Vault at $(date)"
