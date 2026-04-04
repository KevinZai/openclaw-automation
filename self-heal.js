#!/usr/bin/env node
/**
 * @file self-heal.js
 * @description Self-heal engine — monitor gateway logs for error patterns, auto-remediate
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Self-Heal Engine — Automatic error recovery for OpenClaw gateway
 *
 * Monitors gateway logs for recurring error patterns and applies auto-remediation.
 * Logs all actions to shared/daily-brief/ for morning review.
 *
 * Remediation table:
 *   OAuth 401          → log + skip (already fixed by switching to console key)
 *   Rate limit 429     → log + track cooldown duration
 *   Memory OOM         → alert + recommend session reset
 *   Channel disconnect  → log + track reconnect count
 *   Uncaught exception → alert (gateway restart may be needed)
 *
 * PM2 cron: every 5 minutes
 * State: scripts/.self-heal-state.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const CLAWD_DIR = process.env.CLAWD_DIR || path.join(os.homedir(), 'clawd');

const LOG_FILE = `/tmp/openclaw/openclaw-${new Date().toISOString().split('T')[0]}.log`;
const STATE_FILE = path.join(__dirname, '.self-heal-state.json');
const BRIEF_DIR = path.join(CLAWD_DIR, 'shared/daily-brief');
const HEAL_LOG = path.join(BRIEF_DIR, `self-heal-${new Date().toISOString().split('T')[0]}.md`);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      lastOffset: 0,
      lastLogFile: '',
      errors: { auth: 0, rateLimit: 0, oom: 0, disconnect: 0, uncaught: 0 },
      heals: [],
      lastAlertTime: 0,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId =
    process.env.ALERT_TELEGRAM_CHAT_ID || process.env.KEVIN_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const encoded = encodeURIComponent(message);
    execSync(
      `curl -sf "https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encoded}&parse_mode=Markdown" > /dev/null 2>&1`,
      { timeout: 10000 },
    );
  } catch {}
}

function appendHealLog(entries) {
  fs.mkdirSync(BRIEF_DIR, { recursive: true });
  const header = fs.existsSync(HEAL_LOG)
    ? ''
    : `# Self-Heal Log — ${new Date().toISOString().split('T')[0]}\n\n`;

  const lines = entries
    .map(
      e => `- \`${new Date().toISOString().slice(11, 19)}\` **${e.type}**: ${e.message}`,
    )
    .join('\n');

  fs.appendFileSync(HEAL_LOG, header + lines + '\n');
}

function run() {
  const state = loadState();

  // Reset counters if log file changed (new day)
  if (state.lastLogFile !== LOG_FILE) {
    state.lastOffset = 0;
    state.lastLogFile = LOG_FILE;
    state.errors = { auth: 0, rateLimit: 0, oom: 0, disconnect: 0, uncaught: 0 };
  }

  if (!fs.existsSync(LOG_FILE)) {
    console.log('[self-heal] No log file for today yet');
    saveState(state);
    return;
  }

  // Read new log lines since last check
  const stats = fs.statSync(LOG_FILE);
  if (stats.size <= state.lastOffset) {
    console.log('[self-heal] No new log entries');
    saveState(state);
    return;
  }

  const fd = fs.openSync(LOG_FILE, 'r');
  const bufSize = Math.min(stats.size - state.lastOffset, 512 * 1024); // Max 512KB per check
  const buffer = Buffer.alloc(bufSize);
  fs.readSync(fd, buffer, 0, bufSize, state.lastOffset);
  fs.closeSync(fd);
  state.lastOffset = state.lastOffset + bufSize;

  const newContent = buffer.toString('utf8');
  const lines = newContent.split('\n');
  const healActions = [];

  let authErrors = 0;
  let rateLimits = 0;
  let oomErrors = 0;
  let disconnects = 0;
  let uncaughtErrors = 0;

  for (const line of lines) {
    // OAuth 401
    if (
      line.includes('authentication_error') ||
      line.includes('OAuth authentication is currently not supported')
    ) {
      authErrors++;
    }

    // Rate limit 429
    if (line.includes('429') && (line.includes('rate_limit') || line.includes('Too Many Requests'))) {
      rateLimits++;
    }

    // Memory issues
    if (
      line.includes('heap out of memory') ||
      line.includes('ENOMEM') ||
      line.includes('allocation failed')
    ) {
      oomErrors++;
    }

    // Channel disconnects
    if (line.includes('stale-socket') || (line.includes('reconnect') && line.includes('WebSocket'))) {
      disconnects++;
    }

    // Uncaught exceptions
    if (line.includes('uncaughtException') || line.includes('unhandledRejection')) {
      uncaughtErrors++;
    }
  }

  state.errors.auth += authErrors;
  state.errors.rateLimit += rateLimits;
  state.errors.oom += oomErrors;
  state.errors.disconnect += disconnects;
  state.errors.uncaught += uncaughtErrors;

  // Remediation decisions
  if (authErrors > 5) {
    healActions.push({
      type: 'AUTH',
      message: `${authErrors} OAuth 401 errors detected. Provider may need key rotation. Check ANTHROPIC_API_KEY_FROM_CONSOLE.`,
    });
  }

  if (rateLimits > 10) {
    healActions.push({
      type: 'RATE_LIMIT',
      message: `${rateLimits} rate limit (429) errors. Per-model cooldowns active in v2026.3.28. Monitor for cascading failures.`,
    });
  }

  if (oomErrors > 0) {
    healActions.push({
      type: 'OOM',
      message: `${oomErrors} memory errors detected. Recommend session cleanup: openclaw sessions cleanup`,
    });
    // Alert immediately for OOM
    sendTelegramAlert(
      `⚠️ *Self-Heal: Memory Alert*\n\n${oomErrors} OOM errors in gateway logs. May need session cleanup or restart.`,
    );
  }

  if (disconnects > 20) {
    healActions.push({
      type: 'DISCONNECT',
      message: `${disconnects} channel reconnects detected. Check Discord/Slack socket health.`,
    });
  }

  if (uncaughtErrors > 0) {
    healActions.push({
      type: 'UNCAUGHT',
      message: `${uncaughtErrors} uncaught exceptions. Gateway may need restart. Check logs.`,
    });
    // Alert for uncaught exceptions (potential crash loop)
    const now = Date.now();
    if (now - state.lastAlertTime > 1800000) {
      // 30 min cooldown
      sendTelegramAlert(
        `🚨 *Self-Heal: Uncaught Exception*\n\n${uncaughtErrors} uncaught errors in gateway. Check for crash loop.`,
      );
      state.lastAlertTime = now;
    }
  }

  // Log heal actions
  if (healActions.length > 0) {
    appendHealLog(healActions);
    state.heals = [
      ...(state.heals || []).slice(-100),
      ...healActions.map(h => ({ ...h, time: new Date().toISOString() })),
    ];
  }

  saveState(state);

  // Summary
  const total = authErrors + rateLimits + oomErrors + disconnects + uncaughtErrors;
  console.log(
    `[self-heal] Scanned ${lines.length} lines: ${total} errors (auth:${authErrors} 429:${rateLimits} oom:${oomErrors} disc:${disconnects} uncaught:${uncaughtErrors}), ${healActions.length} actions`,
  );
}

run();
