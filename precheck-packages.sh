#!/usr/bin/env bash
# Check if any package.json was modified in last 6 hours
set -euo pipefail
find /Users/ai/clawd/tools /Users/ai/clawd/projects -name "package.json" -maxdepth 2 -mmin -360 2>/dev/null | head -1 | grep -q .
