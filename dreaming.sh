#!/bin/bash
# Part of openclaw-automation — https://github.com/KevinZai/openclaw-automation
# dreaming.sh — Nightly memory consolidation across the full OpenClaw stack
# Queries ALL memory systems: claude-mem, LCM, QMD, MemPalace
# Generates a unified digest of the past 24 hours.
#
# Output:  ~/clawd/output/dev/dreaming/YYYY-MM-DD.md
# Log:     ~/clawd/logs/dreaming.log
# Runtime: <30s typical (pure HTTP + SQL + CLI, no AI calls)

set -euo pipefail

DATE="${1:-$(date +%Y-%m-%d)}"
CLAWD="$HOME/clawd"
OUT_DIR="$CLAWD/output/dev/dreaming"
OUT_FILE="$OUT_DIR/${DATE}.md"
LCM_DB="$HOME/.openclaw/lcm.db"
CLAUDE_MEM_URL="http://127.0.0.1:37777"
LOG_TAG="[dreaming ${DATE}]"

mkdir -p "$OUT_DIR"

# Track which sections ran vs skipped (for final summary)
SECTIONS_RAN=()
SECTIONS_SKIPPED=()

echo "$LOG_TAG START $(date '+%H:%M:%S')"

# ---------------------------------------------------------------------------
# Temp file setup — all temps cleaned up at EXIT via trap (after Obsidian sync)
# ---------------------------------------------------------------------------
CMEM_TMP=$(mktemp)
LCM_TMP=$(mktemp)
QMD_TMP=$(mktemp)
MEMPALACE_TMP=$(mktemp)

# Trap fires at script exit — AFTER the Obsidian sync section reads $CMEM_TMP
trap 'rm -f "$CMEM_TMP" "$LCM_TMP" "$QMD_TMP" "$MEMPALACE_TMP"' EXIT

# ---------------------------------------------------------------------------
# 1. Claude-Mem: cross-session observations (24h)
# ---------------------------------------------------------------------------
CMEM_OK=false
if curl -sf "${CLAUDE_MEM_URL}/health" > /dev/null 2>&1; then
  CMEM_OK=true
  echo "$LOG_TAG claude-mem reachable"
  python3 << 'PYEOF' > "$CMEM_TMP"
import urllib.request, json, time, sys

BASE = "http://127.0.0.1:37777"
SINCE_MS = int(time.time() * 1000) - (24 * 3600 * 1000)
all_items, offset, limit, pages = [], 0, 100, 0

while pages < 20:
    url = f"{BASE}/api/observations?limit={limit}&offset={offset}"
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.load(r)
    except Exception:
        break
    items = data.get("items", [])
    recent = [i for i in items if i.get("created_at_epoch", 0) >= SINCE_MS]
    all_items.extend(recent)
    if not data.get("hasMore", False) or (items and items[-1].get("created_at_epoch", 0) < SINCE_MS):
        break
    offset += limit
    pages += 1

json.dump({"items": all_items, "total": len(all_items)}, sys.stdout)
PYEOF
  SECTIONS_RAN+=("claude-mem")
else
  echo "$LOG_TAG claude-mem unreachable — skipping" >&2
  echo '{"items":[],"total":0}' > "$CMEM_TMP"
  SECTIONS_SKIPPED+=("claude-mem")
fi

# ---------------------------------------------------------------------------
# 2. LCM: recent agent conversations (24h)
# ---------------------------------------------------------------------------
if [ -f "$LCM_DB" ]; then
  echo "$LOG_TAG LCM database found"
  sqlite3 "$LCM_DB" << 'SQL' > "$LCM_TMP"
SELECT json_group_array(json_object(
  'session_key', c.session_key,
  'title', c.title,
  'created_at', c.created_at,
  'message_count', (SELECT count(*) FROM messages m WHERE m.conversation_id = c.conversation_id),
  'summary_count', (SELECT count(*) FROM summaries s WHERE s.conversation_id = c.conversation_id),
  'total_tokens', (SELECT coalesce(sum(m2.token_count),0) FROM messages m2 WHERE m2.conversation_id = c.conversation_id)
))
FROM conversations c
WHERE c.created_at > datetime('now', '-1 day')
ORDER BY c.created_at DESC;
SQL
  SECTIONS_RAN+=("LCM")
else
  echo "$LOG_TAG LCM database not found — skipping" >&2
  echo '[]' > "$LCM_TMP"
  SECTIONS_SKIPPED+=("LCM")
fi

# ---------------------------------------------------------------------------
# 3. QMD: recently indexed knowledge
# ---------------------------------------------------------------------------
if command -v qmd >/dev/null 2>&1; then
  echo "$LOG_TAG QMD available"
  qmd status 2>/dev/null > "$QMD_TMP" || echo "QMD status unavailable" > "$QMD_TMP"
  SECTIONS_RAN+=("QMD")
else
  echo "$LOG_TAG QMD not found — skipping" >&2
  echo "QMD not installed" > "$QMD_TMP"
  SECTIONS_SKIPPED+=("QMD")
fi

# ---------------------------------------------------------------------------
# 4. MemPalace: drawer status
# ---------------------------------------------------------------------------
if command -v mempalace >/dev/null 2>&1; then
  echo "$LOG_TAG MemPalace available"
  mempalace status 2>/dev/null > "$MEMPALACE_TMP" || echo "MemPalace status unavailable" > "$MEMPALACE_TMP"
  SECTIONS_RAN+=("MemPalace")
else
  echo "$LOG_TAG MemPalace not found — skipping" >&2
  echo "MemPalace not installed" > "$MEMPALACE_TMP"
  SECTIONS_SKIPPED+=("MemPalace")
fi

# ---------------------------------------------------------------------------
# 5. Git activity for the date
# ---------------------------------------------------------------------------
GIT_LOG=$(cd "$CLAWD" && git log \
  --oneline \
  --after="${DATE}T00:00:00" \
  --before="${DATE}T23:59:59" \
  2>/dev/null | head -20 || echo "No commits")
[ -z "$GIT_LOG" ] && GIT_LOG="No commits"

# ---------------------------------------------------------------------------
# 6. Build unified digest
# ---------------------------------------------------------------------------
DIGEST=$(python3 << PYEOF
import json, sys
from collections import defaultdict

# --- Load all sources ---
with open("${CMEM_TMP}") as f:
    cmem = json.load(f)

with open("${LCM_TMP}") as f:
    lcm_raw = f.read().strip()
    lcm_convos = json.loads(lcm_raw) if lcm_raw and lcm_raw != "[]" else []

with open("${QMD_TMP}") as f:
    qmd_status = f.read().strip()

with open("${MEMPALACE_TMP}") as f:
    mempalace_status = f.read().strip()

lines = []

# ===================== SYSTEM PULSE =====================
lines.append("## System Pulse")
lines.append("")

# Memory systems status
systems = []
if cmem.get("total", 0) > 0 or ${CMEM_OK:+True} or False:
    systems.append(f"claude-mem: {cmem.get('total', 0)} observations (24h)")
else:
    systems.append("claude-mem: OFFLINE")

if lcm_convos:
    total_tokens = sum(c.get("total_tokens", 0) for c in lcm_convos)
    systems.append(f"LCM: {len(lcm_convos)} conversations, {total_tokens:,} tokens (24h)")
else:
    systems.append("LCM: no recent conversations")

# Parse QMD collection count
qmd_files = 0
for line in qmd_status.split("\n"):
    if "files indexed" in line.lower():
        try:
            qmd_files = int(line.strip().split()[0].replace(",",""))
        except Exception:
            pass
systems.append(f"QMD: {qmd_files} files indexed" if qmd_files else "QMD: status unknown")

# Parse MemPalace drawer count
mp_drawers = 0
for line in mempalace_status.split("\n"):
    if "drawers" in line.lower() and "total" in line.lower():
        try:
            mp_drawers = int(''.join(c for c in line.split(":")[-1] if c.isdigit()))
        except Exception:
            pass
    elif "drawers" in line.lower():
        try:
            mp_drawers = int(''.join(c for c in line.split(":")[0].split()[-1] if c.isdigit()))
        except Exception:
            pass
systems.append(f"MemPalace: {mp_drawers} drawers" if mp_drawers else "MemPalace: status parsed")

for s in systems:
    lines.append(f"- {s}")
lines.append("")

# ===================== LCM: AGENT CONVERSATIONS =====================
if lcm_convos:
    lines.append("## Agent Conversations (LCM)")
    lines.append("")
    lines.append("| Session Key | Messages | Tokens | Time |")
    lines.append("|-------------|----------|--------|------|")
    for c in lcm_convos:
        sk = c.get("session_key", "?")
        # Extract agent name from session key (agent:NAME:...)
        parts = sk.split(":")
        agent = parts[1] if len(parts) > 1 else sk
        ctx = parts[2] if len(parts) > 2 else ""
        label = f"{agent}/{ctx}" if ctx else agent
        msgs = c.get("message_count", 0)
        tokens = c.get("total_tokens", 0)
        ts = (c.get("created_at") or "")[:16].replace("T", " ")
        lines.append(f"| {label[:35]} | {msgs} | {tokens:,} | {ts} |")
    lines.append("")

# ===================== CLAUDE-MEM: OBSERVATIONS =====================
items = cmem.get("items", [])
if items:
    populated = [i for i in items if i.get("title") or i.get("narrative") or i.get("facts")]
    bare = [i for i in items if not (i.get("title") or i.get("narrative") or i.get("facts"))]

    # Type distribution
    type_counts = defaultdict(int)
    for obs in populated:
        type_counts[obs.get("type") or "unknown"] += 1

    lines.append("## Observations (claude-mem)")
    lines.append("")
    lines.append(f"- **Total:** {len(items)} | **With content:** {len(populated)} | **Bare:** {len(bare)}")
    lines.append(f"- **Types:** {', '.join(f'{t}:{c}' for t,c in sorted(type_counts.items(), key=lambda x: -x[1]))}")
    lines.append("")

    # Concept analysis
    concept_counts = defaultdict(int)
    for obs in populated:
        try:
            concepts = json.loads(obs.get("concepts") or "[]")
            for c in concepts:
                concept_counts[c] += 1
        except Exception:
            pass

    if concept_counts:
        lines.append("### Top Concepts")
        for concept, count in sorted(concept_counts.items(), key=lambda x: -x[1])[:10]:
            lines.append(f"- \`{concept}\`: {count}x")
        lines.append("")

    # Per-project breakdown
    by_project = defaultdict(list)
    for obs in populated:
        by_project[obs.get("project") or "General"].append(obs)

    lines.append("### By Project")
    lines.append("")
    for project in sorted(by_project.keys()):
        obs_list = by_project[project]
        lines.append(f"**{project}** ({len(obs_list)})")
        for obs in obs_list[:10]:
            title = obs.get("title") or obs.get("subtitle") or "(untitled)"
            otype = obs.get("type") or "?"
            lines.append(f"- [{otype}] {title[:100]}")
        if len(obs_list) > 10:
            lines.append(f"  _(+{len(obs_list)-10} more)_")
        lines.append("")

    # Lessons highlight
    lessons = [i for i in populated if i.get("type") in ("bugfix", "correction", "lesson")]
    if lessons:
        lines.append("### Lessons & Corrections")
        for obs in lessons[:10]:
            title = obs.get("title") or obs.get("subtitle") or "(untitled)"
            project = obs.get("project") or "General"
            lines.append(f"- **[{project}]** {title[:120]}")
        lines.append("")

    # Prunable entries
    if bare:
        lines.append(f"### Prunable ({len(bare)} bare observations)")
        ids = [str(i.get("id")) for i in bare[:30]]
        lines.append(f"IDs: {', '.join(ids)}")
        if len(bare) > 30:
            lines.append(f"_(+{len(bare)-30} more)_")
        lines.append("")
else:
    lines.append("## Observations (claude-mem)")
    lines.append("No observations in the last 24 hours.")
    lines.append("")

# ===================== QMD INDEX STATUS =====================
lines.append("## Knowledge Index (QMD)")
lines.append("")
lines.append("\`\`\`")
# Just the key stats, not the full dump
for line in qmd_status.split("\n"):
    stripped = line.strip()
    if any(kw in stripped.lower() for kw in ["total:", "vectors:", "pending:", "updated:", "files:", "size:", "collections"]):
        lines.append(stripped)
        if "files indexed" in stripped.lower():
            try:
                qmd_files = int(stripped.split()[0].replace(",",""))
            except Exception:
                pass
lines.append("\`\`\`")
lines.append("")

# ===================== MEMPALACE STATUS =====================
lines.append("## Structured Memory (MemPalace)")
lines.append("")
lines.append("\`\`\`")
for line in mempalace_status.split("\n"):
    stripped = line.strip()
    if stripped:
        lines.append(stripped)
lines.append("\`\`\`")
lines.append("")

print("\n".join(lines))
PYEOF
)

# ---------------------------------------------------------------------------
# 7. Write the digest
# ---------------------------------------------------------------------------
cat > "$OUT_FILE" << EOMD
---
date: ${DATE}
type: dreaming-digest
generated: $(date '+%Y-%m-%dT%H:%M:%S')
sources:
  - claude-mem @ ${CLAUDE_MEM_URL}
  - LCM @ ${LCM_DB}
  - QMD (indexed knowledge)
  - MemPalace (structured memory)
---

# Dreaming Digest — ${DATE}

> Nightly memory consolidation across the full OpenClaw memory stack.
> Generated at $(date '+%H:%M') by \`dreaming.sh\`.

${DIGEST}

## Git Activity — ${DATE}

\`\`\`
${GIT_LOG}
\`\`\`

---
*Digest saved to: \`output/dev/dreaming/${DATE}.md\`*
EOMD

# ---------------------------------------------------------------------------
# 8. Sync digest summary to Obsidian vault daily note
# ---------------------------------------------------------------------------
# NOTE: $CMEM_TMP is still alive here — trap cleanup happens at EXIT, after this section.
VAULT_DIR="${OBSIDIAN_VAULT_DIR:-$HOME/Library/Mobile Documents/iCloud~md~obsidian/vault}"
VAULT_DAILY="$VAULT_DIR/01-Daily/${DATE}.md"

if [ -d "$VAULT_DIR" ]; then
  # Append dreaming summary to the daily note (create if missing)
  if [ ! -f "$VAULT_DAILY" ]; then
    cat > "$VAULT_DAILY" << VAULT_HEADER
# ${DATE}

## Dreaming Digest
VAULT_HEADER
  fi

  # Append a compact summary (not the full report — avoid bloat)
  # Use unquoted heredoc so $CMEM_TMP is expanded — Python opens the file directly
  COMPACT=$(python3 << PYCOMPACT 2>/dev/null || echo "- Summary unavailable"
import json, sys

try:
    with open("${CMEM_TMP}") as f:
        cmem = json.load(f)
    items = cmem.get("items", [])
    total = len(items)

    # Type counts
    from collections import Counter
    types = Counter(i.get("type","?") for i in items if i.get("title"))
    type_str = ", ".join(f"{t}:{c}" for t,c in types.most_common(5))

    # Top projects
    projects = Counter(i.get("project","General") for i in items if i.get("title"))
    proj_str = ", ".join(f"{p} ({c})" for p,c in projects.most_common(5))

    print(f"- **Observations:** {total}")
    print(f"- **Types:** {type_str}")
    print(f"- **Projects:** {proj_str}")
except Exception as e:
    sys.stderr.write(f"compact summary error: {e}\n")
    print("- Dreaming data unavailable")
PYCOMPACT
  )

  # Check if dreaming section already exists
  if ! grep -q "## Dreaming Digest" "$VAULT_DAILY" 2>/dev/null; then
    cat >> "$VAULT_DAILY" << VAULT_APPEND

## Dreaming Digest
${COMPACT}
- **Full report:** [[output/dev/dreaming/${DATE}]]
VAULT_APPEND
    echo "$LOG_TAG Synced to Obsidian daily note"
  else
    echo "$LOG_TAG Obsidian daily note already has dreaming section"
  fi
else
  echo "$LOG_TAG Obsidian vault not found — skipping sync"
fi

# ---------------------------------------------------------------------------
# 9. Final run summary (exit 0 on partial success)
# ---------------------------------------------------------------------------
echo "$LOG_TAG Wrote digest to $OUT_FILE"

if [ ${#SECTIONS_RAN[@]} -gt 0 ]; then
  echo "$LOG_TAG Sections ran: $(IFS=', '; echo "${SECTIONS_RAN[*]}")"
fi
if [ ${#SECTIONS_SKIPPED[@]} -gt 0 ]; then
  echo "$LOG_TAG Sections skipped: $(IFS=', '; echo "${SECTIONS_SKIPPED[*]}")"
fi

echo "$LOG_TAG DONE $(date '+%H:%M:%S')"
# Temp files cleaned by EXIT trap (above)
