#!/usr/bin/env bash
# gbrain-orphan-killer.sh — kill gbrain processes whose parent is launchd (orphaned)
# Background: OC MCP spawns gbrain children; when parent gateway/codex dies, gbrain
# re-parents to launchd and persists, fighting future gbrain processes for the
# PGLite lock at ~/.gbrain/brain.pglite/postmaster.pid.
# Cron: every hour at :07.
# Logs: ~/clawd/logs/gbrain-orphan-killer.log
set -euo pipefail

LOG=~/clawd/logs/gbrain-orphan-killer.log
mkdir -p "$(dirname "$LOG")"
TS=$(date +%Y-%m-%dT%H:%M:%S%z)

# Find all gbrain serve processes
PIDS=$(pgrep -f "gbrain/src/cli.ts serve" 2>/dev/null || true)
KILLED=0
KEPT=0
for PID in $PIDS; do
  PPARENT=$(ps -p "$PID" -o ppid= 2>/dev/null | xargs)
  if [ "$PPARENT" = "1" ]; then
    # Orphan — parent is launchd
    if kill -TERM "$PID" 2>/dev/null; then
      KILLED=$((KILLED+1))
      echo "[$TS] TERM orphan PID=$PID (parent=launchd)" >> "$LOG"
    fi
  else
    KEPT=$((KEPT+1))
  fi
done

# After TERM, give 3s then SIGKILL anything still orphaned
sleep 3
PIDS=$(pgrep -f "gbrain/src/cli.ts serve" 2>/dev/null || true)
for PID in $PIDS; do
  PPARENT=$(ps -p "$PID" -o ppid= 2>/dev/null | xargs)
  if [ "$PPARENT" = "1" ]; then
    if kill -9 "$PID" 2>/dev/null; then
      echo "[$TS] KILL -9 stubborn orphan PID=$PID" >> "$LOG"
    fi
  fi
done

if [ "$KILLED" -gt 0 ]; then
  echo "[$TS] cleaned $KILLED orphans (kept $KEPT legit)" >> "$LOG"
fi
