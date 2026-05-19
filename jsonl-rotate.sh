#!/usr/bin/env bash
# jsonl-rotate.sh — Archive OpenClaw agent JSONL transcripts >30d to Extreme Pro
#
# Replaces the destructive prune-old-sessions.sh (delete-only) with an
# archive-then-trash workflow that preserves history on Extreme Pro.
#
# - For each agent under ~/.openclaw/agents/<id>/sessions/:
#     - Find *.jsonl files older than RETENTION_DAYS (default 30, by mtime)
#     - Group by month (YYYY-MM from mtime)
#     - Tar+gzip each month's batch to:
#         /Volumes/Extreme Pro/clawd-live/archive/oc-jsonl-transcripts/<agent>/<YYYY-MM>.tar.gz
#     - Verify tar integrity before trashing originals (NEVER `rm`)
# - Idempotency strategy: SKIP — if the destination archive already exists,
#   we leave the originals in place rather than appending. This preserves
#   the immutability of historical archives. The cron will re-attempt on
#   the next run; if originals are still present after 30+ days they will
#   need manual review (logged as warning).
# - Bails if Extreme Pro not mounted, or if Extreme Pro disk <10% free.
#
# DRY_RUN=1 to preview without writing/trashing.
# AGENT_FILTER=<name> to process a single agent.
# RETENTION_DAYS=<n> to override default 30.
#
# Cron: 0 4 * * * (daily 4am)
#
# Bash 3.2 compatible (macOS default) — no associative arrays.

set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_NAME="$(basename "$0")"
LOG="${HOME}/clawd/logs/jsonl-rotate.log"
SESSIONS_ROOT="${HOME}/.openclaw/agents"
ARCHIVE_ROOT="/Volumes/Extreme Pro/clawd-live/archive/oc-jsonl-transcripts"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
MIN_FREE_PCT=10
DRY_RUN="${DRY_RUN:-0}"
AGENT_FILTER="${AGENT_FILTER:-}"

mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%dT%H:%M:%S'; }
# log writes to LOG file and stderr (NOT stdout — process_agent uses stdout for its tab-separated stats)
log() {
  local line="[$(ts)] [$SCRIPT_NAME] $*"
  echo "$line" >> "$LOG"
  echo "$line" >&2
}

DRY_PREFIX=""
if [[ "$DRY_RUN" == "1" ]]; then
  DRY_PREFIX="[DRY-RUN] "
  log "${DRY_PREFIX}Starting (dry-run, no writes)"
else
  log "Starting"
fi

# --- Pre-flight checks -------------------------------------------------------

if [[ ! -d "$SESSIONS_ROOT" ]]; then
  log "Sessions root not found: $SESSIONS_ROOT — exit 0"
  exit 0
fi

if [[ ! -d "/Volumes/Extreme Pro/clawd-live" ]]; then
  log "Extreme Pro NOT mounted (/Volumes/Extreme Pro/clawd-live missing) — exit 0"
  exit 0
fi

# Disk-free check on Extreme Pro
FREE_PCT=$(df -k "/Volumes/Extreme Pro" | awk 'NR==2 {gsub("%","",$5); print 100-$5}')
if [[ -z "$FREE_PCT" || "$FREE_PCT" -lt "$MIN_FREE_PCT" ]]; then
  log "Extreme Pro free space ${FREE_PCT}% < ${MIN_FREE_PCT}% — refusing to write — exit 0"
  exit 0
fi
log "Extreme Pro mounted, free=${FREE_PCT}%, retention=${RETENTION_DAYS}d"

# Required tools
for cmd in tar gzip find stat trash awk; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "Required command missing: $cmd — exit 1"
    exit 1
  fi
done

if [[ "$DRY_RUN" != "1" ]]; then
  mkdir -p "$ARCHIVE_ROOT"
fi

# --- Helpers -----------------------------------------------------------------

bytes_to_mb() {
  awk -v b="$1" 'BEGIN { printf "%.2f", b/1024/1024 }'
}

# Process one agent's session dir.
# Args: $1 = agent_sessions_dir, $2 = agent_id
# Echoes a single tab-separated summary line on stdout if any work done:
#   FILES<TAB>BYTES<TAB>ARCHIVES_CREATED<TAB>ARCHIVES_SKIPPED
# All informational/error logging goes to log() (which writes to LOG file + stderr-via-tee).
# Returns 0 always; failures are logged but don't abort the loop.
process_agent() {
  local agent_sessions_dir="$1"
  local agent_id="$2"

  # Build a manifest of old files: each line is "YYYY-MM\t/abs/path"
  local manifest
  manifest="$(mktemp -t jsonl-rotate-manifest-XXXXXX)"
  trap 'rm -f "$manifest"' RETURN

  # Find -mtime +N -> strictly older than (N+1)*24h. Good enough.
  find "$agent_sessions_dir" -maxdepth 1 -type f -name '*.jsonl' -mtime "+$RETENTION_DAYS" -print0 2>/dev/null \
    | while IFS= read -r -d '' f; do
        local ym
        ym="$(stat -f '%Sm' -t '%Y-%m' "$f")"
        printf '%s\t%s\n' "$ym" "$f"
      done > "$manifest"

  # Total old files for this agent
  local total_old
  total_old="$(wc -l < "$manifest" | tr -d ' ')"
  if [[ "$total_old" -eq 0 ]]; then
    rm -f "$manifest"
    return 0
  fi

  # Distinct months
  local months
  months="$(awk -F'\t' '{print $1}' "$manifest" | sort -u)"

  local agent_files_archived=0
  local agent_bytes_freed=0
  local agent_archives_created=0
  local agent_archives_skipped=0

  local agent_archive_dir="$ARCHIVE_ROOT/$agent_id"
  if [[ "$DRY_RUN" != "1" ]]; then
    mkdir -p "$agent_archive_dir"
  fi

  local ym
  while IFS= read -r ym; do
    [[ -z "$ym" ]] && continue
    local archive_path="$agent_archive_dir/${ym}.tar.gz"

    # Files in this bucket (basenames for tar -C/-T)
    local file_list_basenames
    file_list_basenames="$(mktemp -t jsonl-rotate-bucket-XXXXXX)"
    awk -F'\t' -v m="$ym" '$1==m {print $2}' "$manifest" \
      | while IFS= read -r f; do
          basename "$f"
        done > "$file_list_basenames"

    local cnt
    cnt="$(wc -l < "$file_list_basenames" | tr -d ' ')"

    # Compute bucket size in bytes
    local bucket_bytes=0
    local sz
    while IFS= read -r bn; do
      [[ -z "$bn" ]] && continue
      sz="$(stat -f '%z' "$agent_sessions_dir/$bn" 2>/dev/null || echo 0)"
      bucket_bytes=$((bucket_bytes + sz))
    done < "$file_list_basenames"

    # Idempotency: SKIP if archive already exists
    if [[ -f "$archive_path" ]]; then
      log "${DRY_PREFIX}SKIP $agent_id/$ym (archive exists at ${archive_path}; ${cnt} originals still present — manual review)"
      agent_archives_skipped=$((agent_archives_skipped + 1))
      rm -f "$file_list_basenames"
      continue
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
      log "${DRY_PREFIX}WOULD archive $agent_id/$ym → ${archive_path} (${cnt} files, $(bytes_to_mb "$bucket_bytes") MB)"
      agent_files_archived=$((agent_files_archived + cnt))
      agent_bytes_freed=$((agent_bytes_freed + bucket_bytes))
      agent_archives_created=$((agent_archives_created + 1))
      rm -f "$file_list_basenames"
      continue
    fi

    # Create tar.gz from file list (relative paths via -C)
    if ! tar -czf "$archive_path" -C "$agent_sessions_dir" -T "$file_list_basenames" 2>>"$LOG"; then
      log "ERROR tar failed for $agent_id/$ym — leaving originals in place"
      rm -f "$archive_path" "$file_list_basenames"
      continue
    fi

    # Verify: non-empty + extractable + count matches
    if [[ ! -s "$archive_path" ]]; then
      log "ERROR tar produced empty archive for $agent_id/$ym — removing"
      rm -f "$archive_path" "$file_list_basenames"
      continue
    fi
    if ! tar -tzf "$archive_path" >/dev/null 2>>"$LOG"; then
      log "ERROR tar verification failed for $archive_path — removing"
      rm -f "$archive_path" "$file_list_basenames"
      continue
    fi
    local archived_count
    archived_count="$(tar -tzf "$archive_path" 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "$archived_count" -ne "$cnt" ]]; then
      log "ERROR archive count mismatch for $agent_id/$ym (expected $cnt, got $archived_count) — removing"
      rm -f "$archive_path" "$file_list_basenames"
      continue
    fi

    # Tar verified. Trash originals (NEVER rm).
    local trash_failed=0
    while IFS= read -r bn; do
      [[ -z "$bn" ]] && continue
      if ! trash "$agent_sessions_dir/$bn" 2>>"$LOG"; then
        log "ERROR trash failed for $agent_sessions_dir/$bn"
        trash_failed=$((trash_failed + 1))
      fi
    done < "$file_list_basenames"

    if [[ "$trash_failed" -gt 0 ]]; then
      log "WARN $trash_failed/$cnt files failed to trash for $agent_id/$ym (archive at $archive_path is good)"
    fi

    log "ARCHIVED $agent_id/$ym → ${ym}.tar.gz ($cnt files, $(bytes_to_mb "$bucket_bytes") MB)"
    agent_files_archived=$((agent_files_archived + cnt))
    agent_bytes_freed=$((agent_bytes_freed + bucket_bytes))
    agent_archives_created=$((agent_archives_created + 1))
    rm -f "$file_list_basenames"
  done <<< "$months"

  rm -f "$manifest"

  # Stdout the per-agent stats for the parent loop to aggregate
  printf '%d\t%d\t%d\t%d\n' "$agent_files_archived" "$agent_bytes_freed" "$agent_archives_created" "$agent_archives_skipped"
  return 0
}

# --- Main loop ---------------------------------------------------------------

TOTAL_AGENTS=0
TOTAL_FILES_ARCHIVED=0
TOTAL_BYTES_FREED=0
TOTAL_ARCHIVES_CREATED=0
TOTAL_ARCHIVES_SKIPPED=0

# Per-agent summary lines for the final report
SUMMARY_FILE="$(mktemp -t jsonl-rotate-summary-XXXXXX)"

for agent_sessions_dir in "$SESSIONS_ROOT"/*/sessions; do
  [[ -d "$agent_sessions_dir" ]] || continue
  agent_id="$(basename "$(dirname "$agent_sessions_dir")")"

  if [[ -n "$AGENT_FILTER" && "$agent_id" != "$AGENT_FILTER" ]]; then
    continue
  fi

  TOTAL_AGENTS=$((TOTAL_AGENTS + 1))

  agent_stats="$(process_agent "$agent_sessions_dir" "$agent_id" || true)"
  [[ -z "$agent_stats" ]] && continue

  files=$(printf '%s' "$agent_stats" | awk -F'\t' '{print $1}')
  bytes=$(printf '%s' "$agent_stats" | awk -F'\t' '{print $2}')
  created=$(printf '%s' "$agent_stats" | awk -F'\t' '{print $3}')
  skipped=$(printf '%s' "$agent_stats" | awk -F'\t' '{print $4}')

  TOTAL_FILES_ARCHIVED=$((TOTAL_FILES_ARCHIVED + files))
  TOTAL_BYTES_FREED=$((TOTAL_BYTES_FREED + bytes))
  TOTAL_ARCHIVES_CREATED=$((TOTAL_ARCHIVES_CREATED + created))
  TOTAL_ARCHIVES_SKIPPED=$((TOTAL_ARCHIVES_SKIPPED + skipped))

  if [[ "$files" -gt 0 ]]; then
    printf '%s\t%d\t%d\n' "$agent_id" "$files" "$bytes" >> "$SUMMARY_FILE"
  fi
done

# --- Summary -----------------------------------------------------------------

log "${DRY_PREFIX}DONE — agents=$TOTAL_AGENTS files=$TOTAL_FILES_ARCHIVED freed=$(bytes_to_mb "$TOTAL_BYTES_FREED") MB archives_created=$TOTAL_ARCHIVES_CREATED skipped=$TOTAL_ARCHIVES_SKIPPED"

if [[ -s "$SUMMARY_FILE" ]]; then
  # sort by bytes desc, top 10
  log "Top agents by MB freed:"
  sort -t$'\t' -k3 -nr "$SUMMARY_FILE" | head -10 | while IFS=$'\t' read -r aid f b; do
    log "  $aid: $f files, $(bytes_to_mb "$b") MB"
  done
fi

rm -f "$SUMMARY_FILE"
