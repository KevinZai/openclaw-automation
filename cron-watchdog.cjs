#!/usr/bin/env node
// cron-watchdog.cjs — monitor freshness of cron-managed watermark logs
//
// Reads /Users/ai/clawd/shared/refs/cron-watchdog-config.json
// For each cron job, checks if its watermark file's mtime is within maxAgeMinutes.
// Stale jobs → log to /Users/ai/clawd/logs/cron-watchdog.log + (optionally) Telegram.
// Debounces alerts to once per debounceMinutes per job to avoid spam.
//
// Eats its own dogfood: all paths absolute, no $HOME reliance.
//
// Usage:
//   /usr/bin/env node /Users/ai/clawd/scripts/cron-watchdog.cjs           # run check
//   /usr/bin/env node /Users/ai/clawd/scripts/cron-watchdog.cjs --json    # JSON report
//   /usr/bin/env node /Users/ai/clawd/scripts/cron-watchdog.cjs --force   # ignore debounce

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_PATH = '/Users/ai/clawd/shared/refs/cron-watchdog-config.json';
const LOG_PATH = '/Users/ai/clawd/logs/cron-watchdog.log';

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch (_) {}
  process.stdout.write(line);
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function loadDebounce(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return {}; }
}

function saveDebounce(p, data) {
  try { fs.writeFileSync(p, JSON.stringify(data, null, 2)); } catch (e) { logLine(`debounce save failed: ${e.message}`); }
}

function ageMinutes(filePath) {
  try {
    const st = fs.statSync(filePath);
    return (Date.now() - st.mtimeMs) / 60000;
  } catch (e) {
    return null; // file missing
  }
}

function telegramAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    logLine(`telegram skipped (no creds): ${text.slice(0, 80)}`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const req = https.request({
      host: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', (e) => { logLine(`telegram error: ${e.message}`); resolve(false); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes('--json');
  const force = args.includes('--force');

  const cfg = loadConfig();
  const debouncePath = cfg._meta.debounceState;
  const debounceMin = cfg._meta.debounceMinutes || 360;
  const debounce = loadDebounce(debouncePath);
  const now = Date.now();

  const report = { ok: [], stale: [], missing: [] };

  for (const job of cfg.cronJobs) {
    const age = ageMinutes(job.watermark);
    if (age === null) {
      report.missing.push({ ...job, age: null });
    } else if (age > job.maxAgeMinutes) {
      report.stale.push({ ...job, ageMinutes: Math.round(age) });
    } else {
      report.ok.push({ name: job.name, ageMinutes: Math.round(age) });
    }
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  logLine(`watchdog: ok=${report.ok.length} stale=${report.stale.length} missing=${report.missing.length}`);

  const problems = [...report.stale, ...report.missing];
  for (const p of problems) {
    const lastAlerted = debounce[p.name] || 0;
    const shouldAlert = force || (now - lastAlerted > debounceMin * 60000);
    const status = p.ageMinutes === undefined ? 'MISSING' : `STALE (${p.ageMinutes}m old, max ${p.maxAgeMinutes}m)`;
    logLine(`  ${p.name}: ${status} — ${p.watermark}`);
    if (p.telegramAlert && shouldAlert) {
      const text = `🚨 *cron-watchdog*: \`${p.name}\` ${status}\n\`${p.watermark}\``;
      const sent = await telegramAlert(text);
      if (sent) debounce[p.name] = now;
    }
  }

  saveDebounce(debouncePath, debounce);

  if (problems.length > 0) process.exitCode = 1;
}

main().catch((e) => { logLine(`fatal: ${e.message}`); process.exit(2); });
