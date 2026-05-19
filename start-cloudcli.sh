#!/usr/bin/env bash
set -euo pipefail
export SERVER_PORT=4681
export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:$PATH"
exec /Users/ai/.nvm/versions/node/v24.13.0/bin/cloudcli start
