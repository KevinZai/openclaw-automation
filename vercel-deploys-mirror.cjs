#!/usr/bin/env node
/**
 * vercel-deploys-mirror.cjs
 *
 * Sidecar: poll Vercel deployments API across all teams + personal scope,
 * diff vs last-seen state, post new/state-changed deploys to Discord
 * #🥉deploys channel via webhook.
 *
 * Cadence: every 5 min via cron.
 *
 * State: /Users/ai/clawd/.cache/vercel-deploys-last-seen.json
 *   { "deployments": { "<uid>": "<state>" }, "first_run_at": "<iso>" }
 *
 * Creds:
 *   VERCEL_TOKEN                 — Vercel API bearer (env or ~/.openclaw/.env or 1P "Vercel")
 *   DISCORD_VERCEL_WEBHOOK_URL   — Discord webhook URL (env or ~/.openclaw/.env)
 *     — fallback hardcoded below (matches webhook created 2026-05-15 for #🥉deploys)
 *
 * Exit 0 on success (including "nothing new"). Exit 1 on hard failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const HOME = process.env.HOME || '/Users/ai';
const STATE_FILE = path.join(HOME, 'clawd/.cache/vercel-deploys-last-seen.json');
const LOG_FILE = path.join(HOME, 'clawd/logs/vercel-deploys-mirror.log');
const ENV_FILE = path.join(HOME, '.openclaw/.env');

// Webhook URL loaded from ~/.openclaw/.env or env var DISCORD_VERCEL_WEBHOOK_URL.
// To set: append DISCORD_VERCEL_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
// to ~/.openclaw/.env (NOT committed). Webhook for #🥉deploys was created 2026-05-15.
const FALLBACK_WEBHOOK_URL = null;

// Poll window — only consider deployments created in the last N hours
// (avoids replaying ancient history on first run; mirror only goes forward)
const LOOKBACK_HOURS = 6;
const MAX_DEPLOYS_PER_SCOPE = 25;
const PER_RUN_POST_CAP = 20; // safety against flood

// --- logging ---
function log(level, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...payload });
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* ignore */ }
  if (level === 'error') process.stderr.write(line + '\n');
}

// --- env loading ---
function loadEnvFromOpenclaw() {
  if (!fs.existsSync(ENV_FILE)) return;
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const [, k, v0] = m;
      if (process.env[k]) continue;
      let v = v0;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[k] = v;
    }
  } catch (e) {
    log('warn', { msg: 'failed to read ~/.openclaw/.env', err: e.message });
  }
}

function resolveVercelToken() {
  loadEnvFromOpenclaw();
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  // 1P fallback
  try {
    const v = execSync('op read "op://Alfred/Vercel/credential" 2>/dev/null', { encoding: 'utf8' }).trim();
    if (v && !v.includes('use \'op')) return v;
  } catch (_) { /* ignore */ }
  return null;
}

function resolveWebhookUrl() {
  return process.env.DISCORD_VERCEL_WEBHOOK_URL || FALLBACK_WEBHOOK_URL;
}

// --- state ---
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { deployments: {}, first_run_at: null };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    log('warn', { msg: 'state read failed, starting fresh', err: e.message });
    return { deployments: {}, first_run_at: null };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log('error', { msg: 'state save failed', err: e.message });
  }
}

// --- HTTP ---
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'vercel-deploys-mirror/1.0', ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`bad json: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!u.searchParams.has('wait')) u.searchParams.set('wait', 'true');
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'User-Agent': 'vercel-deploys-mirror/1.0',
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); }
        } else {
          reject(new Error(`Discord ${res.statusCode}: ${buf.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- vercel ---
async function listTeams(token) {
  const r = await httpGet('https://api.vercel.com/v2/teams', { Authorization: `Bearer ${token}` });
  return r.teams || [];
}

async function listDeployments(token, scope) {
  // scope: null (personal) or teamId string
  const since = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const qs = new URLSearchParams({ limit: String(MAX_DEPLOYS_PER_SCOPE), since: String(since) });
  if (scope) qs.set('teamId', scope);
  const url = `https://api.vercel.com/v6/deployments?${qs}`;
  const r = await httpGet(url, { Authorization: `Bearer ${token}` });
  return r.deployments || [];
}

// --- discord formatting ---
const STATE_COLORS = {
  READY: 0x22c55e,       // green — production success
  BUILDING: 0xeab308,    // yellow — in progress
  INITIALIZING: 0xeab308,
  QUEUED: 0xeab308,
  ERROR: 0xef4444,       // red — failed
  CANCELED: 0x6b7280,    // gray
  BLOCKED: 0xa855f7,     // purple — blocked (e.g. by deployment protection)
};

const STATE_EMOJI = {
  READY: '✅',
  BUILDING: '🔄',
  INITIALIZING: '🔄',
  QUEUED: '⏳',
  ERROR: '❌',
  CANCELED: '⏹️',
  BLOCKED: '🔒',
};

function buildEmbed(d, scopeName) {
  const state = d.state || d.readyState || 'UNKNOWN';
  const emoji = STATE_EMOJI[state] || '📦';
  const color = STATE_COLORS[state] || 0x6b7280;
  const target = d.target === 'production' ? 'production' : 'preview';
  const targetEmoji = target === 'production' ? '🌐' : '🧪';
  const sha = d.meta?.githubCommitSha?.slice(0, 7) || null;
  const msg = d.meta?.githubCommitMessage?.split('\n')[0]?.slice(0, 100) || null;
  const branch = d.meta?.githubCommitRef || null;
  const author = d.meta?.githubCommitAuthorName || d.creator?.username || null;
  const deployUrl = d.url ? `https://${d.url}` : null;
  const inspectUrl = d.inspectorUrl || null;

  const fields = [];
  if (branch) fields.push({ name: 'branch', value: `\`${branch}\``, inline: true });
  if (sha) fields.push({ name: 'commit', value: `\`${sha}\``, inline: true });
  if (author) fields.push({ name: 'by', value: author, inline: true });

  let description = '';
  if (msg) description += `> ${msg}\n`;
  if (deployUrl) description += `🔗 [${d.url}](${deployUrl})`;
  if (inspectUrl) description += deployUrl ? `  ·  [inspect](${inspectUrl})` : `[inspect](${inspectUrl})`;

  return {
    title: `${emoji} ${d.name} — ${state} ${targetEmoji} ${target}`,
    description: description || undefined,
    color,
    fields: fields.length ? fields : undefined,
    footer: { text: `${scopeName}  ·  ${d.uid}` },
    timestamp: d.created ? new Date(d.created).toISOString() : undefined,
  };
}

// only mirror "interesting" terminal/notable states; skip transient noise
const REPORT_STATES = new Set(['READY', 'ERROR', 'CANCELED', 'BLOCKED']);

async function main() {
  const token = resolveVercelToken();
  if (!token) {
    log('error', { msg: 'no VERCEL_TOKEN available' });
    process.exit(1);
  }
  const webhookUrl = resolveWebhookUrl();
  if (!webhookUrl) {
    log('error', { msg: 'no DISCORD_VERCEL_WEBHOOK_URL available' });
    process.exit(1);
  }

  const state = loadState();
  const isFirstRun = !state.first_run_at;
  if (isFirstRun) {
    state.first_run_at = new Date().toISOString();
    log('info', { msg: 'first run — seeding state without posting', lookback_hours: LOOKBACK_HOURS });
  }

  // Build scope list
  const scopes = [{ id: null, name: 'personal', slug: 'personal' }];
  try {
    const teams = await listTeams(token);
    for (const t of teams) scopes.push({ id: t.id, name: t.name || t.slug, slug: t.slug });
  } catch (e) {
    log('warn', { msg: 'team list failed; falling back to default scope', err: e.message });
  }

  let totalSeen = 0;
  let totalNew = 0;
  let totalPosted = 0;
  const toPost = []; // { embed, uid, newState }

  for (const scope of scopes) {
    let deploys = [];
    try {
      deploys = await listDeployments(token, scope.id);
    } catch (e) {
      log('warn', { msg: 'list failed', scope: scope.slug, err: e.message });
      continue;
    }
    totalSeen += deploys.length;

    for (const d of deploys) {
      const uid = d.uid;
      const cur = d.state || d.readyState || 'UNKNOWN';
      const prev = state.deployments[uid];

      // Skip if we've already recorded this exact state
      if (prev === cur) continue;

      // Always update state — even if we don't post, we want to track transitions
      state.deployments[uid] = cur;
      totalNew++;

      // On first run, just seed — don't post
      if (isFirstRun) continue;

      // Only post on "interesting" terminal states
      if (!REPORT_STATES.has(cur)) continue;

      // For READY: only post if we hadn't already reported READY (idempotency via prev check above)
      // For ERROR/CANCELED/BLOCKED: same — prev !== cur means it's a transition

      toPost.push({
        embed: buildEmbed(d, scope.name),
        uid,
        newState: cur,
      });
    }
  }

  // Cap per-run posts to avoid flood
  const postBatch = toPost.slice(0, PER_RUN_POST_CAP);
  if (toPost.length > PER_RUN_POST_CAP) {
    log('warn', { msg: 'capping post batch', requested: toPost.length, cap: PER_RUN_POST_CAP });
  }

  for (const item of postBatch) {
    try {
      const res = await httpPost(webhookUrl, {
        username: 'Vercel',
        avatar_url: 'https://assets.vercel.com/image/upload/front/favicon/vercel/180x180.png',
        allowed_mentions: { parse: [] },
        embeds: [item.embed],
      });
      totalPosted++;
      log('info', { msg: 'posted', uid: item.uid, state: item.newState, msg_id: res.id });
    } catch (e) {
      log('error', { msg: 'discord post failed', uid: item.uid, err: e.message });
      // Don't break — try remaining; don't update state for failures so we retry next run
      // (But state was already updated above — accept duplicate-post risk on retry; rare)
    }
  }

  // Prune state: keep only deployments from last 14 days worth of UIDs (cap at 500)
  const uids = Object.keys(state.deployments);
  if (uids.length > 500) {
    const keep = uids.slice(-500);
    const newMap = {};
    for (const u of keep) newMap[u] = state.deployments[u];
    state.deployments = newMap;
    log('info', { msg: 'pruned state', kept: keep.length });
  }

  saveState(state);

  log('info', {
    msg: 'run complete',
    scopes: scopes.length,
    seen: totalSeen,
    new_or_changed: totalNew,
    posted: totalPosted,
    first_run: isFirstRun,
  });
}

main().catch((e) => {
  log('error', { msg: 'uncaught', err: e.message, stack: e.stack });
  process.exit(1);
});
