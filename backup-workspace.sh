#!/bin/bash
# Nightly backup of ALL workspace .md files
# Replaces the skills-only backup
# Runs at 2am daily

set -euo pipefail

DATE=$(date +%Y%m%d)
BACKUP_BASE="/Users/ai/backups/workspace-md"
BACKUP_DIR="$BACKUP_BASE/$DATE"

mkdir -p "$BACKUP_DIR"

echo "$(date '+%Y-%m-%d %H:%M:%S') - Starting workspace backup..."

# Backup main clawd workspace (all .md files, preserving structure)
echo "Backing up /Users/ai/clawd..."
cd /Users/ai/clawd
find . -name "*.md" -type f | while read f; do
  dir=$(dirname "$f")
  mkdir -p "$BACKUP_DIR/clawd/$dir"
  cp "$f" "$BACKUP_DIR/clawd/$dir/"
done

# Note: clawd-family is now inside clawd/workspaces/family/ (backed up above)

# Backup key bin scripts
echo "Backing up ~/bin scripts..."
mkdir -p "$BACKUP_DIR/bin"
cp /Users/ai/bin/model-selector "$BACKUP_DIR/bin/" 2>/dev/null || true
cp /Users/ai/bin/set-default-model "$BACKUP_DIR/bin/" 2>/dev/null || true
cp /Users/ai/bin/x "$BACKUP_DIR/bin/" 2>/dev/null || true
cp /Users/ai/bin/cost-report "$BACKUP_DIR/bin/" 2>/dev/null || true
cp /Users/ai/bin/retell "$BACKUP_DIR/bin/" 2>/dev/null || true
cp /Users/ai/bin/elevenlabs-call "$BACKUP_DIR/bin/" 2>/dev/null || true

# Backup openclaw config (sanitized - no API keys)
echo "Backing up openclaw config structure..."
mkdir -p "$BACKUP_DIR/config"
jq 'del(.env) | del(.channels[].password) | del(.channels[].botToken) | del(.gateway.auth) | del(.talk.apiKey) | del(.models.providers[].apiKey)' \
  /Users/ai/.openclaw/openclaw.json > "$BACKUP_DIR/config/openclaw-structure.json" 2>/dev/null || true

# Keep only last 30 days
find "$BACKUP_BASE" -maxdepth 1 -type d -name "20*" -mtime +30 -exec rm -rf {} \;

# Summary
CLAWD_COUNT=$(find "$BACKUP_DIR/clawd" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)

echo "✅ Backup complete: $BACKUP_DIR"
echo "   - clawd: $CLAWD_COUNT .md files (includes all workspaces)"
echo "   - Size: $SIZE"
