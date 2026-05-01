#!/usr/bin/env bash
# Part of openclaw-automation — https://github.com/KevinZai/openclaw-automation
# drift-detect.sh — Automated infrastructure drift detection
# Checks 6 types of drift and reports results.
# Run manually or via cron (see cron-drift-detect.txt).

set -euo pipefail

# ── Environment ──────────────────────────────────────────────────────────────
export PATH="${NVM_DIR:-$HOME/.nvm}/versions/node/$(node --version 2>/dev/null | tr -d 'v' || echo 'current')/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

ECOSYSTEM="${CLAWD_DIR:-$HOME/clawd}/ecosystem.config.cjs"
ECOSYSTEM_OPTIONAL="${CLAWD_DIR:-$HOME/clawd}/ecosystem.config.optional.cjs"
PORT_REGISTRY="${CLAWD_DIR:-$HOME/clawd}/shared/PORT-REGISTRY.md"
CLAUDE_MD="${CLAWD_DIR:-$HOME/clawd}/CLAUDE.md"
OPENCLAW_JSON="${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
OPENCLAW_SKILLS_DIR="${OPENCLAW_HOME:-$HOME/.openclaw}/skills"
WORKSPACES_DIR="${CLAWD_DIR:-$HOME/clawd}/workspaces"

# ── Counters ─────────────────────────────────────────────────────────────────
FAIL_COUNT=0
WARN_COUNT=0
PASS_COUNT=0

# ── Helpers ──────────────────────────────────────────────────────────────────
pass()  { echo "[PASS] $*"; (( PASS_COUNT++ )) || true; }
fail()  { echo "[FAIL] $*"; (( FAIL_COUNT++ )) || true; }
warn()  { echo "[WARN] $*"; (( WARN_COUNT++ )) || true; }
info()  { echo "  - $*"; }

# ── Check 1: Ecosystem Config vs PM2 Runtime ─────────────────────────────────
check_ecosystem_pm2() {
  local label="Ecosystem vs PM2"

  local expected
  expected=$(node -e "
    const c = require('$ECOSYSTEM');
    const apps = c.apps || [];
    apps.forEach(a => console.log(a.name));
  " 2>/dev/null | sort) || {
    fail "$label: could not parse ecosystem config"
    return
  }

  # Load optional ecosystem names so they are not flagged as unexpected drift
  local optional_names
  optional_names=$(node -e "
    try {
      const c = require('$ECOSYSTEM_OPTIONAL');
      const apps = c.apps || [];
      apps.forEach(a => console.log(a.name));
    } catch(e) { /* optional config missing is fine */ }
  " 2>/dev/null | sort) || optional_names=""

  # PM2 modules (not apps) — exclude from ecosystem comparison
  local PM2_MODULE_EXCLUSIONS="pm2-logrotate"

  local running
  running=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys
procs = json.load(sys.stdin)
for p in procs:
    print(p['name'])
" 2>/dev/null | grep -vE "^(pm2-logrotate)$" | sort) || {
    fail "$label: could not read PM2 process list"
    return
  }

  local missing extra
  missing=$(comm -23 <(echo "$expected") <(echo "$running"))
  extra=$(comm -13 <(echo "$expected") <(echo "$running"))

  local expected_count running_count
  expected_count=$(echo "$expected" | grep -c . 2>/dev/null || echo 0)
  running_count=$(echo "$running" | grep -c . 2>/dev/null || echo 0)

  # Partition extra processes into optional (INFO) vs truly unexpected (drift)
  local extra_optional="" extra_unexpected=""
  if [[ -n "$extra" ]]; then
    while IFS= read -r name; do
      [[ -z "$name" ]] && continue
      if echo "$optional_names" | grep -qx "$name"; then
        extra_optional="${extra_optional} ${name}"
      else
        extra_unexpected="${extra_unexpected} ${name}"
      fi
    done <<< "$extra"
  fi

  if [[ -z "$missing" && -z "$extra_unexpected" ]]; then
    pass "$label: $expected_count/$expected_count match"
    if [[ -n "$extra_optional" ]]; then
      info "optional services also running:${extra_optional}"
    fi
  else
    fail "$label: drift detected (expected=$expected_count, running=$running_count)"
    if [[ -n "$missing" ]]; then
      while IFS= read -r name; do
        [[ -n "$name" ]] && info "missing from PM2: $name"
      done <<< "$missing"
    fi
    if [[ -n "$extra_unexpected" ]]; then
      while IFS= read -r name; do
        [[ -n "$name" ]] && info "extra in PM2 (not in ecosystem): $name"
      done <<< "$extra_unexpected"
    fi
    if [[ -n "$extra_optional" ]]; then
      info "optional services also running (expected):${extra_optional}"
    fi
  fi
}

# ── Check 2: Port Registry vs Listeners ──────────────────────────────────────
check_ports() {
  local label="Port Registry"

  # Extract LOCKED/ACTIVE ports from registry (skip REMOVED, DECOMMISSIONED, ON-DEMAND)
  local documented_ports
  documented_ports=$(grep -E '^\|[ ]*[0-9]+[ ]*\|' "$PORT_REGISTRY" 2>/dev/null \
    | grep -v 'DECOMMISSIONED\|REMOVED\|ON-DEMAND' \
    | grep -E '(LOCKED|ACTIVE)' \
    | grep -oE '^\|[ ]*[0-9]+[ ]*\|' \
    | grep -oE '[0-9]+' \
    | sort -n)

  if [[ -z "$documented_ports" ]]; then
    fail "$label: could not parse PORT-REGISTRY.md"
    return
  fi

  # Get currently listening TCP ports, restricted to the infrastructure range
  # (1–39999) to avoid flagging unrelated system services, ephemeral-adjacent
  # ports, or Docker internal networking.  Ports 40000–49000 are excluded
  # because Docker, OrbStack, and macOS use that range heavily for internal
  # purposes unrelated to clawd infrastructure.
  local INFRA_MAX_PORT=39999

  local listening_ports
  listening_ports=$(lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null \
    | awk 'NR>1 {print $9}' \
    | grep -oE ':[0-9]+$' \
    | grep -oE '[0-9]+' \
    | awk -v max="$INFRA_MAX_PORT" '$1 <= max' \
    | sort -n | uniq)

  local not_listening extra_listeners
  not_listening=$(comm -23 <(echo "$documented_ports") <(echo "$listening_ports"))
  # Only flag extra listeners that fall within the documented-port range
  # (i.e., between the min and max documented port) — avoid flagging low-number
  # system ports (22, 80, 443) that are intentionally outside the registry.
  local doc_min doc_max
  doc_min=$(echo "$documented_ports" | grep -E '^[0-9]+$' | head -1)
  doc_max=$(echo "$documented_ports" | grep -E '^[0-9]+$' | tail -1)
  extra_listeners=$(comm -13 <(echo "$documented_ports") <(echo "$listening_ports") \
    | awk -v min="${doc_min:-1000}" -v max="${doc_max:-39999}" '$1 >= min && $1 <= max')

  local doc_count not_listening_count extra_count
  doc_count=$(echo "$documented_ports" | grep -c . 2>/dev/null || echo 0)
  not_listening_count=$(echo "$not_listening" | grep -c . 2>/dev/null || echo 0)
  extra_count=$(echo "$extra_listeners" | grep -c . 2>/dev/null || echo 0)

  if [[ -z "$not_listening" && -z "$extra_listeners" ]]; then
    pass "$label: all $doc_count documented ports match listeners"
  else
    if [[ -n "$not_listening" ]]; then
      fail "$label: $not_listening_count documented port(s) not listening"
      while IFS= read -r port; do
        if [[ -n "$port" ]]; then
          # Look up service name from registry
          local svc
          svc=$(grep -E "^\|[ ]*${port}[ ]*\|" "$PORT_REGISTRY" 2>/dev/null | head -1 \
            | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); print $3}')
          info ":${port} ${svc}"
        fi
      done <<< "$not_listening"
    fi
    if [[ -n "$extra_listeners" ]]; then
      warn "$label: $extra_count listener(s) not in documented registry (within infra range)"
      while IFS= read -r port; do
        [[ -n "$port" ]] && info ":${port} (undocumented)"
      done <<< "$extra_listeners"
    fi
  fi
}

# ── Check 3: CLAUDE.md Count Validation ──────────────────────────────────────
check_claude_md_counts() {
  local label="CLAUDE.md counts"
  local any_fail=0

  # OC version
  local oc_actual oc_claimed
  oc_actual=$(openclaw --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")
  oc_claimed=$(grep -oE 'OpenClaw v[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' "$CLAUDE_MD" 2>/dev/null | head -1 \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || \
    grep -oE 'OpenClaw v[0-9A-Za-z.]+' "$CLAUDE_MD" 2>/dev/null | head -1 \
    | grep -oE '[0-9A-Za-z.]+$' || echo "unknown")

  if [[ "$oc_actual" == "unknown" ]]; then
    warn "$label: OpenClaw version check skipped (command unavailable)"
  fi

  # Agent count
  local agent_count_actual agent_count_claimed
  agent_count_actual=$(openclaw agents list 2>/dev/null | grep -cE "^-" || echo "0")
  agent_count_claimed=$(grep -oE '[0-9]+ specialized AI agents' "$CLAUDE_MD" 2>/dev/null | grep -oE '^[0-9]+' | head -1 || echo "unknown")

  # Workspace count
  local ws_actual ws_claimed
  ws_actual=$(ls -d "$WORKSPACES_DIR"/*/ 2>/dev/null | wc -l | tr -d ' ')
  ws_claimed=$(grep -oE '[0-9]+ workspaces' "$CLAUDE_MD" 2>/dev/null | grep -oE '^[0-9]+' | head -1 || echo "unknown")

  # Skill count
  local skill_actual skill_claimed
  skill_actual=$(ls "$OPENCLAW_SKILLS_DIR" 2>/dev/null | wc -l | tr -d ' ')
  skill_claimed=$(grep -oE '[0-9]+ skills' "$CLAUDE_MD" 2>/dev/null | grep -oE '^[0-9]+' | head -1 || echo "unknown")

  # PM2 count
  local pm2_actual pm2_claimed
  pm2_actual=$(pm2 jlist 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  pm2_claimed=$(grep -oE 'PM2 manages [0-9]+' "$CLAUDE_MD" 2>/dev/null | grep -oE '[0-9]+$' | head -1 || echo "unknown")

  local results=""
  results+="  agents=${agent_count_actual} (claimed: ${agent_count_claimed})"
  results+=" | workspaces=${ws_actual} (claimed: ${ws_claimed})"
  results+=" | skills=${skill_actual} (claimed: ${skill_claimed})"
  results+=" | pm2=${pm2_actual} (claimed: ${pm2_claimed})"

  # Determine pass/fail: flag if actual vs claimed differ by more than 3 (allows for drift)
  local mismatches=0
  for pair in \
    "${agent_count_actual}:${agent_count_claimed}" \
    "${ws_actual}:${ws_claimed}" \
    "${skill_actual}:${skill_claimed}" \
    "${pm2_actual}:${pm2_claimed}"; do
    local actual="${pair%%:*}"
    local claimed="${pair##*:}"
    if [[ "$claimed" != "unknown" && "$actual" =~ ^[0-9]+$ && "$claimed" =~ ^[0-9]+$ ]]; then
      local diff=$(( actual > claimed ? actual - claimed : claimed - actual ))
      if (( diff > 3 )); then
        (( mismatches++ )) || true
      fi
    fi
  done

  if (( mismatches == 0 )); then
    pass "$label"
    info "agents=${agent_count_actual} | workspaces=${ws_actual} | skills=${skill_actual} | pm2=${pm2_actual}"
  else
    warn "$label: ${mismatches} count(s) diverged from CLAUDE.md claims (>3 gap)"
    info "agents=${agent_count_actual} (claimed ${agent_count_claimed})"
    info "workspaces=${ws_actual} (claimed ${ws_claimed})"
    info "skills=${skill_actual} (claimed ${skill_claimed})"
    info "pm2=${pm2_actual} (claimed ${pm2_claimed})"
  fi
}

# ── Check 4: Exec Security Coverage ──────────────────────────────────────────
check_exec_security() {
  local label="Exec security coverage"

  local result
  result=$(node -e "
const JSON5 = require(require.resolve('json5', { paths: [require.resolve('openclaw').replace(/openclaw/.*/, 'openclaw')] }));
const fs = require('fs');
try {
  const data = JSON5.parse(fs.readFileSync('$OPENCLAW_JSON', 'utf8'));
  const agents = (data.agents && data.agents.list) ? data.agents.list : [];
  const globalSecurity = (data.defaults && data.defaults.exec && data.defaults.exec.security !== undefined)
    ? data.defaults.exec.security
    : 'full';

  const withExplicitSec = agents.filter(a => a.tools && a.tools.exec && a.tools.exec.security !== undefined);
  const withoutExplicitSec = agents.filter(a => !(a.tools && a.tools.exec && a.tools.exec.security !== undefined));

  // Agents without explicit exec.security inherit the global default
  const inheritingFull = globalSecurity === 'full' ? withoutExplicitSec : [];

  const total = agents.length;
  const explicit = withExplicitSec.length;
  const inherited = inheritingFull.length;

  console.log('EXPLICIT:' + explicit + '/' + total);
  console.log('GLOBAL_DEFAULT:' + globalSecurity);
  console.log('INHERITING_FULL:' + inherited);
  if (inherited.length > 0) {
    inheritingFull.forEach(a => console.log('AGENT_INHERITING:' + (a.id || a.name || '?')));
  }
  if (inherited > 0) {
    console.log('WARN');
  } else {
    console.log('PASS');
  }
} catch(e) {
  console.log('ERROR: ' + e.message);
  console.log('FAIL');
}
" 2>/dev/null) || {
    fail "$label: node execution error"
    return
  }

  local explicit_ratio global_default inherited_count status
  explicit_ratio=$(echo "$result" | grep "^EXPLICIT:" | sed 's/^EXPLICIT://')
  global_default=$(echo "$result" | grep "^GLOBAL_DEFAULT:" | sed 's/^GLOBAL_DEFAULT://')
  inherited_count=$(echo "$result" | grep "^INHERITING_FULL:" | sed 's/^INHERITING_FULL://')
  status=$(echo "$result" | grep -E "^(PASS|WARN|FAIL)$" | tail -1)

  if [[ "$status" == "PASS" ]]; then
    pass "$label: $explicit_ratio explicit exec.security, global default='${global_default}', 0 inheriting full"
  elif [[ "$status" == "WARN" ]]; then
    warn "$label: $explicit_ratio explicit exec.security, but ${inherited_count} agent(s) inherit global default '${global_default}' (unrestricted exec)"
    while IFS= read -r line; do
      [[ "$line" == AGENT_INHERITING:* ]] && info "inheriting full exec: ${line#AGENT_INHERITING:}"
    done <<< "$result"
  elif [[ "$status" == "FAIL" ]]; then
    fail "$label: could not parse openclaw.json"
    info "$(echo "$result" | grep "^ERROR:")"
  else
    fail "$label: unexpected result"
    info "$result"
  fi
}

# ── Check 5: Model Config Lint ────────────────────────────────────────────────
check_model_config() {
  local label="Model config"

  local result
  result=$(node -e "
const JSON5 = require(require.resolve('json5', { paths: [require.resolve('openclaw').replace(/openclaw/.*/, 'openclaw')] }));
const fs = require('fs');
try {
  const data = JSON5.parse(fs.readFileSync('$OPENCLAW_JSON', 'utf8'));
  const agents = (data.agents && data.agents.list) ? data.agents.list : [];
  const bad = [];

  // Check per-agent model
  agents.forEach(a => {
    if (a.model !== undefined && typeof a.model !== 'string') {
      bad.push('agent ' + (a.id || '?') + ': model is ' + typeof a.model);
    }
  });

  // Check defaults model
  const defaults = data.defaults || {};
  if (defaults.model !== undefined && typeof defaults.model !== 'string') {
    bad.push('defaults.model is ' + typeof defaults.model);
  }

  if (bad.length === 0) {
    const agentCount = agents.filter(a => typeof a.model === 'string').length;
    console.log('PASS:' + agentCount + ' agents with string model');
  } else {
    bad.forEach(b => console.log('BAD:' + b));
    console.log('FAIL');
  }
} catch(e) {
  console.log('ERROR:' + e.message);
  console.log('FAIL');
}
" 2>/dev/null) || {
    fail "$label: node execution error"
    return
  }

  if echo "$result" | grep -q "^PASS:"; then
    local detail
    detail=$(echo "$result" | grep "^PASS:" | sed 's/^PASS://')
    pass "$label: all strings ($detail)"
  elif echo "$result" | grep -q "^FAIL$"; then
    local bad_items
    bad_items=$(echo "$result" | grep "^BAD:")
    fail "$label: non-string model values found"
    while IFS= read -r item; do
      [[ -n "$item" ]] && info "${item#BAD:}"
    done <<< "$bad_items"
  else
    fail "$label: could not parse openclaw.json"
    info "$result"
  fi
}

# ── Check 6: Disk Space ───────────────────────────────────────────────────────
check_disk_space() {
  local label="Disk"
  local threshold_gb=10

  local free_bytes
  free_bytes=$(df -k / 2>/dev/null | awk 'NR==2 {print $4}')
  if [[ -z "$free_bytes" ]]; then
    fail "$label: could not read disk usage"
    return
  fi

  local free_gb
  free_gb=$(echo "scale=1; $free_bytes / 1048576" | bc 2>/dev/null || echo "0")

  # Compare as integers (multiply by 10 to handle one decimal)
  local free_gb_int threshold_int
  free_gb_int=$(echo "$free_gb * 10" | bc 2>/dev/null | cut -d. -f1 || echo "0")
  threshold_int=$(( threshold_gb * 10 ))

  if (( free_gb_int >= threshold_int )); then
    pass "$label: ${free_gb}GB free"
  else
    warn "$label: ${free_gb}GB free (threshold: ${threshold_gb}GB)"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
echo "DRIFT DETECTION — $(date +%Y-%m-%d)"
echo "═══════════════════════════════════════"

check_ecosystem_pm2
check_ports
check_claude_md_counts
check_exec_security
check_model_config
check_disk_space

echo "═══════════════════════════════════════"

RESULT_PARTS=()
(( FAIL_COUNT > 0 )) && RESULT_PARTS+=("${FAIL_COUNT} FAIL")
(( WARN_COUNT > 0 )) && RESULT_PARTS+=("${WARN_COUNT} WARN")
(( PASS_COUNT > 0 )) && RESULT_PARTS+=("${PASS_COUNT} PASS")

if (( FAIL_COUNT == 0 && WARN_COUNT == 0 )); then
  echo "RESULT: ALL PASS"
else
  echo "RESULT: $(IFS=', '; echo "${RESULT_PARTS[*]}")"
fi
