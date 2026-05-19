#!/usr/bin/env node
/**
 * free-fleet-health.cjs — Free Fleet health monitor
 *
 * Runs every 30 min (PM2 cron). Checks:
 * 1. Quota utilization per agent (reads fleet-quota.json)
 * 2. Last successful invocation per agent (reads Quill cycle-state.json)
 * 3. Stuck in-progress briefs (inbox/ files > 4h old)
 * 4. Agent silent > 6h → alert via Discord #alfred
 *
 * Notification: openclaw message send → Discord #alfred (1475370281899135037)
 * Fallback: log to ~/clawd/logs/free-fleet-health.log
 *
 * State file: ~/.openclaw/free-fleet-health-state.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

// ── Config ──────────────────────────────────────────────────────────────────
const CLAWD_DIR = process.env.CLAWD_DIR || path.join(os.homedir(), 'clawd');
const FLEET_DIR = path.join(CLAWD_DIR, 'output/free-fleet');
const QUOTA_FILE = path.join(os.homedir(), '.openclaw/fleet-quota.json');
const CYCLE_STATE = path.join(CLAWD_DIR, 'workspaces/quill/memory/cycle-state.json');
const STATE_FILE = path.join(os.homedir(), '.openclaw/free-fleet-health-state.json');
const LOG_FILE = path.join(CLAWD_DIR, 'logs/free-fleet-health.log');

const DISCORD_CHANNEL = '1475370281899135037'; // #alfred

const ALERT_THRESHOLDS = {
  agentSilentMs: 6 * 60 * 60 * 1000,      // 6h — agent hasn't run
  stuckBriefMs: 4 * 60 * 60 * 1000,        // 4h — brief stuck in inbox
  quotaWarnPct: 80,                          // % — quota approaching limit
  quotaBlockPct: 95,                         // % — quota at limit
};

// ── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

// ── State management ─────────────────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRun: null, alerts: {}, lastAlert: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, lastRun: new Date().toISOString() }, null, 2));
}

// ── Notifications ─────────────────────────────────────────────────────────────
function sendAlert(text) {
  log(`ALERT: ${text}`);
  try {
    const result = spawnSync('openclaw', [
      'message', 'send',
      '--channel', 'discord',
      '--target', DISCORD_CHANNEL,
      '--text', text,
    ], { timeout: 15000, encoding: 'utf8' });
    if (result.status === 0) {
      log('alert posted to Discord #alfred');
    } else {
      log(`Discord send failed (exit ${result.status}): ${result.stderr?.slice(0, 200)}`);
    }
  } catch (err) {
    log(`openclaw not available: ${err.message}`);
  }
}

// ── Check 1: Quota utilization ────────────────────────────────────────────────
function checkQuota() {
  const issues = [];
  if (!fs.existsSync(QUOTA_FILE)) {
    log('quota file not found — skipping quota check');
    return issues;
  }
  let quota;
  try {
    quota = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
  } catch (err) {
    log(`quota file parse error: ${err.message}`);
    return issues;
  }

  const updatedAt = quota.updated_at ? new Date(quota.updated_at) : null;
  const quotaAgeMs = updatedAt ? Date.now() - updatedAt.getTime() : Infinity;
  if (quotaAgeMs > 30 * 60 * 1000) {
    issues.push(`⚠️ fleet-quota.json stale (${Math.round(quotaAgeMs / 60000)} min old) — quota tracker may be down`);
  }

  const agents = quota.agents || {};
  for (const [name, info] of Object.entries(agents)) {
    const pct = typeof info.rpd_pct === 'number' ? info.rpd_pct : null;
    if (pct !== null) {
      if (pct >= ALERT_THRESHOLDS.quotaBlockPct) {
        issues.push(`🚫 ${name} quota BLOCKED (${pct}% of daily limit) — dispatch paused`);
      } else if (pct >= ALERT_THRESHOLDS.quotaWarnPct) {
        issues.push(`⚠️ ${name} quota warning (${pct}% of daily limit)`);
      }
    }
    if (info.status && info.status !== 'ok') {
      issues.push(`🔴 ${name} status: ${info.status}`);
    }
  }
  return issues;
}

// ── Check 2: Agent last-invocation timestamp ──────────────────────────────────
function checkAgentActivity() {
  const issues = [];
  const nowMs = Date.now();

  // Check Quill cycle-state (written by quill-dispatch cron on each cycle)
  if (fs.existsSync(CYCLE_STATE)) {
    let cs;
    try {
      cs = JSON.parse(fs.readFileSync(CYCLE_STATE, 'utf8'));
      const lastTs = cs.last_run || cs.updated_at || cs.timestamp;
      if (lastTs) {
        const ageMs = nowMs - new Date(lastTs).getTime();
        if (ageMs > ALERT_THRESHOLDS.agentSilentMs) {
          const ageH = Math.round(ageMs / 3600000);
          issues.push(`🔇 Quill dispatch cron silent ${ageH}h — last run: ${lastTs}`);
        }
      }
    } catch (err) {
      log(`cycle-state parse error: ${err.message}`);
    }
  } else {
    // cycle-state doesn't exist yet — not an alert if quota tracker shows 0 tasks
    log('cycle-state.json not found (Quill not yet dispatched or path unset)');
  }

  // Check quill-fleet-hourly-digest cron last run via log file
  if (fs.existsSync(LOG_FILE)) {
    const logContent = fs.readFileSync(LOG_FILE, 'utf8');
    const lastActivity = logContent.split('\n')
      .filter(l => l.includes('wrote digest') || l.includes('posted to Discord'))
      .pop();
    if (lastActivity) {
      const match = lastActivity.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]/);
      if (match) {
        const ageMs = nowMs - new Date(match[1]).getTime();
        if (ageMs > ALERT_THRESHOLDS.agentSilentMs) {
          const ageH = Math.round(ageMs / 3600000);
          issues.push(`⏰ Fleet hourly digest not generated in ${ageH}h`);
        }
      }
    }
  }

  return issues;
}

// ── Check 3: Stuck in-progress briefs ────────────────────────────────────────
function checkStuckBriefs() {
  const issues = [];
  const inboxDir = path.join(FLEET_DIR, 'inbox');
  const inProgressDir = path.join(FLEET_DIR, 'in-progress');

  for (const [label, dir] of [['inbox', inboxDir], ['in-progress', inProgressDir]]) {
    if (!fs.existsSync(dir)) continue;
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md');
    } catch {
      continue;
    }
    const stuck = [];
    for (const fname of files) {
      const fpath = path.join(dir, fname);
      try {
        const stat = fs.statSync(fpath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > ALERT_THRESHOLDS.stuckBriefMs) {
          const ageH = Math.round(ageMs / 3600000);
          stuck.push(`${fname} (${ageH}h)`);
        }
      } catch { /* skip */ }
    }
    if (stuck.length > 0) {
      issues.push(`📌 ${stuck.length} brief(s) stuck in ${label} >${Math.round(ALERT_THRESHOLDS.stuckBriefMs / 3600000)}h: ${stuck.slice(0, 3).join(', ')}${stuck.length > 3 ? '…' : ''}`);
    }
  }

  return issues;
}

// ── Dedup: skip if same alert was sent <2h ago ────────────────────────────────
function shouldAlert(state, key, nowMs) {
  const lastAlert = state.lastAlert?.[key] || 0;
  return (nowMs - lastAlert) > 2 * 60 * 60 * 1000;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  log('free-fleet-health check starting');
  const state = loadState();
  const nowMs = Date.now();

  const allIssues = [
    ...checkQuota(),
    ...checkAgentActivity(),
    ...checkStuckBriefs(),
  ];

  if (allIssues.length === 0) {
    log('all checks passed — fleet healthy');
    saveState({ ...state, lastHealthy: new Date().toISOString() });
    return;
  }

  // Group new vs suppressed
  const toAlert = [];
  for (const issue of allIssues) {
    const key = issue.slice(0, 60);
    if (shouldAlert(state, key, nowMs)) {
      toAlert.push(issue);
      state.lastAlert = state.lastAlert || {};
      state.lastAlert[key] = nowMs;
    } else {
      log(`suppressed (already alerted): ${issue}`);
    }
  }

  if (toAlert.length > 0) {
    const msg = `🚨 **Free Fleet Health Alert** (${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Toronto' })} ET)\n\n${toAlert.map(i => `• ${i}`).join('\n')}`;
    sendAlert(msg);
  }

  saveState(state);
  log(`health check done — ${allIssues.length} issue(s), ${toAlert.length} alert(s) sent`);
}

main();
