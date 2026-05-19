#!/usr/bin/env bash
# Fix openclaw.json permissions after gateway restart
# Gateway SIGUSR1 resets to world-readable
set -euo pipefail

chmod 600 ~/.openclaw/openclaw.json 2>/dev/null || true
