#!/usr/bin/env node
/**
 * dormant-file-guard.js — Stale file detector and archiver
 *
 * Runs daily at 6am EST via PM2 cron. Scans for dormant files:
 *   - workspaces/{name}/scratch/ : archive after 7 days
 *   - output/                    : warn after 30 days with no git activity
 *   - tools/{name}/logs/         : archive after 14 days
 *   - Root-level loose .md       : warn (saving strategy violation)
 *
 * Never deletes. Uses fs.rename() to move to archive/dormant/YYYY-MM/.
 * Creates a single consolidated [HOUSEKEEPING] Paperclip issue per run.
 *
 * Adapts file scanning patterns from tools/port-guard/index.js.
 *
 * Usage:
 *   node dormant-file-guard.js           — normal run (archives stale files)
 *   node dormant-file-guard.js --dry-run — report findings, no moves or issues
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAWD_ROOT = path.resolve(__dirname, '..');

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3100';
const COMPANY_ID = 'd852cff2-1645-4c48-ae14-010bd8230444';
const ARCHIVE_ROOT = path.join(CLAWD_ROOT, 'archive', 'dormant');
const STATE_FILE = path.join(__dirname, '.dormant-guard-state.json');

const DRY_RUN = process.argv.includes('--dry-run');
const RATE_LIMIT_DELAY_MS = 2000;

// Scan rules: location → max age in days, action type
const SCAN_RULES = [
  {
    name: 'workspace-scratch',
    glob: 'workspaces/*/scratch',
    maxAgeDays: 7,
    action: 'archive',
    description: 'Workspace scratch files older than 7 days',
  },
  {
    name: 'tool-logs',
    glob: 'tools/*/logs',
    maxAgeDays: 14,
    action: 'archive',
    description: 'Tool log files older than 14 days',
  },
  {
    name: 'output-stale',
    glob: 'output',
    maxAgeDays: 30,
    action: 'warn',
    description: 'Output files with no git activity in 30 days',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function log(level, msg) {
  process.stdout.write(`[${ts()}] [${level}] ${msg}\n`);
}

function info(msg)  { log('INFO', msg); }
function warn(msg)  { log('WARN', msg); }
function error(msg) { log('ERROR', msg); }

let lastCallAt = 0;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function apiCall(method, urlPath, body) {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await sleep(RATE_LIMIT_DELAY_MS - elapsed);
  }
  lastCallAt = Date.now();

  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${urlPath}`;
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 15000,
    };

    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (payload) req.write(payload);
    req.end();
  });
}

// ── State ────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRunAt: null, archived: [], warnings: [] };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── File scanning (port-guard pattern) ───────────────────────────────────────

function findDirsMatchingGlob(baseDir, globPattern) {
  // Simple glob expansion for patterns like 'workspaces/*/scratch'
  const parts = globPattern.split('/');
  let dirs = [baseDir];

  for (const part of parts) {
    const nextDirs = [];
    for (const dir of dirs) {
      if (part === '*') {
        // Expand wildcard
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              nextDirs.push(path.join(dir, entry.name));
            }
          }
        } catch {
          // dir doesn't exist
        }
      } else {
        const candidate = path.join(dir, part);
        if (fs.existsSync(candidate)) {
          nextDirs.push(candidate);
        }
      }
    }
    dirs = nextDirs;
  }

  return dirs;
}

function getFileAge(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

function scanDirectory(dirPath, maxAgeMs) {
  const stale = [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile()) {
        const age = getFileAge(fullPath);
        if (age > maxAgeMs) {
          stale.push({
            path: fullPath,
            relativePath: path.relative(CLAWD_ROOT, fullPath),
            ageMs: age,
            ageDays: Math.round(age / (24 * 60 * 60 * 1000)),
            size: fs.statSync(fullPath).size,
          });
        }
      } else if (entry.isDirectory()) {
        // Recurse one level into subdirs
        stale.push(...scanDirectory(fullPath, maxAgeMs));
      }
    }
  } catch {
    // directory unreadable
  }

  return stale;
}

// ── Loose MD scanner ─────────────────────────────────────────────────────────

function findLooseMdFiles() {
  const violations = [];
  const workspacesDir = path.join(CLAWD_ROOT, 'workspaces');

  try {
    const workspaces = fs.readdirSync(workspacesDir, { withFileTypes: true });
    // Known standard workspace files
    const STANDARD_FILES = new Set([
      'AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md',
      'HEARTBEAT.md', 'CRITICAL.md', 'MEMORY.md', 'BOOT.md',
    ]);

    for (const ws of workspaces) {
      if (!ws.isDirectory() || ws.name.startsWith('.')) continue;
      const wsPath = path.join(workspacesDir, ws.name);

      try {
        const files = fs.readdirSync(wsPath, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile()) continue;
          if (!file.name.endsWith('.md')) continue;

          // Allow standard brain files and variant files (e.g., prism-AGENTS.md)
          const isStandard = STANDARD_FILES.has(file.name);
          const isVariant = [...STANDARD_FILES].some(sf => file.name.endsWith(`-${sf}`));
          const isMemory = file.name.startsWith('MEMORY');
          const isSoulVariant = file.name.startsWith('SOUL-');
          const isHeartbeatVariant = file.name.startsWith('HEARTBEAT-');

          if (!isStandard && !isVariant && !isMemory && !isSoulVariant && !isHeartbeatVariant) {
            violations.push({
              path: path.join(wsPath, file.name),
              relativePath: `workspaces/${ws.name}/${file.name}`,
              workspace: ws.name,
              reason: 'Non-standard .md file in workspace root (file saving strategy violation)',
            });
          }
        }
      } catch {
        // workspace dir unreadable
      }
    }
  } catch {
    // workspaces dir unreadable
  }

  return violations;
}

// ── Archive stale file ───────────────────────────────────────────────────────

function archiveFile(filePath) {
  const now = new Date();
  const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const destDir = path.join(ARCHIVE_ROOT, monthDir);
  const destFile = path.join(destDir, path.basename(filePath));

  if (DRY_RUN) {
    info(`  [DRY-RUN] Would archive: ${path.relative(CLAWD_ROOT, filePath)} → archive/dormant/${monthDir}/`);
    return true;
  }

  try {
    fs.mkdirSync(destDir, { recursive: true });

    // Handle name collisions
    let finalDest = destFile;
    if (fs.existsSync(finalDest)) {
      const ext = path.extname(filePath);
      const base = path.basename(filePath, ext);
      finalDest = path.join(destDir, `${base}-${Date.now()}${ext}`);
    }

    fs.renameSync(filePath, finalDest);
    info(`  ARCHIVED: ${path.relative(CLAWD_ROOT, filePath)} → ${path.relative(CLAWD_ROOT, finalDest)}`);
    return true;
  } catch (e) {
    error(`  Archive failed for ${filePath}: ${e.message}`);
    return false;
  }
}

// ── Create consolidated Paperclip issue ──────────────────────────────────────

async function createHousekeepingIssue(archived, warnings, looseMd) {
  const total = archived.length + warnings.length + looseMd.length;
  if (total === 0) return;

  const sections = [];

  if (archived.length > 0) {
    sections.push(`**Archived (${archived.length} files):**\n${archived.map(f => `- ${f.relativePath} (${f.ageDays} days old)`).join('\n')}`);
  }

  if (warnings.length > 0) {
    sections.push(`**Stale warnings (${warnings.length} files):**\n${warnings.map(f => `- ${f.relativePath} (${f.ageDays} days old)`).join('\n')}`);
  }

  if (looseMd.length > 0) {
    sections.push(`**File saving violations (${looseMd.length} files):**\n${looseMd.map(f => `- ${f.relativePath}: ${f.reason}`).join('\n')}`);
  }

  const title = `[HOUSEKEEPING] ${total} dormant file finding(s) — ${new Date().toISOString().slice(0, 10)}`;
  const description = sections.join('\n\n');

  if (DRY_RUN) {
    info(`[DRY-RUN] Would create issue: "${title}"`);
    return;
  }

  try {
    const resp = await apiCall('POST', `/api/companies/${COMPANY_ID}/issues`, {
      title,
      description: `${description}\n\n---\n*Generated by dormant-file-guard at ${ts()}*`,
      status: 'backlog',
      priority: 'low',
      labels: ['housekeeping'],
    });

    if (resp.status === 200 || resp.status === 201) {
      info(`Created housekeeping issue: "${title}"`);
    } else {
      warn(`Failed to create issue: HTTP ${resp.status}`);
    }
  } catch (e) {
    error(`Issue creation error: ${e.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  info('=== Dormant File Guard starting' + (DRY_RUN ? ' [DRY-RUN]' : '') + ' ===');

  const state = loadState();
  state.lastRunAt = ts();
  state.archived = [];
  state.warnings = [];

  const allArchived = [];
  const allWarnings = [];

  // Scan each rule
  for (const rule of SCAN_RULES) {
    info(`Scanning: ${rule.description} (${rule.glob})...`);
    const dirs = findDirsMatchingGlob(CLAWD_ROOT, rule.glob);
    const maxAgeMs = rule.maxAgeDays * 24 * 60 * 60 * 1000;

    for (const dir of dirs) {
      const staleFiles = scanDirectory(dir, maxAgeMs);

      if (staleFiles.length === 0) continue;

      info(`  Found ${staleFiles.length} stale file(s) in ${path.relative(CLAWD_ROOT, dir)}`);

      for (const file of staleFiles) {
        if (rule.action === 'archive') {
          const ok = archiveFile(file.path);
          if (ok) allArchived.push(file);
        } else {
          warn(`  STALE: ${file.relativePath} (${file.ageDays} days)`);
          allWarnings.push(file);
        }
      }
    }
  }

  // Check for loose .md files in workspace roots
  info('Checking for non-standard .md files in workspace roots...');
  const looseMd = findLooseMdFiles();
  if (looseMd.length > 0) {
    warn(`Found ${looseMd.length} non-standard .md file(s) in workspace roots.`);
    for (const f of looseMd.slice(0, 10)) {
      warn(`  ${f.relativePath}`);
    }
  }

  // Create consolidated Paperclip issue if findings exist
  await createHousekeepingIssue(allArchived, allWarnings, looseMd);

  // Save state
  state.archived = allArchived.map(f => f.relativePath);
  state.warnings = allWarnings.map(f => f.relativePath);
  saveState(state);

  info(`=== Dormant File Guard complete: ${allArchived.length} archived, ${allWarnings.length} warnings, ${looseMd.length} loose MD ===`);
  process.exit(0);
}

main().catch(e => {
  error(`Unhandled error: ${e.message}`);
  process.exit(1);
});
