#!/usr/bin/env bash
# Check if discrawl DB was updated in the last 6 hours
set -euo pipefail
find ~/.discrawl -name "discrawl.db" -mmin -360 2>/dev/null | head -1 | grep -q .
