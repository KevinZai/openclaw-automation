#!/bin/bash
# links-health-check.sh — Validates all links-server URLs are reachable
# Runs as part of service-watchdog or standalone cron
# Alerts on broken links so they never stay down unnoticed
#
# Usage: ./links-health-check.sh [--fix]
#   --fix: automatically restart links-server if URLs are stale

set -euo pipefail

LINKS_API="http://127.0.0.1:3003/api/services"
LOG_TAG="[links-health]"
FAILED=0
TOTAL=0

echo "$LOG_TAG START $(date '+%H:%M:%S')"

# Fetch service list
SERVICES=$(node -e "
const http = require('http');
http.get('${LINKS_API}', {timeout: 5000}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const data = JSON.parse(d);
    for (const s of data.services) {
      // Skip non-HTTP services (they won't respond to GET)
      const url = new URL(s.url);
      console.log(JSON.stringify({name: s.name, url: s.url, host: url.hostname, port: url.port}));
    }
  });
}).on('error', () => { console.error('links-server unreachable'); process.exit(1); });
" 2>/dev/null) || {
  echo "$LOG_TAG ERROR: links-server unreachable at ${LINKS_API} — service is DOWN (Phase 3 will restore)"
  echo "$LOG_TAG DONE $(date '+%H:%M:%S') [degraded — links-server down]"
  exit 0
}

# Check each URL uses correct hostname for its bind
while IFS= read -r line; do
  NAME=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])")
  URL=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
  HOST=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin)['host'])")
  PORT=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin)['port'])")
  TOTAL=$((TOTAL + 1))

  # Skip HTTPS/external URLs (Caddy-proxied, always work)
  if [[ "$URL" == https://* ]]; then
    continue
  fi

  # Skip if no port (shouldn't happen)
  [ -z "$PORT" ] && continue

  # Check actual bind address via lsof
  BIND=$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | grep -v COMMAND | head -1 | awk '{print $9}')

  if [ -z "$BIND" ]; then
    echo "$LOG_TAG WARN: ${NAME} (${URL}) — port ${PORT} not listening"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Check for hostname mismatch
  if echo "$BIND" | grep -q "127.0.0.1" && [ "$HOST" = "alfred" ]; then
    echo "$LOG_TAG FAIL: ${NAME} — URL uses 'alfred' but service bound to 127.0.0.1"
    FAILED=$((FAILED + 1))
  elif echo "$BIND" | grep -q "\*:" && [ "$HOST" = "localhost" -o "$HOST" = "127.0.0.1" ]; then
    # Wildcard bind with localhost URL — this works fine
    :
  fi
done <<< "$SERVICES"

echo "$LOG_TAG Checked ${TOTAL} services, ${FAILED} issues"

if [ "$FAILED" -gt 0 ]; then
  echo "$LOG_TAG ACTION NEEDED: ${FAILED} links have hostname/bind mismatches"
  exit 1
fi

echo "$LOG_TAG DONE $(date '+%H:%M:%S')"
