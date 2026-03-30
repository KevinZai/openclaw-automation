#!/usr/bin/env node
/**
 * @file pipeline-health-check.js
 * @description Pipeline health check — Paperclip API health + per-agent cost anomaly detection
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * pipeline-health-check.js — Paperclip auto-dispatch pipeline health monitor
 *
 * Runs every 30 minutes via PM2 cron. Checks:
 *   1. Paperclip API liveness
 *   2. Agents stuck in `error` state for >1h (alert only)
 *   3. Issues stuck `in_progress` for >2h (alert only)
 *   4. Free fleet idle vs working utilization
 *   5. Budget guard — $10/day global limit
 *
 * Circuit breaker: 3 consecutive API failures → 5-min pause → retry → stop.
 * State persisted to scripts/.pipeline-health-state.json.
 *
 * Usage:
 *   node pipeline-health-check.js           — normal run
 *   node pipeline-health-check.js --dry-run — simulate without mutating state
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3110';
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || 'YOUR_COMPANY_ID';
const STATE_FILE = path.join(__dirname, '.pipeline-health-state.json');

const CIRCUIT_BREAKER_THRESHOLD = 3;         // failures before tripping
const CIRCUIT_BREAKER_PAUSE_MS = 5 * 60 * 1000; // 5 min
const AGENT_ERROR_THRESHOLD_MS = 60 * 60 * 1000; // 1h
const ISSUE_STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h
const DAILY_BUDGET_LIMIT = 10.00;
const RATE_LIMIT_DELAY_MS = 2000; // 30 calls/min = 1 per 2s
const AGENT_COST_SPIKE_MULTIPLIER = 3; // Alert if agent exceeds 3x its 7-day average
const SESSION_COST_ALERT = 2.00; // Alert if any single session exceeds $2
const AGENTS_SESSION_DIR = process.env.AGENTS_DIR || path.join(os.homedir(), '.openclaw', 'agents');

const DRY_RUN = process.argv.includes('--dry-run');

// Free fleet agent IDs (forge, flare, lama, oracle, codex-dev)
const FREE_FLEET_IDS = new Set([
  process.env.FORGE_AGENT_ID || 'FORGE_AGENT_ID', // forge
  process.env.FLARE_AGENT_ID || 'FLARE_AGENT_ID', // flare
  process.env.LAMA_AGENT_ID || 'LAMA_AGENT_ID', // lama
  process.env.ORACLE_AGENT_ID || 'ORACLE_AGENT_ID', // oracle
  'c8660590-de82-463d-acf4-1e5b9fa22ae7', // codex-dev
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function log(level, msg) {
  process.stdout.write(`[${ts()}] [${level}] ${msg}\n`);
}

function info(msg)  { log('INFO', msg); }
function warn(msg)  { log('WARN', msg); }
function error(msg) { log('ERROR', msg); }

// ── State persistence (gateway-watchdog pattern) ──────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      consecutiveFailures: 0,
      circuitOpen: false,
      circuitOpenedAt: null,
      lastRunAt: null,
      lastSuccessAt: null,
    };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Rate-limited HTTP (port-guard timestamped logging pattern) ────────────────

let lastCallAt = 0;

async function apiGet(urlPath) {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS - elapsed));
  }
  lastCallAt = Date.now();

  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${urlPath}`;
    const req = http.get(url, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── Circuit breaker logic ─────────────────────────────────────────────────────

async function checkCircuitBreaker(state) {
  if (!state.circuitOpen) return false;

  const openedAt = new Date(state.circuitOpenedAt).getTime();
  const elapsed = Date.now() - openedAt;

  if (elapsed < CIRCUIT_BREAKER_PAUSE_MS) {
    const remainingSec = Math.round((CIRCUIT_BREAKER_PAUSE_MS - elapsed) / 1000);
    warn(`Circuit breaker OPEN — pausing (${remainingSec}s remaining). Skipping run.`);
    return true; // still pausing
  }

  // Pause elapsed — do one retry probe
  info('Circuit breaker: pause elapsed, attempting single retry probe...');
  try {
    const resp = await apiGet(`/api/companies/${COMPANY_ID}/agents`);
    if (resp.status === 200) {
      info('Retry probe PASSED — closing circuit breaker.');
      state.circuitOpen = false;
      state.circuitOpenedAt = null;
      state.consecutiveFailures = 0;
      saveState(state);
      return false; // recovered
    }
  } catch (e) {
    warn(`Circuit breaker retry probe error: ${e.message}`);
  }

  error('Retry probe FAILED — circuit breaker remains open. Manual intervention required.');
  error(`Paperclip API at ${BASE_URL} is unresponsive. Check PM2 logs: pm2 logs paperclip`);
  saveState(state);
  return true; // still open
}

function recordFailure(state) {
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !state.circuitOpen) {
    state.circuitOpen = true;
    state.circuitOpenedAt = new Date().toISOString();
    error(`Circuit breaker TRIPPED after ${state.consecutiveFailures} consecutive failures.`);
    error('Pipeline monitoring paused for 5 min. Then one retry before stopping.');
  } else if (!state.circuitOpen) {
    warn(`API failure ${state.consecutiveFailures}/${CIRCUIT_BREAKER_THRESHOLD} before circuit trips.`);
  }
  saveState(state);
}

function recordSuccess(state) {
  if (state.consecutiveFailures > 0) {
    info(`API recovered after ${state.consecutiveFailures} failure(s).`);
  }
  state.consecutiveFailures = 0;
  state.circuitOpen = false;
  state.circuitOpenedAt = null;
  state.lastSuccessAt = new Date().toISOString();
  saveState(state);
}

// ── Health checks ─────────────────────────────────────────────────────────────

// Check 1: API liveness
async function checkApiAlive(state) {
  try {
    const resp = await apiGet(`/api/companies/${COMPANY_ID}/agents`);
    if (resp.status === 200) {
      recordSuccess(state);
      info('Check 1 PASS — Paperclip API alive (agents endpoint 200).');
      return { ok: true, agents: resp.body };
    }
    warn(`Check 1 WARN — API returned HTTP ${resp.status}.`);
    recordFailure(state);
    return { ok: false, agents: null };
  } catch (e) {
    error(`Check 1 FAIL — API unreachable: ${e.message}`);
    recordFailure(state);
    return { ok: false, agents: null };
  }
}

// Check 2: Agents stuck in error state >1h
function checkAgentErrors(agents) {
  if (!Array.isArray(agents)) {
    warn('Check 2 SKIP — agents data unavailable.');
    return;
  }

  const now = Date.now();
  const stuckAgents = agents.filter(agent => {
    if (agent.status !== 'error') return false;
    if (!agent.updatedAt) return true;
    const since = now - new Date(agent.updatedAt).getTime();
    return since > AGENT_ERROR_THRESHOLD_MS;
  });

  if (stuckAgents.length === 0) {
    info('Check 2 PASS — no agents stuck in error state >1h.');
  } else {
    // violation categorization (port-guard pattern)
    const violations = stuckAgents.map(a => ({
      id: a.id,
      name: a.name ?? 'unknown',
      status: a.status,
      stuckSince: a.updatedAt ?? 'unknown',
      stuckMs: a.updatedAt ? now - new Date(a.updatedAt).getTime() : null,
    }));
    warn(`Check 2 ALERT — ${stuckAgents.length} agent(s) stuck in error >1h (alert only, no auto-fix):`);
    for (const v of violations) {
      const stuckMin = v.stuckMs ? Math.round(v.stuckMs / 60000) : '?';
      warn(`  agent=${v.id} name="${v.name}" stuck_min=${stuckMin}`);
    }
  }
}

// Check 3: Stuck in_progress issues >2h
async function checkStuckIssues() {
  try {
    const resp = await apiGet(`/api/companies/${COMPANY_ID}/issues?status=in_progress&limit=100`);
    if (resp.status !== 200) {
      warn(`Check 3 SKIP — issues endpoint returned HTTP ${resp.status}.`);
      return;
    }

    const issues = Array.isArray(resp.body) ? resp.body
      : Array.isArray(resp.body?.issues) ? resp.body.issues
      : Array.isArray(resp.body?.data) ? resp.body.data
      : [];

    const now = Date.now();
    const stuck = issues.filter(issue => {
      const since = issue.updatedAt
        ? now - new Date(issue.updatedAt).getTime()
        : now - new Date(issue.createdAt ?? 0).getTime();
      return since > ISSUE_STUCK_THRESHOLD_MS;
    });

    if (stuck.length === 0) {
      info('Check 3 PASS — no issues stuck in_progress >2h.');
    } else {
      warn(`Check 3 ALERT — ${stuck.length} issue(s) in_progress >2h with no activity:`);
      for (const issue of stuck) {
        const sinceMs = issue.updatedAt
          ? now - new Date(issue.updatedAt).getTime()
          : null;
        const sinceMin = sinceMs ? Math.round(sinceMs / 60000) : '?';
        warn(`  issue=${issue.id} title="${issue.title ?? 'unknown'}" stuck_min=${sinceMin} agent=${issue.assigneeId ?? 'none'}`);
      }
    }
  } catch (e) {
    warn(`Check 3 FAIL — could not fetch issues: ${e.message}`);
  }
}

// Check 4: Free fleet utilization
function checkFreeFleet(agents) {
  if (!Array.isArray(agents)) {
    warn('Check 4 SKIP — agents data unavailable.');
    return;
  }

  const freeFleet = agents.filter(a => FREE_FLEET_IDS.has(a.id));
  const idle = freeFleet.filter(a => a.status === 'idle' || a.status === 'available' || !a.status);
  const working = freeFleet.filter(a => a.status === 'working' || a.status === 'in_progress' || a.status === 'busy');

  info(`Check 4 — Free fleet utilization: ${freeFleet.length} total, ${idle.length} idle, ${working.length} working.`);
  for (const a of freeFleet) {
    info(`  agent=${a.id} name="${a.name ?? 'unknown'}" status=${a.status ?? 'unknown'}`);
  }
}

// Check 5: Budget guard
async function checkBudget() {
  try {
    const resp = await apiGet(`/api/companies/${COMPANY_ID}/budget`);
    if (resp.status === 404 || resp.status === 405) {
      // Endpoint may not exist — try alternate
      info(`Check 5 SKIP — budget endpoint not found (HTTP ${resp.status}). Skipping budget check.`);
      return;
    }
    if (resp.status !== 200) {
      warn(`Check 5 SKIP — budget endpoint returned HTTP ${resp.status}.`);
      return;
    }

    const budget = resp.body;
    const spent = budget?.dailySpend ?? budget?.todaySpend ?? budget?.spent ?? null;

    if (spent === null) {
      info('Check 5 INFO — budget endpoint returned data but spend field not found. Raw: ' + JSON.stringify(budget).slice(0, 200));
      return;
    }

    const spentNum = parseFloat(spent);
    const pct = ((spentNum / DAILY_BUDGET_LIMIT) * 100).toFixed(1);

    if (spentNum >= DAILY_BUDGET_LIMIT) {
      error(`Check 5 ALERT — Daily budget EXCEEDED: $${spentNum.toFixed(2)} >= $${DAILY_BUDGET_LIMIT} limit (${pct}%). Pipeline may be hard-stopped.`);
    } else if (spentNum >= DAILY_BUDGET_LIMIT * 0.8) {
      warn(`Check 5 WARN — Daily budget at ${pct}%: $${spentNum.toFixed(2)} / $${DAILY_BUDGET_LIMIT}.`);
    } else {
      info(`Check 5 PASS — Daily budget OK: $${spentNum.toFixed(2)} / $${DAILY_BUDGET_LIMIT} (${pct}%).`);
    }
  } catch (e) {
    warn(`Check 5 FAIL — budget check error: ${e.message}`);
  }
}

// Check 6: Per-agent cost anomaly detection
function checkAgentCosts(state) {
  if (!fs.existsSync(AGENTS_SESSION_DIR)) {
    info('Check 6 SKIP — agents session dir not found.');
    return;
  }
  if (!state.costHistory) state.costHistory = {};

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(AGENTS_SESSION_DIR).filter(d => {
      const full = path.join(AGENTS_SESSION_DIR, d);
      return fs.statSync(full).isDirectory() && !d.startsWith('_') && d !== 'default';
    });
  } catch (e) {
    warn('Check 6 SKIP — cannot read agents dir: ' + e.message);
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const alerts = [];
  let totalDailyCost = 0;

  for (const agentId of agentDirs) {
    const sessDir = path.join(AGENTS_SESSION_DIR, agentId, 'sessions');
    if (!fs.existsSync(sessDir)) continue;

    let agentDailyCost = 0;
    try {
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(sessDir, file);
        const stat = fs.statSync(filePath);
        const fileDate = stat.mtime.toISOString().split('T')[0];
        if (fileDate !== today) continue;

        const fileSize = stat.size;
        const readSize = Math.min(fileSize, 100 * 1024);
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(readSize);
        fs.readSync(fd, buffer, 0, readSize, Math.max(0, fileSize - readSize));
        fs.closeSync(fd);

        const lines = buffer.toString('utf8').split('
').filter(l => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const cost = entry.cost || entry.session_cost || entry.total_cost || 0;
            if (typeof cost === 'number' && cost > 0) agentDailyCost += cost;
            if (entry.usage) {
              const inp = entry.usage.input_tokens || entry.usage.prompt_tokens || 0;
              const out = entry.usage.output_tokens || entry.usage.completion_tokens || 0;
              const est = (inp * 3 + out * 15) / 1_000_000;
              if (est > 0) agentDailyCost += est;
            }
          } catch { /* skip non-JSON */ }
        }
      }
    } catch { continue; }

    totalDailyCost += agentDailyCost;

    if (!state.costHistory[agentId]) state.costHistory[agentId] = [];
    const lastEntry = state.costHistory[agentId][state.costHistory[agentId].length - 1];
    if (!lastEntry || lastEntry.date !== today) {
      state.costHistory[agentId].push({ date: today, cost: agentDailyCost });
    } else {
      lastEntry.cost = agentDailyCost;
    }
    state.costHistory[agentId] = state.costHistory[agentId].slice(-7);

    const history = state.costHistory[agentId];
    if (history.length >= 3 && agentDailyCost > 0) {
      const pastDays = history.slice(0, -1);
      const avgCost = pastDays.reduce((sum, d) => sum + d.cost, 0) / pastDays.length;
      if (avgCost > 0 && agentDailyCost > avgCost * AGENT_COST_SPIKE_MULTIPLIER) {
        alerts.push('agent=' + agentId + ' cost=$' + agentDailyCost.toFixed(2) + ' avg=$' + avgCost.toFixed(2) + ' (' + (agentDailyCost / avgCost).toFixed(1) + 'x spike)');
      }
    }
    if (agentDailyCost > SESSION_COST_ALERT) {
      alerts.push('agent=' + agentId + ' daily_cost=$' + agentDailyCost.toFixed(2) + ' exceeds $' + SESSION_COST_ALERT + ' threshold');
    }
  }

  if (alerts.length === 0) {
    info('Check 6 PASS — Agent cost tracking: $' + totalDailyCost.toFixed(2) + ' total today across ' + agentDirs.length + ' agents.');
  } else {
    warn('Check 6 ALERT — ' + alerts.length + ' cost anomalies detected:');
    for (const alert of alerts) { warn('  ' + alert); }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  info('=== Paperclip Pipeline Health Check starting' + (DRY_RUN ? ' [DRY-RUN]' : '') + ' ===');

  const state = loadState();
  state.lastRunAt = new Date().toISOString();

  // Circuit breaker gate
  const stillOpen = await checkCircuitBreaker(state);
  if (stillOpen) {
    saveState(state);
    process.exit(1);
  }

  // Check 1: API liveness (also fetches agents for checks 2 + 4)
  const { ok, agents } = await checkApiAlive(state);

  if (!ok) {
    // If circuit just tripped, exit 1
    saveState(state);
    info('=== Health check complete with errors ===');
    process.exit(1);
  }

  // Check 2: Agent error states
  checkAgentErrors(agents);

  // Check 3: Stuck issues (requires separate API call)
  await checkStuckIssues();

  // Check 4: Free fleet utilization
  checkFreeFleet(agents);

  // Check 5: Budget guard
  await checkBudget();

  // Check 6: Per-agent cost anomaly detection
  checkAgentCosts(state);

  saveState(state);
  info('=== Health check complete ===');
  process.exit(0);
}

main().catch(e => {
  error(`Unhandled error: ${e.message}`);
  try {
    const state = loadState();
    state.lastRunAt = new Date().toISOString();
    saveState(state);
  } catch {
    // State save failed — nothing more we can do
  }
  process.exit(1);
});
