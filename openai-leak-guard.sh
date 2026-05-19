#!/usr/bin/env bash
# openai-leak-guard.sh — Prevent paid OPENAI_API_KEY from sneaking back into OC chat dispatch.
#
# Two layers of defense run on every cron tick:
#   1. AUDIT — scan all agent models.json for `.providers.openai` overrides that route chat
#              calls to api.openai.com / portkey-cache. Auto-strip + alert.
#   2. SYNC  — copy fresh OAuth tokens from ~/.codex/auth.json into all OC agent
#              auth-profiles.json so the kzicherman codex profile never expires-on-disk.
#
# Per HARD RULE in ~/clawd/CLAUDE.md:
#   "NEVER use OPENAI_API_KEY for any OpenClaw chat/agent operation.
#    ONLY for image gen. All chat MUST route through openai-codex with agentRuntime.id=codex."
#
# ── LANE-AWARENESS (added 2026-05-14) ──────────────────────────────────────
# Prior behavior: rewrote auth-profiles.json for EVERY agent on every 6h tick,
# which dropped active codex `app-server` clients with `client is closed`
# (observed storm at 09:00 hitting guardian/inbox/quill/tank/prism).
#
# Fix: before rewriting auth-profiles.json, check whether the agent has an
# active codex lane.  "Active" = any file under either of these dirs was
# modified within ACTIVE_THRESHOLD_SEC (default 300s = 5 min):
#   - ~/.openclaw/agents/<id>/sessions/
#   - ~/.openclaw/agents/<id>/agent/codex-home/sessions/
# (the second path catches in-flight codex-app-server rollout files even when
#  the parent session JSONL hasn't been flushed yet.)
#
# Active agents are skipped for the auth-profiles.json rewrite step only;
# models.json leak-strip still runs (structural defense, not session-active).
# Skipped agents are logged and re-attempted next tick.
#
# Safety: if more than SAFETY_MAX_SKIP_PCT (50%) of agents would be skipped
# in one run we abort entirely and Discord-alert — that pattern suggests the
# defense is being suppressed too often (or detection broke).
#
# Flags: --dry-run    Show what would change without writing.
#
# Exit codes:
#   0 = clean (no leak, sync ok)
#   1 = leak detected + auto-stripped (alerts to Discord + logs)
#   2 = codex CLI unreachable (sync failed)
#   3 = safety abort (skip-rate exceeded threshold)
#
# Logs: ~/clawd/logs/openai-leak-guard.log
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 64 ;;
  esac
done

LOG=~/clawd/logs/openai-leak-guard.log
STATE=~/.openclaw/.leak-guard-state
ACTIVE_THRESHOLD_SEC=300   # 5 min — session-file mtime window
SAFETY_MAX_SKIP_PCT=50     # >50% skip rate = abort

mkdir -p "$(dirname "$LOG")"
TS=$(date +%Y-%m-%dT%H:%M:%S%z)

log() { echo "[$TS] $*" >> "$LOG"; }
alert() { log "ALERT: $*"; >&2 echo "ALERT: $*"; }

# Fast path: skip if nothing changed since last clean run.
# Compares mtime of agents/ tree against last-run timestamp; bails if no churn.
# (Skipped under --dry-run so operator can always see what would happen.)
LAST_RUN=$(cat "$STATE" 2>/dev/null || echo 0)
NEWEST=$(find ~/.openclaw/agents \( -name 'models.json' -o -name 'auth-profiles.json' \) -newer "$STATE" 2>/dev/null | head -1 || true)
CODEX_AUTH_MTIME=$(stat -f %m ~/.codex/auth.json 2>/dev/null || echo 0)
if [ "$DRY_RUN" -eq 0 ] && [ -z "$NEWEST" ] && [ "$CODEX_AUTH_MTIME" -le "$LAST_RUN" ] && [ -f "$STATE" ]; then
  # No agent config churn AND codex auth file not refreshed since last run → skip silently.
  exit 0
fi

# ── 0) ACTIVE-LANE DETECTION ──
# Build space-separated list of agent IDs that currently have an active codex
# session (any session file modified within ACTIVE_THRESHOLD_SEC).
# Bash 3.2 compatible — no associative arrays, no mapfile.
ACTIVE_MIN=$(( (ACTIVE_THRESHOLD_SEC + 59) / 60 ))   # round up to whole minutes
ACTIVE_LIST=$(find ~/.openclaw/agents \
                -type f \
                \( -path '*/sessions/*' -o -path '*/codex-home/sessions/*' \) \
                -mmin -"$ACTIVE_MIN" 2>/dev/null \
              | sed -E 's|.*/agents/([^/]+)/.*|\1|' \
              | sort -u \
              | tr '\n' ' ')

# Helper: is_active <agent-id>  → exit 0 if active, 1 otherwise.
is_active() {
  case " $ACTIVE_LIST " in
    *" $1 "*) return 0 ;;
    *)        return 1 ;;
  esac
}

TOTAL_AGENTS=$(find ~/.openclaw/agents -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | xargs)
ACTIVE_COUNT=$(echo "$ACTIVE_LIST" | tr ' ' '\n' | grep -c . || true)
log "LANES: total=$TOTAL_AGENTS active=$ACTIVE_COUNT list=[${ACTIVE_LIST% }]"

# Safety abort: if active-lane detection would skip >SAFETY_MAX_SKIP_PCT agents,
# something is wrong (mass restart? detection bug?).  Bail and alert.
if [ "$TOTAL_AGENTS" -gt 0 ]; then
  SKIP_PCT=$(( ACTIVE_COUNT * 100 / TOTAL_AGENTS ))
  if [ "$SKIP_PCT" -gt "$SAFETY_MAX_SKIP_PCT" ]; then
    alert "SAFETY ABORT: would skip $ACTIVE_COUNT/$TOTAL_AGENTS agents (${SKIP_PCT}%) > ${SAFETY_MAX_SKIP_PCT}% threshold — bailing without changes"
    if command -v curl >/dev/null 2>&1 && [ -n "${DISCORD_WEBHOOK_OPS:-}" ]; then
      curl -fsS -X POST -H 'Content-Type: application/json' \
        -d "{\"content\":\":rotating_light: openai-leak-guard SAFETY ABORT: $ACTIVE_COUNT/$TOTAL_AGENTS agents active (${SKIP_PCT}%). Defense suppressed too often — investigate.\"}" \
        "$DISCORD_WEBHOOK_OPS" >/dev/null 2>&1 || true
    fi
    exit 3
  fi
fi

# ── 1) AUDIT — scan for paid openai provider overrides ──
# Note: models.json strip runs for ALL agents (active included).  Re-routing
# a chat call's provider mid-session is a one-time read; the codex
# app-server client doesn't hold an open handle to models.json.
LEAK_COUNT=0
LEAK_AGENTS=()
for f in $(find ~/.openclaw/agents -name 'models.json' 2>/dev/null); do
  if jq -e '.providers.openai' "$f" >/dev/null 2>&1; then
    agent=$(echo "$f" | awk -F/ '{print $(NF-2)}')
    api=$(jq -r '.providers.openai.api // "?"' "$f")
    # Only flag CHAT apis (openai-completions, openai-responses) — image apis are OK
    if echo "$api" | grep -qE 'completions|responses' && ! echo "$api" | grep -q 'codex'; then
      LEAK_COUNT=$((LEAK_COUNT+1))
      LEAK_AGENTS+=("$agent")
      if [ "$DRY_RUN" -eq 1 ]; then
        log "DRY-RUN would-strip leak: agent=$agent api=$api file=$f"
      else
        # Auto-strip
        backup_dir=~/clawd/archive/openai-leak-guards/$(date +%Y%m%d)
        mkdir -p "$backup_dir"
        cp "$f" "$backup_dir/$(echo $f | sed 's|/|_|g').$(date +%H%M%S).bak"
        jq 'del(.providers.openai)' "$f" > "$f.new" && [ -s "$f.new" ] && mv "$f.new" "$f"
        log "STRIPPED leak: agent=$agent api=$api file=$f"
      fi
    fi
  fi
done

if [ "$LEAK_COUNT" -gt 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  alert "openai-leak-guard: stripped paid openai provider from $LEAK_COUNT agents: ${LEAK_AGENTS[*]}"
fi

# ── 2) SYNC — refresh OC profiles from ~/.codex/auth.json ──
# DISABLED 2026-05-15: OC 5.12 uses oauthRef centralized store, not per-profile
# .access/.refresh fields. Per-agent auth-profiles.json now holds only an oauthRef
# pointer (e.g. {"source":"openclaw-credentials","provider":"openai-codex","id":"<uuid>"})
# and the actual tokens live encrypted in ~/.openclaw/credentials/auth-profiles/<uuid>.json
# (AES-256-GCM, OC-managed key). This block was writing to .access/.refresh fields that
# OC 5.12 no longer reads — writes were silently ignored and "SYNC" log lines were false-OK.
# OC's own auth daemon handles Codex OAuth refresh; this block is unnecessary and ineffective.
# Re-enable when/if we have a confirmed path to write the encrypted credential store.
#
# CODEX_AUTH=~/.codex/auth.json
# ...
SYNC_COUNT=0
SYNC_SKIPPED=0
log "INFO: codex-sync block disabled (OC 5.12 uses oauthRef centralized store — see comment above)"

# ── 2b) SYNC — claude-cli OAuth from macOS keychain → OC profiles ──
# Modern Claude CLI stores creds in keychain ("Claude Code-credentials").
# After `claude /login` or auto-refresh the keychain holds the fresh token;
# OC's auth-profiles.json on disk drifts until something writes it.
# Lane-aware: skip active agents here too — claude-cli profile rewrites can
# also nudge the gateway to reload the agent record.
CLAUDE_KEYCHAIN_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
if [ -n "$CLAUDE_KEYCHAIN_JSON" ]; then
  CLAUDE_ACCESS=$(echo "$CLAUDE_KEYCHAIN_JSON" | jq -r '.claudeAiOauth.accessToken // empty')
  CLAUDE_REFRESH=$(echo "$CLAUDE_KEYCHAIN_JSON" | jq -r '.claudeAiOauth.refreshToken // empty')
  CLAUDE_EXPIRES=$(echo "$CLAUDE_KEYCHAIN_JSON" | jq -r '.claudeAiOauth.expiresAt // 0')
  if [ -n "$CLAUDE_ACCESS" ] && [ "$CLAUDE_EXPIRES" -gt 0 ]; then
    CLAUDE_SYNC=0
    CLAUDE_SKIPPED=0
    for f in $(find ~/.openclaw/agents -name 'auth-profiles.json' 2>/dev/null); do
      if jq -e '.profiles["anthropic:claude-cli"]' "$f" >/dev/null 2>&1; then
        agent=$(echo "$f" | awk -F/ '{print $(NF-2)}')
        current=$(jq -r '.profiles["anthropic:claude-cli"].access // ""' "$f")
        if [ "$current" != "$CLAUDE_ACCESS" ]; then
          if is_active "$agent"; then
            CLAUDE_SKIPPED=$((CLAUDE_SKIPPED+1))
            log "SKIP claude-cli-sync: agent=$agent (active lane within ${ACTIVE_THRESHOLD_SEC}s)"
            continue
          fi
          if [ "$DRY_RUN" -eq 1 ]; then
            log "DRY-RUN would-sync claude-cli: agent=$agent file=$f"
          else
            jq --arg t "$CLAUDE_ACCESS" --arg r "$CLAUDE_REFRESH" --argjson e "$CLAUDE_EXPIRES" '
              .profiles["anthropic:claude-cli"].access = $t
              | .profiles["anthropic:claude-cli"].refresh = $r
              | .profiles["anthropic:claude-cli"].expires = $e
            ' "$f" > "$f.new" && [ -s "$f.new" ] && mv "$f.new" "$f"
            log "SYNC claude-cli: agent=$agent file=$f"
          fi
          CLAUDE_SYNC=$((CLAUDE_SYNC+1))
        fi
      fi
    done
    if [ "$CLAUDE_SYNC" -gt 0 ] && [ "$DRY_RUN" -eq 0 ]; then
      log "SYNC summary: refreshed anthropic:claude-cli OAuth in $CLAUDE_SYNC agent profiles (next expiry: $(date -r $((CLAUDE_EXPIRES/1000))))"
    fi
    if [ "$CLAUDE_SKIPPED" -gt 0 ]; then
      log "SYNC skipped $CLAUDE_SKIPPED active agent(s) for claude-cli refresh — retry next tick"
    fi
  fi
fi

# ── 2c) STALENESS — alert if Codex OAuth nearing expiry ──
# OC 5.12 stores Codex OAuth in encrypted credential store (~/.openclaw/credentials/auth-profiles/<uuid>.json)
# referenced by oauthRef.id. We CANNOT auto-refresh from a shell script (no encryption key access),
# but we CAN detect staleness and prompt Kevin to run `openclaw models auth login --provider openai`.
# Threshold: <= 2 days of expiry headroom triggers an alert (Codex auto-rotates every ~7d).
STALE_THRESHOLD_DAYS=2
# Pick a Codex-runtime agent for the staleness probe (tank is canonical).
CODEX_PROBE_AGENT=tank
CODEX_STATUS=$(openclaw models status --agent "$CODEX_PROBE_AGENT" 2>/dev/null | grep -E "openai-codex:[^ ]+@.+ ok expires in" | head -1 || true)
if [ -n "$CODEX_STATUS" ]; then
  # Format: "  - openai-codex:kevin@example.com (kevin@example.com) ok expires in 6d"
  CODEX_EXP=$(echo "$CODEX_STATUS" | sed -E 's/.*expires in ([0-9]+)([dh]).*/\1\2/')
  CODEX_NUM=$(echo "$CODEX_EXP" | sed -E 's/([0-9]+).*/\1/')
  CODEX_UNIT=$(echo "$CODEX_EXP" | sed -E 's/[0-9]+([dh])/\1/')
  CODEX_DAYS=$CODEX_NUM
  if [ "$CODEX_UNIT" = "h" ]; then
    CODEX_DAYS=$(( CODEX_NUM / 24 ))
  fi
  log "CODEX-AUTH probe=$CODEX_PROBE_AGENT expires_in=${CODEX_EXP} (~${CODEX_DAYS}d) threshold=${STALE_THRESHOLD_DAYS}d"
  if [ "$CODEX_DAYS" -le "$STALE_THRESHOLD_DAYS" ]; then
    alert "Codex OAuth expires in ${CODEX_EXP} (probe=$CODEX_PROBE_AGENT) — run \`openclaw models auth login --provider openai\` to refresh BEFORE expiry. OC 5.12 encrypted-store auto-sync is not implemented."
    if command -v curl >/dev/null 2>&1 && [ -n "${DISCORD_WEBHOOK_OPS:-}" ]; then
      curl -fsS -X POST -H 'Content-Type: application/json' \
        -d "{\"content\":\":warning: Codex OAuth expires in ${CODEX_EXP}. Run \`openclaw models auth login --provider openai\` to refresh.\"}" \
        "$DISCORD_WEBHOOK_OPS" >/dev/null 2>&1 || true
    fi
  fi
else
  log "CODEX-AUTH probe=$CODEX_PROBE_AGENT could not parse expiry (status command returned no match)"
fi

# ── 3) ASSERTION — verify post-state ──
REMAINING=$(find ~/.openclaw/agents -name 'models.json' -exec jq -e '.providers.openai // empty | select(.api | test("completions|responses") and (test("codex") | not))' {} \; 2>/dev/null | wc -l | xargs)
if [ "$REMAINING" -gt 0 ]; then
  alert "Post-strip assertion FAILED: $REMAINING leaks still present"
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN OK: $LEAK_COUNT would-strip, $SYNC_COUNT would-sync, $SYNC_SKIPPED would-skip (active lane), $REMAINING leaks remaining"
  exit 0
fi

log "OK: $LEAK_COUNT leaks stripped, $SYNC_COUNT profiles synced, $SYNC_SKIPPED active skips, $REMAINING leaks remaining"
date +%s > "$STATE"
exit "$LEAK_COUNT"
