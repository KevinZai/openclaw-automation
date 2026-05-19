#!/usr/bin/env bash
# pc.sh — Paperclip REST API wrapper
#
# Usage:
#   pc.sh <METHOD> <path>            # e.g. pc.sh GET /api/companies
#   pc.sh GET  /api/agents/me
#   pc.sh POST /api/companies/$CID/issues '{"title":"...","projectId":"..."}'
#   pc.sh PATCH /api/issues/$IID '{"status":"in_progress"}'
#
# Shortcuts (auto-resolve companyId from claimed key):
#   pc.sh tasks.list                 → GET /api/companies/$CID/issues
#   pc.sh tasks.get <id>             → GET /api/issues/<id>
#   pc.sh tasks.create <json>        → POST /api/companies/$CID/issues
#   pc.sh tasks.update <id> <json>   → PATCH /api/issues/<id>
#   pc.sh agents.list                → GET /api/companies/$CID/agents
#   pc.sh agents.me                  → GET /api/agents/me
#   pc.sh projects.list              → GET /api/companies/$CID/projects
#   pc.sh health                     → GET /api/health
#
# Routines (cron + webhook + api triggers — see shared/refs/PAPERCLIP-ROUTINES-API.md):
#   pc.sh routines.list                       → GET /api/companies/$CID/routines
#   pc.sh routines.get <id>                   → GET /api/routines/<id>
#   pc.sh routines.create <json>              → POST /api/companies/$CID/routines  [board]
#   pc.sh routines.update <id> <json>         → PATCH /api/routines/<id>
#   pc.sh routines.runs <id>                  → GET /api/routines/<id>/runs
#   pc.sh routines.fire <id> [json]           → POST /api/routines/<id>/run        [board]
#   pc.sh routines.triggers.add <id> <json>   → POST /api/routines/<id>/triggers
#   pc.sh routines.triggers.update <id> <json>→ PATCH /api/routine-triggers/<id>
#   pc.sh routines.triggers.delete <id>       → DELETE /api/routine-triggers/<id>
#   pc.sh routines.triggers.rotate <id>       → POST /api/routine-triggers/<id>/rotate-secret
#
# Auth modes (server resolves automatically):
#   --board       : NO Authorization header → treated as local_implicit board (full admin).
#                   Required for cross-agent ops (create routine assigned to a different agent,
#                   manual fire, trigger CRUD). Localhost-only path.
#   default       : Bearer token from key-file → agent identity; restricted to self-assigned routines.
#
# Auth: reads ~/.openclaw/workspace/paperclip-claimed-api-key.json (token + companyId).
# Override with $PAPERCLIP_TOKEN, $PAPERCLIP_COMPANY_ID, $PAPERCLIP_API_URL.
# Add --board as 1st arg after the command to force board (no-auth localhost) mode.

set -euo pipefail

KEY_FILE="${PAPERCLIP_KEY_FILE:-$HOME/.openclaw/workspace/paperclip-claimed-api-key.json}"
API_URL="${PAPERCLIP_API_URL:-}"
TOKEN="${PAPERCLIP_TOKEN:-}"
CID="${PAPERCLIP_COMPANY_ID:-}"

if [[ -f "$KEY_FILE" ]]; then
  [[ -z "$TOKEN"   ]] && TOKEN=$(/usr/bin/python3 -c "import json,sys; print(json.load(open('$KEY_FILE'))['token'])" 2>/dev/null || true)
  [[ -z "$CID"     ]] && CID=$(/usr/bin/python3 -c "import json,sys; print(json.load(open('$KEY_FILE'))['companyId'])" 2>/dev/null || true)
  [[ -z "$API_URL" ]] && API_URL=$(/usr/bin/python3 -c "import json,sys; print(json.load(open('$KEY_FILE'))['apiUrl'])" 2>/dev/null || true)
fi
API_URL="${API_URL:-http://127.0.0.1:3100}"

if [[ -z "$TOKEN" ]]; then
  echo "pc.sh: no Paperclip token — set PAPERCLIP_TOKEN or create $KEY_FILE" >&2
  exit 2
fi

BOARD_MODE=0

call() {
  local method="$1" path="$2" body="${3:-}"
  local auth_header=""
  if [[ $BOARD_MODE -eq 0 ]]; then
    auth_header="authorization: Bearer $TOKEN"
  else
    auth_header="x-paperclip-board-mode: local_implicit"
  fi
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$API_URL$path" \
      -H "$auth_header" \
      -H "content-type: application/json" \
      -d "$body"
  else
    curl -fsS -X "$method" "$API_URL$path" \
      -H "$auth_header"
  fi
  echo
}

cmd="${1:-help}"; shift || true

# Allow --board flag immediately after command to force no-auth local_implicit mode
if [[ "${1:-}" == "--board" ]]; then
  BOARD_MODE=1
  shift
fi

case "$cmd" in
  help|-h|--help)
    sed -n '2,22p' "$0"
    exit 0
    ;;
  health)        call GET /api/health ;;
  agents.me)     call GET /api/agents/me ;;
  agents.list)   call GET "/api/companies/$CID/agents" ;;
  projects.list) call GET "/api/companies/$CID/projects" ;;
  tasks.list)    call GET "/api/companies/$CID/issues" ;;
  tasks.get)     call GET "/api/issues/$1" ;;
  tasks.create)  call POST "/api/companies/$CID/issues" "$1" ;;
  tasks.update)  call PATCH "/api/issues/$1" "$2" ;;
  tasks.comment) call POST "/api/issues/$1/comments" "$2" ;;
  routines.list)            call GET    "/api/companies/$CID/routines" ;;
  routines.get)             call GET    "/api/routines/$1" ;;
  routines.create)          call POST   "/api/companies/$CID/routines" "$1" ;;
  routines.update)          call PATCH  "/api/routines/$1" "$2" ;;
  routines.runs)            call GET    "/api/routines/$1/runs" ;;
  routines.fire)            call POST   "/api/routines/$1/run" "${2:-$(printf '{"source":"manual"}')}" ;;
  routines.triggers.add)    call POST   "/api/routines/$1/triggers" "$2" ;;
  routines.triggers.update) call PATCH  "/api/routine-triggers/$1" "$2" ;;
  routines.triggers.delete) call DELETE "/api/routine-triggers/$1" ;;
  routines.triggers.rotate) call POST   "/api/routine-triggers/$1/rotate-secret" "{}" ;;
  GET|POST|PATCH|PUT|DELETE)
    call "$cmd" "$1" "${2:-}"
    ;;
  *)
    echo "pc.sh: unknown command '$cmd' — try 'pc.sh help'" >&2
    exit 2
    ;;
esac
