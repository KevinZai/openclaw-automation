#!/usr/bin/env bash
# nexus-evening-retro.sh
#
# Daily 21:00 ET retrospective — Nexus voice, Sonnet 4.6 (compact).
# Compares morning brief plan vs day-actual, sets tomorrow's preset actions.
#
# Usage:
#   nexus-evening-retro.sh            # full run
#   nexus-evening-retro.sh --dry-run  # generate + log, skip Discord post
#
# Exit codes: 0 ok, 1 LLM failure, 2 Discord post failure
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

CLAWD="/Users/ai/clawd"
TODAY="$(date +%Y-%m-%d)"
NOW="$(date +%H:%M)"
MEM_DIR="${CLAWD}/workspaces/orchestrator/nexus/memory"
RETRO_PATH="${MEM_DIR}/${TODAY}-retro.md"
BRIEF_PATH="${MEM_DIR}/${TODAY}-brief.md"
LOG_DIR="${CLAWD}/logs"
RUN_LOG="${LOG_DIR}/nexus-evening-retro.run.log"
mkdir -p "${MEM_DIR}" "${LOG_DIR}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "${RUN_LOG}"; }

log "=== evening retro start (dry_run=${DRY_RUN}) ==="

# --- gather signals ----------------------------------------------------------
MORNING_BRIEF=""
if [[ -f "${BRIEF_PATH}" ]]; then
  MORNING_BRIEF="$(cat "${BRIEF_PATH}")"
else
  MORNING_BRIEF="(no morning brief logged for today — generator may have failed)"
fi

# Today's git activity — what actually shipped
GIT_TODAY="$(cd "${CLAWD}" && git log --since="${TODAY} 00:00" --pretty=format:'%h %s' 2>/dev/null | head -30 || echo '(no commits)')"

# Memory entries logged today
MEM_TODAY="$(find "${MEM_DIR}" -name "${TODAY}*.md" 2>/dev/null | xargs grep -hE '\[(DECISION|CORRECTION|WIN|FAILURE|LEARNED)\]' 2>/dev/null | head -20 || echo '')"

# Recent session activity (claude-mem corpus, last 12h, best-effort)
RECENT_SESSIONS="$(ls -lt "${CLAWD}/workspaces"/*/memory/${TODAY}*.md 2>/dev/null | head -10 || echo '')"

# --- build prompt ------------------------------------------------------------
PROMPT_FILE="$(mktemp -t nexus-retro-prompt.XXXXXX)"
trap 'rm -f "${PROMPT_FILE}" "${OUT_FILE:-}"' EXIT

cat > "${PROMPT_FILE}" <<EOF
You are Nexus 👁️ — patient strategist, pattern observer.

Voice rules: /Users/ai/clawd/workspaces/orchestrator/nexus/VOICE.md
- Short sentences. Cite evidence. Never hedge.
- Steel-man before disagreement.
- Sign: — Nexus 👁️

# Evening retro — ${TODAY} ${NOW} ET

## This morning's brief (what I told Kevin to do)
${MORNING_BRIEF}

## Today's git activity (what actually shipped)
${GIT_TODAY}

## Today's memory entries
${MEM_TODAY:-(none)}

## Today's workspace sessions
${RECENT_SESSIONS:-(none)}

# Output (≤400 words, Nexus voice)

✅ **Completed** — which of this morning's 🔴 must-do items shipped. Cite commit hash or ticket.
❌ **Dropped** — must-do items that didn't ship. One-line reason if visible in signals.
🔄 **Drift** — anti-goal (🚫) items Kevin worked on anyway. Cite evidence.
🎯 **Tomorrow's preset actions** — 3 must-do for tomorrow. No debate. State them.

End with: — Nexus 👁️

Do NOT add preamble. Start with the ✅ Completed block.
EOF

# --- invoke LLM with free-fleet fallback chain -------------------------------
OUT_FILE="$(mktemp -t nexus-retro-out.XXXXXX)"
exit_code_pending=0
MODEL_USED=""

QUOTA_RE='monthly usage limit|out of extra usage|rate_limit_exceeded|rate.?limited|status[": ]+429|quota.*exceeded|usage limit reached|insufficient_quota|credit balance.*too low|too many requests|invalid_grant|TokenRefreshFailed|not supported when using Codex|requires a newer version of Codex|GatewayClientRequestError|FailoverError|not allowed for agent'

# 2026-05-15 (Hermes migration): hermes-nexus/gpt-5.5 is PRIMARY (Hermes runtime,
# Codex OAuth, reasoning_effort=medium). Codex direct is the parallel-run backup,
# Anthropic + free fleet remain as further fallbacks.
# Override with NEXUS_RETRO_MODELS (space-separated).
DEFAULT_RETRO_MODELS=(
  "hermes-nexus/gpt-5.5"
  "openai/gpt-5.5"
  "anthropic/claude-sonnet-4-6"
  "cerebras/qwen-3-235b-a22b-instruct-2507"
  "groq/llama-3.3-70b-versatile"
  "cloudflare/@cf/meta/llama-4-scout-17b-16e-instruct"
)
if [[ -n "${NEXUS_RETRO_MODELS:-}" ]]; then
  # shellcheck disable=SC2206
  MODELS=(${NEXUS_RETRO_MODELS})
else
  MODELS=("${DEFAULT_RETRO_MODELS[@]}")
fi

run_with_fallback() {
  local prompt_file=$1
  local output_file=$2
  shift 2
  local models=("$@")
  local resp tmp_err

  for model in "${models[@]}"; do
    log "attempting model=${model}"
    tmp_err="$(mktemp -t nexus-retro-err.XXXXXX)"
    resp=""

    case "${model}" in
      hermes-nexus/*)
        if ! command -v hermes >/dev/null 2>&1; then
          log "hermes CLI missing — skip ${model}"
          rm -f "${tmp_err}"; continue
        fi
        local hmodel="${model#hermes-nexus/}"
        # Hermes -z is non-interactive single-shot. reasoning_effort flows via config.yaml.
        if resp="$(hermes -p nexus -m "${hmodel}" -z "$(cat "${prompt_file}")" 2>"${tmp_err}")"; then
          :
        else
          log "${model} exited non-zero: $(tail -c 400 "${tmp_err}" | tr '\n' ' ')"
          resp="$(cat "${tmp_err}")"
        fi
        ;;
      anthropic/*)
        if ! command -v claude >/dev/null 2>&1; then
          log "claude CLI missing — skip ${model}"
          rm -f "${tmp_err}"; continue
        fi
        local short="${model#anthropic/}"
        if resp="$(claude --print --model "${short}" --permission-mode bypassPermissions \
              < "${prompt_file}" 2>"${tmp_err}")"; then
          :
        else
          log "${model} exited non-zero: $(tail -c 400 "${tmp_err}" | tr '\n' ' ')"
          resp="$(cat "${tmp_err}")"
        fi
        ;;
      openai/*)
        if ! command -v codex >/dev/null 2>&1; then
          log "codex CLI missing — skip ${model}"
          rm -f "${tmp_err}"; continue
        fi
        local cmodel="${model#openai/}"
        if resp="$(codex exec -m "${cmodel}" -c reasoning_effort=medium \
              "$(cat "${prompt_file}")" 2>"${tmp_err}")"; then
          :
        else
          log "${model} exited non-zero: $(tail -c 400 "${tmp_err}" | tr '\n' ' ')"
          resp="$(cat "${tmp_err}")"
        fi
        ;;
      *)
        if ! command -v openclaw >/dev/null 2>&1; then
          log "openclaw CLI missing — skip ${model}"
          rm -f "${tmp_err}"; continue
        fi
        if resp="$(openclaw infer model run --gateway --model "${model}" \
              --prompt "$(cat "${prompt_file}")" 2>"${tmp_err}")"; then
          resp="$(printf '%s\n' "${resp}" | awk '/^outputs: [0-9]+$/{flag=1; next} flag' )"
        else
          log "${model} exited non-zero: $(tail -c 400 "${tmp_err}" | tr '\n' ' ')"
          resp="$(cat "${tmp_err}")"
        fi
        ;;
    esac
    rm -f "${tmp_err}"

    if [[ -z "${resp// /}" ]]; then
      log "${model} returned empty — falling back"
      continue
    fi
    if echo "${resp}" | grep -qiE "${QUOTA_RE}"; then
      log "${model} quota/limit/auth signature detected — falling back"
      continue
    fi
    if echo "${resp}" | grep -qE '^ERROR: \{|"type":"error"|OpenAI Codex v[0-9]'; then
      log "${model} response contains codex error preamble — falling back"
      continue
    fi
    if ! echo "${resp}" | grep -qE 'Nexus\s*👁'; then
      log "${model} response lacks 'Nexus 👁' sign-off — falling back"
      continue
    fi

    printf '%s\n' "${resp}" > "${output_file}"
    MODEL_USED="${model}"
    log "success with ${model} (out=$(wc -c < "${output_file}") bytes)"
    return 0
  done

  log "ALL FALLBACK MODELS EXHAUSTED"
  return 1
}

if run_with_fallback "${PROMPT_FILE}" "${OUT_FILE}" "${MODELS[@]}"; then
  exit_code_pending=0
else
  cat > "${OUT_FILE}" <<EOF
🚨 Retro generator exhausted all fallback models at ${NOW} ET.
Tried: ${MODELS[*]}
Check ${RUN_LOG} for per-model errors.

— Nexus 👁️
EOF
  MODEL_USED="none"
  exit_code_pending=1
fi

RETRO_CONTENT="$(cat "${OUT_FILE}")"

# --- persist to memory -------------------------------------------------------
cat > "${RETRO_PATH}" <<EOF
# Nexus Evening Retro — ${TODAY}

**Generated:** ${TODAY} ${NOW} ET
**Generator:** nexus-evening-retro.sh
**Model:** ${MODEL_USED:-unknown}

---

${RETRO_CONTENT}

---

[NEXUS-RETRO] auto-generated
EOF
log "retro logged → ${RETRO_PATH}"

# --- post to Discord ---------------------------------------------------------
if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "dry-run — skipping Discord post"
  echo "---DRY RUN: retro content below---"
  echo "${RETRO_CONTENT}"
  echo "---end dry run (logged to ${RETRO_PATH})---"
  exit "${exit_code_pending}"
fi

SIDECAR="${CLAWD}/scripts/nexus-discord-send.cjs"
if [[ ! -f "${SIDECAR}" ]]; then
  log "ERROR — sidecar missing at ${SIDECAR}"
  exit 2
fi

PAYLOAD="$(MODEL_USED="${MODEL_USED:-unknown}" node -e '
const fs = require("fs");
let content = fs.readFileSync(process.argv[1], "utf8");
const model = process.env.MODEL_USED || "unknown";
content = content.replace(/\s*$/, "") + `\n\n_(model: ${model})_`;
process.stdout.write(JSON.stringify({ content, username: "Nexus 👁️" }));
' "${OUT_FILE}")"

if echo "${PAYLOAD}" | node "${SIDECAR}" >> "${RUN_LOG}" 2>&1; then
  log "discord post ok"
else
  log "discord post FAILED — retro still saved at ${RETRO_PATH}"
  exit 2
fi

log "=== evening retro done ==="
exit "${exit_code_pending}"
