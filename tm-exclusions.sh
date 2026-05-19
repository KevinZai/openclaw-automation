#!/bin/bash
# Time Machine exclusions for reproducible/ephemeral data
# Run with: sudo bash ~/clawd/scripts/tm-exclusions.sh
# Re-run after adding new projects with node_modules

set -euo pipefail

echo "Adding Time Machine exclusions..."

# 1. All node_modules (biggest offender ~8GB)
find ~/clawd -maxdepth 4 -name "node_modules" -type d -exec tmutil addexclusion {} \;
echo "✅ node_modules excluded"

# 2. All .next build dirs
find ~/clawd -maxdepth 4 -name ".next" -type d -exec tmutil addexclusion {} \;
echo "✅ .next build dirs excluded"

# 3. OpenClaw ephemeral/rebuildable
tmutil addexclusion ~/.openclaw/memory        # LCM vector store (694MB)
tmutil addexclusion ~/.openclaw/extensions     # LCM data (571MB)
tmutil addexclusion ~/.openclaw/browser        # browser cache (154MB)
tmutil addexclusion ~/.openclaw/logs           # logs (72MB)
tmutil addexclusion ~/.openclaw/media          # media cache (44MB)
echo "✅ OpenClaw ephemeral excluded"

# 4. Claude Code ephemeral
tmutil addexclusion ~/.claude/projects         # session data (739MB)
tmutil addexclusion ~/.claude/plugins          # reinstallable (260MB)
tmutil addexclusion ~/.claude/debug            # debug logs (14MB)
tmutil addexclusion ~/.claude/telemetry        # telemetry (2MB)
tmutil addexclusion ~/.claude/shell-snapshots  # shell snapshots
tmutil addexclusion ~/.claude/file-history     # file history (27MB)
tmutil addexclusion ~/.claude/sessions         # session JSONs
echo "✅ Claude Code ephemeral excluded"

# 5. Pruned skill backups
tmutil addexclusion ~/.claude/skills-pruned-backup-20260321
tmutil addexclusion ~/.claude/plugins/cache/antigravity-pruned-backup 2>/dev/null || true
echo "✅ Skill backup dirs excluded"

echo ""
echo "=== Verification ==="
for p in ~/.openclaw/memory ~/.openclaw/extensions ~/.openclaw/browser ~/.openclaw/logs ~/.claude/projects ~/.claude/plugins; do
    tmutil isexcluded "$p"
done

echo ""
echo "Done. Estimated savings: ~11GB per backup cycle."
