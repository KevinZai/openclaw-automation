#!/usr/bin/env node
/**
 * nexus-discord-send.cjs
 *
 * Sidecar dispatcher: send a message to #👁️nexus via the Nexus webhook
 * instead of routing through OpenClaw's Discord bot adapter.
 *
 * Usage:
 *   echo '{"content":"hello"}' | node scripts/nexus-discord-send.cjs
 *   echo '{"content":"...","username":"Nexus","embeds":[...]}' | node ...
 *
 * Env (loaded from process.env; OC's .env is the canonical source):
 *   DISCORD_NEXUS_WEBHOOK_URL                 (preferred, combined form)
 *   DISCORD_NEXUS_WEBHOOK_ID + _TOKEN         (fallback, split form)
 *   DISCORD_NEXUS_WEBHOOK_AVATAR_URL          (optional)
 *
 * Exit codes: 0 success, 1 failure (structured JSON to stderr)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const LOG_FILE = path.join(process.env.HOME || '/Users/ai', 'clawd/logs/nexus-discord.log');
const DISCORD_LIMIT = 2000;

function log(level, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...payload });
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* swallow log errors */ }
  if (level === 'error') process.stderr.write(line + '\n');
}

function redact(s) {
  if (!s) return s;
  return String(s).replace(/[A-Za-z0-9_-]{20,}/g, '<REDACTED>');
}

function loadEnvFromOpenclaw() {
  // Fallback: if env vars aren't already exported, try ~/.openclaw/.env
  if (process.env.DISCORD_NEXUS_WEBHOOK_URL ||
      (process.env.DISCORD_NEXUS_WEBHOOK_ID && process.env.DISCORD_NEXUS_WEBHOOK_TOKEN)) {
    return;
  }
  const envPath = path.join(process.env.HOME || '/Users/ai', '.openclaw/.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(DISCORD_NEXUS_WEBHOOK_[A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[m[1]] = v;
      }
    }
  } catch (e) {
    log('warn', { msg: 'failed to read ~/.openclaw/.env', err: e.message });
  }
}

function resolveWebhookUrl() {
  loadEnvFromOpenclaw();
  if (process.env.DISCORD_NEXUS_WEBHOOK_URL) return process.env.DISCORD_NEXUS_WEBHOOK_URL;
  const id = process.env.DISCORD_NEXUS_WEBHOOK_ID;
  const tok = process.env.DISCORD_NEXUS_WEBHOOK_TOKEN;
  if (id && tok) return `https://discord.com/api/webhooks/${id}/${tok}`;
  return null;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function splitContent(content, limit = DISCORD_LIMIT) {
  if (!content || content.length <= limit) return [content || ''];
  const chunks = [];
  let remaining = content;
  while (remaining.length > limit) {
    // Try to split at last newline before limit, else at last space, else hard cut.
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

function postToWebhook(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // wait=true → Discord returns the created message object (incl. id)
    if (!u.searchParams.has('wait')) u.searchParams.set('wait', 'true');
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'User-Agent': 'nexus-discord-send/1.0 (+clawd)',
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); }
        } else {
          reject(new Error(`Discord ${res.statusCode}: ${out.slice(0, 400)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const url = resolveWebhookUrl();
  if (!url) {
    log('error', { msg: 'missing webhook creds', need: ['DISCORD_NEXUS_WEBHOOK_URL', 'or _ID + _TOKEN'] });
    process.exit(1);
  }

  const raw = await readStdin();
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    log('error', { msg: 'invalid JSON on stdin', err: e.message });
    process.exit(1);
  }

  const username = payload.username || 'Nexus';
  const avatar_url = payload.avatar_url || process.env.DISCORD_NEXUS_WEBHOOK_AVATAR_URL || undefined;
  const embeds = Array.isArray(payload.embeds) ? payload.embeds : undefined;
  const allowed_mentions = payload.allowed_mentions || { parse: [] };

  const chunks = splitContent(payload.content || '');
  if (!chunks.length && !embeds) {
    log('error', { msg: 'empty payload — need content or embeds' });
    process.exit(1);
  }

  const results = [];
  try {
    for (let i = 0; i < Math.max(chunks.length, 1); i++) {
      const body = {
        username,
        avatar_url,
        allowed_mentions,
        content: chunks[i] || '',
      };
      // Attach embeds only to the LAST chunk so they don't duplicate.
      if (embeds && i === Math.max(chunks.length, 1) - 1) body.embeds = embeds;
      const res = await postToWebhook(url, body);
      results.push({ id: res.id, channel_id: res.channel_id });
      log('info', {
        msg: 'sent',
        chunk: i + 1,
        total: Math.max(chunks.length, 1),
        msg_id: res.id,
        channel_id: res.channel_id,
        preview: redact((chunks[i] || '').slice(0, 80)),
      });
    }
  } catch (e) {
    log('error', { msg: 'webhook post failed', err: e.message });
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ ok: true, sent: results }) + '\n');
}

main().catch((e) => {
  log('error', { msg: 'uncaught', err: e.message, stack: e.stack });
  process.exit(1);
});
