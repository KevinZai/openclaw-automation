#!/usr/bin/env bash
# Check if any PM2 process changed status in the last 30 min
set -euo pipefail
RECENT=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys,time
data=json.load(sys.stdin)
now=time.time()*1000
changed=any(now - d['pm2_env'].get('pm_uptime',now) < 1800000 for d in data)
sys.exit(0 if changed else 1)
" 2>/dev/null)
