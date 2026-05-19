#!/usr/bin/env node
/**
 * rollback-pipeline.js — Emergency rollback for the Paperclip auto-dispatch pipeline
 *
 * Steps:
 *   1. Read most recent agent snapshot from /tmp/paperclip-agents-snapshot-*.json
 *   2. PATCH all agents to set heartbeat.enabled: false (disables auto-wakeup)
 *   3. Stop PM2 crons: auto-dispatcher, agent-resource-query, dormant-file-guard, pipeline-health-check
 *   4. Log rollback event to stdout
 *
 * With --restore flag: also restores runtimeConfigs from snapshot.
 *
 * Usage:
 *   node rollback-pipeline.js             — disable heartbeats + stop PM2 crons
 *   node rollback-pipeline.js --restore   — also restore runtimeConfigs from snapshot
 *   node rollback-pipeline.js --dry-run   — print what would happen, no mutations
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3100';
const COMPANY_ID = 'd852cff2-1645-4c48-ae14-010bd8230444';
const SNAPSHOT_GLOB_DIR = '/tmp';
const SNAPSHOT_PREFIX = 'paperclip-agents-snapshot-';

const PM2_CRONS_TO_STOP = [
  'auto-dispatcher',
  'agent-resource-query',
  'dormant-file-guard',
  'pipeline-health-check',
];

const RATE_LIMIT_DELAY_MS = 2000; // 30 calls/min
const DRY_RUN = process.argv.includes('--dry-run');
const RESTORE = process.argv.includes('--restore');

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

// ── Step 1: Find most recent snapshot ────────────────────────────────────────

function findLatestSnapshot() {
  let files;
  try {
    files = fs.readdirSync(SNAPSHOT_GLOB_DIR);
  } catch (e) {
    throw new Error(`Cannot read ${SNAPSHOT_GLOB_DIR}: ${e.message}`);
  }

  const snapshots = files
    .filter(f => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith('.json'))
    .map(f => {
      const fullPath = path.join(SNAPSHOT_GLOB_DIR, f);
      const stat = fs.statSync(fullPath);
      return { file: f, fullPath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  if (snapshots.length === 0) {
    throw new Error(`No snapshot files found matching ${SNAPSHOT_GLOB_DIR}/${SNAPSHOT_PREFIX}*.json`);
  }

  return snapshots[0];
}

function loadSnapshot(snapshotPath) {
  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const data = JSON.parse(raw);

    // Support array of agents or wrapped object
    const agents = Array.isArray(data) ? data
      : Array.isArray(data?.agents) ? data.agents
      : null;

    if (!agents) {
      throw new Error(`Snapshot at ${snapshotPath} does not contain an agents array. Keys: ${Object.keys(data).join(', ')}`);
    }

    return agents;
  } catch (e) {
    throw new Error(`Cannot load snapshot ${snapshotPath}: ${e.message}`);
  }
}

// ── Step 2: Disable heartbeats via PATCH ─────────────────────────────────────

async function disableAgentHeartbeats(agents) {
  info(`Disabling heartbeats for ${agents.length} agent(s)...`);

  const results = [];

  for (const agent of agents) {
    const agentId = agent.id;
    if (!agentId) {
      warn(`Skipping agent with no id: ${JSON.stringify(agent).slice(0, 100)}`);
      continue;
    }

    if (DRY_RUN) {
      info(`  [DRY-RUN] Would PATCH /api/agents/${agentId} heartbeat.enabled=false`);
      results.push({ id: agentId, status: 'dry-run' });
      continue;
    }

    try {
      const resp = await apiCall('PATCH', `/api/agents/${agentId}`, {
        heartbeat: { enabled: false },
      });

      if (resp.status === 200) {
        info(`  PATCH OK — agent ${agentId} (${agent.name ?? 'unknown'}) heartbeat disabled.`);
        results.push({ id: agentId, name: agent.name, status: 'ok' });
      } else {
        warn(`  PATCH ${resp.status} — agent ${agentId}: ${JSON.stringify(resp.body).slice(0, 200)}`);
        results.push({ id: agentId, name: agent.name, status: `http-${resp.status}` });
      }
    } catch (e) {
      error(`  PATCH FAIL — agent ${agentId}: ${e.message}`);
      results.push({ id: agentId, name: agent.name, status: 'error', error: e.message });
    }
  }

  const ok = results.filter(r => r.status === 'ok' || r.status === 'dry-run').length;
  const failed = results.filter(r => r.status !== 'ok' && r.status !== 'dry-run').length;
  info(`Heartbeat disable complete: ${ok} OK, ${failed} failed.`);

  return results;
}

// ── Step 3: Restore runtimeConfigs from snapshot ──────────────────────────────

async function restoreRuntimeConfigs(agents) {
  info(`Restoring runtimeConfigs for ${agents.length} agent(s)...`);

  const results = [];

  for (const agent of agents) {
    const agentId = agent.id;
    if (!agentId) continue;

    const runtimeConfig = agent.runtimeConfig ?? agent.config ?? agent.settings;
    if (!runtimeConfig) {
      warn(`  Agent ${agentId} has no runtimeConfig in snapshot — skipping.`);
      continue;
    }

    if (DRY_RUN) {
      info(`  [DRY-RUN] Would PATCH /api/agents/${agentId} runtimeConfig: ${JSON.stringify(runtimeConfig).slice(0, 100)}`);
      results.push({ id: agentId, status: 'dry-run' });
      continue;
    }

    try {
      const resp = await apiCall('PATCH', `/api/agents/${agentId}`, { runtimeConfig });

      if (resp.status === 200) {
        info(`  Restored runtimeConfig for agent ${agentId} (${agent.name ?? 'unknown'}).`);
        results.push({ id: agentId, name: agent.name, status: 'ok' });
      } else {
        warn(`  Restore ${resp.status} — agent ${agentId}: ${JSON.stringify(resp.body).slice(0, 200)}`);
        results.push({ id: agentId, name: agent.name, status: `http-${resp.status}` });
      }
    } catch (e) {
      error(`  Restore FAIL — agent ${agentId}: ${e.message}`);
      results.push({ id: agentId, name: agent.name, status: 'error', error: e.message });
    }
  }

  const ok = results.filter(r => r.status === 'ok' || r.status === 'dry-run').length;
  const failed = results.filter(r => r.status !== 'ok' && r.status !== 'dry-run').length;
  info(`runtimeConfig restore complete: ${ok} OK, ${failed} failed.`);
  return results;
}

// ── Step 4: Stop PM2 crons ────────────────────────────────────────────────────

function stopPm2Crons() {
  info(`Stopping ${PM2_CRONS_TO_STOP.length} PM2 service(s): ${PM2_CRONS_TO_STOP.join(', ')}`);

  // violation categorization (port-guard pattern) — track per-service outcome
  const violations = [];
  const stopped = [];

  for (const svc of PM2_CRONS_TO_STOP) {
    if (DRY_RUN) {
      info(`  [DRY-RUN] Would run: pm2 stop ${svc}`);
      stopped.push(svc);
      continue;
    }

    try {
      const output = execSync(`pm2 stop ${svc} 2>&1`, { encoding: 'utf8', timeout: 15000 });
      info(`  pm2 stop ${svc} OK${output.trim() ? ': ' + output.trim().split('\n')[0] : ''}`);
      stopped.push(svc);
    } catch (e) {
      const stderr = e.stdout ?? e.stderr ?? e.message ?? '';
      if (/not found|not running|no process/i.test(stderr)) {
        warn(`  pm2 stop ${svc} — process not found or not running (may already be stopped)`);
        stopped.push(svc); // not a blocking error
      } else {
        error(`  pm2 stop ${svc} FAILED: ${stderr.slice(0, 200)}`);
        violations.push({ service: svc, error: stderr.slice(0, 200), status: 'pm2-stop-failed' });
      }
    }
  }

  if (violations.length > 0) {
    warn(`PM2 stop violations: ${violations.length} service(s) failed to stop.`);
    for (const v of violations) {
      warn(`  service=${v.service} status=${v.status} error=${v.error}`);
    }
  }

  info(`PM2 stop complete: ${stopped.length} stopped/confirmed, ${violations.length} failed.`);
  return { stopped, violations };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  info('=== Paperclip Pipeline Emergency Rollback' + (DRY_RUN ? ' [DRY-RUN]' : '') + (RESTORE ? ' [--restore]' : '') + ' ===');
  warn('This rollback will disable agent heartbeats and stop pipeline PM2 crons.');

  if (!DRY_RUN) {
    warn('LIVE MODE — changes will be applied. Use --dry-run to preview first.');
  }

  // Step 1: Find and load snapshot
  info('Step 1: Locating agent snapshot...');
  let snapshot;
  let snapshotMeta;
  try {
    snapshotMeta = findLatestSnapshot();
    info(`  Found snapshot: ${snapshotMeta.fullPath} (modified: ${new Date(snapshotMeta.mtime).toISOString()})`);
    snapshot = loadSnapshot(snapshotMeta.fullPath);
    info(`  Loaded ${snapshot.length} agent(s) from snapshot.`);
  } catch (e) {
    error(`Step 1 FAILED: ${e.message}`);
    error('Cannot proceed without a valid snapshot. Create one with: node scripts/snapshot-agents.js');
    process.exit(1);
  }

  // Step 2: Disable heartbeats
  info('Step 2: Disabling agent heartbeats...');
  const heartbeatResults = await disableAgentHeartbeats(snapshot);

  const heartbeatFailed = heartbeatResults.filter(r => r.status !== 'ok' && r.status !== 'dry-run');
  if (heartbeatFailed.length > 0) {
    warn(`${heartbeatFailed.length} agent(s) failed heartbeat disable — proceeding anyway.`);
  }

  // Step 2b (conditional): Restore runtimeConfigs
  if (RESTORE) {
    info('Step 2b: Restoring runtimeConfigs from snapshot...');
    await restoreRuntimeConfigs(snapshot);
  }

  // Step 3: Stop PM2 crons
  info('Step 3: Stopping PM2 pipeline crons...');
  const { stopped, violations: pm2Violations } = stopPm2Crons();

  // Step 4: Log rollback summary
  info('');
  info('=== Rollback Summary ===');
  info(`  Snapshot: ${snapshotMeta?.fullPath ?? 'N/A'}`);
  info(`  Agents processed: ${heartbeatResults.length}`);
  info(`  Heartbeats disabled: ${heartbeatResults.filter(r => r.status === 'ok').length}` + (DRY_RUN ? ' (dry-run)' : ''));
  info(`  runtimeConfigs restored: ${RESTORE ? 'yes' : 'no (--restore not set)'}`);
  info(`  PM2 crons stopped: ${stopped.join(', ')}`);
  if (pm2Violations.length > 0) {
    warn(`  PM2 failures: ${pm2Violations.map(v => v.service).join(', ')}`);
  }
  info(`  Completed at: ${ts()}`);

  const anyError = heartbeatFailed.length > 0 || pm2Violations.length > 0;
  if (anyError) {
    warn('Rollback completed with warnings — review WARN/ERROR lines above.');
    process.exit(1);
  } else {
    info('Rollback completed successfully.');
    info('To re-enable the pipeline: re-enable heartbeats per agent and run: pm2 start <service>');
    process.exit(0);
  }
}

main().catch(e => {
  error(`Unhandled error: ${e.message}`);
  process.exit(1);
});
