#!/usr/bin/env node
/**
 * test-pipeline.js — End-to-end integration tests for the Paperclip auto-dispatch pipeline
 *
 * Tests:
 *   1. CRUD — create → read → update → delete an issue
 *   2. Auto-Wake Chain — assign to forge → verify lastHeartbeatAt updates within 60s
 *   3. Backlog Gate — backlog blocks wakeup; todo triggers it
 *   4. Budget Gate — free fleet agents not hard-stopped by budget
 *
 * Usage:
 *   node test-pipeline.js           — run all tests
 *   node test-pipeline.js --test 1  — run test 1 only
 *   node test-pipeline.js --dry-run — simulate (no API mutations)
 */

import http from 'http';

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3100';
const COMPANY_ID = 'd852cff2-1645-4c48-ae14-010bd8230444';
const FORGE_AGENT_ID = '1234c699-6592-42a6-b746-266f9618507a';

const WAKE_TIMEOUT_MS = 60 * 1000;   // 60s for auto-wake
const APPROVAL_WAIT_MS = 30 * 1000;  // 30s to confirm no wakeup on backlog
const POLL_INTERVAL_MS = 3000;
const RATE_LIMIT_DELAY_MS = 2000;    // 30 calls/min

const DRY_RUN = process.argv.includes('--dry-run');
const TEST_FILTER = (() => {
  const idx = process.argv.indexOf('--test');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : null;
})();

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

const apiGet    = (path)       => apiCall('GET', path, null);
const apiPost   = (path, body) => apiCall('POST', path, body);
const apiPatch  = (path, body) => apiCall('PATCH', path, body);
const apiDelete = (path)       => apiCall('DELETE', path, null);

// ── Test result tracking ──────────────────────────────────────────────────────

const results = [];

function pass(testNum, name, detail) {
  const msg = `Test ${testNum}: PASS — ${name}${detail ? ` (${detail})` : ''}`;
  info(msg);
  results.push({ test: testNum, name, status: 'PASS', detail, at: ts() });
}

function fail(testNum, name, reason) {
  const msg = `Test ${testNum}: FAIL — ${name}: ${reason}`;
  error(msg);
  results.push({ test: testNum, name, status: 'FAIL', reason, at: ts() });
}

function skip(testNum, name, reason) {
  const msg = `Test ${testNum}: SKIP — ${name}: ${reason}`;
  warn(msg);
  results.push({ test: testNum, name, status: 'SKIP', reason, at: ts() });
}

// ── Cleanup helper ────────────────────────────────────────────────────────────

async function deleteIssue(issueId, label) {
  if (DRY_RUN) {
    info(`[DRY-RUN] Would delete issue ${issueId} (${label})`);
    return;
  }
  try {
    await apiDelete(`/api/issues/${issueId}`);
    info(`Cleanup: deleted issue ${issueId} (${label})`);
  } catch (e) {
    warn(`Cleanup: could not delete issue ${issueId}: ${e.message}`);
  }
}

// ── Test 1: Paperclip API CRUD ────────────────────────────────────────────────

async function test1() {
  const name = 'Paperclip API CRUD';
  info(`--- Test 1: ${name} ---`);

  if (DRY_RUN) {
    skip(1, name, 'dry-run mode — skipping mutations');
    return;
  }

  let issueId = null;

  try {
    // Create
    const createResp = await apiPost(`/api/companies/${COMPANY_ID}/issues`, {
      title: '[test-pipeline] CRUD test issue',
      status: 'todo',
      description: 'Automated pipeline test — safe to delete',
    });

    if (createResp.status !== 201 && createResp.status !== 200) {
      fail(1, name, `Create failed with HTTP ${createResp.status}: ${JSON.stringify(createResp.body).slice(0, 200)}`);
      return;
    }

    issueId = createResp.body?.id ?? createResp.body?.issue?.id;
    if (!issueId) {
      fail(1, name, `Create succeeded but no id in response: ${JSON.stringify(createResp.body).slice(0, 200)}`);
      return;
    }
    info(`  Create OK — issue id: ${issueId}`);

    // Read
    const readResp = await apiGet(`/api/issues/${issueId}`);
    if (readResp.status !== 200) {
      fail(1, name, `Read failed with HTTP ${readResp.status}`);
      await deleteIssue(issueId, 'crud-test');
      return;
    }
    info(`  Read OK — status: ${readResp.body?.status}`);

    // Update status
    const patchResp = await apiPatch(`/api/issues/${issueId}`, { status: 'in_progress' });
    if (patchResp.status !== 200) {
      fail(1, name, `Update failed with HTTP ${patchResp.status}`);
      await deleteIssue(issueId, 'crud-test');
      return;
    }
    const updatedStatus = patchResp.body?.status ?? patchResp.body?.issue?.status;
    if (updatedStatus !== 'in_progress') {
      fail(1, name, `Update returned wrong status: ${updatedStatus}`);
      await deleteIssue(issueId, 'crud-test');
      return;
    }
    info(`  Update OK — status now: ${updatedStatus}`);

    // Delete
    const delResp = await apiDelete(`/api/issues/${issueId}`);
    if (delResp.status !== 200 && delResp.status !== 204) {
      fail(1, name, `Delete failed with HTTP ${delResp.status}`);
      return;
    }
    issueId = null; // cleanup not needed
    info(`  Delete OK`);

    pass(1, name);
  } catch (e) {
    fail(1, name, `Unexpected error: ${e.message}`);
    if (issueId) await deleteIssue(issueId, 'crud-test');
  }
}

// ── Test 2: Auto-Wake Chain ───────────────────────────────────────────────────

async function test2() {
  const name = 'Auto-Wake Chain';
  info(`--- Test 2: ${name} ---`);

  if (DRY_RUN) {
    skip(2, name, 'dry-run mode — skipping mutations');
    return;
  }

  // Read forge heartbeat before
  let forgeBefore;
  try {
    const agentResp = await apiGet(`/api/agents/${FORGE_AGENT_ID}`);
    if (agentResp.status !== 200) {
      fail(2, name, `Cannot fetch forge agent (HTTP ${agentResp.status}) — is forge registered?`);
      return;
    }
    forgeBefore = agentResp.body;
    info(`  Forge agent fetched — lastHeartbeatAt: ${forgeBefore?.lastHeartbeatAt ?? 'null'}`);
  } catch (e) {
    fail(2, name, `Cannot fetch forge agent: ${e.message}`);
    return;
  }

  const heartbeatBefore = forgeBefore?.lastHeartbeatAt
    ? new Date(forgeBefore.lastHeartbeatAt).getTime()
    : 0;

  // Create issue assigned to forge with status=todo
  let issueId = null;
  try {
    const createResp = await apiPost(`/api/companies/${COMPANY_ID}/issues`, {
      title: '[test-pipeline] Auto-wake chain test',
      status: 'todo',
      assigneeAgentId: FORGE_AGENT_ID,
      description: 'Automated pipeline test — safe to delete',
    });

    if (createResp.status !== 201 && createResp.status !== 200) {
      fail(2, name, `Create issue failed HTTP ${createResp.status}`);
      return;
    }

    issueId = createResp.body?.id ?? createResp.body?.issue?.id;
    if (!issueId) {
      fail(2, name, 'Create succeeded but no id returned');
      return;
    }
    info(`  Issue created: ${issueId} — polling for heartbeat update (up to ${WAKE_TIMEOUT_MS / 1000}s)...`);

    // Poll for heartbeat update
    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    let woke = false;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const agentResp = await apiGet(`/api/agents/${FORGE_AGENT_ID}`);
        if (agentResp.status === 200) {
          const hbAt = agentResp.body?.lastHeartbeatAt
            ? new Date(agentResp.body.lastHeartbeatAt).getTime()
            : 0;
          if (hbAt > heartbeatBefore) {
            info(`  Heartbeat updated: ${agentResp.body.lastHeartbeatAt}`);
            woke = true;
            break;
          }
        }
      } catch {
        // transient — keep polling
      }
    }

    if (woke) {
      pass(2, name, 'forge heartbeat updated within 60s of issue assignment');
    } else {
      // Heartbeat not updated — could be forge is a local/offline agent
      warn(`  Forge heartbeat did NOT update within ${WAKE_TIMEOUT_MS / 1000}s.`);
      warn(`  This may be expected if forge (Hugging Face) is offline or heartbeat is not wakeup-based.`);
      fail(2, name, `lastHeartbeatAt did not advance within ${WAKE_TIMEOUT_MS / 1000}s`);
    }
  } catch (e) {
    fail(2, name, `Unexpected error: ${e.message}`);
  } finally {
    if (issueId) await deleteIssue(issueId, 'auto-wake-test');
  }
}

// ── Test 3: Backlog Gate ──────────────────────────────────────────────────────

async function test3() {
  const name = 'Backlog Gate';
  info(`--- Test 3: ${name} ---`);

  if (DRY_RUN) {
    skip(3, name, 'dry-run mode — skipping mutations');
    return;
  }

  // Read forge heartbeat baseline
  let baselineHb = 0;
  try {
    const agentResp = await apiGet(`/api/agents/${FORGE_AGENT_ID}`);
    if (agentResp.status === 200 && agentResp.body?.lastHeartbeatAt) {
      baselineHb = new Date(agentResp.body.lastHeartbeatAt).getTime();
    }
  } catch {
    // non-fatal — we'll compare against 0
  }
  info(`  Baseline heartbeat: ${baselineHb ? new Date(baselineHb).toISOString() : 'none'}`);

  let issueId = null;
  try {
    // Create issue with backlog status. Backlog is the valid Paperclip approval queue;
    // assigned backlog issues must not wake agents until moved to todo.
    const createResp = await apiPost(`/api/companies/${COMPANY_ID}/issues`, {
      title: '[test-pipeline] Backlog gate test',
      status: 'backlog',
      assigneeAgentId: FORGE_AGENT_ID,
      description: 'Automated pipeline test — safe to delete',
    });

    if (createResp.status !== 201 && createResp.status !== 200) {
      fail(3, name, `Create backlog issue failed HTTP ${createResp.status}`);
      return;
    }

    issueId = createResp.body?.id ?? createResp.body?.issue?.id;
    if (!issueId) {
      fail(3, name, 'Create succeeded but no id returned');
      return;
    }
    info(`  Issue created (backlog): ${issueId} — waiting ${APPROVAL_WAIT_MS / 1000}s to confirm no wakeup...`);

    // Wait and verify NO heartbeat update
    await sleep(APPROVAL_WAIT_MS);

    let hbDuringWait = 0;
    try {
      const agentResp = await apiGet(`/api/agents/${FORGE_AGENT_ID}`);
      if (agentResp.status === 200 && agentResp.body?.lastHeartbeatAt) {
        hbDuringWait = new Date(agentResp.body.lastHeartbeatAt).getTime();
      }
    } catch { /* non-fatal */ }

    if (hbDuringWait > baselineHb) {
      // Wakeup fired during backlog — gate failed
      fail(3, name, `Wakeup fired during backlog (heartbeat advanced from ${baselineHb} to ${hbDuringWait})`);
      await deleteIssue(issueId, 'approval-gate-test');
      issueId = null;
      return;
    }
    info(`  Backlog gate held — no wakeup during backlog. Moving to todo...`);

    // Now move to todo — wakeup should fire
    const patchResp = await apiPatch(`/api/issues/${issueId}`, { status: 'todo' });
    if (patchResp.status !== 200) {
      fail(3, name, `Patch to todo failed HTTP ${patchResp.status}`);
      await deleteIssue(issueId, 'approval-gate-test');
      issueId = null;
      return;
    }
    info(`  Status set to todo — polling for wakeup (up to ${WAKE_TIMEOUT_MS / 1000}s)...`);

    const hbAfterApproval = hbDuringWait || baselineHb;
    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    let woke = false;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const agentResp = await apiGet(`/api/agents/${FORGE_AGENT_ID}`);
        if (agentResp.status === 200) {
          const hb = agentResp.body?.lastHeartbeatAt
            ? new Date(agentResp.body.lastHeartbeatAt).getTime()
            : 0;
          if (hb > hbAfterApproval) {
            woke = true;
            info(`  Wakeup fired post-approval: ${agentResp.body.lastHeartbeatAt}`);
            break;
          }
        }
      } catch { /* transient */ }
    }

    if (woke) {
      pass(3, name, 'blocked during backlog; woke after move to todo');
    } else {
      warn(`  Wakeup did not fire within ${WAKE_TIMEOUT_MS / 1000}s after moving to todo.`);
      fail(3, name, `Heartbeat did not advance after transitioning backlog → todo`);
    }
  } catch (e) {
    fail(3, name, `Unexpected error: ${e.message}`);
  } finally {
    if (issueId) await deleteIssue(issueId, 'approval-gate-test');
  }
}

// ── Test 4: Budget Gate ───────────────────────────────────────────────────────

async function test4() {
  const name = 'Budget Gate';
  info(`--- Test 4: ${name} ---`);

  try {
    // Try to fetch budget info for the company or agents
    const agentsResp = await apiGet(`/api/companies/${COMPANY_ID}/agents`);
    if (agentsResp.status !== 200) {
      fail(4, name, `Cannot fetch agents for budget check (HTTP ${agentsResp.status})`);
      return;
    }

    const agents = Array.isArray(agentsResp.body) ? agentsResp.body : [];
    const freeFleet = agents.filter(a =>
      a.id === FORGE_AGENT_ID ||
      (a.name && /forge|flare|lama|oracle/i.test(a.name))
    );

    info(`  Found ${freeFleet.length} free fleet agent(s).`);

    // Check each for hard-stop / budget-blocked indicators
    const blocked = freeFleet.filter(a =>
      a.status === 'budget_exceeded' ||
      a.status === 'hard_stop' ||
      a.budgetExceeded === true ||
      a.blocked === true ||
      a.hardStop === true
    );

    if (blocked.length > 0) {
      fail(4, name, `${blocked.length} free fleet agent(s) are budget-hard-stopped: ${blocked.map(a => a.id).join(', ')}`);
      return;
    }

    // Check global budget endpoint
    const budgetResp = await apiGet(`/api/companies/${COMPANY_ID}/budget`);
    if (budgetResp.status === 200) {
      const budget = budgetResp.body;
      const spent = budget?.dailySpend ?? budget?.todaySpend ?? budget?.spent;
      if (spent !== undefined && parseFloat(spent) >= 10.0) {
        fail(4, name, `Daily budget exceeded ($${parseFloat(spent).toFixed(2)} >= $10.00) — free fleet may be blocked`);
        return;
      }
      info(`  Budget endpoint OK — daily spend: ${spent !== undefined ? `$${parseFloat(spent).toFixed(2)}` : 'unknown'}`);
    } else {
      info(`  Budget endpoint not available (HTTP ${budgetResp.status}) — checking agent-level budget fields only.`);
    }

    pass(4, name, `${freeFleet.length} free fleet agent(s) not budget-blocked`);
  } catch (e) {
    fail(4, name, `Unexpected error: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  info('=== Paperclip Pipeline Integration Tests' + (DRY_RUN ? ' [DRY-RUN]' : '') + (TEST_FILTER ? ` [test=${TEST_FILTER}]` : '') + ' ===');

  const tests = [
    { num: 1, fn: test1 },
    { num: 2, fn: test2 },
    { num: 3, fn: test3 },
    { num: 4, fn: test4 },
  ];

  const toRun = TEST_FILTER
    ? tests.filter(t => t.num === TEST_FILTER)
    : tests;

  if (toRun.length === 0) {
    error(`No test found with --test ${TEST_FILTER}. Valid: 1-4.`);
    process.exit(1);
  }

  for (const t of toRun) {
    await t.fn();
  }

  // Summary
  info('');
  info('=== Test Summary ===');
  let anyFail = false;
  for (const r of results) {
    const line = `  Test ${r.test} [${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}${r.reason ? ` — ${r.reason}` : ''}`;
    if (r.status === 'FAIL') { error(line); anyFail = true; }
    else if (r.status === 'SKIP') warn(line);
    else info(line);
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  info(`Totals: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  info('=== Done ===');

  process.exit(anyFail ? 1 : 0);
}

main().catch(e => {
  error(`Unhandled error: ${e.message}`);
  process.exit(1);
});
