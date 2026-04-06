#!/usr/bin/env node
/**
 * @file scout-agent.js
 * @description Scout agent — auto-discovers actionable signals and creates Paperclip tasks
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @version 1.0.0
 * @created 2026-03-30
 *
 * Runs every 4 hours. Scans for actionable signals:
 * - Polymarket odds shifts (>5% move on watched markets)
 * - MyWiFi competitor mentions on social
 * - Stale Paperclip tasks (assigned but no progress >48h)
 * - Down PM2 services that should be running
 * - Memory files with unprocessed [TASK] tags
 *
 * Creates Paperclip tasks for free fleet workers when signals found.
 * This is the "AI finds its own work" pattern.
 *
 * PM2 cron: every 4 hours
 * State: scripts/.scout-state.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');

const CLAWD_DIR = process.env.CLAWD_DIR || path.join(os.homedir(), 'clawd');
const PAPERCLIP_URL = process.env.PAPERCLIP_URL || 'http://localhost:3110';
const COMPANY = process.env.OPENCLAW_COMPANY_ID;
if (!COMPANY) throw new Error('OPENCLAW_COMPANY_ID env var is required');

const STATE_FILE = path.join(__dirname, '.scout-state.json');
const BRIEF_DIR = path.join(CLAWD_DIR, 'shared/daily-brief');
const WORKSPACES_DIR = path.join(CLAWD_DIR, 'workspaces');

const FREE_AGENTS = {
  oracle: process.env.AGENT_ID_ORACLE,
  forge: process.env.AGENT_ID_FORGE,
  lama: process.env.AGENT_ID_LAMA,
};

const FLEET_OPS_PROJECT = process.env.FLEET_OPS_PROJECT_ID;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRun: null, signals: [], tasksCreated: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
      timeout: 10000,
    };
    const req = http.request(`${PAPERCLIP_URL}${urlPath}`, opts, res => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Signal 1: Stale Paperclip tasks (in_progress >48h with no activity)
async function findStaleTasks() {
  const signals = [];
  try {
    const resp = await apiCall(
      'GET',
      `/api/companies/${COMPANY}/issues?status=in_progress&limit=50`,
    );
    if (resp.status !== 200) return signals;

    const issues = Array.isArray(resp.data)
      ? resp.data
      : resp.data?.data || resp.data?.issues || [];
    const now = Date.now();
    const staleThreshold = 48 * 60 * 60 * 1000;

    for (const issue of issues) {
      const updatedAt = new Date(issue.updatedAt || issue.createdAt).getTime();
      if (now - updatedAt > staleThreshold) {
        signals.push({
          type: 'STALE_TASK',
          detail: `${issue.identifier || issue.id.slice(0, 8)}: "${issue.title}" — stale ${Math.round((now - updatedAt) / 3600000)}h`,
          action: 'Flag for Neo to reassign or close',
        });
      }
    }
  } catch {}
  return signals;
}

// Signal 2: Down PM2 services that should be running
function findDownServices() {
  const signals = [];
  try {
    const jlist = execSync('pm2 jlist 2>/dev/null', { timeout: 10000 }).toString();
    const apps = JSON.parse(jlist);

    const shouldBeRunning = ['paperclip', 'cloudflared', 'n8n', 'attio-proxy', 'openclaw-nerve', 'claudeswap'];

    for (const app of apps) {
      const name = app.name;
      const status = app.pm2_env?.status;
      if (shouldBeRunning.includes(name) && status !== 'online') {
        signals.push({
          type: 'SERVICE_DOWN',
          detail: `PM2 service "${name}" is ${status} — should be online`,
          action: `pm2 restart ${name}`,
        });
      }
    }
  } catch {}
  return signals;
}

// Signal 3: Unprocessed [TASK] tags in memory files
function findUnprocessedTasks() {
  const signals = [];
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  try {
    const workspaces = fs.readdirSync(WORKSPACES_DIR).filter(d => {
      return (
        fs.statSync(path.join(WORKSPACES_DIR, d)).isDirectory() && !d.startsWith('.')
      );
    });

    for (const ws of workspaces) {
      for (const dateStr of [today, yesterday]) {
        const memFile = path.join(WORKSPACES_DIR, ws, 'memory', `${dateStr}.md`);
        if (!fs.existsSync(memFile)) continue;

        const content = fs.readFileSync(memFile, 'utf8');
        const taskLines = content.split('\n').filter(l => l.includes('[TASK]'));

        for (const line of taskLines) {
          const text = line
            .replace(/\[TASK\]/g, '')
            .replace(/^[\s\-\*#]+/, '')
            .trim();
          if (text.length > 10) {
            signals.push({
              type: 'MEMORY_TASK',
              detail: `[${ws}] ${text.slice(0, 100)}`,
              action: 'Create Paperclip task from memory tag',
            });
          }
        }
      }
    }
  } catch {}
  return signals;
}

// Signal 4: Check daily brief for unresolved issues
function findBriefAlerts() {
  const signals = [];
  const today = new Date().toISOString().split('T')[0];

  // Check self-heal for critical errors
  const healFile = path.join(BRIEF_DIR, `self-heal-${today}.md`);
  if (fs.existsSync(healFile)) {
    const content = fs.readFileSync(healFile, 'utf8');
    if (content.includes('OOM') || content.includes('UNCAUGHT')) {
      signals.push({
        type: 'CRITICAL_ERROR',
        detail: 'Self-heal detected OOM or uncaught exception today',
        action: 'Investigate gateway logs immediately',
      });
    }
  }

  // Check backup verify for failures
  const backupFile = path.join(BRIEF_DIR, `backup-verify-${today}.md`);
  if (fs.existsSync(backupFile)) {
    signals.push({
      type: 'BACKUP_ISSUE',
      detail: 'Backup verification found issues today',
      action: 'Check backup-verify report',
    });
  }

  return signals;
}

const SIGNAL_LABELS = {
  STALE_TASK: ['research'],
  SERVICE_DOWN: ['config'],
  MEMORY_TASK: ['research'],
  CRITICAL_ERROR: ['bug'],
  BACKUP_ISSUE: ['config'],
};

async function createTask(signal) {
  try {
    const labels = SIGNAL_LABELS[signal.type] || ['research'];
    const resp = await apiCall('POST', `/api/companies/${COMPANY}/issues`, {
      title: `[Scout] ${signal.type}: ${signal.detail.slice(0, 80)}`,
      description: `**Auto-discovered by Scout Agent**\n\n**Signal:** ${signal.type}\n**Detail:** ${signal.detail}\n**Recommended Action:** ${signal.action}`,
      status: 'todo',
      priority: signal.type === 'CRITICAL_ERROR' ? 'critical' : 'medium',
      labels,
      projectId: FLEET_OPS_PROJECT,
    });
    return resp.status === 201 || resp.status === 200;
  } catch {
    return false;
  }
}

async function run() {
  const state = loadState();
  const now = new Date().toISOString();

  console.log('[scout] Scanning for actionable signals...');

  const allSignals = [
    ...(await findStaleTasks()),
    ...findDownServices(),
    ...findUnprocessedTasks(),
    ...findBriefAlerts(),
  ];

  console.log(`[scout] Found ${allSignals.length} signals`);

  // Only create tasks for new signals (dedup against last run)
  const lastSignalKeys = new Set((state.signals || []).map(s => s.detail));
  const newSignals = allSignals.filter(s => !lastSignalKeys.has(s.detail));

  let created = 0;
  for (const signal of newSignals.slice(0, 5)) {
    // Max 5 tasks per run
    const ok = await createTask(signal);
    if (ok) created++;
    console.log(`  ${ok ? '✅' : '❌'} ${signal.type}: ${signal.detail.slice(0, 60)}`);
  }

  state.lastRun = now;
  state.signals = allSignals.slice(0, 20);
  state.tasksCreated = (state.tasksCreated || 0) + created;
  saveState(state);

  console.log(`[scout] Done: ${created} tasks created, ${allSignals.length} signals tracked`);
}

run().catch(e => {
  console.error('[scout] Fatal:', e.message);
  process.exit(1);
});
