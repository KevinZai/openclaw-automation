#!/usr/bin/env node
/**
 * birdclaw-raindrop-sync.cjs — Bridge birdclaw SQLite → Raindrop.io.
 *
 * Flow:
 *   birdclaw jobs sync-bookmarks  (LaunchAgent, every 3h)
 *     → bookmarks land in ~/.birdclaw/birdclaw.sqlite
 *     → THIS script reads new ones since last run
 *     → POST to Raindrop Unsorted collection (id=0)
 *     → existing ~/clawd/scripts/bookmark-poll.cjs (cron 10min)
 *       picks them up → isolated agentTurn to Athena
 *       → Discord forum thread in #bookmarks (1478076650888364093)
 *
 * Designed to be run AFTER birdclaw sync. Either chain via LaunchAgent
 * `--log` post-hook OR install as a separate cron 5 min after birdclaw runs.
 *
 * State: ~/clawd/scripts/.birdclaw-bridge-state.json (lastSeenId watermark)
 * Logs:  ~/clawd/logs/birdclaw-raindrop-sync.log
 *
 * Env required:
 *   RAINDROP_TEST_TOKEN  — from raindrop.io app settings (Kevin sets via 1Password)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const STATE_FILE = path.join(process.env.HOME, 'clawd/scripts/.birdclaw-bridge-state.json');
const LOG_FILE = path.join(process.env.HOME, 'clawd/logs/birdclaw-raindrop-sync.log');
const SQLITE_DB = path.join(process.env.HOME, '.birdclaw/birdclaw.sqlite');
const ACCOUNT_MAP_FILE = path.join(process.env.HOME, 'clawd/shared/refs/birdclaw-raindrop-map.json');
const TOKEN = process.env.RAINDROP_TEST_TOKEN;
const RAINDROP_API = 'api.raindrop.io';
const UNSORTED_COLLECTION = -1; // Raindrop unsorted id is -1

function loadAccountMap() {
  // Returns { [account_id]: { collectionId: number|null, ... } }
  // Missing file → defaults all accounts to Unsorted (legacy behavior).
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNT_MAP_FILE, 'utf8'));
    return raw.accounts || {};
  } catch {
    return {};
  }
}

function collectionFor(accountId, accountMap) {
  // null = explicit hold (skip push); undefined entry = fallback to Unsorted.
  if (!Object.prototype.hasOwnProperty.call(accountMap, accountId)) {
    return UNSORTED_COLLECTION;
  }
  const entry = accountMap[accountId];
  if (entry.collectionId === null) return null; // hold
  return typeof entry.collectionId === 'number' ? entry.collectionId : UNSORTED_COLLECTION;
}

function log(msg) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { lastCollectedAt: null }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function queryBookmarks(sinceTs) {
  // birdclaw schema: tweet_collections (account_id, tweet_id, kind, collected_at, ...) JOIN tweets for content.
  // We want kind='bookmarks' rows newer than watermark.
  let rows;
  try {
    const since = sinceTs || '1970-01-01T00:00:00Z';
    // collected_at can be empty for legacy/seed rows — fall back to updated_at as watermark.
    const sql = `
      SELECT tc.tweet_id,
             tc.account_id,
             COALESCE(NULLIF(tc.collected_at, ''), tc.updated_at) AS collected_at,
             COALESCE(t.text, '') AS text,
             COALESCE(p.handle, '') AS author,
             tc.raw_json
      FROM tweet_collections tc
      LEFT JOIN tweets t ON t.id = tc.tweet_id
      LEFT JOIN profiles p ON p.id = t.author_profile_id
      WHERE tc.kind = 'bookmarks'
        AND COALESCE(NULLIF(tc.collected_at, ''), tc.updated_at) > '${since}'
      ORDER BY COALESCE(NULLIF(tc.collected_at, ''), tc.updated_at) ASC
      LIMIT 50;
    `;
    const out = execSync(`sqlite3 "${SQLITE_DB}" -json "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
    rows = out.trim() ? JSON.parse(out) : [];
  } catch (e) {
    log(`ERR sqlite: ${e.message.slice(0, 200)}`);
    return [];
  }
  return rows.map(r => ({
    tweet_id: r.tweet_id,
    account_id: r.account_id,
    url: r.author ? `https://x.com/${r.author}/status/${r.tweet_id}` : `https://x.com/i/web/status/${r.tweet_id}`,
    text: r.text,
    collected_at: r.collected_at,
  }));
}

function postRaindrop(item, collectionId) {
  return new Promise((resolve, reject) => {
    const tags = ['x-bookmark', 'auto-synced'];
    if (item.account_id) tags.push(`acct:${item.account_id}`);
    const body = JSON.stringify({
      link: item.url || `https://x.com/i/web/status/${item.tweet_id}`,
      collectionId: typeof collectionId === 'number' ? collectionId : UNSORTED_COLLECTION,
      excerpt: (item.text || '').slice(0, 1000),
      tags,
      note: `Synced from birdclaw at ${new Date().toISOString()} (account=${item.account_id || 'unknown'})`,
    });
    const req = https.request({
      hostname: RAINDROP_API,
      path: '/rest/v1/raindrop',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let resp = '';
      res.on('data', (d) => (resp += d));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${resp.slice(0, 200)}`));
        try { resolve(JSON.parse(resp)); } catch { resolve({ ok: true }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!TOKEN) {
    // Dormant until Kevin sets the token
    return;
  }
  if (!fs.existsSync(SQLITE_DB)) {
    log('birdclaw db not found; skipping');
    return;
  }

  const state = readState();
  const accountMap = loadAccountMap();
  const newRows = queryBookmarks(state.lastCollectedAt);
  if (newRows.length === 0) return; // silent empty path

  log(`new=${newRows.length} bridging to raindrop (map_accounts=${Object.keys(accountMap).length})`);
  let pushed = 0;
  let held = 0;
  let maxTs = state.lastCollectedAt;
  for (const r of newRows) {
    const collId = collectionFor(r.account_id, accountMap);
    if (collId === null) {
      // Explicit hold — don't push, don't advance watermark past this row
      held++;
      log(`= tweet=${r.tweet_id} acct=${r.account_id} held_pending_collection_id`);
      break;
    }
    try {
      await postRaindrop(r, collId);
      pushed++;
      if (!maxTs || r.collected_at > maxTs) maxTs = r.collected_at;
      log(`+ tweet=${r.tweet_id} acct=${r.account_id} coll=${collId} → raindrop OK`);
    } catch (e) {
      log(`ERR raindrop tweet=${r.tweet_id}: ${e.message.slice(0, 200)}`);
      break;
    }
  }
  if (pushed > 0) {
    state.lastCollectedAt = maxTs;
    saveState(state);
    log(`done pushed=${pushed} held=${held} new_watermark=${maxTs}`);
  } else if (held > 0) {
    log(`done pushed=0 held=${held} watermark_unchanged=${state.lastCollectedAt}`);
  }
}

main().catch((e) => log(`FATAL: ${e.message}`));
