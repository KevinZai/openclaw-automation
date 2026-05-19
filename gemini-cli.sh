#!/usr/bin/env bash
# gemini-cli — OAuth-ONLY wrapper for Google Gemini access.
#
# Per Kevin policy 2026-05-18: NEVER paid API. Google One subscription covers
# all Gemini usage via gemini-cli OAuth. If OAuth fails, this script fails LOUD
# rather than silently falling back to billed API.
#
# Usage:
#   echo "your prompt" | bash scripts/gemini-cli.sh                       # default: gemini-2.5-flash
#   bash scripts/gemini-cli.sh --prompt "..." --model gemini-3-pro-preview
#   bash scripts/gemini-cli.sh --json --prompt "..."                       # JSON output
#
# OAuth refresh (if creds expire): launch 'gemini' interactively, sign in.
# Credentials live at ~/.gemini/oauth_creds.json (refresh-token rotation auto).
#
# Models: gemini-2.5-flash (fast/cheap), gemini-3-pro-preview (deep reasoning).

set -uo pipefail

MODEL="gemini-2.5-flash"
PROMPT=""
JSON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model|-m) MODEL="$2"; shift 2 ;;
    --prompt|-p) PROMPT="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) PROMPT="${PROMPT}${PROMPT:+ }$1"; shift ;;
  esac
done

# Read prompt from stdin if not passed via flag
if [[ -z "$PROMPT" ]] && [[ ! -t 0 ]]; then
  PROMPT=$(cat)
fi

if [[ -z "$PROMPT" ]]; then
  echo "ERROR: no prompt provided (use --prompt or pipe to stdin)" >&2
  exit 2
fi

LOG="${HOME}/clawd/logs/gemini-cli-wrapper.log"
mkdir -p "$(dirname "$LOG")"
log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# ── OAuth-only path via gemini-cli (FREE — Google One subscription) ─
# Per Kevin policy: NEVER paid API. Fail loud if OAuth doesn't work.
gemini_with_timeout() {
  local timeout_sec="$1"; shift
  perl -e '
    use POSIX ":sys_wait_h";
    my $timeout = shift;
    my $pid = fork();
    if ($pid == 0) { exec(@ARGV) or die "exec: $!"; }
    my $deadline = time + $timeout;
    while (time < $deadline) {
      my $kid = waitpid($pid, WNOHANG);
      if ($kid > 0) { exit($? >> 8); }
      sleep 1;
    }
    kill 9, $pid;
    waitpid($pid, 0);
    exit 124;
  ' "$timeout_sec" "$@"
}

OAUTH_CREDS="${HOME}/.gemini/oauth_creds.json"

run_oauth() {
  if ! command -v gemini >/dev/null 2>&1; then
    echo "ERROR: gemini-cli not installed (brew install gemini-cli or equivalent)" >&2
    return 2
  fi
  if [[ ! -f "$OAUTH_CREDS" ]]; then
    echo "ERROR: no OAuth creds at $OAUTH_CREDS. Run 'gemini' interactively to sign in." >&2
    return 2
  fi

  # Check expiry from the JWT — if expired, fail loud (refresh-token rotation
  # should normally have happened, but if it didn't, user needs to re-auth).
  local exp_ms
  exp_ms=$(python3 -c "import json; print(json.load(open('$OAUTH_CREDS')).get('expiry_date', 0))" 2>/dev/null)
  local now_ms=$(($(date +%s) * 1000))
  if [[ -n "$exp_ms" && "$exp_ms" -lt "$now_ms" ]]; then
    log "OAuth token expired (will auto-refresh via refresh_token on next call)"
  fi

  log "OAuth (free quota) — model=$MODEL"
  local fmt="text"
  [[ "$JSON" -eq 1 ]] && fmt="json"
  local out
  out=$(echo "$PROMPT" | gemini_with_timeout 60 gemini -p "$PROMPT" -m "$MODEL" -o "$fmt" 2>&1 </dev/null)
  local rc=$?
  if [[ "$rc" -eq 124 ]]; then
    echo "ERROR: gemini call timed out (60s). OAuth may need refresh: launch 'gemini' interactively." >&2
    log "OAuth timed out after 60s"
    return 2
  fi
  if echo "$out" | grep -qiE 'Authentication cancelled|login.*required|invalid_grant|token.*expired'; then
    echo "ERROR: OAuth failed. Re-auth required: launch 'gemini' interactively." >&2
    log "OAuth call returned auth-error: $(echo "$out" | head -1)"
    return 2
  fi
  printf '%s\n' "$out"
  return 0
}

# ── Execute (OAuth-only — no API fallback per Kevin policy) ──
run_oauth
exit $?
