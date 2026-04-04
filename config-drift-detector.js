#!/usr/bin/env node
/**
 * @file config-drift-detector.js
 * @description Config drift detector — daily SHA256 hash monitoring of openclaw.json
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Config Drift Detector — Monitors openclaw.json for unauthorized changes
 *
 * Snapshots SHA256 hash of openclaw.json daily.
 * On drift: diffs against last known good, logs to daily-brief.
 * Alerts via Telegram if hash changes unexpectedly.
 * Auto-runs `openclaw doctor` after any detected change.
 *
 * PM2 cron: daily 8am EST (0 13 * * * UTC)
 * State: scripts/.config-drift-state.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const CLAWD_DIR = process.env.CLAWD_DIR || path.join(os.homedir(), 'clawd');
const CONFIG_FILE = path.join(OPENCLAW_DIR, 'openclaw.json');
const STATE_FILE = path.join(__dirname, '.config-drift-state.json');
const BRIEF_DIR = path.join(CLAWD_DIR, 'shared/daily-brief');
const SNAPSHOT_DIR = path.join(__dirname, '.config-snapshots');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastHash: null, lastCheckAt: null, driftCount: 0, history: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.KEVIN_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const encoded = encodeURIComponent(message);
    execSync(`curl -sf "https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encoded}&parse_mode=Markdown" > /dev/null 2>&1`, { timeout: 10000 });
  } catch {}
}

function runDoctor() {
  try {
    const result = execSync('openclaw doctor 2>&1', { timeout: 30000 }).toString();
    return result.trim();
  } catch (e) {
    return `Doctor failed: ${e.message}`;
  }
}

function run() {
  const state = loadState();
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('[config-drift] openclaw.json not found!');
    sendTelegramAlert('🚨 *Config Drift: openclaw.json MISSING*');
    process.exit(1);
  }

  const currentHash = hashFile(CONFIG_FILE);
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  // First run — establish baseline
  if (!state.lastHash) {
    console.log('[config-drift] First run — establishing baseline hash');
    state.lastHash = currentHash;
    state.lastCheckAt = now;
    // Save a snapshot
    fs.copyFileSync(CONFIG_FILE, path.join(SNAPSHOT_DIR, `openclaw-${today}.json`));
    saveState(state);
    return;
  }

  // Compare
  if (currentHash === state.lastHash) {
    console.log('[config-drift] No drift detected — config unchanged');
    state.lastCheckAt = now;
    saveState(state);
    return;
  }

  // DRIFT DETECTED
  state.driftCount++;
  const driftEntry = { date: now, oldHash: state.lastHash.slice(0, 12), newHash: currentHash.slice(0, 12) };
  state.history = [...(state.history || []).slice(-30), driftEntry];

  console.log(`[config-drift] DRIFT DETECTED — hash changed from ${state.lastHash.slice(0, 12)}... to ${currentHash.slice(0, 12)}...`);

  // Save current as new snapshot
  fs.copyFileSync(CONFIG_FILE, path.join(SNAPSHOT_DIR, `openclaw-${today}.json`));

  // Try to find previous snapshot for diff
  let diffSummary = 'No previous snapshot available for diff.';
  const snapshots = fs.readdirSync(SNAPSHOT_DIR)
    .filter(f => f.startsWith('openclaw-') && f.endsWith('.json') && f !== `openclaw-${today}.json`)
    .sort()
    .reverse();

  if (snapshots.length > 0) {
    const prevSnap = path.join(SNAPSHOT_DIR, snapshots[0]);
    try {
      const diff = execSync(`diff --unified=3 "${prevSnap}" "${CONFIG_FILE}" 2>&1 | head -50`, { timeout: 10000 }).toString();
      diffSummary = diff || 'Files differ but diff produced no output.';
    } catch (e) {
      // diff returns exit code 1 when files differ
      diffSummary = e.stdout?.toString().slice(0, 2000) || 'Diff failed.';
    }
  }

  // Run doctor
  const doctorOutput = runDoctor();

  // Log to daily brief
  fs.mkdirSync(BRIEF_DIR, { recursive: true });
  const briefFile = path.join(BRIEF_DIR, `config-drift-${today}.md`);
  const briefContent = `# Config Drift Detected — ${today}\n\n` +
    `**Time:** ${now}\n` +
    `**Old hash:** ${state.lastHash.slice(0, 16)}...\n` +
    `**New hash:** ${currentHash.slice(0, 16)}...\n` +
    `**Total drifts detected:** ${state.driftCount}\n\n` +
    `## Diff (first 50 lines)\n\`\`\`diff\n${diffSummary}\n\`\`\`\n\n` +
    `## Doctor Output\n\`\`\`\n${doctorOutput}\n\`\`\`\n`;

  fs.writeFileSync(briefFile, briefContent);

  // Telegram alert
  sendTelegramAlert(`⚠️ *Config Drift Detected*\n\nopenclaw.json changed.\nHash: ${state.lastHash.slice(0, 8)}→${currentHash.slice(0, 8)}\nDoctor: ${doctorOutput.includes('error') ? '❌ errors found' : '✅ clean'}\n\nCheck: shared/daily-brief/config-drift-${today}.md`);

  // Update state with new hash
  state.lastHash = currentHash;
  state.lastCheckAt = now;
  saveState(state);

  // Keep only last 10 snapshots
  const allSnaps = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.startsWith('openclaw-')).sort();
  while (allSnaps.length > 10) {
    fs.unlinkSync(path.join(SNAPSHOT_DIR, allSnaps.shift()));
  }
}

run();
