#!/usr/bin/env bash
# gbrain-sync.sh — incremental sync of all memory sources into gbrain
# Runs via OC cron or PM2, sequentially (PGLite single-writer)
set -euo pipefail

GBRAIN="/Users/ai/clawd/tools/gbrain"
BUN="/opt/homebrew/bin/bun"
CLI="$GBRAIN/src/cli.ts"

# Load API keys for embeddings
source /Users/ai/.openclaw/.env 2>/dev/null || true

log() { echo "[gbrain-sync] $(date +%H:%M:%S) $1"; }

log "Starting incremental sync"

for ws in main architecture trading guestnetworks dev home orchestrator worker axiom; do
  dir="/Users/ai/clawd/workspaces/$ws/memory/"
  [ -d "$dir" ] && $BUN run "$CLI" import "$dir" --no-embed 2>&1 | grep -E "imported|skipped|error" || true
done

$BUN run "$CLI" import /Users/ai/clawd/shared/memory/ --no-embed 2>&1 | grep -E "imported|skipped|error" || true
$BUN run "$CLI" import /Users/ai/.claude/projects/-Users-ai-clawd/memory/ --no-embed 2>&1 | grep -E "imported|skipped|error" || true

log "Importing OC lcm.db summaries"
$BUN run /Users/ai/clawd/scripts/import-lcm.ts 2>&1 | grep -E "imported|errors|Done|Fatal|ERROR" || true

log "Generating embeddings for new pages"
$BUN run "$CLI" embed --stale 2>&1 | tail -3 || true

log "Exporting to Obsidian vault"
VAULT="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Kevin-Vault/12-Brain"
mkdir -p "$VAULT" 2>/dev/null
$BUN run "$CLI" export --dir "$VAULT" 2>&1 | tail -3 || true

log "Sync complete"
