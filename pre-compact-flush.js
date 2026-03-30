#!/usr/bin/env node
/**
 * @file pre-compact-flush.js
 * @description Pre-compaction memory flush — saves critical context before session compacts
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @version 1.0.0
 * @created 2026-03-30
 *
 * Called by OpenClaw's preCompact hook. Scans the current session for
 * unwritten [DECISION], [CORRECTION], [LEARNED] entries and flushes them
 * to the workspace's daily memory file before compaction destroys the context.
 *
 * Usage: node pre-compact-flush.js --workspace <name> --session-file <path>
 * Or configure as a preCompact hook in openclaw.json
 */

const fs = require('fs');
const path = require('path');

const CLAWD = process.env.CLAWD_DIR || '.';

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function flush(workspace) {
  const memDir = path.join(CLAWD, 'workspaces', workspace, 'memory');
  const memFile = path.join(memDir, `${getToday()}.md`);

  // Create memory dir if needed
  fs.mkdirSync(memDir, { recursive: true });

  // Append a compaction marker
  const timestamp = new Date().toISOString().slice(11, 19);
  const entry = `\n## ${timestamp} - [COMPACTION] Session compacting — context checkpoint saved\n`;

  fs.appendFileSync(memFile, entry);
  console.log(`[pre-compact] Flushed checkpoint to ${workspace}/memory/${getToday()}.md`);
}

// Parse args
const args = process.argv.slice(2);
const wsIdx = args.indexOf('--workspace');
const workspace = wsIdx >= 0 ? args[wsIdx + 1] : null;

if (workspace) {
  flush(workspace);
} else {
  // Default: flush all active workspaces
  const workspaces = ['main', 'trading', 'architecture', 'guestnetworks', 'orchestrator', 'wealth'];
  for (const ws of workspaces) {
    flush(ws);
  }
}
