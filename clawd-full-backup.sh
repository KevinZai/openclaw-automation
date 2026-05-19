#!/usr/bin/env bash

# --- external-drive availability guard (added 2026-04-24) ---
# ~/clawd/backups is a symlink to /Volumes/Extreme Pro/backups.
# Fail fast if the external drive is unmounted instead of silently
# creating a bogus local .tar.gz where the mount point should be.
BACKUP_TARGET="$HOME/clawd/backups"
REAL_TARGET="$(readlink -f "$BACKUP_TARGET" 2>/dev/null || echo "$BACKUP_TARGET")"
if [[ "$REAL_TARGET" == /Volumes/* ]]; then
    VOLUME_ROOT="$(echo "$REAL_TARGET" | awk -F/ '{print "/"$2"/"$3}')"
    if [ ! -d "$VOLUME_ROOT" ] || [ ! -w "$BACKUP_TARGET" ]; then
        echo "ERROR: backup target external drive unavailable: $VOLUME_ROOT" >&2
        echo "       symlinked from $BACKUP_TARGET" >&2
        exit 1
    fi
fi
# --- end guard ---

# workspace-backup.sh — Daily backup of ~/clawd, keep last 7
# Replaces LLM cron — zero AI cost
#
# Note on git data: the main tarball excludes `.git/` to keep size down
# (vendor submodules + per-repo .git dirs would balloon size by ~10x).
# To preserve stashes + local-only branches, a companion archive
# `clawd-git-refs-YYYY-MM-DD.tar.gz` is produced via per-repo
# `git bundle create --all`. This was added 2026-05-15 after the
# cc-commander deletion incident exposed silent stash loss in backups.

set -euo pipefail

BACKUP_DIR="/Volumes/Extreme Pro/clawd-live/backups"
# Fallback to local if External HD not mounted
if [[ ! -d "/Volumes/Extreme Pro/clawd-live" ]]; then
  BACKUP_DIR="/Users/ai/clawd/backups"
fi
SOURCE="/Users/ai/clawd"
DATE=$(date +%Y-%m-%d)
OUT="$BACKUP_DIR/clawd-$DATE.tar.gz"
REFS_OUT="$BACKUP_DIR/clawd-git-refs-$DATE.tar.gz"

mkdir -p "$BACKUP_DIR"

tar -czf "$OUT" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.venv' \
  --exclude='__pycache__' \
  --exclude='dist' \
  --exclude='build' \
  --exclude='.next' \
  --exclude='*.tar.gz' \
  --exclude='backups' \
  --exclude='webclaw' \
  --exclude='caddy/data' \
  "$SOURCE" 2>/dev/null || true

SIZE=$(du -sh "$OUT" | cut -f1)

# --- git refs preservation (added 2026-05-15) ---
# For every git repo under ~/clawd, run `git bundle create --all`
# so stashes, local-only branches, and tags survive a restore.
# The main tarball excludes `.git/` for size — bundles are the safety net.
STAGE="$(mktemp -d -t clawd-git-refs-XXXXXX)"
REPO_COUNT=0
STASH_REPO_COUNT=0
TOTAL_STASHES=0

while IFS= read -r -d '' gitdir; do
  repo="$(dirname "$gitdir")"
  rel="${repo#$SOURCE/}"
  # Skip vendor submodules (tracked upstream — local commits unlikely)
  case "$rel" in
    vendor|vendor/*|*/vendor/*) continue ;;
    *node_modules*|*.venv*|*__pycache__*) continue ;;
  esac

  # Bundle requires at least one ref. `git bundle create --all`
  # silently produces empty bundle on a fresh repo with no commits.
  if ! ( cd "$repo" && git rev-parse --verify HEAD >/dev/null 2>&1 ); then
    continue
  fi

  bundle_rel="${rel:-_root}"
  bundle_path="$STAGE/${bundle_rel//\//__}.bundle"
  if ( cd "$repo" && git bundle create "$bundle_path" --all 2>/dev/null ); then
    REPO_COUNT=$((REPO_COUNT + 1))
    n=$( cd "$repo" && git stash list 2>/dev/null | wc -l | tr -d ' ' )
    if [ "$n" -gt 0 ]; then
      STASH_REPO_COUNT=$((STASH_REPO_COUNT + 1))
      TOTAL_STASHES=$((TOTAL_STASHES + n))
    fi
  fi
done < <(find "$SOURCE" \
  -type d \( -name node_modules -o -name vendor -o -name .venv -o -name __pycache__ -o -name dist -o -name build -o -name .next \) -prune -o \
  -type d -name .git -print0 2>/dev/null)

# Pack the bundles
if [ "$REPO_COUNT" -gt 0 ]; then
  tar -czf "$REFS_OUT" -C "$STAGE" . 2>/dev/null || true
  REFS_SIZE=$(du -sh "$REFS_OUT" | cut -f1)
else
  REFS_SIZE="0B"
fi
rm -rf "$STAGE"
# --- end git refs preservation ---

# Keep only last 7 backups (both main + refs)
ls -t "$BACKUP_DIR"/clawd-[0-9]*.tar.gz 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null || true
ls -t "$BACKUP_DIR"/clawd-git-refs-*.tar.gz 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null || true
COUNT=$(ls "$BACKUP_DIR"/clawd-[0-9]*.tar.gz 2>/dev/null | wc -l | tr -d ' ')

# --- post-backup validation (added 2026-05-15) ---
# Fail loudly if the tarball is missing core data. Catches silent
# tar errors that the `2>/dev/null || true` upstream would otherwise hide.
fail() {
  echo "ERROR: backup validation FAILED — $1" >&2
  exit 1
}

# Sentinel: this file should always be present in a healthy ~/clawd backup.
SENTINEL="Users/ai/clawd/CLAUDE.md"
if ! tar -tzf "$OUT" "$SENTINEL" >/dev/null 2>&1; then
  fail "main tarball missing sentinel $SENTINEL"
fi

# If we found any git repos, the refs archive must exist and be non-trivial.
if [ "$REPO_COUNT" -gt 0 ]; then
  [ -f "$REFS_OUT" ] || fail "git-refs tarball missing despite $REPO_COUNT repos"
  # Spot-check: extract one bundle and verify it's a valid git bundle.
  PROBE="$(mktemp -d -t clawd-probe-XXXXXX)"
  tar -xzf "$REFS_OUT" -C "$PROBE" 2>/dev/null || fail "git-refs tarball failed to extract"
  FIRST_BUNDLE="$(find "$PROBE" -name '*.bundle' -type f | head -1)"
  [ -n "$FIRST_BUNDLE" ] || { rm -rf "$PROBE"; fail "no bundles in git-refs tarball"; }
  git bundle list-heads "$FIRST_BUNDLE" >/dev/null 2>&1 || { rm -rf "$PROBE"; fail "bundle $FIRST_BUNDLE is corrupt"; }
  rm -rf "$PROBE"
fi
# --- end validation ---

echo "$(date): backup $OUT ($SIZE) — $COUNT backups retained"
echo "$(date): git-refs $REFS_OUT ($REFS_SIZE) — $REPO_COUNT repos, $STASH_REPO_COUNT with stashes ($TOTAL_STASHES total)"
