#!/usr/bin/env node
/**
 * auto-dispatcher.js — Unified free fleet auto-assign dispatcher
 *
 * Runs every 30 min via PM2 cron. Handles ALL auto-assignment logic:
 *   1. GET unassigned `todo` issues from Paperclip (whitelisted projects only)
 *   2. Route to best available free agent by label
 *   3. Skip `agent:backlog` issues (AO poller handles those)
 *   4. Optimistic concurrency — only PATCH if assigneeAgentId still null
 *   5. Codex daily-hour cap (4.5h/day)
 *   6. State persistence to dispatch-state.json
 *
 * Adapts patterns from tools/neo-dispatch/ao-bridge.js.
 *
 * Usage:
 *   node auto-dispatcher.js           — normal run
 *   node auto-dispatcher.js --dry-run — log what WOULD be assigned, no PATCHes
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const PAPERCLIP_URL = process.env.PAPERCLIP_URL || 'http://localhost:3110';
const BASE_URL = PAPERCLIP_URL;
const COMPANY_ID = process.env.OPENCLAW_COMPANY_ID || 'd852cff2-1645-4c48-ae14-010bd8230444';
const STATE_FILE = path.join(__dirname, 'dispatch-state.json');

const DRY_RUN = process.argv.includes('--dry-run');
const RATE_LIMIT_DELAY_MS = 2000; // 30 calls/min
const MAX_ASSIGNMENTS_PER_RUN = 5;
const CODEX_DAILY_HOURS_CAP = 4.5;

// Only auto-assign issues from whitelisted projects
const DESIGNATED_PROJECTS = new Set([
  // Add Paperclip project IDs here as they become known
  // e.g. 'proj_dmhub', 'proj_axiom-site', 'proj_mywifi-redesign'
]);
// When empty, dispatches from ALL projects (bootstrap mode)
const ENFORCE_PROJECT_WHITELIST = DESIGNATED_PROJECTS.size > 0;

// ── Agent Registry (from Phase 1 snapshot) ───────────────────────────────────

const AGENTS = {
  // Free Fleet (always try first)
  // Override any agent ID via env vars: AGENT_ID_FORGE, AGENT_ID_FLARE, etc.
  forge:     { id: process.env.AGENT_ID_FORGE    || '1234c699-6592-42a6-b746-266f9618507a', tier: 'free', provider: 'huggingface' },
  flare:     { id: process.env.AGENT_ID_FLARE    || 'da8ba82b-d860-4825-b387-3e3042478441', tier: 'free', provider: 'cloudflare' },
  lama:      { id: process.env.AGENT_ID_LAMA     || 'f4ad011a-cc1c-46ac-a9c5-782891b48185', tier: 'free', provider: 'ollama' },
  oracle:    { id: process.env.AGENT_ID_ORACLE   || 'bc370f55-81db-4e38-bbbb-00eca803d799', tier: 'free', provider: 'groq' },
  codexDev:  { id: process.env.AGENT_ID_CODEX    || 'c8660590-de82-463d-acf4-1e5b9fa22ae7', tier: 'free', provider: 'codex' },
  // Workers
  atlas:     { id: process.env.AGENT_ID_ATLAS    || '6b232cb7-4c59-4afe-ba87-702463ca3ead', tier: 'worker' },
  scribe:    { id: process.env.AGENT_ID_SCRIBE   || '6915128f-5bcd-407b-a677-00cccda07c01', tier: 'worker' },
  pixel:     { id: process.env.AGENT_ID_PIXEL    || 'faa0c49f-5023-47ce-908c-74e17d93fccd', tier: 'worker' },
};

// ── Label-to-Agent Routing (ao-bridge pattern) ───────────────────────────────

const LABEL_ROUTES = {
  // Code work → Codex first (if under cap), then Forge, then Flare
  code:     ['codexDev', 'forge', 'flare'],
  feature:  ['codexDev', 'forge', 'flare'],
  bug:      ['codexDev', 'forge', 'flare'],
  build:    ['codexDev', 'forge', 'flare'],
  api:      ['codexDev', 'forge', 'flare'],
  ui:       ['codexDev', 'forge', 'flare'],
  config:   ['forge', 'flare'],

  // Research → Oracle (Groq, fast), then Atlas
  research: ['oracle', 'atlas'],
  analysis: ['oracle', 'atlas'],

  // Content → Scribe
  content:  ['scribe'],
  writing:  ['scribe'],
  docs:     ['scribe'],

  // Design → Pixel
  design:   ['pixel'],
};

// Default fallback chain if no label matches
const DEFAULT_CHAIN = ['forge', 'flare', 'lama'];

// Labels that the AO backlog poller handles — skip these
const AO_BACKLOG_LABELS = new Set(['agent:backlog']);

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

// ── State persistence (ao-bridge pattern) ────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      dispatched: {},       // issueId → { agentKey, agentId, assignedAt }
      dailyStats: {},       // YYYY-MM-DD → { codexHours, assignments }
      lastRunAt: null,
    };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyStats(state) {
  const key = todayKey();
  if (!state.dailyStats[key]) {
    state.dailyStats[key] = { codexHours: 0, assignments: 0 };
  }
  return state.dailyStats[key];
}

// ── Codex daily hour cap ─────────────────────────────────────────────────────

function isCodexAvailable(state) {
  const stats = getDailyStats(state);
  if (stats.codexHours >= CODEX_DAILY_HOURS_CAP) {
    info(`Codex-dev at ${stats.codexHours}h / ${CODEX_DAILY_HOURS_CAP}h daily cap — skipping.`);
    return false;
  }
  return true;
}

// ── Issue filtering ──────────────────────────────────────────────────────────

function getIssueLabels(issue) {
  if (Array.isArray(issue.labels)) return issue.labels.map(l => typeof l === 'string' ? l : l.name ?? '');
  if (typeof issue.labels === 'string') return issue.labels.split(',').map(l => l.trim());
  return [];
}

function shouldSkipIssue(issue) {
  // Skip if already assigned
  if (issue.assigneeAgentId || issue.assigneeId) return 'already-assigned';

  // Skip non-todo status
  if (issue.status !== 'todo') return `status=${issue.status}`;

  // Skip AO backlog issues
  const labels = getIssueLabels(issue);
  if (labels.some(l => AO_BACKLOG_LABELS.has(l))) return 'ao-backlog';

  // Skip if project whitelist enforced and issue not in it
  if (ENFORCE_PROJECT_WHITELIST && issue.projectId && !DESIGNATED_PROJECTS.has(issue.projectId)) {
    return `project-not-whitelisted`;
  }

  return null;
}

// ── Agent selection (label routing) ──────────────────────────────────────────

function selectAgent(issue, state, busyAgentIds) {
  const labels = getIssueLabels(issue);

  // Find the first matching label route
  let candidateChain = null;
  for (const label of labels) {
    const chain = LABEL_ROUTES[label.toLowerCase()];
    if (chain) {
      candidateChain = chain;
      break;
    }
  }

  if (!candidateChain) {
    candidateChain = DEFAULT_CHAIN;
  }

  // Walk the chain, pick first available
  for (const agentKey of candidateChain) {
    const agent = AGENTS[agentKey];
    if (!agent) continue;

    // Skip busy agents
    if (busyAgentIds.has(agent.id)) continue;

    // Codex daily cap check
    if (agentKey === 'codexDev' && !isCodexAvailable(state)) continue;

    return { agentKey, agentId: agent.id };
  }

  return null; // No available agent
}

// ── Fetch issues ─────────────────────────────────────────────────────────────

async function fetchTodoIssues() {
  try {
    const resp = await apiCall('GET', `/api/companies/${COMPANY_ID}/issues?status=todo&limit=50`, null);
    if (resp.status !== 200) {
      error(`Failed to fetch issues: HTTP ${resp.status}`);
      return null;
    }

    const issues = Array.isArray(resp.body) ? resp.body
      : Array.isArray(resp.body?.issues) ? resp.body.issues
      : Array.isArray(resp.body?.data) ? resp.body.data
      : [];

    return issues;
  } catch (e) {
    error(`Failed to fetch issues: ${e.message}`);
    return null;
  }
}

// ── Fetch agent statuses to find busy ones ───────────────────────────────────

async function fetchBusyAgentIds() {
  const busy = new Set();
  try {
    const resp = await apiCall('GET', `/api/companies/${COMPANY_ID}/agents`, null);
    if (resp.status === 200 && Array.isArray(resp.body)) {
      for (const agent of resp.body) {
        if (agent.status === 'working' || agent.status === 'in_progress' || agent.status === 'busy') {
          busy.add(agent.id);
        }
      }
    }
  } catch (e) {
    warn(`Could not fetch agent statuses: ${e.message}. Proceeding without busy check.`);
  }
  return busy;
}

// ── Assign issue (optimistic concurrency) ────────────────────────────────────

async function assignIssue(issue, agentKey, agentId) {
  if (DRY_RUN) {
    info(`  [DRY-RUN] Would assign issue "${issue.title}" (${issue.id}) → ${agentKey} (${agentId})`);
    return true;
  }

  // Optimistic concurrency: re-fetch issue to confirm still unassigned
  try {
    const check = await apiCall('GET', `/api/issues/${issue.id}`, null);
    if (check.status === 200) {
      const current = check.body;
      if (current.assigneeAgentId || current.assigneeId) {
        warn(`  Issue "${issue.title}" was assigned by someone else — skipping.`);
        return false;
      }
    }
  } catch {
    // If re-fetch fails, proceed with PATCH anyway
  }

  try {
    const resp = await apiCall('PATCH', `/api/issues/${issue.id}`, {
      assigneeAgentId: agentId,
    });

    if (resp.status === 200) {
      info(`  ASSIGNED: "${issue.title}" (${issue.id}) → ${agentKey} (${agentId})`);
      return true;
    } else {
      warn(`  PATCH failed for issue ${issue.id}: HTTP ${resp.status}`);
      return false;
    }
  } catch (e) {
    error(`  PATCH error for issue ${issue.id}: ${e.message}`);
    return false;
  }
}

// ── Main dispatch loop ───────────────────────────────────────────────────────

async function main() {
  info('=== Auto-Dispatcher starting' + (DRY_RUN ? ' [DRY-RUN]' : '') + ' ===');

  const state = loadState();
  state.lastRunAt = ts();

  // Fetch todo issues and agent statuses in sequence (rate limited)
  const issues = await fetchTodoIssues();
  if (!issues) {
    error('Cannot fetch issues — aborting run.');
    saveState(state);
    process.exit(1);
  }

  const busyAgentIds = await fetchBusyAgentIds();

  // Filter to dispatchable issues
  const dispatchable = [];
  for (const issue of issues) {
    const skipReason = shouldSkipIssue(issue);
    if (skipReason) continue;
    dispatchable.push(issue);
  }

  info(`Found ${issues.length} todo issues, ${dispatchable.length} dispatchable (unassigned, not AO-backlog).`);

  if (dispatchable.length === 0) {
    info('No issues to dispatch. Done.');
    saveState(state);
    process.exit(0);
  }

  // Dispatch up to MAX_ASSIGNMENTS_PER_RUN
  let assigned = 0;
  const dailyStats = getDailyStats(state);

  for (const issue of dispatchable) {
    if (assigned >= MAX_ASSIGNMENTS_PER_RUN) {
      info(`Hit max assignments per run (${MAX_ASSIGNMENTS_PER_RUN}). Remaining issues deferred to next run.`);
      break;
    }

    const selection = selectAgent(issue, state, busyAgentIds);
    if (!selection) {
      warn(`  No available agent for issue "${issue.title}" (labels: ${getIssueLabels(issue).join(',') || 'none'}) — skipping.`);
      continue;
    }

    const { agentKey, agentId } = selection;
    const ok = await assignIssue(issue, agentKey, agentId);

    if (ok) {
      assigned++;
      dailyStats.assignments++;

      // Track Codex hours (estimate 1h per assignment)
      if (agentKey === 'codexDev') {
        dailyStats.codexHours += 1;
      }

      // Mark agent as busy for this run
      busyAgentIds.add(agentId);

      // Record dispatch (ao-bridge state pattern)
      state.dispatched[issue.id] = {
        agentKey,
        agentId,
        issueTitle: issue.title,
        assignedAt: ts(),
      };
    }
  }

  // Prune old dispatch records (>7 days)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, record] of Object.entries(state.dispatched)) {
    if (new Date(record.assignedAt).getTime() < cutoff) {
      delete state.dispatched[id];
    }
  }

  // Prune old daily stats (>30 days)
  const statsCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const dateKey of Object.keys(state.dailyStats)) {
    if (dateKey < statsCutoff) {
      delete state.dailyStats[dateKey];
    }
  }

  saveState(state);

  info(`=== Auto-Dispatcher complete: ${assigned} assigned, ${dispatchable.length - assigned} deferred ===`);
  process.exit(0);
}

main().catch(e => {
  error(`Unhandled error: ${e.message}`);
  process.exit(1);
});
