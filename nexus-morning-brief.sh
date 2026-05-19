#!/usr/bin/env bash
# nexus-morning-brief.sh
#
# Daily 07:00 ET morning brief — Nexus voice, Opus 4.7 thinking=high.
# Pulls TELOS context + recent signals, generates brief, posts to #👁️nexus,
# logs to ~/clawd/workspaces/orchestrator/nexus/memory/YYYY-MM-DD-brief.md.
#
# Usage:
#   nexus-morning-brief.sh            # full run: generate, log, post to Discord
#   nexus-morning-brief.sh --dry-run  # generate + log, skip Discord post
#
# Exit codes: 0 ok, 1 LLM failure, 2 Discord post failure (brief still logged)
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

CLAWD="/Users/ai/clawd"
TODAY="$(date +%Y-%m-%d)"
NOW="$(date +%H:%M)"
MEM_DIR="${CLAWD}/workspaces/orchestrator/nexus/memory"
BRIEF_PATH="${MEM_DIR}/${TODAY}-brief.md"
LOG_DIR="${CLAWD}/logs"
RUN_LOG="${LOG_DIR}/nexus-morning-brief.run.log"
mkdir -p "${MEM_DIR}" "${LOG_DIR}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "${RUN_LOG}"; }

log "=== morning brief start (dry_run=${DRY_RUN}) ==="

# --- gather signals (best-effort, all soft-fail) -----------------------------
TELOS_FOCUS="$(grep -A 60 '^## §5' "${CLAWD}/workspaces/main/TELOS.md" 2>/dev/null | head -80 || echo '(TELOS.md unreadable)')"
ANTI_GOALS="$(grep -A 25 '^## §7' "${CLAWD}/workspaces/main/TELOS.md" 2>/dev/null | head -40 || echo '(no §7 anti-goals)')"

# Yesterday's git activity across clawd repos (signal density)
YESTERDAY="$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d 'yesterday' +%Y-%m-%d)"
GIT_ACTIVITY="$(cd "${CLAWD}" && git log --since="${YESTERDAY}" --pretty=format:'%h %s' 2>/dev/null | head -20 || echo '(no commits)')"

# Yesterday's brief (for continuity)
PREV_BRIEF=""
if [[ -f "${MEM_DIR}/${YESTERDAY}-brief.md" ]]; then
  PREV_BRIEF="$(cat "${MEM_DIR}/${YESTERDAY}-brief.md")"
fi
PREV_RETRO=""
if [[ -f "${MEM_DIR}/${YESTERDAY}-retro.md" ]]; then
  PREV_RETRO="$(cat "${MEM_DIR}/${YESTERDAY}-retro.md")"
fi

# Recent Nexus memory tags (DECISION / CORRECTION / TODO from last 3 days)
RECENT_MEM="$(find "${MEM_DIR}" -name '*.md' -mtime -3 2>/dev/null | xargs grep -hE '\[(DECISION|CORRECTION|TODO|FAILURE)\]' 2>/dev/null | tail -15 || echo '')"

# --- build prompt ------------------------------------------------------------
PROMPT_FILE="$(mktemp -t nexus-brief-prompt.XXXXXX)"
trap 'rm -f "${PROMPT_FILE}" "${OUT_FILE:-}"' EXIT

cat > "${PROMPT_FILE}" <<EOF
You are Nexus 👁️ — patient strategist, pattern observer, no-nonsense.

Voice rules: /Users/ai/clawd/workspaces/orchestrator/nexus/VOICE.md
- Short sentences. Hemingway, not Tolstoy.
- Cite evidence. Timestamps, file paths, ticket #s.
- Never apologize. Never hedge.
- Steel-man before disagreement.
- Sign every message: — Nexus 👁️

# Today's brief — ${TODAY} ${NOW} ET

## TELOS §5 (current focus)
${TELOS_FOCUS}

## TELOS §7 (anti-goals / tier-3)
${ANTI_GOALS}

## Yesterday's git activity
${GIT_ACTIVITY}

## Yesterday's brief (for continuity — did the plan hold?)
${PREV_BRIEF:-(none — first run or weekend)}

## Yesterday's retro (what shipped / drifted)
${PREV_RETRO:-(none)}

## Recent memory tags (last 72h)
${RECENT_MEM:-(none)}

# Output (≤500 words, Nexus voice, severity emoji first)

🔴 **3 must-do today** — per TELOS §5 current phase. One sentence each + rationale. Cite TELOS section.
🟡 **5 nice-to-do** — P1 backlog. Bullets, one line each.
🚫 **3 don't-do today** — explicit anti-goals from §7 or drift you predict.
🎯 **1 focus block** — 90-min deep work, name the exact task + start time.

End with: — Nexus 👁️

Do NOT add preamble. Do NOT say "Good morning." Start with the 🔴 must-do block.
EOF

# --- invoke LLM with free-fleet fallback chain -------------------------------
OUT_FILE="$(mktemp -t nexus-brief-out.XXXXXX)"
MODEL_USED=""

# Quota / rate-limit / OAuth-exhausted error patterns → trigger fallback.
QUOTA_RE='monthly usage limit|out of extra usage|rate_limit_exceeded|rate.?limited|status[": ]+429|quota.*exceeded|usage limit reached|insufficient_quota|credit balance.*too low|too many requests|invalid_grant|TokenRefreshFailed|not supported when using Codex|requires a newer version of Codex|GatewayClientRequestError|FailoverError|not allowed for agent'

# 2026-05-15 (Hermes migration): hermes-nexus/gpt-5.5 PRIMARY (Hermes runtime,
# Codex OAuth, reasoning_effort=high), Codex direct as parallel-run backup,
# Anthropic + free fleet remain as further fallbacks. Override with NEXUS_BRIEF_MODELS.
DEFAULT_BRIEF_MODELS=(
  "hermes-nexus/gpt-5.5"
  "openai/gpt-5.5"
  "anthropic/claude-opus-4-7"
  "anthropic/claude-sonnet-4-6"
  "cerebras/qwen-3-235b-a22b-instruct-2507"
  "cloudflare/@cf/meta/llama-4-scout-17b-16e-instruct"
)
if [[ -n "${NEXUS_BRIEF_MODELS:-}" ]]; then
  # shellcheck disable=SC2206
  MODELS=(${NEXUS_BRIEF_MODELS})
else
  MODELS=("${DEFAULT_BRIEF_MODELS[@]}")
fi

run_with_fallback() {
  local prompt_file=$1
  local output_file=$2
  shift 2
  local models=("$@")
  local resp tmp_err

  for model in "${models[@]}"; do
    log "attempting model=${model}"
    tmp_err="$(mktemp -t nexus-brief-err.XXXXXX)"
    resp=""

    case "${model}" in
      hermes-nexus/*)
        if ! command -v hermes >/dev/null 2>&1; then
          log "hermes CLI missing — skip ${model}"
          rm -f "${tmp_err}"; continue
        fi
        local hmodel="${model#hermes-nexus/}"
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
        local thinking_flag=()
        [[ "${short}" == "claude-opus-4-7" ]] && thinking_flag=(--permission-mode bypassPermissions)
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
        # Codex OAuth, read-only sandbox (no writes — pure prompt → text)
        if resp="$(codex exec -m "${cmodel}" -c reasoning_effort=high \
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
          # Strip openclaw decorative box-drawing + provider metadata header.
          # Real model output appears AFTER the "outputs: N" line.
          resp="$(printf '%s\n' "${resp}" | awk '/^outputs: [0-9]+$/{flag=1; next} flag' )"
        else
          log "${model} exited non-zero: $(tail -c 400 "${tmp_err}" | tr '\n' ' ')"
          resp="$(cat "${tmp_err}")"
        fi
        ;;
    esac
    rm -f "${tmp_err}"

    # Empty response → treat as failure
    if [[ -z "${resp// /}" ]]; then
      log "${model} returned empty — falling back"
      continue
    fi

    # Quota / limit / auth-broken signature → continue to next model
    if echo "${resp}" | grep -qiE "${QUOTA_RE}"; then
      log "${model} quota/limit/auth signature detected — falling back"
      continue
    fi

    # Hard reject: ERROR: JSON envelopes or Codex preamble (means stdout
    # captured the codex banner not the model output).
    if echo "${resp}" | grep -qE '^ERROR: \{|"type":"error"|OpenAI Codex v[0-9]'; then
      log "${model} response contains codex error preamble — falling back"
      continue
    fi

    # Sanity: response must contain a Nexus sign-off (- Nexus) — every
    # prompt-compliant output ends with that signature.
    if ! echo "${resp}" | grep -qE 'Nexus\s*👁'; then
      log "${model} response lacks 'Nexus 👁' sign-off (${#resp} bytes) — falling back"
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
🚨 Morning brief generator exhausted all fallback models at ${NOW} ET.
Tried: ${MODELS[*]}
Check ${RUN_LOG} for per-model errors.
Falling back to: read TELOS §5 manually and pick your own top-3.

— Nexus 👁️
EOF
  MODEL_USED="none"
  exit_code_pending=1
fi

BRIEF_CONTENT="$(cat "${OUT_FILE}")"

# --- persist to memory -------------------------------------------------------
cat > "${BRIEF_PATH}" <<EOF
# Nexus Morning Brief — ${TODAY}

**Generated:** ${TODAY} ${NOW} ET
**Generator:** nexus-morning-brief.sh
**Model:** ${MODEL_USED:-unknown}

---

${BRIEF_CONTENT}

---

[NEXUS-BRIEF] auto-generated
EOF
log "brief logged → ${BRIEF_PATH}"

# --- post to Discord ---------------------------------------------------------
if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "dry-run — skipping Discord post"
  echo "---DRY RUN: brief content below---"
  echo "${BRIEF_CONTENT}"
  echo "---end dry run (logged to ${BRIEF_PATH})---"
  exit "${exit_code_pending:-0}"
fi

SIDECAR="${CLAWD}/scripts/nexus-discord-send.cjs"
if [[ ! -x "${SIDECAR}" && ! -f "${SIDECAR}" ]]; then
  log "ERROR — sidecar missing at ${SIDECAR}"
  exit 2
fi

# JSON-encode the content safely, append model footnote
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
  log "discord post FAILED — brief still saved at ${BRIEF_PATH}"
  exit 2
fi

log "=== morning brief done ==="
exit "${exit_code_pending:-0}"
