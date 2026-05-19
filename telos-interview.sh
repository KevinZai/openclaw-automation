#!/usr/bin/env bash
# telos-interview.sh — Interactive TELOS.md filler for Nexus activation
#
# Usage: bash ~/clawd/scripts/telos-interview.sh
# Time:  ~20 min
# Owner: Kevin (sole edit rights on TELOS.md)
#
# Asks 7 questions, validates each section has real content (not just placeholder
# comments), and writes the result into ~/clawd/workspaces/main/TELOS.md in place
# (with a timestamped backup).
#
# Last updated: 2026-05-14

set -euo pipefail

TELOS="$HOME/clawd/workspaces/main/TELOS.md"
BACKUP_DIR="$HOME/clawd/workspaces/main/archive"
TS="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -t telos-interview-XXXXXX)"

if [[ ! -f "$TELOS" ]]; then
  echo "ERROR: $TELOS does not exist. Aborting." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
cp "$TELOS" "$BACKUP_DIR/TELOS.md.backup-$TS"
echo "✓ Backup written: $BACKUP_DIR/TELOS.md.backup-$TS"
echo

cat <<'BANNER'
================================================================
  TELOS Interview — Nexus activation prereq
================================================================
You'll answer 7 questions. Each one fills a section in
~/clawd/workspaces/main/TELOS.md, which Nexus loads at every
session to know what to optimize against.

Tips:
  - Multi-line answers: end with a single line containing END
  - Be specific. Vague TELOS = Nexus nudges feel generic.
  - You can always re-run this script later.
================================================================
BANNER
echo

read_block() {
  local prompt="$1"
  local block=""
  echo
  echo "─── $prompt ───"
  echo "(Type your answer. End with a single line: END)"
  while IFS= read -r line; do
    [[ "$line" == "END" ]] && break
    block+="$line"$'\n'
  done
  echo "$block"
}

validate_nonempty() {
  local content="$1"
  local label="$2"
  # Strip whitespace; reject if it's empty OR just the placeholder comment
  local stripped
  stripped="$(echo "$content" | tr -d '[:space:]')"
  if [[ -z "$stripped" ]] || [[ "$content" == *"<!-- KEVIN: fill in -->"* ]]; then
    echo "ERROR: section '$label' is empty or still contains placeholder. Aborting." >&2
    echo "       Re-run and provide real content. Backup preserved." >&2
    rm -f "$TMP"
    exit 2
  fi
}

# ─── Q1: Mission ─────────────────────────────────────────────
Q1=$(read_block "Q1. MISSION — One paragraph. Why are you doing all of this?")
validate_nonempty "$Q1" "Mission"

# ─── Q2: 12-month goals ──────────────────────────────────────
Q2=$(read_block "Q2. 12-MONTH GOALS — 3-5 bullets, concrete enough to measure")
validate_nonempty "$Q2" "12-Month Goals"

# ─── Q3: Values / Non-negotiables ────────────────────────────
Q3=$(read_block "Q3. VALUES / NON-NEGOTIABLES — Things that override goals")
validate_nonempty "$Q3" "Values"

# ─── Q4: Current Focus Areas ─────────────────────────────────
Q4=$(read_block "Q4. CURRENT FOCUS AREAS (this quarter) — 2-3 things actively pushing")
validate_nonempty "$Q4" "Current Focus"

# ─── Q5: Anti-goals ──────────────────────────────────────────
Q5=$(read_block "Q5. ANTI-GOALS — Explicit list of things NOT trying to do")
validate_nonempty "$Q5" "Anti-Goals"

# ─── Q6: Decision heuristics ─────────────────────────────────
Q6=$(read_block "Q6. DECISION HEURISTICS — Pre-committed rules for common choices")
validate_nonempty "$Q6" "Decision Heuristics"

# ─── Q7: Nexus operating notes ───────────────────────────────
Q7=$(read_block "Q7. NEXUS OPERATING NOTES — How should Nexus interpret this TELOS?")
validate_nonempty "$Q7" "Nexus Operating Notes"

# ─── Write new TELOS ─────────────────────────────────────────
TODAY="$(date +%Y-%m-%d)"

cat > "$TMP" <<EOF
# TELOS.md — Kevin's Canonical Goal Document

**Status:** ACTIVE — filled $TODAY via telos-interview.sh
**Authoritative path:** \`~/clawd/workspaces/main/TELOS.md\`
**Owner:** Kevin (sole edit rights). Morpheus may propose edits via \`[TELOS-DRAFT]\` tagged memos; Nexus may suggest revisions at the Sunday retro.
**Last refresh:** $TODAY

> **PAI principle:** *"Without TELOS, your DA has nothing to optimize against."*
> This file is what makes Nexus more than a logger.

---

## 1. Mission

$Q1
---

## 2. 12-Month Goals

$Q2
---

## 3. Values / Non-Negotiables

$Q3
---

## 4. Current Focus Areas

$Q4
**Refresh cadence:** every quarter (Mar 31, Jun 30, Sep 30, Dec 31). Nexus prompts a refresh in the Sunday retro before each quarter rolls.

---

## 5. Anti-Goals

$Q5
---

## 6. Decision Heuristics

$Q6
---

## 7. Nexus Operating Notes

$Q7
---

## Changelog

| Date | Edit | Author |
|------|------|--------|
| 2026-05-14 | Initial skeleton scaffold | Nexus rollout (Opus 4.7) |
| $TODAY | Filled via telos-interview.sh | Kevin |

---

**This document is canonical. When in doubt about priority, Nexus reads here first.**
EOF

# Sanity check: file is non-trivial size
SIZE="$(wc -c < "$TMP")"
if (( SIZE < 600 )); then
  echo "ERROR: generated TELOS is suspiciously small ($SIZE bytes). Aborting." >&2
  rm -f "$TMP"
  exit 3
fi

mv "$TMP" "$TELOS"

echo
echo "================================================================"
echo "  ✓ TELOS.md written — $(wc -l < "$TELOS") lines"
echo "  ✓ Backup at:        $BACKUP_DIR/TELOS.md.backup-$TS"
echo "================================================================"
echo
echo "Next steps:"
echo "  1. Review:  less $TELOS"
echo "  2. Edit:    \$EDITOR $TELOS  (anytime)"
echo "  3. Activate Nexus: see ~/clawd/output/dev/audit-deep-2026-05-14/NEXUS-DEPLOY-READY.md"
echo
