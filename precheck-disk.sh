#!/usr/bin/env bash
set -euo pipefail
USAGE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
[ "$USAGE" -gt 80 ]
