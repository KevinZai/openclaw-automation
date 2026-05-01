#!/usr/bin/env bash
# Part of openclaw-automation — https://github.com/KevinZai/openclaw-automation
# pm2-caddy-sync.sh — Verify and fix Caddy reverse_proxy ports against PM2 reality
#
# Usage:
#   ./pm2-caddy-sync.sh              # Normal run (dry-run safe — only reloads if mismatches found)
#   ./pm2-caddy-sync.sh --dry-run    # Report mismatches without writing or reloading
#   ./pm2-caddy-sync.sh --verbose    # Show all checked routes, not just mismatches
#
# Cron (every 5 min):
#   */5 * * * * $CLAWD_DIR/scripts/pm2-caddy-sync.sh >> /tmp/pm2-caddy-sync.log 2>&1
#
# PM2 restart hook (ecosystem.config.js post_update hook):
#   post_update: ['$CLAWD_DIR/scripts/pm2-caddy-sync.sh']
#
# Requirements: pm2, caddy, jq, python3 (for JSON parsing)
# Safe to run as cron — atomic Caddyfile writes, no-op if nothing changed.

set -euo pipefail

CADDYFILE="${CADDYFILE:-${CLAWD_DIR:-$HOME/clawd}/tools/caddy/Caddyfile}"
DRY_RUN=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --verbose) VERBOSE=true ;;
  esac
done

# ─────────────────────────────────────────────────────────────
# SERVICE → HOST → EXPECTED_PORT MAPPING
#
# Format: "pm2_name|caddy_hostname|expected_port"
# expected_port can be:
#   - A literal number (hardcoded fallback)
#   - "PM2:argflag" to extract from PM2 args (e.g. PM2:--port)
#   - "PM2:env:VAR" to extract from PM2 env
#   - "SKIP" to omit from checks entirely
#
# Port resolution order (per entry):
#   1. PM2 args: --port NNNN or -p NNNN or --port=NNNN
#   2. PM2 env var PORT
#   3. Fallback literal from this map
# ─────────────────────────────────────────────────────────────

# NOTE: domains below are Tailscale-only routes via Caddy — not public internet.
# Replace *.your-tailscale-domain.com with your own Tailscale/internal hostnames.
# Format: "pm2_service_name|caddy_hostname|expected_port"
declare -a SERVICE_MAP=(
  "cloudcli|cc.your-tailscale-domain.com|4681"
  "mission-control|mc.your-tailscale-domain.com|3004"
  "links-server|links.your-tailscale-domain.com|3003"
  "portkey-gateway|portkey.your-tailscale-domain.com|8790"
  "openclaw-nerve|nerve.your-tailscale-domain.com|3080"
  "n8n|n8n.your-tailscale-domain.com|5678"
  "paperclip|pc.your-tailscale-domain.com|3100"
)

# ─────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
warn() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN: $*" >&2; }

# Extract port from PM2 jlist JSON for a given service name.
# Resolution order: --port/--port=/--PORT/-p in args → env.PORT → fallback
get_pm2_port() {
  local service="$1"
  local fallback="$2"

  # Parse with python3 — jq is overkill for array indexing
  python3 - "$service" "$fallback" <<'PYEOF'
import sys, json, subprocess, re

service = sys.argv[1]
fallback = sys.argv[2]

try:
    raw = subprocess.check_output(['pm2', 'jlist'], stderr=subprocess.DEVNULL)
    data = json.loads(raw)
except Exception:
    print(fallback)
    sys.exit(0)

proc = next((p for p in data if p.get('name') == service), None)
if not proc:
    print(fallback)
    sys.exit(0)

env = proc.get('pm2_env', {})
args = env.get('args') or []

# 1. Scan args list for port flags
arg_str = ' '.join(str(a) for a in args)

# --port=NNNN
m = re.search(r'--port=(\d+)', arg_str)
if m:
    print(m.group(1))
    sys.exit(0)

# --port NNNN (next element) or -p NNNN
for i, a in enumerate(args):
    if str(a) in ('--port', '-p', '--PORT') and i + 1 < len(args):
        candidate = str(args[i + 1])
        if candidate.isdigit():
            print(candidate)
            sys.exit(0)

# PORT=NNNN embedded in a shell -c string (e.g. 'PORT=4001 pnpm start')
m = re.search(r'\bPORT=(\d+)', arg_str)
if m:
    print(m.group(1))
    sys.exit(0)

# 2. env.PORT
port_env = (env.get('env') or {}).get('PORT', '')
if str(port_env).isdigit():
    print(port_env)
    sys.exit(0)

# 3. Fallback
print(fallback)
PYEOF
}

# Extract the current port for a given hostname from the Caddyfile.
# Returns empty string if the hostname block is not found or is commented out.
get_caddy_port() {
  local hostname="$1"
  # Match the hostname line then grab the reverse_proxy localhost:PORT within that block.
  # Handles both "hostname {" and "hostname, alias {" patterns.
  python3 - "$hostname" "$CADDYFILE" <<'PYEOF'
import sys, re

hostname = sys.argv[1]
caddyfile = sys.argv[2]

try:
    with open(caddyfile) as f:
        content = f.read()
except FileNotFoundError:
    print('')
    sys.exit(0)

# Split into blocks by finding the outermost braces.
# We look for a block whose opening line contains our hostname (not commented out).
lines = content.splitlines()
in_block = False
depth = 0
found_port = ''

i = 0
while i < len(lines):
    line = lines[i]
    stripped = line.strip()

    if not in_block:
        # Check if this line opens the target block (not a comment line)
        if not stripped.startswith('#') and hostname in stripped and stripped.endswith('{'):
            in_block = True
            depth = 1
            i += 1
            continue
    else:
        depth += stripped.count('{') - stripped.count('}')
        if depth <= 0:
            in_block = False
        elif not stripped.startswith('#'):
            m = re.search(r'reverse_proxy\s+localhost:(\d+)', stripped)
            if m:
                found_port = m.group(1)
                break
    i += 1

print(found_port)
PYEOF
}

# Rewrite the port for a given hostname's reverse_proxy line in the Caddyfile.
# Only rewrites the first matching line inside the correct block.
set_caddy_port() {
  local hostname="$1"
  local new_port="$2"

  python3 - "$hostname" "$new_port" "$CADDYFILE" <<'PYEOF'
import sys, re

hostname = sys.argv[1]
new_port = sys.argv[2]
caddyfile = sys.argv[3]

with open(caddyfile) as f:
    lines = f.readlines()

in_block = False
depth = 0
patched = False
out = []

for line in lines:
    stripped = line.strip()

    if not in_block:
        if not stripped.startswith('#') and hostname in stripped and stripped.endswith('{'):
            in_block = True
            depth = 1
            out.append(line)
            continue
    else:
        depth += stripped.count('{') - stripped.count('}')
        if depth <= 0:
            in_block = False
        elif not stripped.startswith('#') and not patched:
            m = re.search(r'(reverse_proxy\s+localhost:)(\d+)(.*)', stripped)
            if m:
                new_line = line.replace(
                    f"localhost:{m.group(2)}",
                    f"localhost:{new_port}",
                    1
                )
                out.append(new_line)
                patched = True
                continue

    out.append(line)

if not patched:
    print(f"ERROR: could not find reverse_proxy line for {hostname}", file=sys.stderr)
    sys.exit(1)

with open(caddyfile, 'w') as f:
    f.writelines(out)

print("patched")
PYEOF
}

# ─────────────────────────────────────────────────────────────
# PREFLIGHT CHECKS
# ─────────────────────────────────────────────────────────────

if [[ ! -f "$CADDYFILE" ]]; then
  warn "Caddyfile not found at $CADDYFILE — aborting."
  exit 1
fi

if ! command -v pm2 &>/dev/null; then
  warn "pm2 not found in PATH — aborting."
  exit 1
fi

if ! command -v caddy &>/dev/null; then
  warn "caddy not found in PATH — aborting."
  exit 1
fi

# ─────────────────────────────────────────────────────────────
# MAIN LOOP
# ─────────────────────────────────────────────────────────────

mismatches=0
fixes=0
errors=0

for entry in "${SERVICE_MAP[@]}"; do
  IFS='|' read -r service hostname fallback_port <<< "$entry"

  # Resolve actual port from PM2 (with fallback)
  actual_port="$(get_pm2_port "$service" "$fallback_port")"

  # Read what Caddy currently has
  caddy_port="$(get_caddy_port "$hostname")"

  if [[ -z "$caddy_port" ]]; then
    # Block is commented out or disabled — skip silently
    $VERBOSE && log "SKIP $service → $hostname (no active reverse_proxy block)"
    continue
  fi

  if [[ "$caddy_port" == "$actual_port" ]]; then
    $VERBOSE && log "OK  $service → $hostname :$caddy_port"
    continue
  fi

  ((mismatches++)) || true
  log "MISMATCH  $service → $hostname — Caddy has :$caddy_port, PM2 reports :$actual_port"

  if $DRY_RUN; then
    log "DRY-RUN — would patch $hostname :$caddy_port → :$actual_port"
    continue
  fi

  # Patch Caddyfile
  result="$(set_caddy_port "$hostname" "$actual_port" 2>&1)"
  if [[ "$result" == "patched" ]]; then
    log "FIXED     $hostname :$caddy_port → :$actual_port"
    ((fixes++)) || true
  else
    warn "Failed to patch $hostname: $result"
    ((errors++)) || true
  fi
done

# ─────────────────────────────────────────────────────────────
# RELOAD CADDY IF ANYTHING CHANGED
# ─────────────────────────────────────────────────────────────

if [[ $mismatches -eq 0 ]]; then
  log "All routes verified (${#SERVICE_MAP[@]} checked)"
  exit 0
fi

if $DRY_RUN; then
  log "Dry-run complete — $mismatches mismatch(es) found, no changes made."
  exit 0
fi

if [[ $fixes -gt 0 && $errors -eq 0 ]]; then
  log "Reloading Caddy ($fixes fix(es) applied)..."
  if caddy reload --config "$CADDYFILE" 2>&1 | while IFS= read -r line; do log "caddy: $line"; done; then
    log "Caddy reloaded successfully."
  else
    warn "caddy reload failed — check Caddyfile syntax."
    exit 2
  fi
elif [[ $errors -gt 0 ]]; then
  warn "$errors patch(es) failed — NOT reloading Caddy to avoid partial state."
  exit 3
fi

exit 0
