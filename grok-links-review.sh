#!/usr/bin/env bash
# grok-links-review — single-URL review via Hermes-Grok-Reviewer profile.
# Per Constitution Rule 2: ALL Grok inference via Hermes OAuth (no xAI API key).
#
# Usage:
#   bash scripts/grok-links-review.sh <url>           # stdout: JSON decision
#   bash scripts/grok-links-review.sh <url> --quiet   # writes to review-log only
#
# Output JSON shape (single line):
#   {"ts": "...", "url": "...", "score": 73, "routing": "real-time",
#    "title": "...", "sentiment": "positive", "tags": [...], "reasoning": "..."}
#
# Routing logic:
#   score <30  → SILENT (archive only)
#   score 30-70 → DIGEST (batched)
#   score >70  → REAL-TIME (post to #links-intake immediately)

set -uo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <url> [--quiet]" >&2
  exit 2
fi

URL="$1"
QUIET=0
[[ "${2:-}" == "--quiet" ]] && QUIET=1

REVIEW_LOG="${HOME}/clawd/output/links/_review-log.jsonl"
ARCHIVE_DIR="${HOME}/clawd/output/links"
REJECT_DIR="${HOME}/clawd/output/links/_rejected"
mkdir -p "$ARCHIVE_DIR" "$REJECT_DIR" "$(dirname "$REVIEW_LOG")"

# Dedup check — already in log?
if [[ -f "$REVIEW_LOG" ]]; then
  EXISTING=$(grep -F "\"url\": \"$URL\"" "$REVIEW_LOG" 2>/dev/null | tail -1)
  if [[ -n "$EXISTING" ]]; then
    [[ "$QUIET" -eq 0 ]] && echo "$EXISTING"
    exit 0
  fi
fi

# ─── Optional cheap pre-filter via Gemini Flash (OAuth = free) ────
# Skip obvious spam/dead URLs before hitting SuperGrok quota.
# Set SKIP_GEMINI_PREFILTER=1 to bypass.
if [[ "${SKIP_GEMINI_PREFILTER:-0}" -eq 0 ]] && [[ -x "${HOME}/clawd/scripts/gemini-cli.sh" ]]; then
  PREFILTER=$(bash "${HOME}/clawd/scripts/gemini-cli.sh" \
    --model gemini-2.5-flash \
    --prompt "Quick triage for URL '$URL'. Output a single word: SKIP if it's obviously spam/dead/paywall-stub, OR REVIEW if worth Grok review. Reply with only SKIP or REVIEW." 2>/dev/null | tr -d '[:space:]' | head -c 10)

  if [[ "$PREFILTER" == "SKIP" ]]; then
    SKIP_DECISION="{\"ts\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"url\": \"$URL\", \"score\": 0, \"routing\": \"silent\", \"title\": \"PREFILTER_SKIP\", \"sentiment\": \"neutral\", \"tags\": [\"prefilter\"], \"reasoning\": \"gemini-flash flagged as spam/dead/paywall — skipped Grok review\"}"
    echo "$SKIP_DECISION" >> "$REVIEW_LOG"
    [[ "$QUIET" -eq 0 ]] && echo "$SKIP_DECISION"
    exit 0
  fi
fi

# Hermes-Grok-Reviewer prompt
PROMPT="Review this URL and respond ONLY with valid JSONL on a single line (no prose, no markdown):

URL: $URL

Use the scoring rubric in your SOUL.md. Output schema:
{\"ts\": \"<ISO>\", \"url\": \"$URL\", \"score\": <0-100>, \"routing\": \"silent|digest|real-time\", \"title\": \"...\", \"sentiment\": \"positive|critical|neutral\", \"tags\": [...], \"reasoning\": \"<one line>\"}

If the URL is unreachable, paywalled, or spam: set score to 0 and routing to 'silent'."

# Invoke Hermes-Grok-Reviewer
# Explicit model: xai/grok-4.3 (1M context, via xai-oauth SuperGrok subscription — Constitution Rule 2)
RESPONSE=$(hermes -p grok-reviewer -m "xai/grok-4.3" --provider xai-oauth -z "$PROMPT" 2>&1 | tail -3 | grep -E '^\s*\{' | head -1)

if [[ -z "$RESPONSE" ]]; then
  # Fallback: score 0, log failure
  RESPONSE="{\"ts\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"url\": \"$URL\", \"score\": 0, \"routing\": \"silent\", \"title\": \"REVIEW_FAILED\", \"sentiment\": \"neutral\", \"tags\": [\"error\"], \"reasoning\": \"hermes-grok-reviewer returned no JSON\"}"
fi

# Append to review log (audit trail)
echo "$RESPONSE" >> "$REVIEW_LOG"

# Parse routing decision
ROUTING=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('routing','silent'))" 2>/dev/null || echo "silent")
SCORE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('score',0))" 2>/dev/null || echo 0)

# Save page locally based on routing
SLUG=$(echo "$URL" | sed -E 's|https?://||; s|[^a-zA-Z0-9]|-|g' | cut -c1-80)
DATE=$(date +%Y-%m-%d)
case "$ROUTING" in
  real-time|digest)
    # Save to archive
    OUT="$ARCHIVE_DIR/$DATE-$SLUG.md"
    {
      printf -- '---\n'
      printf -- 'url: %s\n' "$URL"
      printf -- 'score: %s\n' "$SCORE"
      printf -- 'routing: %s\n' "$ROUTING"
      printf -- 'reviewed_at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf -- 'reviewer: hermes-grok-reviewer\n'
      printf -- '---\n\n'
      printf '%s\n' "$RESPONSE"
    } > "$OUT"
    ;;
  silent|*)
    # Save to rejected
    OUT="$REJECT_DIR/$DATE-$SLUG.md"
    {
      printf -- '---\n'
      printf -- 'url: %s\n' "$URL"
      printf -- 'score: %s\n' "$SCORE"
      printf -- 'routing: %s\n' "$ROUTING"
      printf -- '---\n\n'
      printf '%s\n' "$RESPONSE"
    } > "$OUT"
    ;;
esac

# Output decision
[[ "$QUIET" -eq 0 ]] && echo "$RESPONSE"
exit 0
