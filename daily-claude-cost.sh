#!/bin/bash
# Daily Claude Code cost summary — lightweight tracking via ccusage + ClaudeSwap + Portkey
# Run via cron or manually. Posts to Discord if DISCORD_COST_WEBHOOK set.
#
# Usage:
#   bash ~/clawd/scripts/daily-claude-cost.sh            # print to stdout
#   bash ~/clawd/scripts/daily-claude-cost.sh --discord  # also post to Discord

set -euo pipefail

# Yesterday's cost via ccusage (Claude Code CLI sessions)
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d "yesterday" +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)

echo "=== Claude Code Cost Report — $TODAY ==="
echo ""
echo "### ccusage (CLI sessions) ###"
ccusage --from "$YESTERDAY" --to "$TODAY" 2>&1 | tail -30 || echo "ccusage failed"

echo ""
echo "### ClaudeSwap (OpenClaw Anthropic OAuth) ###"
# Tail last 1000 lines of ClaudeSwap logs, count requests + errors
CS_LOG="$HOME/.pm2/logs/claudeswap-out.log"
CS_ERR="$HOME/.pm2/logs/claudeswap-error.log"
if [ -f "$CS_LOG" ]; then
  REQS=$(tail -n 10000 "$CS_LOG" 2>/dev/null | grep -c "POST /v1/messages" || echo 0)
  ERRS=$(tail -n 10000 "$CS_ERR" 2>/dev/null | grep -cE "ERROR|5[0-9]{2}" || echo 0)
  echo "Requests (last 10k log lines): $REQS"
  echo "Errors (last 10k log lines): $ERRS"
else
  echo "ClaudeSwap logs not found at $CS_LOG"
fi

echo ""
echo "### Portkey (LLM routing) ###"
# Portkey tracks cost at portkey.ai dashboard — link only
echo "Dashboard: https://app.portkey.ai/ (free tier = 10K req/mo analytics)"
echo "Local proxy: http://alfred:8790"

echo ""
echo "### Active Claude Code processes ###"
pgrep -lf "claude --" 2>/dev/null | head -5 || echo "(none running)"

# Optional Discord post
if [ "${1:-}" = "--discord" ] && [ -n "${DISCORD_COST_WEBHOOK:-}" ]; then
  MSG="$(bash "$0" 2>/dev/null | head -40)"
  curl -sS -X POST "$DISCORD_COST_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"\`\`\`\n$MSG\n\`\`\`\"}" > /dev/null
  echo "[Posted to Discord]"
fi
