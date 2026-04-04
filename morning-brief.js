#!/usr/bin/env node
/**
 * @file morning-brief.js
 * @description Morning brief generator — consolidated overnight automation activity report
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Morning Brief Generator — Aggregates all overnight automation activity
 *
 * Reads all daily-brief files for today, PM2 logs, and state files.
 * Generates a single consolidated morning briefing for Kevin.
 * Optionally sends via Telegram.
 *
 * PM2 cron: daily 9am EST (0 14 * * * UTC)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const CLAWD_DIR = process.env.CLAWD_DIR || path.join(os.homedir(), 'clawd');
const BRIEF_DIR = path.join(CLAWD_DIR, 'shared/daily-brief');
const SCRIPTS_DIR = path.join(CLAWD_DIR, 'scripts');
const OUTPUT_DIR = process.env.MORNING_BRIEF_OUTPUT_DIR || path.join(CLAWD_DIR, 'output/team-kevin');

function today() {
  return new Date().toISOString().split('T')[0];
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function getStateValue(stateFile, key) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state[key];
  } catch {
    return null;
  }
}

function getPM2Status() {
  try {
    const jlist = execSync('pm2 jlist 2>/dev/null', { timeout: 10000 }).toString();
    const apps = JSON.parse(jlist);
    const summary = { online: 0, stopped: 0, errored: 0, total: apps.length };
    for (const app of apps) {
      const status = app.pm2_env?.status || 'unknown';
      if (status === 'online') summary.online++;
      else if (status === 'stopped' || status === 'waiting restart') summary.stopped++;
      else summary.errored++;
    }
    return summary;
  } catch {
    return null;
  }
}

function run() {
  const date = today();
  const sections = [];

  // Header
  sections.push(`# Morning Brief — ${date}\n`);
  sections.push(`Generated at ${new Date().toISOString()}\n`);

  // PM2 Fleet Status
  const pm2 = getPM2Status();
  if (pm2) {
    sections.push(`## Fleet Status\n`);
    sections.push(`**PM2:** ${pm2.online} online, ${pm2.stopped} stopped/waiting, ${pm2.errored} errored (${pm2.total} total)\n`);
  }

  // Self-Heal Summary
  const healLog = readIfExists(path.join(BRIEF_DIR, `self-heal-${date}.md`));
  if (healLog) {
    sections.push(`## Self-Heal Activity\n`);
    sections.push(healLog + '\n');
  } else {
    const healState = getStateValue(path.join(SCRIPTS_DIR, '.self-heal-state.json'), 'errors');
    if (healState) {
      const total = Object.values(healState).reduce((a, b) => a + b, 0);
      sections.push(`## Self-Heal\n✅ No issues overnight. Cumulative errors today: ${total}\n`);
    }
  }

  // Heartbeat Summary
  const hbState = path.join(SCRIPTS_DIR, '.heartbeat-state.json');
  const hbData = readIfExists(hbState);
  if (hbData) {
    try {
      const state = JSON.parse(hbData);
      const silentAgents = Object.entries(state.misses || {}).filter(([, v]) => v > 0);
      const heals = (state.heals || []).filter(h => h.time?.startsWith(date));
      sections.push(`## Agent Heartbeat\n`);
      if (silentAgents.length > 0) {
        sections.push(`**Silent agents:** ${silentAgents.map(([k, v]) => `${k} (${v} misses)`).join(', ')}\n`);
      } else {
        sections.push(`✅ All agents responsive\n`);
      }
      if (heals.length > 0) {
        sections.push(`**Auto-heals:** ${heals.length}\n`);
      }
    } catch {}
  }

  // Config Drift
  const driftLog = readIfExists(path.join(BRIEF_DIR, `config-drift-${date}.md`));
  if (driftLog) {
    sections.push(`## Config Drift\n⚠️ Drift detected — see config-drift-${date}.md\n`);
  } else {
    sections.push(`## Config Drift\n✅ No unauthorized changes\n`);
  }

  // Correction Propagator
  const corrLog = readIfExists(path.join(BRIEF_DIR, `corrections-${date}.md`));
  if (corrLog) {
    sections.push(`## Correction Propagator\n`);
    sections.push(corrLog + '\n');
  }

  // Skill Health
  const skillLog = readIfExists(path.join(BRIEF_DIR, `skill-health-${date}.md`));
  if (skillLog) {
    // Just extract the summary line
    const lines = skillLog.split('\n');
    const summaryLine = lines.find(l => l.includes('Total invocations') || l.includes('Period'));
    if (summaryLine) {
      sections.push(`## Skill Health\n${summaryLine}\n`);
    }
  }

  // Convention Check
  const convLog = readIfExists(path.join(BRIEF_DIR, `convention-${date}.md`));
  if (convLog) {
    const issueMatch = convLog.match(/Total issues:\*\* (\d+)/);
    const count = issueMatch ? issueMatch[1] : '?';
    sections.push(`## Workspace Convention\n${count === '0' ? '✅' : '⚠️'} ${count} convention issues\n`);
  }

  // Backup Verify
  const backupLog = readIfExists(path.join(BRIEF_DIR, `backup-verify-${date}.md`));
  if (backupLog) {
    sections.push(`## Backup Verification\n⚠️ Issues found — see backup-verify-${date}.md\n`);
  } else {
    sections.push(`## Backup\n✅ Backup verified\n`);
  }

  // Competitive Monitor
  const compLog = readIfExists(path.join(BRIEF_DIR, `competitive-${date}.md`));
  if (compLog) {
    const changedMatch = compLog.match(/Changes detected:\*\* (\d+)/);
    const count = changedMatch ? changedMatch[1] : '0';
    if (count !== '0') {
      sections.push(`## Competitive Intel\n🔴 ${count} competitor changes detected — see competitive-${date}.md\n`);
    }
  }

  // Combine
  const brief = sections.join('\n');

  // Write to daily-brief
  fs.mkdirSync(BRIEF_DIR, { recursive: true });
  const briefFile = path.join(BRIEF_DIR, `morning-brief-${date}.md`);
  fs.writeFileSync(briefFile, brief);

  // Also write to output
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputFile = path.join(OUTPUT_DIR, `${date}-morning-brief.md`);
  fs.writeFileSync(outputFile, brief);

  // Telegram summary (condensed)
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.KEVIN_TELEGRAM_CHAT_ID;
  if (token && chatId) {
    const pm2Line = pm2 ? `Fleet: ${pm2.online}/${pm2.total} online` : '';
    const tgMsg = `☀️ *Morning Brief — ${date}*\n\n${pm2Line}\n${sections.filter(s => s.includes('✅') || s.includes('⚠️') || s.includes('🔴')).join('\n')}`.slice(0, 4000);
    try {
      const encoded = encodeURIComponent(tgMsg);
      execSync(`curl -sf "https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encoded}&parse_mode=Markdown" > /dev/null 2>&1`, { timeout: 10000 });
    } catch {}
  }

  console.log(`[morning-brief] Generated: ${briefFile}`);
}

run();
