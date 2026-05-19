#!/usr/bin/env bash
# Prune Paperclip SQL backups — keep newest 10, delete rest
set -euo pipefail

BACKUP_DIR="$HOME/.paperclip/instances/default/data/backups"
KEEP=10

if [ ! -d "$BACKUP_DIR" ]; then
  exit 0
fi

total=$(ls -1 "$BACKUP_DIR"/*.sql 2>/dev/null | wc -l | tr -d ' ')
if [ "$total" -le "$KEEP" ]; then
  exit 0
fi

to_remove=$((total - KEEP))
# Use find+sort instead of ls|xargs to handle filenames with spaces safely
mapfile -t all_backups < <(find "$BACKUP_DIR" -maxdepth 1 -name "*.sql" -print0 \
  | xargs -0 ls -1t 2>/dev/null)
for f in "${all_backups[@]:$KEEP}"; do
  rm -f -- "$f"
done
echo "$(date): Pruned $to_remove Paperclip backups (kept $KEEP of $total)"
