#!/usr/bin/env bash
# Send a minimal request every 55 min to keep Anthropic prompt cache warm
# The extended-cache-ttl gives us 1hr; this refreshes at 55min to prevent expiry
set -euo pipefail

# Headroom proxy health probe (verifies proxy is alive before warming cache)
if ! curl -fsS http://localhost:6767/health >/dev/null 2>&1; then
  echo "WARN: headroom-proxy DOWN at $(date)" | tee -a /tmp/cache-keepalive.log
fi

curl -s -o /dev/null -w "cache-keepalive: %{http_code}\n" \
  http://127.0.0.1:6767/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $(cat ~/.claude/claudeswap-key 2>/dev/null || echo 'sk-placeholder')" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: extended-cache-ttl-2025-04-11,prompt-caching-2024-07-31" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","text":"ping","cache_control":{"type":"ephemeral"}}]}]}' \
  --max-time 10 >> /tmp/cache-keepalive.log 2>&1
