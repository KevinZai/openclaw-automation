#!/usr/bin/env node
/**
 * agent-retirement-audit.cjs
 * Audits all OpenClaw agents for inactivity and retirement candidacy.
 *
 * Usage: node scripts/agent-retirement-audit.cjs [--json]
 *
 * Output:
 *   - Prints human-readable table (default) or JSON (--json flag)
 *   - Saves JSON report to output/dev/agent-retirement-audit-YYYY-MM-DD.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────

const OPENCLAW_CONFIG  = path.join(process.env.HOME, '.openclaw/openclaw.json');
const OPENCLAW_AGENTS  = path.join(process.env.HOME, '.openclaw/agents');
const CLAWD_ROOT       = path.join(process.env.HOME, 'clawd');
const WORKSPACES_ROOT  = path.join(CLAWD_ROOT, 'workspaces');
const OUTPUT_DIR       = path.join(CLAWD_ROOT, 'output/dev');
const INACTIVITY_DAYS  = 30;   // threshold for "recommend archive"
const TODAY            = new Date();

// ── Agents that are dormant by design — never auto-archive ────────────────────
// Checked at runtime from IDENTITY.md DORMANT_BY_DESIGN flag, but these are
// hardcoded fallbacks in case the flag hasn't been written yet.
const DORMANT_BY_DESIGN_FALLBACK = new Set([
  'trading',   // Viper — waits for market signal
  'cobra',     // trading co-tenant
  'cleo',      // home — responds to family channel only
  'sage',      // kid agent — family only
  'sander',    // kid agent — family only
  'axel',      // kid agent — family only
  'wealth',    // financial — waits for explicit invocation
  'nexus',     // world agent — background-only, no channel binding
]);

// ── Agents newly deployed (< 60 days) — skip auto-archive even if 0 sessions ─
const NEWLY_DEPLOYED = new Set([
  'bolt',   // free-tier micro-task worker, awaiting Quill dispatches
  'coder',  // free-tier code gen,          awaiting Quill dispatches
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  if (isNaN(d)) return Infinity;
  return Math.floor((TODAY - d) / 86_400_000);
}

function findLatestSession(agentId) {
  const sessionsDir = path.join(OPENCLAW_AGENTS, agentId, 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;

  try {
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(sessionsDir, f))
      .sort()  // lexicographic — JSONL files are timestamped
      .reverse();

    return files.length ? files[0] : null;
  } catch {
    return null;
  }
}

function countLifetimeSessions(agentId) {
  const sessionsDir = path.join(OPENCLAW_AGENTS, agentId, 'sessions');
  if (!fs.existsSync(sessionsDir)) return 0;
  try {
    return fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')).length;
  } catch {
    return 0;
  }
}

function getFileMtime(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.mtime.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/** Read IDENTITY.md for a workspace and check for flags. */
function readIdentityFlags(workspace) {
  if (!workspace) return { dormantByDesign: false, alwaysOn: false, retired: false };

  // workspace may be an absolute path or relative to CLAWD_ROOT
  const wsPath = path.isAbsolute(workspace) ? workspace : path.join(CLAWD_ROOT, workspace);
  const identityPath = path.join(wsPath, 'IDENTITY.md');

  if (!fs.existsSync(identityPath)) {
    return { dormantByDesign: false, alwaysOn: false, retired: false };
  }

  const content = fs.readFileSync(identityPath, 'utf8');
  return {
    dormantByDesign: /DORMANT_BY_DESIGN\s*:\s*true/i.test(content),
    alwaysOn:        /ALWAYS_ON\s*:\s*true/i.test(content),
    retired:         /RETIRED\s*:/i.test(content),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function audit() {
  if (!fs.existsSync(OPENCLAW_CONFIG)) {
    console.error(`ERROR: openclaw.json not found at ${OPENCLAW_CONFIG}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
  const agents = config.agents?.list || [];

  const results = [];

  for (const agent of agents) {
    const id = agent.id;
    const name = agent.name || id;
    const workspace = agent.workspace || null;

    // Session data
    const lifetimeSessions = countLifetimeSessions(id);
    const latestFile = findLatestSession(id);
    const lastSessionDate = latestFile ? getFileMtime(latestFile) : null;
    const lastSessionDaysAgo = daysSince(lastSessionDate);

    // Identity flags (from IDENTITY.md)
    const flags = readIdentityFlags(workspace);

    // Dormancy logic
    const isDormantByDesign = flags.dormantByDesign || DORMANT_BY_DESIGN_FALLBACK.has(id);
    const isAlwaysOn = flags.alwaysOn;
    const isNewlyDeployed = NEWLY_DEPLOYED.has(id);
    const isRetired = flags.retired;

    // Recommendation
    let recommend, reason;

    if (isRetired) {
      recommend = 'already_retired';
      reason = 'RETIRED flag present in IDENTITY.md';
    } else if (isAlwaysOn) {
      recommend = 'keep_always_on';
      reason = 'ALWAYS_ON flag in IDENTITY.md — critical infrastructure';
    } else if (isDormantByDesign) {
      recommend = 'keep_dormant';
      reason = 'DORMANT_BY_DESIGN — waits for specific trigger (market hours / family channel / etc.)';
    } else if (isNewlyDeployed) {
      recommend = 'keep_new';
      reason = 'Newly deployed — 0 sessions expected until dispatch pipeline activates';
    } else if (lastSessionDaysAgo >= INACTIVITY_DAYS && lifetimeSessions === 0) {
      recommend = 'archive';
      reason = `0 lifetime sessions, ${lastSessionDaysAgo === Infinity ? 'never used' : `${lastSessionDaysAgo}d inactive`}`;
    } else if (lastSessionDaysAgo >= INACTIVITY_DAYS) {
      // Has history but long inactive — flag for human decision
      recommend = 'review';
      reason = `${lastSessionDaysAgo}d since last session (${lifetimeSessions} lifetime sessions) — human decision needed`;
    } else {
      recommend = 'active';
      reason = `${lastSessionDaysAgo}d since last session`;
    }

    results.push({
      id,
      name,
      workspace: workspace || '(none)',
      disabled: agent.disabled || false,
      last_session_date: lastSessionDate,
      last_session_days_ago: lastSessionDaysAgo === Infinity ? null : lastSessionDaysAgo,
      lifetime_sessions: lifetimeSessions,
      flags: {
        dormant_by_design: isDormantByDesign,
        always_on: isAlwaysOn,
        newly_deployed: isNewlyDeployed,
        already_retired: isRetired,
      },
      recommend,
      reason,
    });
  }

  // Sort: archive first, then review, then active
  const order = { archive: 0, review: 1, keep_dormant: 2, keep_new: 3, keep_always_on: 4, active: 5, already_retired: 6 };
  results.sort((a, b) => (order[a.recommend] ?? 9) - (order[b.recommend] ?? 9));

  const report = {
    audit_date: TODAY.toISOString().split('T')[0],
    inactivity_threshold_days: INACTIVITY_DAYS,
    summary: {
      total: results.length,
      archive: results.filter(r => r.recommend === 'archive').length,
      review:  results.filter(r => r.recommend === 'review').length,
      active:  results.filter(r => r.recommend === 'active').length,
      keep:    results.filter(r => r.recommend.startsWith('keep')).length,
    },
    agents: results,
  };

  return report;
}

function printTable(report) {
  const { audit_date, inactivity_threshold_days, summary, agents } = report;

  console.log(`\nAgent Retirement Audit — ${audit_date}`);
  console.log(`Inactivity threshold: ${inactivity_threshold_days} days\n`);

  const icons = {
    archive:        '🔴 ARCHIVE',
    review:         '🟡 REVIEW ',
    active:         '🟢 ACTIVE ',
    keep_dormant:   '💤 DORMANT',
    keep_new:       '🆕 NEW    ',
    keep_always_on: '🔒 ALWAYS ',
    already_retired:'📦 RETIRED',
  };

  const header = `${'ID'.padEnd(14)} ${'NAME'.padEnd(20)} ${'SESSIONS'.padStart(8)} ${'LAST'.padEnd(12)} ${'DAYS'.padStart(5)}  ${'STATUS'.padEnd(10)}  REASON`;
  console.log(header);
  console.log('─'.repeat(header.length + 20));

  for (const a of agents) {
    const icon = icons[a.recommend] || a.recommend;
    const days = a.last_session_days_ago === null ? '  n/a' : String(a.last_session_days_ago).padStart(5);
    const last = a.last_session_date || 'never';
    console.log(
      `${a.id.padEnd(14)} ${a.name.padEnd(20)} ${String(a.lifetime_sessions).padStart(8)} ${last.padEnd(12)} ${days}  ${icon}  ${a.reason}`
    );
  }

  console.log('\nSummary:');
  console.log(`  Total: ${summary.total} | Archive: ${summary.archive} | Review: ${summary.review} | Active: ${summary.active} | Keep: ${summary.keep}`);
  console.log('');
}

// ── Run ───────────────────────────────────────────────────────────────────────

const report = audit();
const isJson = process.argv.includes('--json');

if (isJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printTable(report);
}

// Always save JSON report
const dateStr = report.audit_date;
const outputPath = path.join(OUTPUT_DIR, `agent-retirement-audit-${dateStr}.json`);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
if (!isJson) {
  console.log(`Report saved: ${outputPath}`);
}
