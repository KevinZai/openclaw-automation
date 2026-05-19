#!/usr/bin/env node
/**
 * bookmark-sync.cjs — Direct path: Raindrop → Grok-4 (X-sentiment) → Discord #links + Obsidian.
 *
 * REDESIGN 2026-05-15 (CC-${TBD}): switched summarizer from Athena (Sonnet)
 *   to **xai/grok-4-0709** via xAI Responses API with native `x_search` tool.
 *   Grok-4 fetches the link's topic from X in real time, runs sentiment
 *   analysis, and quotes 2-3 representative posts. Athena Sonnet path is
 *   removed (was wasting MAX quota + had no X visibility).
 *
 * Fallback chain (CC-835 → CC-${TBD}):
 *   1. xai/grok-4-0709          (primary, x_search enabled, ~$0.006/call)
 *   2. xai/grok-4-fast-reasoning (~10x cheaper, still has x_search)
 *   3. openai/gpt-5.5 via Codex OAuth (FREE, NO x_search — text only)
 *   4. anthropic/claude-sonnet-4-6 via Athena (last resort, no x_search)
 *
 *   Paperclip is NOT on the outbound path. Summary is posted directly to:
 *     1. Discord forum thread in #links (channel 1475370312362364993)
 *     2. Obsidian vault (Kevin-Vault/00-Inbox/Quick-Capture/bookmarks/)
 *
 * State: ~/clawd/workspaces/main/memory/raindrop-state.json
 * Logs:  ~/clawd/logs/bookmark-sync.log
 *
 * Env required:
 *   RAINDROP_TEST_TOKEN — raindrop.io API token
 *   DISCORD_BOT_TOKEN   — bot with #links forum thread perms
 *   XAI_API_KEY         — xAI API key (loaded from ~/.openclaw/.env)
 *
 * Cron: every 10 min (replaces bookmark-poll.cjs entry — see crontab)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const STATE_FILE = path.join(process.env.HOME, 'clawd/workspaces/main/memory/raindrop-state.json');
const LOG_FILE = path.join(process.env.HOME, 'clawd/logs/bookmark-sync.log');
const DISCORD_CHANNEL = '1475370312362364993'; // #links (forum, type 15)
const OBSIDIAN_DIR = path.join(
  process.env.HOME,
  'Library/Mobile Documents/com~apple~CloudDocs/Kevin-Vault/00-Inbox/Quick-Capture/bookmarks'
);
const ATHENA_AGENT = 'athena';
const ATHENA_THINKING = 'low';
const ATHENA_TIMEOUT_S = 120;
const FALLBACK_AGENT = 'vox'; // codex-runtime agent on openai/gpt-5.5 (free, no x_search)
// Grok / xAI Responses API config
const XAI_BASE_URL = 'https://api.x.ai/v1/responses';
const GROK_PRIMARY = 'grok-4-fast-reasoning'; // FAST: ~10x cheaper than grok-4-0709, still has x_search (~$0.0006/call)
const GROK_FALLBACK = 'grok-4-0709'; // FULL: heavier reasoning, ~$0.006/call, used only if fast fails
const GROK_TIMEOUT_MS = 60000; // 60s — grok-fast is plenty under this
// Load XAI_API_KEY from process.env or ~/.openclaw/.env if not in cron env
function loadXaiKey() {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  try {
    const env = fs.readFileSync(path.join(process.env.HOME, '.openclaw/.env'), 'utf8');
    const m = env.match(/^XAI_API_KEY=(.+)$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  } catch {}
  return null;
}
const XAI_API_KEY = loadXaiKey();
const RAINDROP_TOKEN = process.env.RAINDROP_TEST_TOKEN;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const MAX_PER_RUN = 5;
const PER_BOOKMARK_SLEEP_MS = 2000;

function log(msg) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastSeenIds: [], lastChecked: null }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getRaindrop(urlPath) {
  return new Promise((resolve, reject) => {
    https.request({
      hostname: 'api.raindrop.io',
      path: urlPath,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${RAINDROP_TOKEN}` },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`raindrop ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject).end();
  });
}

function detectType(link) {
  if (!link) return 'generic';
  const u = link.toLowerCase();
  if (u.includes('github.com')) return 'github';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('x.com/') || u.includes('twitter.com/')) return 'x-thread';
  if (u.includes('substack.com') || u.includes('beehiiv.com') || u.includes('medium.com')) return 'newsletter';
  return 'generic';
}

// Build a human-readable title for the bookmark. Raindrop's `title` field is
// often empty for X/twitter URLs (and sometimes for direct media links), in
// which case we'd otherwise fall back to the bare URL. For X tweets we extract
// the first sentence of the excerpt (the tweet text itself); for other types
// we prefer title → excerpt-first-sentence → link.
function buildTitle(b) {
  const isX = (b.link || '').match(/^https?:\/\/(x|twitter)\.com\//);
  const titleField = (b.title || '').trim();
  if (titleField && titleField !== b.link) return titleField.slice(0, 100);
  const excerpt = (b.excerpt || '').replace(/\s+/g, ' ').trim();
  if (excerpt) {
    // First sentence — break on ". " or "\n" or 100 chars
    const firstSentence = excerpt.split(/(?<=\.|!|\?)\s|\n/)[0].trim();
    if (firstSentence) return firstSentence.slice(0, 100);
  }
  if (isX) {
    const m = (b.link || '').match(/x\.com\/([^/]+)\/status\/(\d+)/);
    if (m) return `X · @${m[1]} · ${m[2]}`;
  }
  return (b.link || `Bookmark ${b._id}`).slice(0, 100);
}

// Build the bookmark analysis prompt for Grok (primary) and Athena/Vox (fallback).
function buildPrompt(bookmark) {
  const title = (bookmark.title || bookmark.link || '').slice(0, 200);
  const url = bookmark.link || '';
  const excerpt = (bookmark.excerpt || '').slice(0, 2000);
  const type = detectType(url);
  return (
    `You are analyzing a link Kevin bookmarked on X.\n\n` +
    `LINK TYPE: ${type}\n` +
    `LINK URL: ${url}\n` +
    `LINK TITLE: ${title}\n` +
    `LINK EXCERPT: ${excerpt}\n\n` +
    `Use the x_search tool to find what people on X are saying about this URL or its core topic. ` +
    `Then produce EXACTLY this markdown structure (no preamble, no closing remarks):\n\n` +
    `**Summary** (2-3 sentences explaining what the link is about)\n\n` +
    `**X Sentiment**: 👍 Positive | 👎 Negative | 🤷 Mixed | 🤐 Silent (no X conversation found)\n` +
    `**Confidence**: 1-5\n\n` +
    `**X Voices**\n` +
    `- "<quote>" — @handle (date if visible)\n` +
    `- "<quote>" — @handle\n` +
    `(2-3 representative posts; omit section if Silent)\n\n` +
    `**Why Kevin saved this** (one sentence inference — Kevin's focus areas: AI-native infra/OpenClaw, GuestNetworks PMS-integrated WiFi, ReadyIQ AI consulting, crypto/markets)\n\n` +
    `**Action**: [⭐ Highlight] | [🗂️ Archive] | [📤 Share]\n\n` +
    `Keep total output under 500 words. Avoid hype. Quote real X posts only — never invent quotes.`
  );
}

// Call xAI Responses API with x_search tool enabled.
// Returns { summary, costUsd, latencyMs, model, citations } or throws.
function callGrok(prompt, modelId) {
  const startMs = Date.now();
  const url = new URL(XAI_BASE_URL);
  const payload = JSON.stringify({
    model: modelId,
    input: prompt,
    tools: [{ type: 'x_search' }],
    tool_choice: 'auto',
    max_output_tokens: 1500,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${XAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: GROK_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        const latencyMs = Date.now() - startMs;
        if (res.statusCode >= 400) {
          return reject(new Error(`xai ${res.statusCode}: ${body.slice(0, 300)}`));
        }
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) { return reject(e); }
        // Responses API: output is array of items. Find the message item.
        const msg = (parsed.output || []).find(o => o.type === 'message');
        const textPart = msg?.content?.find(c => c.type === 'output_text');
        const summary = textPart?.text || null;
        const citations = (textPart?.annotations || [])
          .filter(a => a.type === 'url_citation')
          .map(a => a.url);
        // cost_in_usd_ticks: 1 tick = 1e-9 USD (verified empirically)
        const ticks = parsed.usage?.cost_in_usd_ticks || 0;
        const costUsd = ticks / 1e9;
        const xSearchCalls = parsed.usage?.server_side_tool_usage_details?.x_search_calls || 0;
        if (!summary) return reject(new Error(`xai: empty output (${body.slice(0, 200)})`));
        resolve({ summary, costUsd, latencyMs, model: modelId, citations, xSearchCalls });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('xai timeout')); });
    req.write(payload);
    req.end();
  });
}

// Athena/Vox fallback (no x_search; via openclaw CLI). Returns summary string or null.
function callOpenclawAgent(prompt, agentId, thinking) {
  try {
    const out = execFileSync(
      'openclaw',
      ['agent', '--agent', agentId, '--thinking', thinking,
       '--timeout', String(ATHENA_TIMEOUT_S), '-m', prompt],
      { encoding: 'utf8', timeout: (ATHENA_TIMEOUT_S + 10) * 1000, maxBuffer: 4 * 1024 * 1024 }
    );
    const lines = out.split('\n');
    const start = lines.findIndex(l =>
      !l.startsWith('[plugins]') &&
      !l.includes('config.loadConfig()') &&
      l.trim().length > 0
    );
    return (start >= 0 ? lines.slice(start).join('\n') : out).trim() || null;
  } catch (e) {
    return null;
  }
}

// Tier 0 (marathon 2026-05-18 Phase C.1): Hermes-Elon shell-out.
// Uses xai-oauth + grok-4-fast-reasoning via SuperGrok subscription (FREE
// at consumer rate). Native x_search built into Hermes elon profile.
// Replaces direct XAI_API_KEY call as the primary path so we stop double-
// billing (XAI_API_KEY → xAI metered) when SuperGrok already covers grok-4-fast.
function callGrokViaHermes(prompt) {
  const start = Date.now();
  try {
    const out = execFileSync(
      'hermes',
      ['-p', 'elon', '-z', prompt],
      { encoding: 'utf8', timeout: 180 * 1000, maxBuffer: 8 * 1024 * 1024 }
    );
    const summary = (out || '').trim();
    if (!summary) {
      throw new Error('empty response from hermes-elon');
    }
    return {
      summary,
      costUsd: 0,
      latencyMs: Date.now() - start,
      citations: [],
      xSearchCalls: 0,
      source: 'hermes-elon-grok-4-fast-reasoning'
    };
  } catch (e) {
    throw new Error(`hermes-elon shell-out failed: ${(e && e.message ? e.message : String(e)).slice(0, 200)}`);
  }
}

// Main summarizer with full fallback chain. Returns {summary, source, costUsd, latencyMs, citations}.
async function summarizeBookmark(bookmark) {
  const prompt = buildPrompt(bookmark);

  // Tier 0 (marathon 2026-05-18 Phase C.1): Hermes-Elon shell-out — FREE via
  // SuperGrok subscription, x_search native.
  try {
    const r = callGrokViaHermes(prompt);
    log(`  + hermes-elon (grok-4-fast-reasoning) ok latency=${r.latencyMs}ms cost=$0 (SuperGrok)`);
    return { ...r };
  } catch (e) {
    log(`  ! hermes-elon failed: ${e.message.slice(0, 200)} — trying XAI direct path`);
  }
  // Tier 1: Grok 4 primary (XAI_API_KEY direct, ~$0.006/call)
  if (XAI_API_KEY) {
    try {
      const r = await callGrok(prompt, GROK_PRIMARY);
      log(`  + grok-4 ok cost=$${r.costUsd.toFixed(4)} latency=${r.latencyMs}ms x_search=${r.xSearchCalls} citations=${r.citations.length}`);
      return { ...r, source: GROK_PRIMARY };
    } catch (e) {
      log(`  ! grok-4 failed: ${e.message.slice(0, 200)} — trying ${GROK_FALLBACK}`);
    }
    // Tier 2: Grok 4 fast
    try {
      const r = await callGrok(prompt, GROK_FALLBACK);
      log(`  + grok-4-fast ok cost=$${r.costUsd.toFixed(4)} latency=${r.latencyMs}ms`);
      return { ...r, source: GROK_FALLBACK };
    } catch (e) {
      log(`  ! grok-4-fast failed: ${e.message.slice(0, 200)} — falling back to ${FALLBACK_AGENT}`);
    }
  } else {
    log(`  ! XAI_API_KEY missing — skipping Grok, using ${FALLBACK_AGENT}`);
  }
  // Tier 3: Vox (openai/gpt-5.5 Codex OAuth, FREE, no x_search)
  const voxSummary = callOpenclawAgent(prompt, FALLBACK_AGENT, 'low');
  if (voxSummary) {
    log(`  + ${FALLBACK_AGENT} ok (no x_search)`);
    return { summary: voxSummary, source: FALLBACK_AGENT, costUsd: 0, latencyMs: 0, citations: [] };
  }
  // Tier 4: Athena (Sonnet, last resort)
  log(`  ! ${FALLBACK_AGENT} failed — last-resort fallback to ${ATHENA_AGENT}`);
  const athenaSummary = callOpenclawAgent(prompt, ATHENA_AGENT, ATHENA_THINKING);
  if (athenaSummary) {
    return { summary: athenaSummary, source: ATHENA_AGENT, costUsd: 0, latencyMs: 0, citations: [] };
  }
  return null;
}

function postDiscordForumThread({ name, content }) {
  return new Promise((resolve, reject) => {
    // Forum channels (type 15) require POST /channels/{id}/threads with
    // a `message` payload to seed the first post.
    // https://discord.com/developers/docs/resources/channel#start-thread-in-forum-or-media-channel
    const body = JSON.stringify({
      name: name.slice(0, 95),               // max 100 chars
      auto_archive_duration: 1440,            // 24h
      message: { content: content.slice(0, 1900) }, // max 2000
    });
    https.request({
      hostname: 'discord.com',
      path: `/api/v10/channels/${DISCORD_CHANNEL}/threads`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let resp = '';
      res.on('data', d => resp += d);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`discord ${res.statusCode}: ${resp.slice(0, 200)}`));
        try { resolve(JSON.parse(resp)); } catch { resolve({ ok: true }); }
      });
    }).on('error', reject).end(body);
  });
}

function writeObsidian(bookmark, summary, threadId, meta = {}) {
  fs.mkdirSync(OBSIDIAN_DIR, { recursive: true });
  const date = new Date(bookmark.created || Date.now()).toISOString().slice(0, 10);
  const slug = buildTitle(bookmark)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `raindrop-${bookmark._id}`;
  const file = path.join(OBSIDIAN_DIR, `${date}-${slug}.md`);
  const tags = ['bookmark', detectType(bookmark.link), ...(bookmark.tags || [])]
    .filter(Boolean)
    .map(t => t.replace(/\s+/g, '-'));
  const { source = 'unknown', costUsd = 0, latencyMs = 0, citations = [] } = meta;
  const front = [
    '---',
    `title: "${buildTitle(bookmark).replace(/"/g, '\\"')}"`,
    `url: ${bookmark.link || ''}`,
    `raindrop_id: ${bookmark._id}`,
    `created: ${bookmark.created || new Date().toISOString()}`,
    `synced: ${new Date().toISOString()}`,
    `discord_thread: ${threadId || ''}`,
    `summarizer: ${source}`,
    `cost_usd: ${costUsd.toFixed(6)}`,
    `latency_ms: ${latencyMs}`,
    `x_citations: ${citations.length}`,
    `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
    '---',
    '',
  ].join('\n');
  const citationsBlock = citations.length
    ? '\n## X Citations\n' + citations.map(u => `- ${u}`).join('\n') + '\n'
    : '';
  const body = [
    `# ${buildTitle(bookmark)}`,
    '',
    `**URL:** ${bookmark.link || '(none)'}`,
    '',
    `## Summary (${source})`,
    summary || '_(no summary)_',
    '',
    citationsBlock,
    '## Excerpt',
    bookmark.excerpt ? bookmark.excerpt.slice(0, 2000) : '_(none)_',
    '',
  ].join('\n');
  fs.writeFileSync(file, front + body);
  return file;
}

async function processBookmark(b) {
  log(`  > processing ${b._id} ${(b.link || '').slice(0, 60)}`);
  const result = await summarizeBookmark(b);
  if (!result || !result.summary) {
    log(`  ! skip ${b._id} — no summary`);
    return false;
  }
  const { summary, source, costUsd, latencyMs, citations } = result;
  // Discord post
  let threadId = null;
  try {
    const titleLine = buildTitle(b).slice(0, 80);
    const sourceTag = source === GROK_PRIMARY ? 'Grok-4 + X' :
                      source === GROK_FALLBACK ? 'Grok-4-fast + X' :
                      source === FALLBACK_AGENT ? 'Vox (no X)' : 'Athena (no X)';
    const content = `**${titleLine}**\n${b.link || ''}\n\n${summary}\n\n_via ${sourceTag}_`;
    const thread = await postDiscordForumThread({ name: titleLine, content });
    threadId = thread?.id || null;
    log(`  + discord thread=${threadId} for ${b._id}`);
  } catch (e) {
    log(`  ! discord post failed ${b._id}: ${e.message.slice(0, 200)}`);
  }
  // Obsidian write (always — local SSOT)
  try {
    const file = writeObsidian(b, summary, threadId, { source, costUsd, latencyMs, citations });
    log(`  + obsidian ${path.basename(file)}`);
  } catch (e) {
    log(`  ! obsidian write failed ${b._id}: ${e.message.slice(0, 200)}`);
  }
  return true;
}

async function main() {
  if (!RAINDROP_TOKEN) return;     // dormant until token set
  if (!DISCORD_TOKEN) {
    log('WARN: DISCORD_BOT_TOKEN missing — Obsidian-only mode');
  }
  const state = readState();
  const seen = new Set(state.lastSeenIds || []);
  let data;
  try {
    data = await getRaindrop('/rest/v1/raindrops/0?perpage=50&sort=-created');
  } catch (e) {
    log(`ERR raindrop fetch: ${e.message.slice(0, 200)}`);
    return;
  }
  const items = (data.items || []).filter(b => !seen.has(b._id));
  if (items.length === 0) {
    // silent in normal cron path; useful if invoked manually:
    if (process.stdout.isTTY) console.log('no new bookmarks');
    return;
  }
  const batch = items.slice(0, MAX_PER_RUN);
  log(`new=${items.length} processing=${batch.length} (cap=${MAX_PER_RUN}) deferred=${items.length - batch.length}`);
  for (let i = 0; i < batch.length; i++) {
    const b = batch[i];
    const ok = await processBookmark(b);
    // Mark as seen even on partial failure (Athena/Discord) to avoid retry storms.
    // The Obsidian write is best-effort; manual replay is `delete from state` + rerun.
    seen.add(b._id);
    if (i < batch.length - 1) await sleep(PER_BOOKMARK_SLEEP_MS);
  }
  state.lastSeenIds = Array.from(seen).slice(-200);
  state.lastChecked = new Date().toISOString();
  saveState(state);
  log(`done batch=${batch.length} watermark_size=${state.lastSeenIds.length}`);
}

main().catch((e) => log(`FATAL: ${e.message}`));
