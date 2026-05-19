#!/usr/bin/env bash
# Elon agent migration — xai/grok-4.3 direct → hermes-proxy/grok-4.3 OAuth
# Constitution Rules: 2 (one front door = Hermes), 19 (no gateway restart)
#
# PREREQUISITES (Kevin manual — browser-interactive, run BEFORE this script):
#   1. hermes login --provider xai-oauth          # SuperGrok OAuth flow
#   2. hermes proxy start --provider supergrok --port 8910 &   # start proxy
#      OR: pm2 start "hermes proxy start --provider supergrok --port 8910" --name hermes-proxy
#   3. curl -s http://127.0.0.1:8910/v1/models    # verify proxy returns grok models
#
# THIS SCRIPT (idempotent, safe):
#   a. Verify proxy is running
#   b. Backup ~/.openclaw/openclaw.json
#   c. Add hermes-proxy provider to OC config
#   d. Switch Elon agent's model to hermes-proxy/grok-4.3
#   e. Verify config validates via openclaw doctor (no --fix per Rule 18)
#
# Apply with --apply flag. Default is --dry-run.

set -euo pipefail

APPLY=0
PROXY_PORT="${HERMES_PROXY_PORT:-8910}"
PROXY_HOST="${HERMES_PROXY_HOST:-127.0.0.1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --port) PROXY_PORT="$2"; shift 2 ;;
    --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

OC_CONFIG="${HOME}/.openclaw/openclaw.json"
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"

step() { printf '\n=== %s ===\n' "$*"; }

step "STEP A: Verify Hermes proxy running"
if ! curl -s --max-time 3 "${PROXY_URL}/v1/models" >/dev/null 2>&1; then
  echo "❌ Hermes proxy not responding at ${PROXY_URL}"
  echo ""
  echo "Run these (Kevin-manual, browser-interactive):"
  echo "   hermes login --provider xai-oauth"
  echo "   hermes proxy start --provider supergrok --port ${PROXY_PORT} &"
  echo ""
  echo "Then re-run this script."
  exit 1
fi
echo "✅ proxy responds at ${PROXY_URL}"
MODELS=$(curl -s --max-time 3 "${PROXY_URL}/v1/models" | jq -r '.data[]?.id' 2>/dev/null | head -3)
echo "  Available models (first 3): $MODELS"

step "STEP B: Show current Elon model"
CURRENT=$(jq -r '.agents.list[] | select(.id=="elon") | .model' "$OC_CONFIG")
echo "  Current: elon.model = $CURRENT"
if [[ "$CURRENT" == "hermes-proxy/grok-4.3" ]]; then
  echo "✅ Elon already migrated. Exiting."
  exit 0
fi

step "STEP C: Dry-run diff preview"
TMP=$(mktemp)
jq --arg url "${PROXY_URL}/v1/chat/completions" '
  .models.providers["hermes-proxy"] = {
    "api": $url,
    "apiKey": "HERMES_PROXY_TOKEN",
    "models": ["grok-4.3", "grok-4-fast-reasoning"]
  }
  | (.agents.list[] | select(.id == "elon").model) = "hermes-proxy/grok-4.3"
' "$OC_CONFIG" > "$TMP"

if ! jq empty "$TMP"; then
  echo "❌ jq produced invalid JSON. Aborting."
  rm -f "$TMP"
  exit 1
fi

echo "Diff (model fields only):"
diff <(jq -S '.agents.list[] | select(.id=="elon") | {id, model}' "$OC_CONFIG") <(jq -S '.agents.list[] | select(.id=="elon") | {id, model}' "$TMP") || true
echo ""
echo "Provider added: hermes-proxy (models: grok-4.3, grok-4-fast-reasoning)"

if [[ "$APPLY" -eq 0 ]]; then
  echo ""
  echo "🟡 DRY RUN — re-run with --apply to write changes."
  rm -f "$TMP"
  exit 0
fi

step "STEP D: Apply changes"
BAK="${OC_CONFIG}.backup-elon-hermes-$(date +%Y%m%d-%H%M%S)"
cp "$OC_CONFIG" "$BAK"
echo "  Backup: $BAK"
mv "$TMP" "$OC_CONFIG"
chmod 600 "$OC_CONFIG"
echo "✅ Applied"

step "STEP E: Validate (openclaw doctor, NO --fix per Rule 18)"
if openclaw doctor 2>&1 | grep -q 'Invalid config'; then
  echo "❌ openclaw doctor reported invalid config. Restoring backup."
  cp "$BAK" "$OC_CONFIG"
  exit 1
fi
echo "✅ openclaw doctor passed"

step "DONE"
echo "Elon now routes through Hermes proxy. NO gateway restart needed — Constitution Rule 19 honored."
echo "Next OC heartbeat or cron run for Elon will use the new route."
echo "Verify after first run: openclaw cron runs --id elon"
