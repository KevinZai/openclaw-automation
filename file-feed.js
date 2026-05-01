#!/usr/bin/env node
/**
 * @file file-feed.js
 * @description Live file activity feed — logs every MD/output file created or modified
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @version 1.0.0
 * @created 2026-03-30
 *
 * Polls ~/clawd/ for recent file changes every 60 seconds.
 * Appends to shared/feed.log with Tailscale-friendly links.
 * Also generates shared/feed.html for browser viewing.
 *
 * PM2 cron: continuous (autorestart: true)
 */

const fs = require('fs');
const path = require('path');

const CLAWD = process.env.CLAWD_DIR || path.join(require('os').homedir(), 'clawd');
const FEED_LOG = path.join(CLAWD, 'shared/feed.log');
const FEED_HTML = path.join(CLAWD, 'shared/feed.html');
const FILES_BASE_URL = process.env.FILES_BASE_URL || 'http://localhost:8080';
const POLL_INTERVAL = 60000; // 60 seconds
const STATE_FILE = path.join(CLAWD, 'scripts/.file-feed-state.json');

const PERSONAL_SHARE_DIR = process.env.OPENCLAW_SHARE_DIR || 'shared/kevinzai';

const WATCH_DIRS = [
  PERSONAL_SHARE_DIR,
  'shared/products',
  'shared/daily-brief',
  'shared/pending-improvements',
  'shared/pending-rules',
  'output',
  'workspaces/main/memory',
  'workspaces/trading/memory',
  'workspaces/guestnetworks/memory',
  'workspaces/architecture/memory',
  'workspaces/dev/memory',
  'workspaces/wealth/memory',
];

const WATCH_EXTENSIONS = new Set(['.md', '.html', '.json', '.csv', '.txt', '.log']);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastScan: 0, knownFiles: {} }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function scanDir(dir, since) {
  const changes = [];
  const fullDir = path.join(CLAWD, dir);
  if (!fs.existsSync(fullDir)) return changes;

  const walk = (d) => {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(full);
        } else if (entry.isFile() && WATCH_EXTENSIONS.has(path.extname(entry.name))) {
          try {
            const stat = fs.statSync(full);
            const mtime = stat.mtimeMs;
            const relPath = full.replace(CLAWD + '/', '');
            if (mtime > since) {
              const isNew = stat.birthtimeMs > since;
              changes.push({
                action: isNew ? 'CREATED' : 'MODIFIED',
                path: relPath,
                time: new Date(mtime).toISOString(),
                size: stat.size,
              });
            }
          } catch {}
        }
      }
    } catch {}
  };

  walk(fullDir);
  return changes;
}

function appendFeedLog(changes) {
  if (changes.length === 0) return;

  const lines = changes.map(c => {
    const link = `${FILES_BASE_URL}/${c.path}`;
    const sizeKB = (c.size / 1024).toFixed(1);
    return `${c.time} ${c.action.padEnd(8)} ${c.path} (${sizeKB}KB) ${link}`;
  }).join('\n');

  fs.appendFileSync(FEED_LOG, lines + '\n');
}

function generateFeedHtml(maxEntries = 100) {
  let entries = [];
  try {
    const log = fs.readFileSync(FEED_LOG, 'utf8');
    entries = log.trim().split('\n').filter(l => l.trim()).reverse().slice(0, maxEntries);
  } catch {}

  const rows = entries.map(line => {
    const match = line.match(/^(\S+)\s+(CREATED|MODIFIED)\s+(\S+)\s+\(([^)]+)\)\s+(.+)$/);
    if (!match) return `<tr><td colspan="5">${line}</td></tr>`;
    const [, time, action, filepath, size, link] = match;
    const icon = action === 'CREATED' ? '🆕' : '✏️';
    const timeStr = time.replace('T', ' ').slice(0, 19);
    return `<tr>
      <td>${icon} ${action}</td>
      <td>${timeStr}</td>
      <td><a href="${link}" target="_blank">${filepath}</a></td>
      <td>${size}</td>
    </tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>OpenClaw File Feed</title>
  <meta http-equiv="refresh" content="30">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0f1e; color: #f9fafb; padding: 20px; }
    h1 { color: #00d4ff; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 8px; border-bottom: 2px solid #333; color: #00d4ff; }
    td { padding: 6px 8px; border-bottom: 1px solid #222; }
    a { color: #00d4ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .meta { color: #666; font-size: 12px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <h1>OpenClaw File Feed</h1>
  <p class="meta">Auto-refreshes every 30s | ${entries.length} entries | <a href="/feed.log">Raw log</a></p>
  <table>
    <thead><tr><th>Action</th><th>Time</th><th>File</th><th>Size</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;

  fs.writeFileSync(FEED_HTML, html);
}

function poll() {
  const state = loadState();
  const since = state.lastScan || (Date.now() - 120000); // Default: last 2 min
  const now = Date.now();

  const allChanges = [];
  for (const dir of WATCH_DIRS) {
    allChanges.push(...scanDir(dir, since));
  }

  if (allChanges.length > 0) {
    appendFeedLog(allChanges);
    generateFeedHtml();
    console.log(`[file-feed] ${allChanges.length} changes logged`);
  }

  state.lastScan = now;
  saveState(state);
}

// Run once immediately, then poll
poll();
setInterval(poll, POLL_INTERVAL);
console.log(`[file-feed] Watching ${WATCH_DIRS.length} directories, polling every ${POLL_INTERVAL/1000}s`);
