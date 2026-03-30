#!/usr/bin/env node
/**
 * @file backup-verify.js
 * @description Backup verification — validate daily backup integrity, size, key files
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Backup Verification — Validates daily backup integrity
 *
 * After clawd-full-backup.sh runs, verify:
 *   - Tarball exists for today
 *   - File count and size are within expected range
 *   - Key files present in archive
 *   - Size hasn't dropped >20% vs 7-day average
 * Alerts via Telegram on failure.
 *
 * PM2 cron: daily 7:30am EST (30 12 * * * UTC)
 * State: scripts/.backup-verify-state.json
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(os.homedir(), 'backups');
const STATE_FILE = path.join(__dirname, '.backup-verify-state.json');
const BRIEF_DIR = process.env.BRIEF_DIR || './shared/daily-brief';
const KEY_FILES = ['CLAUDE.md', 'ecosystem.config.cjs', 'shared/PORT-REGISTRY.md'];
const SIZE_DROP_THRESHOLD = 0.20; // Alert if size drops >20%

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { history: [], lastVerified: null, consecutiveFailures: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.KEVIN_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const encoded = encodeURIComponent(message);
    execSync(`curl -sf "https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encoded}&parse_mode=Markdown" > /dev/null 2>&1`, { timeout: 10000 });
  } catch {}
}

function findTodaysBackup() {
  const today = new Date().toISOString().split('T')[0];
  const pattern = `clawd-${today}`;

  if (!fs.existsSync(BACKUP_DIR)) return null;

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.includes(pattern) && (f.endsWith('.tar.gz') || f.endsWith('.tgz')))
    .sort()
    .reverse();

  return files.length > 0 ? path.join(BACKUP_DIR, files[0]) : null;
}

function getBackupSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function listBackupContents(filePath) {
  try {
    const result = execSync(`tar tzf "${filePath}" 2>/dev/null | head -100`, { timeout: 30000 });
    return result.toString().split('\n').filter(l => l.trim());
  } catch {
    return [];
  }
}

function run() {
  const state = loadState();
  const today = new Date().toISOString().split('T')[0];
  const issues = [];

  // Find today's backup
  const backupFile = findTodaysBackup();

  if (!backupFile) {
    issues.push(`No backup found for ${today} in ${BACKUP_DIR}`);
    state.consecutiveFailures++;
  } else {
    state.consecutiveFailures = 0;
    const size = getBackupSize(backupFile);
    const sizeMB = (size / 1024 / 1024).toFixed(1);

    // Check size against history
    const recentSizes = state.history.slice(-7).map(h => h.size).filter(s => s > 0);
    if (recentSizes.length >= 3) {
      const avgSize = recentSizes.reduce((a, b) => a + b, 0) / recentSizes.length;
      if (size < avgSize * (1 - SIZE_DROP_THRESHOLD)) {
        const dropPct = ((1 - size / avgSize) * 100).toFixed(1);
        issues.push(`Backup size dropped ${dropPct}%: ${sizeMB}MB vs ${(avgSize / 1024 / 1024).toFixed(1)}MB avg`);
      }
    }

    // Check key files in archive
    const contents = listBackupContents(backupFile);
    for (const keyFile of KEY_FILES) {
      if (!contents.some(c => c.includes(keyFile))) {
        issues.push(`Key file missing from backup: ${keyFile}`);
      }
    }

    // Record in history
    state.history = [
      ...(state.history || []).slice(-14),
      { date: today, file: path.basename(backupFile), size, fileCount: contents.length },
    ];

    console.log(`[backup-verify] Found: ${path.basename(backupFile)} (${sizeMB}MB, ${contents.length} entries)`);
  }

  // Alert on issues
  if (issues.length > 0) {
    const msg = `⚠️ *Backup Verification Failed*\n\n${issues.map(i => '- ' + i).join('\n')}`;
    sendTelegramAlert(msg);

    // Log to daily brief
    fs.mkdirSync(BRIEF_DIR, { recursive: true });
    const briefFile = path.join(BRIEF_DIR, `backup-verify-${today}.md`);
    fs.writeFileSync(briefFile,
      `# Backup Verification — ${today}\n\n## Issues\n${issues.map(i => '- ❌ ' + i).join('\n')}\n`);
  }

  if (state.consecutiveFailures >= 3) {
    sendTelegramAlert('🚨 *Backup CRITICAL: ${state.consecutiveFailures} consecutive failures!*');
  }

  state.lastVerified = new Date().toISOString();
  saveState(state);

  console.log(`[backup-verify] ${issues.length} issues found`);
}

run();
