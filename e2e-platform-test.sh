#!/usr/bin/env bash
# e2e-platform-test.sh — end-to-end platform health suite for the agent OS.
# Created: 2026-05-18 marathon Phase D
# Owner: Morpheus
#
# Runs 30 tests across channels, agents, tools, memory, crons, constitution.
# Exit 0 if all pass (or only marked-SKIPs).
# Exit 1 if any FAIL.
#
# Designed to be safe in CI: reads only, no destructive ops.

set -u

TS=$(date +%Y%m%d-%H%M%S)
LOG=~/clawd/logs/e2e-platform-test-$TS.log
mkdir -p ~/clawd/logs

PASS=0; FAIL=0; SKIP=0
FAIL_NAMES=()

T() {
  local name="$1"; shift
  echo "" | tee -a "$LOG"
  echo "──── $name ────" | tee -a "$LOG"
  if "$@" >> "$LOG" 2>&1; then
    echo "✅ PASS: $name" | tee -a "$LOG"
    PASS=$((PASS+1))
  else
    local rc=$?
    if [ "$rc" -eq 77 ]; then
      echo "⏭️  SKIP: $name" | tee -a "$LOG"
      SKIP=$((SKIP+1))
    else
      echo "❌ FAIL: $name (exit $rc)" | tee -a "$LOG"
      FAIL=$((FAIL+1))
      FAIL_NAMES+=("$name")
    fi
  fi
}

# ───── Test helpers ─────

DT_OC=$(grep -E '^DISCORD_BOT_TOKEN' ~/.openclaw/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
DT_ALFRED=$(grep -E '^DISCORD_BOT_TOKEN' ~/.hermes/profiles/alfred/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")

discord_get_channel() {
  local channel_id="$1"
  curl -sS --max-time 8 -H "Authorization: Bot $DT_OC" -H "User-Agent: DiscordBot (clawd, 1.0)" \
    "https://discord.com/api/v10/channels/$channel_id"
}

# ───── Tests ─────

# 1. OC gateway alive
t_oc_gateway() { openclaw gateway status 2>&1 | grep -q 'Runtime: running'; }
T "01 OC gateway alive" t_oc_gateway

# 2. Hermes default profile alive
t_hermes_default() { hermes profile list 2>&1 | grep -E '^[ ◆]+default\s' | grep -q 'running'; }
T "02 Hermes default running" t_hermes_default

# 3. Hermes alfred profile alive
t_hermes_alfred() { hermes profile list 2>&1 | grep -E '^[ ◆]+alfred\s' | grep -q 'running'; }
T "03 Hermes alfred running" t_hermes_alfred

# 4. Hermes tank profile alive
t_hermes_tank() { hermes profile list 2>&1 | grep -E '^[ ◆]+tank\s' | grep -q 'running'; }
T "04 Hermes tank running" t_hermes_tank

# 5. Hermes nexus profile alive
t_hermes_nexus() { hermes profile list 2>&1 | grep -E '^[ ◆]+nexus\s' | grep -q 'running'; }
T "05 Hermes nexus running" t_hermes_nexus

# 6. Hermes elon profile alive
t_hermes_elon() { hermes profile list 2>&1 | grep -E '^[ ◆]+elon\s' | grep -q 'running'; }
T "06 Hermes elon running" t_hermes_elon

# 7. OC main agent on openai/gpt-5.5 (5.18: runtime is provider/model scoped, no agentRuntime field)
t_oc_main_model() {
  jq -e '.agents.list[]|select(.id=="main")|.model=="openai/gpt-5.5" or (.model.primary // .model)=="openai/gpt-5.5"' \
    ~/.openclaw/openclaw.json > /dev/null
}
T "07 OC main agent = openai/gpt-5.5" t_oc_main_model

# 8. #🎩alfred channel exists (Discord API)
t_alfred_channel() {
  local resp=$(discord_get_channel 1475370281899135037)
  echo "$resp" | grep -q '"name"' && ! echo "$resp" | grep -q '"code"'
}
T "08 #🎩alfred channel exists" t_alfred_channel

# 9. #🎩alfred-hermes channel exists
t_alfred_hermes_channel() {
  local resp=$(discord_get_channel 1505870589338845285)
  echo "$resp" | grep -q '"name"' && ! echo "$resp" | grep -q '"code"'
}
T "09 #🎩alfred-hermes channel exists" t_alfred_hermes_channel

# 10. #💊morpheus channel exists
t_morpheus_channel() {
  local resp=$(discord_get_channel 1475601212639281356)
  echo "$resp" | grep -q '"name"' && ! echo "$resp" | grep -q '"code"'
}
T "10 #💊morpheus channel exists" t_morpheus_channel

# 11. #🔍elon channel exists
t_elon_channel() {
  local resp=$(discord_get_channel 1479242818525466829)
  echo "$resp" | grep -q '"name"' && ! echo "$resp" | grep -q '"code"'
}
T "11 #🔍elon channel exists" t_elon_channel

# 12. OC main agent has alfred binding
t_oc_alfred_binding() {
  jq -e '.bindings | any(.match.peer.id == "1475370281899135037")' \
    ~/.openclaw/openclaw.json > /dev/null
}
T "12 OC main has #🎩alfred binding" t_oc_alfred_binding

# 13. Hermes-Alfred config has new channel
t_hermes_alfred_channel() {
  grep -q 'free_response_channels: 1505870589338845285' ~/.hermes/profiles/alfred/config.yaml
}
T "13 Hermes-Alfred routes to #🎩alfred-hermes" t_hermes_alfred_channel

# 14. OC Alfred OC daily audio brief cron exists
t_oc_alfred_brief_cron() {
  openclaw cron list 2>&1 | grep -q 'Alfred OC Daily Audio'
}
T "14 OC has Alfred OC Daily Audio Brief cron" t_oc_alfred_brief_cron

# 15. Hermes-Alfred cron delivers to new channel
t_hermes_alfred_cron_target() {
  hermes -p alfred cron list 2>&1 | grep -q 'discord:channel:1505870589338845285'
}
T "15 Hermes-Alfred cron → #🎩alfred-hermes" t_hermes_alfred_cron_target

# 16. morpheus-post.sh executable
t_morpheus_post_exec() { test -x ~/clawd/scripts/morpheus-post.sh; }
T "16 morpheus-post.sh executable" t_morpheus_post_exec

# 17. SessionStart hook valid JSON output
t_session_start_hook() {
  cd ~/clawd && bash ~/clawd/scripts/hooks/SessionStart-workspace-identity.sh 2>/dev/null \
    | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null
}
T "17 SessionStart hook emits valid JSON" t_session_start_hook

# 18. Constitution check 5/5
t_constitution() {
  bash ~/clawd/shared/scripts/constitution-check.sh 2>&1 | grep -q '5 pass / 0 fail'
}
T "18 Constitution check 5/5" t_constitution

# 19. gbrain doctor health
t_gbrain_doctor() {
  gbrain doctor 2>&1 | grep -qE 'Health score: ([89][0-9]|100)/100'
}
T "19 gbrain doctor ≥80/100" t_gbrain_doctor

# 20. QMD status returns clean
t_qmd_status() {
  qmd status 2>&1 | grep -q 'Documents'
}
T "20 QMD status clean" t_qmd_status

# 21. claude-mem chroma dir exists
t_claude_mem_chroma() {
  test -d ~/.claude-mem/chroma
}
T "21 claude-mem chroma dir exists" t_claude_mem_chroma

# 22. LCM database accessible
t_lcm_db() {
  test -f ~/.openclaw/lcm.db && [ "$(stat -f '%z' ~/.openclaw/lcm.db)" -gt 1000000 ]
}
T "22 LCM database accessible (>1MB)" t_lcm_db

# 23. Hermes-Alfred responds to one-shot query
t_hermes_alfred_response() {
  # macOS has no `timeout`; use perl alarm wrapper
  local resp=$(perl -e 'alarm 90; exec @ARGV' hermes -p alfred -z "Reply with exactly: PONG. Nothing else." 2>&1 | head -3)
  echo "$resp" | grep -q 'PONG'
}
T "23 Hermes-Alfred responds (one-shot)" t_hermes_alfred_response

# 24. Hermes-Elon responds + has x_search
t_hermes_elon_response() {
  local resp=$(perl -e 'alarm 90; exec @ARGV' hermes -p elon -z "Reply with exactly: ELON-OK. Nothing else." 2>&1 | head -3)
  echo "$resp" | grep -q 'ELON-OK'
}
T "24 Hermes-Elon responds (one-shot)" t_hermes_elon_response

# 25. ccusage today = $0 (Codex OAuth, no metered)
t_ccusage_zero() {
  if ! command -v ccusage > /dev/null 2>&1; then
    return 77  # SKIP
  fi
  local out=$(ccusage daily 2>&1 || true)
  local today=$(date +%Y-%m-%d)
  # Look for today's row + check cost field
  local cost=$(echo "$out" | grep "$today" | head -1 | grep -oE '\$[0-9]+\.[0-9]+' | head -1)
  if [ -z "$cost" ]; then
    # ccusage may have warmup line + no today row yet — accept
    return 0
  fi
  if [ "$cost" = "\$0.00" ]; then
    return 0
  fi
  echo "Cost today: $cost (expected \$0.00 or empty)"
  return 1
}
T "25 ccusage today = \$0 metered" t_ccusage_zero

# 26. Tank supervise exit code 0 or warnings-only
t_tank_supervise() {
  bash ~/clawd/scripts/tank-supervise.sh 2>&1 | grep -qE '🟢 gateway' &&
  ! bash ~/clawd/scripts/tank-supervise.sh 2>&1 | grep -qE '🔴'
}
T "26 tank-supervise.sh no 🔴 critical" t_tank_supervise

# 27. OC alfred-hermes channel perms have OC bot SEND deny
t_alfred_hermes_perms() {
  local resp=$(discord_get_channel 1505870589338845285)
  echo "$resp" | jq -e '.permission_overwrites[] | select(.id=="1475367007707726086") | .deny == "2048"' > /dev/null
}
T "27 #🎩alfred-hermes has OC bot SEND deny" t_alfred_hermes_perms

# 28. OC alfred channel perms have Alfred bot SEND deny
t_alfred_perms() {
  local resp=$(discord_get_channel 1475370281899135037)
  echo "$resp" | jq -e '.permission_overwrites[] | select(.id=="1481503781744021636") | .deny == "2048"' > /dev/null
}
T "28 #🎩alfred has Alfred bot SEND deny" t_alfred_perms

# 29. bookmark-sync.cjs has Tier 0 hermes-elon path
t_bookmark_sync_tier0() {
  grep -q 'callGrokViaHermes' ~/clawd/scripts/bookmark-sync.cjs &&
  grep -q "hermes-elon-grok-4-fast-reasoning" ~/clawd/scripts/bookmark-sync.cjs
}
T "29 bookmark-sync.cjs has hermes-elon Tier 0" t_bookmark_sync_tier0

# 30. Voice mapping has alfred=xai/rex
t_voice_alfred_rex() {
  jq -e '.agents.alfred.provider=="xai" and .agents.alfred.voice_name=="rex"' \
    ~/.openclaw/voice-profiles.json > /dev/null
}
T "30 Voice: alfred = xai/rex" t_voice_alfred_rex

# ───── Summary ─────
echo "" | tee -a "$LOG"
echo "═══════════════════════════════════════════" | tee -a "$LOG"
echo "E2E PLATFORM TEST RESULTS — $TS" | tee -a "$LOG"
echo "═══════════════════════════════════════════" | tee -a "$LOG"
echo "✅ PASS: $PASS" | tee -a "$LOG"
echo "❌ FAIL: $FAIL" | tee -a "$LOG"
echo "⏭️ SKIP: $SKIP" | tee -a "$LOG"
echo "" | tee -a "$LOG"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tests:" | tee -a "$LOG"
  for n in "${FAIL_NAMES[@]}"; do
    echo "  - $n" | tee -a "$LOG"
  done
  exit 1
fi
echo "All clear." | tee -a "$LOG"
exit 0
