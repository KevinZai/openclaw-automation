#!/usr/bin/env node
/**
 * agent-budget-tracker.cjs
 * Per-agent daily budget enforcement — reads OC session JSONL, calculates spend,
 * compares against budgets.json tiers, fires Discord alerts + pause flags.
 *
 * Usage:
 *   node agent-budget-tracker.cjs --check          (dry run, read-only)
 *   node agent-budget-tracker.cjs --enforce        (apply pause flags, send alerts)
 *   node agent-budget-tracker.cjs --verbose        (show all agents, not just over-threshold)
 *   node agent-budget-tracker.cjs --simulate-overage <agent-id>  (test mode)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ── Config ────────────────────────────────────────────────────────────────────

const AGENTS_DIR = path.join(os.homedir(), '.openclaw', 'agents');
const BUDGETS_FILE = path.join(__dirname, '..', 'tools', 'cost-tracker', 'budgets.json');
const PAUSE_FLAGS_DIR = path.join(__dirname, '..', 'tools', 'cost-tracker', 'pause-flags');
const WARNINGS_LOG_DIR = path.join(__dirname, '..', 'output', 'dev');
const OC_LOGS_DIR = path.join(__dirname, '..', 'logs');
const DEBOUNCE_DIR = path.join(__dirname, '..', 'tools', 'cost-tracker', '.warn-debounce');
const ALFRED_DISCORD_CHANNEL = '1475370281899135037';
const GATEWAY_URL = 'http://127.0.0.1:18789/health';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const MODE_CHECK = args.includes('--check');
const MODE_ENFORCE = args.includes('--enforce');
const MODE_VERBOSE = args.includes('--verbose');
const SIMULATE_IDX = args.indexOf('--simulate-overage');
const SIMULATE_AGENT = SIMULATE_IDX >= 0 ? args[SIMULATE_IDX + 1] : null;

if (!MODE_CHECK && !MODE_ENFORCE && !SIMULATE_AGENT) {
  console.error('Usage: agent-budget-tracker.cjs [--check|--enforce] [--verbose] [--simulate-overage <agent>]');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  // Also append to budget tracker log
  try {
    fs.appendFileSync(path.join(OC_LOGS_DIR, 'budget-tracker.log'), line + '\n');
  } catch {}
}

function loadBudgets() {
  const raw = fs.readFileSync(BUDGETS_FILE, 'utf8');
  return JSON.parse(raw);
}

function isGatewayUp() {
  try {
    execSync(`curl -sf --max-time 2 ${GATEWAY_URL}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the pricing table says this model is free (all-zero costs).
 * Used to ignore embedded API cost fields for Codex OAuth and other free providers.
 */
function isFreeTierModel(modelId, pricing) {
  const p = pricing[modelId] || pricing['openai/gpt-5.5'];
  if (!p) return false;
  return p.input === 0 && p.output === 0 && (p.cacheRead || 0) === 0;
}

/**
 * Calculate cost from token usage using pricing table.
 * For free-tier models (Codex OAuth, Groq, CF, Cerebras, OpenRouter free):
 *   always return $0 — OpenAI and other providers embed non-zero cost fields in their
 *   API responses even for OAuth/free-tier usage, so we MUST ignore those fields
 *   and trust the pricing table instead.
 * For paid models: use the embedded cost.total when available (more accurate than
 *   our token-based estimate), falling back to the pricing table.
 */
function calcCost(usage, modelId, pricing) {
  // Free-tier models: always $0 regardless of what the API reports
  if (isFreeTierModel(modelId, pricing)) return 0;

  // Paid models: trust embedded cost if present (more accurate than token estimate)
  if (usage?.cost?.total > 0) return usage.cost.total;

  const modelPricing = pricing[modelId] || pricing['openai/gpt-5.5'];
  if (!modelPricing) return 0;

  const PER_M = 1_000_000;
  const inputTokens = (usage?.input || 0);
  const outputTokens = (usage?.output || 0);
  const cacheReadTokens = (usage?.cacheRead || 0);
  const cacheWriteTokens = (usage?.cacheWrite || 0);

  return (
    (inputTokens * modelPricing.input / PER_M) +
    (outputTokens * modelPricing.output / PER_M) +
    (cacheReadTokens * modelPricing.cacheRead / PER_M) +
    (cacheWriteTokens * (modelPricing.cacheWrite || 0) / PER_M)
  );
}

/**
 * Parse JSONL session file and extract today's total cost for this agent.
 * Uses model.completed records which have provider + usage.
 */
function parseSessionCost(jsonlPath, agentModel, pricing) {
  let totalCost = 0;
  let totalTokens = 0;

  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);

        // model.completed has provider + data.usage (most reliable)
        if (obj.type === 'model.completed') {
          const modelId = obj.modelId ? `${obj.provider}/${obj.modelId}` : agentModel;
          const usage = obj.data?.usage;
          if (usage) {
            totalTokens += usage.total || 0;
            totalCost += calcCost(usage, modelId, pricing);
          }
          continue;
        }

        // Fallback: message records with usage.cost or usage.totalTokens
        if (obj.type === 'message' && obj.message?.role === 'assistant') {
          const u = obj.message?.usage;
          // Only trust embedded cost for paid models — free-tier providers (Codex OAuth, Groq,
          // Cloudflare, Cerebras, OpenRouter free) embed non-zero costs in API responses that
          // do not reflect actual charges. Use pricing table (returns $0) for those.
          if (u?.cost?.total > 0 && !isFreeTierModel(agentModel, pricing)) {
            totalCost += u.cost.total;
          } else if (u?.totalTokens > 0 && totalCost === 0) {
            // Only use as last resort (can't calc cost without model context here)
            totalTokens += u.totalTokens;
          }
        }
      } catch {}
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log(`WARN: failed to parse ${jsonlPath}: ${err.message}`);
  }

  return { totalCost, totalTokens };
}

/**
 * Aggregate today's spend across all JSONL sessions for an agent.
 */
function agentSpendToday(agentId, agentModel, pricing) {
  const sessionsDir = path.join(AGENTS_DIR, agentId, 'sessions');
  if (!fs.existsSync(sessionsDir)) return { cost: 0, tokens: 0, sessions: 0 };

  let totalCost = 0;
  let totalTokens = 0;
  let sessionCount = 0;

  try {
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      // Skip trajectory, checkpoint, and archived files
      if (!file.endsWith('.jsonl')) continue;
      if (file.includes('.trajectory') || file.includes('.checkpoint') || file.includes('.archived')) continue;

      const fullPath = path.join(sessionsDir, file);
      try {
        const stat = fs.statSync(fullPath);
        const mdate = new Date(stat.mtime).toISOString().slice(0, 10);
        if (mdate !== TODAY) continue; // Only today's sessions

        const { totalCost: c, totalTokens: t } = parseSessionCost(fullPath, agentModel, pricing);
        totalCost += c;
        totalTokens += t;
        if (c > 0 || t > 0) sessionCount++;
      } catch {}
    }
  } catch {}

  return { cost: totalCost, tokens: totalTokens, sessions: sessionCount };
}

/**
 * Debounce warning: return true if we should fire (once per day per agent per threshold).
 */
function shouldWarn(agentId, level) {
  if (!fs.existsSync(DEBOUNCE_DIR)) fs.mkdirSync(DEBOUNCE_DIR, { recursive: true });
  const key = path.join(DEBOUNCE_DIR, `${agentId}-${level}-${TODAY}`);
  if (fs.existsSync(key)) return false;
  try { fs.writeFileSync(key, new Date().toISOString()); } catch {}
  return true;
}

function setPauseFlag(agentId) {
  if (!fs.existsSync(PAUSE_FLAGS_DIR)) fs.mkdirSync(PAUSE_FLAGS_DIR, { recursive: true });
  const flagPath = path.join(PAUSE_FLAGS_DIR, `${agentId}.paused`);
  fs.writeFileSync(flagPath, `Paused at ${new Date().toISOString()} — daily hard cap exceeded`);
  return flagPath;
}

function isPaused(agentId) {
  return fs.existsSync(path.join(PAUSE_FLAGS_DIR, `${agentId}.paused`));
}

/**
 * Send Discord notification to Alfred's channel via openclaw CLI.
 */
function notify(message) {
  if (!isGatewayUp()) {
    log(`WARN: gateway down, cannot notify. Message: ${message}`);
    return false;
  }
  try {
    execSync(
      `openclaw message send --channel discord --target ${ALFRED_DISCORD_CHANNEL} --message ${JSON.stringify(message)} --silent`,
      { stdio: 'ignore', timeout: 5000 }
    );
    return true;
  } catch (err) {
    // Fallback: try without target flag (channel-only)
    try {
      execSync(
        `openclaw message send --channel discord --message ${JSON.stringify(message)} --silent`,
        { stdio: 'ignore', timeout: 5000 }
      );
      return true;
    } catch {
      log(`WARN: notification failed: ${err.message}`);
      return false;
    }
  }
}

/**
 * Append to dated warning log in output/dev/.
 */
function appendWarningLog(entry) {
  const logFile = path.join(WARNINGS_LOG_DIR, `budget-warnings-${TODAY}.log`);
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────────

function run() {
  log(`budget-tracker start mode=${MODE_ENFORCE ? 'enforce' : 'check'} date=${TODAY}`);

  const budgetConfig = loadBudgets();
  const { agents: agentBudgets, pricing, thresholds } = budgetConfig;

  const agentIds = Object.keys(agentBudgets);
  const results = [];

  for (const agentId of agentIds) {
    const budget = agentBudgets[agentId];
    let spend;

    if (SIMULATE_AGENT && SIMULATE_AGENT === agentId) {
      // Test mode: simulate 200% of hard cap
      spend = { cost: budget.hardCap * 2.0, tokens: 999999, sessions: 1 };
      log(`SIMULATE: ${agentId} — injecting cost $${spend.cost.toFixed(4)}`);
    } else {
      spend = agentSpendToday(agentId, budget.model, pricing);
    }

    const { cost, tokens, sessions } = spend;
    const dailyBudget = budget.dailyBudget;
    const hardCap = budget.hardCap;

    // Calculate threshold breaches
    const warnThreshold = dailyBudget > 0 ? dailyBudget * thresholds.warn : hardCap * thresholds.warn;
    const softCapThreshold = dailyBudget > 0 ? dailyBudget : hardCap;
    const hardCapThreshold = hardCap * thresholds.hardCap;

    let status = 'ok';
    if (cost >= hardCapThreshold) status = 'critical';
    else if (cost >= softCapThreshold && (dailyBudget > 0 || cost >= hardCap)) status = 'soft-cap';
    else if (cost >= warnThreshold) status = 'warn';

    const pct = hardCap > 0 ? (cost / hardCap * 100).toFixed(1) : 'N/A';

    const result = {
      agentId,
      name: budget.name,
      tier: budget.tier,
      cost: parseFloat(cost.toFixed(6)),
      tokens,
      sessions,
      dailyBudget,
      hardCap,
      pctOfHardCap: pct,
      status,
      paused: isPaused(agentId),
    };
    results.push(result);

    if (MODE_VERBOSE || status !== 'ok') {
      log(`${agentId} (${budget.name}) tier=${budget.tier} spend=$${cost.toFixed(4)} tokens=${tokens} pct=${pct}% status=${status} paused=${isPaused(agentId)}`);
    }

    if (!MODE_ENFORCE && !SIMULATE_AGENT) continue;

    // ── Enforce thresholds ─────────────────────────────────────────────────

    if (status === 'critical') {
      const entry = { ts: new Date().toISOString(), agentId, level: 'critical', cost, hardCap, pct };
      appendWarningLog(entry);

      if (shouldWarn(agentId, 'critical')) {
        const msg = `🔴 BUDGET CRITICAL: ${budget.name} (${agentId}) spent $${cost.toFixed(4)} — ${pct}% of $${hardCap} hard cap. PAUSING cron jobs for today.`;
        log(msg);
        notify(msg);
      }

      if (MODE_ENFORCE) {
        const flagPath = setPauseFlag(agentId);
        log(`PAUSE FLAG SET: ${flagPath}`);
      }

    } else if (status === 'soft-cap') {
      const entry = { ts: new Date().toISOString(), agentId, level: 'soft-cap', cost, dailyBudget, pct };
      appendWarningLog(entry);

      if (shouldWarn(agentId, 'soft-cap')) {
        const msg = `🟡 BUDGET SOFT CAP: ${budget.name} (${agentId}) hit daily budget ($${cost.toFixed(4)} of $${dailyBudget} limit). Please be conservative with remaining calls.`;
        log(msg);
        notify(msg);
        // Note: soft-cap does NOT pause the agent — only message sent
      }

    } else if (status === 'warn') {
      const entry = { ts: new Date().toISOString(), agentId, level: 'warn', cost, dailyBudget, pct };
      appendWarningLog(entry);

      if (shouldWarn(agentId, 'warn')) {
        const msg = `⚠️ BUDGET WARN: ${budget.name} (${agentId}) at ${pct}% of hard cap ($${cost.toFixed(4)} / $${hardCap}).`;
        log(msg);
        notify(msg);
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const overBudget = results.filter(r => r.status !== 'ok');
  const paused = results.filter(r => r.paused);
  const totalSpend = results.reduce((sum, r) => sum + r.cost, 0);

  log(`SUMMARY: ${results.length} agents checked, ${overBudget.length} over threshold, ${paused.length} paused, total_today=$${totalSpend.toFixed(4)}`);

  if (overBudget.length > 0) {
    log('OVER THRESHOLD:');
    for (const r of overBudget) {
      log(`  ${r.agentId} (${r.name}) $${r.cost.toFixed(4)} [${r.status}] ${r.paused ? 'PAUSED' : ''}`);
    }
  }

  return { results, totalSpend, overBudget, paused };
}

run();
