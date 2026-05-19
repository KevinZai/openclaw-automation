#!/usr/bin/env node
/**
 * agent-resource-query.js — Domain agent proposal collector + codebase scanner
 *
 * Runs 2x daily (9am + 6pm EST) via PM2 cron. Two modes:
 *   1. Agent query — polls Prism, Axiom, Jarvis for structured proposals
 *   2. Codebase scan — finds TODOs, large files, missing tests
 *
 * All proposals land as `backlog` issues in Paperclip with
 * [PROPOSED] or [SCAN] prefixes. Kevin approves before anything executes.
 *
 * Usage:
 *   node agent-resource-query.js              — full run (query + scan)
 *   node agent-resource-query.js --query-only — agent queries only
 *   node agent-resource-query.js --scan-only  — codebase scan only
 *   node agent-resource-query.js --dry-run    — log everything, no mutations
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3100';
const COMPANY_ID = 'd852cff2-1645-4c48-ae14-010bd8230444';
const GATEWAY_URL = 'http://localhost:18789';
const STATE_FILE = path.join(__dirname, '.agent-query-state.json');

const DRY_RUN = process.argv.includes('--dry-run');
const QUERY_ONLY = process.argv.includes('--query-only');
const SCAN_ONLY = process.argv.includes('--scan-only');

const RATE_LIMIT_DELAY_MS = 2000;
const AGENT_QUERY_TIMEOUT_MS = 60 * 1000; // 60s per agent
const MAX_PROPOSALS_PER_AGENT = 5;
const MAX_SCAN_PROPOSALS = 5;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

// Projects to scan for codebase issues
const SCAN_PROJECTS = [
  { name: 'dmhub', path: '/Users/ai/clawd/projects/dmhub' },
  { name: 'guestnetworks-mcp', path: '/Users/ai/clawd/projects/guestnetworks-mcp' },
];

// ── Domain agents to query ───────────────────────────────────────────────────
// NOTE: Worker agent blocks sessions_send — cannot be queried

const DOMAIN_AGENTS = [
  {
    name: 'Prism',
    sessionKey: 'agent:main:discord:channel:1480681745669160960',
    prompt: 'Review your designated projects. What improvements, features, or fixes should be prioritized? Respond with a JSON array of proposals, each with: title, description, priority (low/medium/high), labels (array of strings). Max 5 proposals.',
  },
  {
    name: 'Axiom',
    sessionKey: 'agent:axiom:discord:channel:1479364742752755742',
    prompt: 'Review axiom-site and consulting deliverables. What needs building, updating, or researching? Respond with a JSON array of proposals, each with: title, description, priority (low/medium/high), labels (array of strings). Max 5 proposals.',
  },
  {
    name: 'Jarvis',
    sessionKey: 'agent:guestnetworks:slack:C08JGBV2W4X',
    prompt: 'Review MyWiFi platform and GuestNetworks MCP. What features, bugs, or improvements need attention? Respond with a JSON array of proposals, each with: title, description, priority (low/medium/high), labels (array of strings). Max 5 proposals.',
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

async function apiCall(method, urlPath, body, baseUrl = BASE_URL) {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await sleep(RATE_LIMIT_DELAY_MS - elapsed);
  }
  lastCallAt = Date.now();

  return new Promise((resolve, reject) => {
    const url = `${baseUrl}${urlPath}`;
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
    return {
      lastRunAt: null,
      recentTitles: {},  // title → createdAt (for dedup)
      stats: {},         // YYYY-MM-DD → { proposed, created, scanned }
    };
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isDuplicate(state, title) {
  const normalized = title.toLowerCase().trim();
  const existing = state.recentTitles[normalized];
  if (!existing) return false;
  const age = Date.now() - new Date(existing).getTime();
  return age < DEDUP_WINDOW_MS;
}

function recordTitle(state, title) {
  state.recentTitles[title.toLowerCase().trim()] = ts();
}

// Prune old dedup entries
function pruneDedup(state) {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [title, createdAt] of Object.entries(state.recentTitles)) {
    if (new Date(createdAt).getTime() < cutoff) {
      delete state.recentTitles[title];
    }
  }
}

// ── Agent Query via Gateway sessions_send ────────────────────────────────────

async function queryAgent(agent) {
  info(`Querying ${agent.name} (timeout: ${AGENT_QUERY_TIMEOUT_MS / 1000}s)...`);

  if (DRY_RUN) {
    info(`  [DRY-RUN] Would send to ${agent.sessionKey}: "${agent.prompt.slice(0, 80)}..."`);
    return [];
  }

  try {
    // Use OpenClaw gateway RPC to send message and get response
    const resp = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        method: 'sessions_send',
        params: {
          sessionKey: agent.sessionKey,
          message: agent.prompt,
          waitForResponse: true,
          timeout: AGENT_QUERY_TIMEOUT_MS,
        },
      });

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: AGENT_QUERY_TIMEOUT_MS + 5000,
      };

      const req = http.request(`${GATEWAY_URL}/rpc`, options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ error: 'Parse error', raw: data.slice(0, 500) });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`${agent.name} query timeout`)); });
      req.write(payload);
      req.end();
    });

    if (resp.error) {
      warn(`  ${agent.name} returned error: ${JSON.stringify(resp.error).slice(0, 200)}`);
      return [];
    }

    // Try to extract JSON proposals from the response
    const responseText = typeof resp.result === 'string' ? resp.result
      : resp.result?.message ?? resp.result?.content ?? JSON.stringify(resp.result);

    const proposals = parseProposals(responseText, agent.name);
    info(`  ${agent.name} returned ${proposals.length} proposal(s).`);
    return proposals.slice(0, MAX_PROPOSALS_PER_AGENT);

  } catch (e) {
    warn(`  ${agent.name} query failed: ${e.message} — skipping.`);
    return [];
  }
}

function parseProposals(text, agentName) {
  // Try to extract JSON array from response (may be wrapped in markdown code fences)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    warn(`  Could not extract JSON proposals from ${agentName} response.`);
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(p => p.title && typeof p.title === 'string')
      .map(p => ({
        title: p.title.slice(0, 200),
        description: (p.description ?? '').slice(0, 1000),
        priority: ['low', 'medium', 'high'].includes(p.priority) ? p.priority : 'medium',
        labels: Array.isArray(p.labels) ? p.labels.map(String).slice(0, 5) : [],
        source: agentName,
      }));
  } catch {
    warn(`  JSON parse failed for ${agentName} proposals.`);
    return [];
  }
}

// ── Codebase Scanner ─────────────────────────────────────────────────────────

function scanCodebase() {
  info('Running codebase scan...');
  const proposals = [];

  for (const project of SCAN_PROJECTS) {
    if (!fs.existsSync(project.path)) {
      warn(`  Project path not found: ${project.path} — skipping.`);
      continue;
    }

    // Find TODO/FIXME/HACK comments
    try {
      const output = execSync(
        `grep -rn "TODO\\|FIXME\\|HACK" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" "${project.path}" | head -20`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      const lines = output.split('\n').filter(Boolean);
      if (lines.length >= 5) {
        proposals.push({
          title: `[SCAN] ${project.name}: ${lines.length}+ TODO/FIXME comments need attention`,
          description: `Found ${lines.length}+ code annotations:\n${lines.slice(0, 5).map(l => `- ${l.slice(0, 120)}`).join('\n')}`,
          priority: 'low',
          labels: ['code', 'cleanup'],
          source: 'codebase-scan',
        });
      }
    } catch {
      // grep returns exit 1 on no matches — that's fine
    }

    // Find large files (>800 lines)
    try {
      const output = execSync(
        `find "${project.path}/src" -name "*.ts" -o -name "*.tsx" -o -name "*.js" 2>/dev/null | xargs wc -l 2>/dev/null | sort -rn | head -5`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      const lines = output.split('\n').filter(Boolean);
      const largeFiles = lines
        .map(l => {
          const match = l.trim().match(/^(\d+)\s+(.+)/);
          return match ? { lines: parseInt(match[1]), file: match[2] } : null;
        })
        .filter(f => f && f.lines > 800 && !f.file.includes('total'));

      if (largeFiles.length > 0) {
        proposals.push({
          title: `[SCAN] ${project.name}: ${largeFiles.length} file(s) exceed 800 lines`,
          description: `Large files that may benefit from refactoring:\n${largeFiles.map(f => `- ${f.file} (${f.lines} lines)`).join('\n')}`,
          priority: 'low',
          labels: ['code', 'refactor'],
          source: 'codebase-scan',
        });
      }
    } catch {
      // fine if src/ doesn't exist
    }

    if (proposals.length >= MAX_SCAN_PROPOSALS) break;
  }

  info(`Codebase scan found ${proposals.length} proposal(s).`);
  return proposals.slice(0, MAX_SCAN_PROPOSALS);
}

// ── Create Paperclip Issue ───────────────────────────────────────────────────

async function createProposalIssue(proposal, state) {
  const prefixedTitle = proposal.title.startsWith('[') ? proposal.title : `[PROPOSED] ${proposal.title}`;

  if (isDuplicate(state, prefixedTitle)) {
    info(`  DEDUP: "${prefixedTitle}" — skipping (created within 24h).`);
    return false;
  }

  if (DRY_RUN) {
    info(`  [DRY-RUN] Would create: "${prefixedTitle}" (priority: ${proposal.priority}, source: ${proposal.source})`);
    recordTitle(state, prefixedTitle);
    return true;
  }

  try {
    const resp = await apiCall('POST', `/api/companies/${COMPANY_ID}/issues`, {
      title: prefixedTitle,
      description: `${proposal.description}\n\n---\n*Source: ${proposal.source} | Created: ${ts()}*`,
      status: 'backlog',
      priority: proposal.priority,
      labels: proposal.labels,
    });

    if (resp.status === 200 || resp.status === 201) {
      info(`  CREATED: "${prefixedTitle}" → backlog`);
      recordTitle(state, prefixedTitle);
      return true;
    } else {
      warn(`  CREATE FAILED: HTTP ${resp.status} — ${JSON.stringify(resp.body).slice(0, 200)}`);
      return false;
    }
  } catch (e) {
    error(`  CREATE ERROR: ${e.message}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  info('=== Agent Resource Query starting' + (DRY_RUN ? ' [DRY-RUN]' : '') + ' ===');

  const state = loadState();
  state.lastRunAt = ts();
  pruneDedup(state);

  const today = new Date().toISOString().slice(0, 10);
  if (!state.stats[today]) state.stats[today] = { proposed: 0, created: 0, scanned: 0 };
  const todayStats = state.stats[today];

  let allProposals = [];

  // Phase A: Agent queries
  if (!SCAN_ONLY) {
    info('--- Phase A: Querying domain agents ---');
    for (const agent of DOMAIN_AGENTS) {
      const proposals = await queryAgent(agent);
      allProposals.push(...proposals);
      todayStats.proposed += proposals.length;
    }
  }

  // Phase B: Codebase scan
  if (!QUERY_ONLY) {
    info('--- Phase B: Codebase scan ---');
    const scanProposals = scanCodebase();
    allProposals.push(...scanProposals);
    todayStats.scanned += scanProposals.length;
  }

  // Create issues for all proposals
  info(`--- Creating ${allProposals.length} proposal issue(s) ---`);
  let created = 0;
  for (const proposal of allProposals) {
    const ok = await createProposalIssue(proposal, state);
    if (ok) created++;
  }
  todayStats.created += created;

  // Prune old stats (>30 days)
  const statsCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const dateKey of Object.keys(state.stats)) {
    if (dateKey < statsCutoff) delete state.stats[dateKey];
  }

  saveState(state);

  info(`=== Agent Resource Query complete: ${allProposals.length} proposed, ${created} created as backlog ===`);
  process.exit(0);
}

main().catch(e => {
  error(`Unhandled error: ${e.message}`);
  process.exit(1);
});
