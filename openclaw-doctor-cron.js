#!/usr/bin/env node
/**
 * @file openclaw-doctor-cron.js
 * @description OpenClaw doctor cron — automated health check 2x daily
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * OpenClaw Doctor Cron — Automated health check 2x/day
 *
 * Runs `openclaw doctor` and pipes results to daily-brief.
 * Alerts via Telegram if errors are found.
 *
 * PM2 cron: 2x daily at 10am + 6pm EST (15:00 + 23:00 UTC)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BRIEF_DIR = process.env.BRIEF_DIR || './shared/daily-brief';

function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.KEVIN_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const encoded = encodeURIComponent(message);
    execSync(`curl -sf "https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encoded}&parse_mode=Markdown" > /dev/null 2>&1`, { timeout: 10000 });
  } catch {}
}

function run() {
  const today = new Date().toISOString().split('T')[0];
  const time = new Date().toISOString().slice(11, 19);
  let output = '';
  let hasErrors = false;

  try {
    output = execSync('openclaw doctor 2>&1', { timeout: 30000 }).toString();
  } catch (e) {
    output = e.stdout?.toString() || e.message;
    hasErrors = true;
  }

  // Check for error indicators
  if (output.includes('error') || output.includes('ERROR') || output.includes('FAIL')) {
    hasErrors = true;
  }

  // Log to daily brief
  fs.mkdirSync(BRIEF_DIR, { recursive: true });
  const briefFile = path.join(BRIEF_DIR, `doctor-${today}.md`);
  const entry = `\n## Doctor Run ${time}\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\`\n`;

  fs.appendFileSync(briefFile, entry);

  if (hasErrors) {
    sendTelegramAlert(`⚠️ *OpenClaw Doctor: Issues Found*\n\n${output.slice(0, 500)}`);
  }

  console.log(`[doctor-cron] ${hasErrors ? 'ISSUES FOUND' : 'Clean'}. Logged to ${briefFile}`);
}

run();
