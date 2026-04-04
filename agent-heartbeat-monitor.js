#!/usr/bin/env node
/**
 * @file agent-heartbeat-monitor.js
 * @description Agent heartbeat monitor — detect silent/stuck agents, auto-restart critical ones
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Agent Heartbeat Monitor — Self-healing watchdog for the OpenClaw fleet
 *
 * Checks all agent session stores for recent activity.
 * Critical agents silent >2h during business hours → Telegram alert + auto-restart.
 * Non-critical agents silent >6h → log warning.
 *
 * PM2 cron: every 10 minutes
 * State: scripts/.heartbeat-state.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const CLAWD_DIR = process.env.CLAWD_DIR || path.join(os.homedir(), 'clawd');
const OPENCLAW_AGENTS_DIR =
  process.env.OPENCLAW_AGENTS_DIR || path.join(os.homedir(), '.openclaw/agents');

const AGENTS_DIR = OPENCLAW_AGENTS_DIR;
const STATE_FILE = path.join(__dirname, '.heartbeat-state.json');
const BRIEF_DIR = path.join(CLAWD_DIR, 'shared/daily-brief');

const CRITICAL_AGENTS = ['main', 'morpheus', 'neo', 'trading', 'jarvis'];
const CRITICAL_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const NORMAL_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
const BUSINESS_HOURS = { start: 8, end: 23 }; // EST-ish
const MAX_CONSECUTIVE_MISSES = 3;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { misses: {}, lastAlerts: {}, heals: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getAgentLastActivity(agentId) {
  const sessFile = path.join(AGENTS_DIR, agentId, 'sessions', 'sessions.json');
  if (!fs.existsSync(sessFile)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
    let latest = 0;
    for (const [, session] of Object.entries(data)) {
      if (session && typeof session === 'object' && session.updatedAt) {
        const ts =
          typeof session.updatedAt === 'number'
            ? session.updatedAt
            : Date.parse(session.updatedAt);
        if (ts > latest) latest = ts;
      }
    }
    return latest || null;
  } catch {
    return null;
  }
}

function isBusinessHours() {
  const hour = new Date().getHours();
  return hour >= BUSINESS_HOURS.start && hour < BUSINESS_HOURS.end;
}

function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId =
    process.env.ALERT_TELEGRAM_CHAT_ID || process.env.KEVIN_TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('[heartbeat] No Telegram credentials — alert not sent');
    return;
  }

  try {
    const encoded = encodeURIComponent(message);
    execSync(
      `curl -sf "https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encoded}&parse_mode=Markdown" > /dev/null 2>&1`,
      { timeout: 10000 },
    );
  } catch (e) {
    console.error('[heartbeat] Telegram alert failed:', e.message);
  }
}

function resetAgent(agentId) {
  // Some agents don't support session reset — skip gracefully
  const SKIP_RESET = new Set(['neo', 'morpheus', 'main']); // orchestrator agents
  if (SKIP_RESET.has(agentId)) {
    console.log(`[heartbeat] Skipping reset for ${agentId} (orchestrator — alert only)`);
    return false;
  }
  try {
    const result = execSync(`openclaw sessions reset ${agentId} 2>&1`, {
      timeout: 15000,
    }).toString();
    console.log(`[heartbeat] Auto-reset ${agentId}: ${result.trim()}`);
    return true;
  } catch (e) {
    console.error(
      `[heartbeat] Auto-reset ${agentId} failed (non-fatal): ${e.message.split('\n')[0]}`,
    );
    return false;
  }
}

function run() {
  const now = Date.now();
  const state = loadState();
  const alerts = [];
  const warnings = [];
  const heals = [];

  // Get all agent dirs (skip _archived, default)
  let agents;
  try {
    agents = fs
      .readdirSync(AGENTS_DIR)
      .filter(
        d =>
          !d.startsWith('_') &&
          d !== 'default' &&
          fs.statSync(path.join(AGENTS_DIR, d)).isDirectory(),
      );
  } catch (e) {
    console.error('[heartbeat] Cannot read agents dir:', e.message);
    process.exit(1);
  }

  for (const agent of agents) {
    const lastActivity = getAgentLastActivity(agent);
    if (!lastActivity) continue;

    const silentMs = now - lastActivity;
    const isCritical = CRITICAL_AGENTS.includes(agent);
    const threshold = isCritical ? CRITICAL_THRESHOLD_MS : NORMAL_THRESHOLD_MS;

    if (silentMs > threshold && isBusinessHours()) {
      // Track consecutive misses
      state.misses[agent] = (state.misses[agent] || 0) + 1;
      const silentHours = (silentMs / 3600000).toFixed(1);

      if (isCritical) {
        alerts.push(`*${agent}* silent for ${silentHours}h (miss #${state.misses[agent]})`);

        // Auto-restart after MAX_CONSECUTIVE_MISSES
        if (state.misses[agent] >= MAX_CONSECUTIVE_MISSES) {
          const healed = resetAgent(agent);
          if (healed) {
            heals.push({ agent, action: 'session-reset', time: new Date().toISOString() });
            state.misses[agent] = 0;
            alerts.push(`  → Auto-reset ${agent} after ${MAX_CONSECUTIVE_MISSES} consecutive misses`);
          }
        }
      } else {
        warnings.push(`${agent}: silent ${silentHours}h`);
      }
    } else {
      // Agent is active — clear miss count
      if (state.misses[agent]) {
        state.misses[agent] = 0;
      }
    }
  }

  // Send Telegram alert for critical agents (rate limit: max 1 per agent per hour)
  if (alerts.length > 0) {
    const now_ts = Date.now();
    const newAlerts = alerts.filter(a => {
      const agentMatch = a.match(/\*(\w+)\*/);
      if (!agentMatch) return true;
      const lastAlert = state.lastAlerts[agentMatch[1]] || 0;
      return now_ts - lastAlert > 3600000; // 1 hour cooldown
    });

    if (newAlerts.length > 0) {
      const msg = `🫀 *Agent Heartbeat Alert*\n\n${newAlerts.join('\n')}\n\n${warnings.length > 0 ? `⚠️ Warnings: ${warnings.length} non-critical agents silent` : ''}`;
      sendTelegramAlert(msg);

      // Update last alert times
      for (const a of newAlerts) {
        const match = a.match(/\*(\w+)\*/);
        if (match) state.lastAlerts[match[1]] = now_ts;
      }
    }
  }

  // Record heals
  if (heals.length > 0) {
    state.heals = [...(state.heals || []).slice(-50), ...heals];
  }

  saveState(state);

  // Summary
  const total = agents.length;
  const silent = Object.values(state.misses).filter(v => v > 0).length;
  console.log(
    `[heartbeat] ${total} agents checked, ${silent} silent, ${alerts.length} alerts, ${heals.length} auto-heals`,
  );
}

run();
