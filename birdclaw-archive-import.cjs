#!/usr/bin/env node
/**
 * birdclaw-archive-import.cjs — STUB (not implemented)
 *
 * Purpose: backfill bookmarks older than `bird` GraphQL's ~800-row pagination
 * ceiling by importing from a Twitter/X data archive ZIP.
 *
 * Why this exists:
 *   The recurring birdclaw sync (LaunchAgent every 3h) only sees the most
 *   recent ~800 bookmarks per account. Anything older is invisible to `bird`.
 *   The only path to recover historical bookmarks is the official X data
 *   archive: https://x.com/settings/your_twitter_data (request → 24h wait → ZIP).
 *
 * Invocation (target API once implemented):
 *   node ~/clawd/scripts/birdclaw-archive-import.cjs \
 *     --account acct_kryptokwant \
 *     --archive ~/.birdclaw/archives/kryptokwant/twitter-archive.zip
 *
 * X Archive ZIP format (as of 2024–2026, subject to change):
 *   - data/like.js           → likes (function-wrapped JSON: `window.YTD.like.part0 = [...]`)
 *   - data/bookmark.js       → bookmarks (when included — X has been inconsistent
 *                              about including this; sometimes only via separate request)
 *   - data/tweets.js         → user's own tweets (NOT what we want for bookmarks)
 *   - data/account.js        → account metadata (handle, user id, created date)
 *   - tweet_media/*          → embedded media files (optional copy to ~/.birdclaw/media/)
 *
 * TODO (implementation outline):
 *   1. argv parse: --account <id> (required), --archive <path> (required), --dry-run
 *   2. Validate account_id exists in `accounts` table — fail fast if not
 *   3. Unzip archive to temp dir (e.g. /tmp/birdclaw-archive-<account>-<ts>/)
 *   4. Read data/bookmark.js — strip the `window.YTD.bookmark.part0 = ` prefix,
 *      parse remainder as JSON array
 *   5. For each bookmark entry, transform to birdclaw schema:
 *        - tweet_id          → entry.bookmark.tweetId
 *        - kind              → 'bookmarks'
 *        - account_id        → from --account flag
 *        - collected_at      → datetime('now')      (we don't have original bookmark time)
 *        - raw_json          → JSON.stringify(entry)
 *   6. INSERT OR IGNORE into tweet_collections (dedup on (account_id, tweet_id, kind))
 *   7. Resolve missing tweet content: for any tweet_id not in `tweets` table,
 *      either (a) call `bird` to fetch (limited to ~800 most recent — may miss old)
 *      OR (b) leave content stub; downstream Raindrop bridge will still create a
 *      bookmark with the canonical x.com URL even if text is blank
 *   8. Print summary: { imported, skipped_duplicate, content_missing, errors }
 *   9. Optionally trigger raindrop-sync watermark reset so all imported rows
 *      flow through to Raindrop (carefully — could mean 10K POSTs)
 *
 * Edge cases to handle:
 *   - Archive missing bookmark.js entirely (X sometimes omits — error gracefully)
 *   - Function-wrapper format change (`window.YTD.bookmark.part0 = ` → something new)
 *   - Bookmark count >> Raindrop bulk-insert rate limits (chunk + sleep)
 *   - Tweet ID belongs to a deleted/suspended account (URL 404 — accept silently)
 *
 * Out of scope for now:
 *   - Likes import (would use data/like.js, same pattern)
 *   - Lists import
 *   - DM/conversation import
 */

console.error('birdclaw-archive-import.cjs: NOT YET IMPLEMENTED');
console.error('See header comments for design. Implement when Kevin needs historical backfill.');
process.exit(2);
