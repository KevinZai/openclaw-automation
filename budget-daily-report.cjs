#!/usr/bin/env node
/**
 * budget-daily-report.cjs
 * Yesterday's per-agent spend report → Discord #alfred at 09:00 PT.
 *
 * Usage:
 *   node budget-daily-report.cjs          (sends to Discord)
 *   node budget-daily-report.cjs --dry    (print to stdout only)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const AGENTS_DIR = path.join(os.homedir(), '.openclaw', 'agents');
const BUDGETS_FILE = path.join(__dirname, '..', 'tools', 'cost-tracker', 'budgets.json');
const PAUSE_FLAGS_DIR = path.join(__dirname, '..', 'tools', 'cost-tracker', 'pause-flags');
const ALFRED_DISCORD_CHANNEL = '1475370281899135037';
const GATEWAY_URL = 'http://127.0.0.1:18789/health';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry');

// Yesterday
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const REPORT_DATE = yesterday.toISOString().slice(0, 10);

function isGatewayUp() {
  try {
    execSync(`curl -sf --max-time 2 ${GATEWAY_URL}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function calcCost(usage, modelId, pricing) {
  if (usage?.cost?.total > 0) return usage.cost.total;
  const p = pricing[modelId] || {};
  const PER_M = 1_000_000;
  return (
    ((usage?.input || 0) * (p.input || 0) / PER_M) +
    ((usage?.output || 0) * (p.output || 0) / PER_M) +
    ((usage?.cacheRead || 0) * (p.cacheRead || 0) / PER_M) +
    ((usage?.cacheWrite || 0) * (p.cacheWrite || 0) / PER_M)
  );
}

function agentSpendOnDate(agentId, agentModel, pricing, targetDate) {
  const sessionsDir = path.join(AGENTS_DIR, agentId, 'sessions');
  if (!fs.existsSync(sessionsDir)) return { cost: 0, tokens: 0 };

  let totalCost = 0, totalTokens = 0;

  try {
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      if (file.includes('.trajectory') || file.includes('.checkpoint') || file.includes('.archived')) continue;

      const fullPath = path.join(sessionsDir, file);
      try {
        const stat = fs.statSync(fullPath);
        const mdate = new Date(stat.mtime).toISOString().slice(0, 10);
        if (mdate !== targetDate) continue;

        const content = fs.readFileSync(fullPath, 'utf8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'model.completed') {
              const modelId = obj.modelId ? `${obj.provider}/${obj.modelId}` : agentModel;
              const u = obj.data?.usage;
              if (u) {
                totalTokens += u.total || 0;
                totalCost += calcCost(u, modelId, pricing);
              }
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return { cost: totalCost, tokens: totalTokens };
}

function run() {
  const budgetConfig = JSON.parse(fs.readFileSync(BUDGETS_FILE, 'utf8'));
  const { agents: agentBudgets, pricing } = budgetConfig;

  const agentIds = Object.keys(agentBudgets);
  const rows = [];

  for (const agentId of agentIds) {
    const budget = agentBudgets[agentId];
    const spend = agentSpendOnDate(agentId, budget.model, pricing, REPORT_DATE);
    rows.push({
      agentId,
      name: budget.name,
      tier: budget.tier,
      cost: spend.cost,
      tokens: spend.tokens,
      hardCap: budget.hardCap,
      dailyBudget: budget.dailyBudget,
      wasPaused: fs.existsSync(path.join(PAUSE_FLAGS_DIR, `${agentId}.paused`)),
    });
  }

  rows.sort((a, b) => b.cost - a.cost);

  const totalSpend = rows.reduce((sum, r) => sum + r.cost, 0);
  const top3 = rows.slice(0, 3);
  const hitCap = rows.filter(r => r.cost >= r.hardCap);
  const activeAgents = rows.filter(r => r.cost > 0 || r.tokens > 0);

  // Build report
  const lines = [
    `📊 **Agent Budget Report — ${REPORT_DATE}**`,
    `Total spend: **$${totalSpend.toFixed(4)}** across ${activeAgents.length} active agents`,
    '',
    `**Top 3 spenders:**`,
  ];

  for (const r of top3) {
    const pct = r.hardCap > 0 ? (r.cost / r.hardCap * 100).toFixed(0) : '0';
    const flag = r.wasPaused ? ' ⏸️' : '';
    lines.push(`  • ${r.name} (${r.tier}): $${r.cost.toFixed(4)} — ${pct}% of $${r.hardCap} cap${flag}`);
  }

  if (hitCap.length > 0) {
    lines.push('');
    lines.push(`🔴 **Hit hard cap (${hitCap.length}):** ${hitCap.map(r => r.name).join(', ')}`);
  } else {
    lines.push('');
    lines.push('✅ No agents hit hard cap yesterday');
  }

  lines.push('');
  lines.push(`_Budget tracker v1.0 | Pause flags reset at 01:00 daily_`);

  const report = lines.join('\n');

  if (DRY_RUN) {
    console.log(report);
    return;
  }

  console.log(`[${new Date().toISOString()}] Sending daily budget report for ${REPORT_DATE}`);
  console.log(report);

  if (!isGatewayUp()) {
    console.error('Gateway down — cannot send report');
    process.exit(1);
  }

  try {
    execSync(
      `openclaw message send --channel discord --target ${ALFRED_DISCORD_CHANNEL} --message ${JSON.stringify(report)} --silent`,
      { stdio: 'ignore', timeout: 5000 }
    );
    console.log('Report sent to #alfred');
  } catch {
    try {
      execSync(
        `openclaw message send --channel discord --message ${JSON.stringify(report)} --silent`,
        { stdio: 'ignore', timeout: 5000 }
      );
      console.log('Report sent (fallback)');
    } catch (err) {
      console.error('Failed to send report:', err.message);
    }
  }
}

run();
