#!/usr/bin/env bash
# oc-hook-input-sanitizer.sh — OpenClaw preProcess hook wrapper for input-sanitizer.js
#
# Called by OpenClaw with the incoming message passed as $1.
# Scans for prompt injection patterns and logs any findings.
# Alert-only mode — does NOT block or reject messages.
#
# Expected call convention from openclaw.json hooks:
#   command: "/Users/ai/clawd/scripts/oc-hook-input-sanitizer.sh"
#   args passed by OC: the raw message text as the first argument
#
# Exit codes:
#   0 — clean (or alert-only; OC should continue processing)
#   Non-zero — reserved for future blocking mode

set -euo pipefail

SCRIPT_DIR="/Users/ai/clawd/scripts"
NODE="$(which node 2>/dev/null || echo '/usr/local/bin/node')"

# If no argument provided, nothing to scan
if [ $# -eq 0 ]; then
  exit 0
fi

MESSAGE="$*"

# Run the sanitizer in CLI mode (node input-sanitizer.js "<message>")
OUTPUT=$("$NODE" "$SCRIPT_DIR/input-sanitizer.js" "$MESSAGE" 2>&1) || true

# Log findings to stderr so OC captures them in hook logs
if echo "$OUTPUT" | grep -q "^ALERT"; then
  echo "[oc-hook-input-sanitizer] $(date -u +%Y-%m-%dT%H:%M:%SZ) $OUTPUT" >&2
fi

# Always exit 0 — alert-only mode, never block
exit 0
