#!/usr/bin/env node
/**
 * doc-sync-watch.cjs
 *
 * Ambient watcher: re-runs doc-sync-from-config.cjs whenever
 * ~/.openclaw/openclaw.json changes (debounced).
 *
 * Run manually:
 *   node scripts/doc-sync-watch.cjs
 *
 * Or via PM2 (NOT auto-started):
 *   pm2 start scripts/doc-sync-watch.cjs --name doc-sync-watch
 *
 * Stops on SIGINT/SIGTERM.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const SYNC_SCRIPT = path.join(__dirname, 'doc-sync-from-config.cjs');
const DEBOUNCE_MS = 1500;

let timer = null;

function runSync() {
  console.log(`[${new Date().toISOString()}] config changed → running doc-sync`);
  const child = spawn('node', [SYNC_SCRIPT], { stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log(`[${new Date().toISOString()}] doc-sync exit=${code}`);
  });
}

function debounce() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(runSync, DEBOUNCE_MS);
}

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`✗ Config not found: ${CONFIG_PATH}`);
  process.exit(2);
}

console.log(`▸ doc-sync-watch — watching ${CONFIG_PATH}`);

const watcher = fs.watch(CONFIG_PATH, { persistent: true }, (event) => {
  if (event === 'change') debounce();
});

const shutdown = () => {
  console.log('\n▸ shutting down doc-sync-watch');
  watcher.close();
  if (timer) clearTimeout(timer);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
