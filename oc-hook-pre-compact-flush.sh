#!/usr/bin/env bash
# oc-hook-pre-compact-flush.sh — OpenClaw preCompact hook wrapper for pre-compact-flush.js
#
# Called by OpenClaw immediately before session compaction.
# Writes a compaction checkpoint entry to each active workspace's daily memory file.
#
# Expected call convention from openclaw.json hooks:
#   command: "/Users/ai/clawd/scripts/oc-hook-pre-compact-flush.sh"
#   Optional: pass --workspace <name> to flush a single workspace only.
#   Without args: flushes all default workspaces (main, trading, architecture,
#                 guestnetworks, orchestrator, wealth).
#
# Exit codes:
#   0 — flush completed (or nothing to flush)
#   Non-zero — write error (will appear in OC hook logs)

set -euo pipefail

SCRIPT_DIR="/Users/ai/clawd/scripts"
NODE="$(which node 2>/dev/null || echo '/usr/local/bin/node')"

# Forward all arguments to the Node script unchanged
"$NODE" "$SCRIPT_DIR/pre-compact-flush.js" "$@"
