#!/bin/bash
# daily-retrospective.sh — End-of-day enrichment for Obsidian daily notes
# Runs at 10 PM via OpenClaw cron
# Reads: workspace memory, git log, Paperclip API
# Writes: shared/daily-brief/ (source of truth) + iCloud vault (appended retro section)
#
# Usage: bash daily-retrospective.sh [YYYY-MM-DD]
# Default: today's date

set -euo pipefail

DATE="${1:-$(date +%Y-%m-%d)}"
DOW=$(date -j -f "%Y-%m-%d" "$DATE" "+%A" 2>/dev/null || date -d "$DATE" "+%A" 2>/dev/null || echo "Unknown")
CLAWD="$HOME/clawd"
BRIEF_DIR="$CLAWD/shared/daily-brief"
VAULT_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Kevin-Vault/01-Daily"
OUTPUT="$BRIEF_DIR/retro-$DATE.md"
VAULT_FILE="$VAULT_DIR/$DATE.md"

mkdir -p "$BRIEF_DIR"
mkdir -p "$VAULT_DIR" 2>/dev/null || true

echo "[daily-retro] Building retrospective for $DATE ($DOW)..."

# ---------------------------------------------------------------------------
# 1. Git commits for today (clawd repo)
# ---------------------------------------------------------------------------
GIT_LOG=$(cd "$CLAWD" && git log \
  --oneline \
  --after="${DATE}T00:00:00" \
  --before="${DATE}T23:59:59" \
  2>/dev/null || echo "No commits")

if [ -z "$GIT_LOG" ]; then
  GIT_LOG="No commits"
fi

# ---------------------------------------------------------------------------
# 2. Workspace memory entries for today — collect all matching files
# ---------------------------------------------------------------------------
MEMORY_RAW=""
MEMORY_WS_LIST=""

for mem_file in "$CLAWD"/workspaces/*/memory/"${DATE}"*.md; do
  if [ -f "$mem_file" ]; then
    ws=$(echo "$mem_file" | sed "s|.*/workspaces/||;s|/memory/.*||")
    MEMORY_WS_LIST="$MEMORY_WS_LIST $ws"
    MEMORY_RAW+="### $ws\n"
    MEMORY_RAW+="$(cat "$mem_file")\n\n"
  fi
done

if [ -z "$MEMORY_RAW" ]; then
  MEMORY_RAW="No workspace memory entries for $DATE"
fi

# ---------------------------------------------------------------------------
# 3. Paperclip issues completed today
# ---------------------------------------------------------------------------
PC_DONE=$(curl -s --max-time 5 \
  "http://localhost:3110/api/companies/d852cff2-1645-4c48-ae14-010bd8230444/issues" \
  2>/dev/null | python3 -c "
import sys, json
try:
    issues = json.load(sys.stdin)
    done = [
        i for i in issues
        if i.get('status') == 'done'
        and (
            (i.get('completedAt') or '')[:10] == '$DATE'
            or (i.get('updatedAt') or '')[:10] == '$DATE'
        )
    ]
    if done:
        for i in sorted(done, key=lambda x: x.get('completedAt') or '', reverse=True):
            identifier = i.get('identifier', i.get('id','')[:8])
            title = i.get('title','')[:80]
            print(f'- [{identifier}] {title}')
    else:
        print('No issues completed today')
except Exception as e:
    print(f'Paperclip unavailable ({e})')
" 2>/dev/null || echo "Paperclip unavailable")

# ---------------------------------------------------------------------------
# 4. Extract tagged entries from memory
# ---------------------------------------------------------------------------
extract_tag() {
  local tag="$1"
  local result
  result=$(printf '%b' "$MEMORY_RAW" | grep -i "\[$tag\]" 2>/dev/null | \
    sed 's/^## //;s/^- //' | head -20 || true)
  if [ -z "$result" ]; then
    echo "None recorded"
  else
    echo "$result"
  fi
}

DECISIONS=$(extract_tag "DECISION")
LEARNED=$(extract_tag "LEARNED\|CORRECTION")
SHIPPED=$(extract_tag "SHIPPED\|DEPLOYED")
TASKS_DONE=$(extract_tag "TASK")

# Memory preview — first 80 lines, skip Claude-Code session noise
MEMORY_PREVIEW=$(printf '%b' "$MEMORY_RAW" | \
  grep -v "^\[CLAUDE-CODE\]\|Session ended\|Stop reason: unknown" | \
  head -80 || true)

# ---------------------------------------------------------------------------
# 5. Write source-of-truth retrospective to shared/daily-brief/
# ---------------------------------------------------------------------------
cat > "$OUTPUT" << EOMD
---
date: $DATE
type: retrospective
generated: $(date "+%Y-%m-%dT%H:%M:%S")
workspaces:${MEMORY_WS_LIST}
---

# Retrospective — $DATE ($DOW)

> Auto-generated at $(date "+%H:%M") by daily-retrospective.sh

## Shipped / Deployed
${SHIPPED}

## Tasks Completed
${TASKS_DONE}

## Paperclip Done Today
${PC_DONE}

## Decisions
${DECISIONS}

## Learned / Corrections
${LEARNED}

## Git Activity
${GIT_LOG}

## Memory Entries (filtered)
$(printf '%b' "$MEMORY_PREVIEW")

---
*Source: \`shared/daily-brief/retro-$DATE.md\`*
EOMD

echo "[daily-retro] Wrote retro to $OUTPUT"

# ---------------------------------------------------------------------------
# 6. Enrich vault daily note — append retrospective section if not already present
# ---------------------------------------------------------------------------
if [ -f "$VAULT_FILE" ]; then
  # Check if retro section already exists
  if grep -q "## Retrospective" "$VAULT_FILE" 2>/dev/null; then
    echo "[daily-retro] Vault note already has Retrospective section — skipping append"
  else
    # Append to existing daily note
    cat >> "$VAULT_FILE" << EOAPPEND

---

## Retrospective

### Shipped / Deployed
${SHIPPED}

### Tasks Completed
${TASKS_DONE}

### Paperclip Done Today
${PC_DONE}

### Decisions
${DECISIONS}

### Learned / Corrections
${LEARNED}

### Git Activity
${GIT_LOG}

---
*Appended by daily-retrospective.sh at $(date "+%H:%M")*
EOAPPEND
    echo "[daily-retro] Appended retro section to vault note: $VAULT_FILE"
  fi
else
  # Vault note doesn't exist yet — write standalone note
  cat > "$VAULT_FILE" << EOVAULT
---
date: $DATE
tags: [daily, retrospective]
---

# $DATE ($DOW)

## Retrospective

### Shipped / Deployed
${SHIPPED}

### Tasks Completed
${TASKS_DONE}

### Paperclip Done Today
${PC_DONE}

### Decisions
${DECISIONS}

### Learned / Corrections
${LEARNED}

### Git Activity
${GIT_LOG}

---
*Generated by daily-retrospective.sh at $(date "+%H:%M")*
EOVAULT
  echo "[daily-retro] Created new vault note: $VAULT_FILE"
fi

echo "[daily-retro] Done. Files:"
echo "  Source of truth: $OUTPUT"
echo "  Vault:           $VAULT_FILE"
