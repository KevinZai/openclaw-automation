#!/usr/bin/env node
/**
 * @file self-improve.js
 * @description Self-improvement loop — weekly review of automation quality and proposals
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Self-Improvement Loop — Reviews automation output quality and proposes upgrades
 *
 * Weekly: scans all auto-generated outputs (daily briefs, revenue tasks, etc.)
 * Evaluates: are tasks getting completed? Are reports useful? What's failing silently?
 * Generates improvement proposals → shared/pending-improvements/
 *
 * PM2 cron: Sundays 10am EST (0 15 * * 0 UTC)
 */

const fs = require('fs');
const path = require('path');

const BRIEF_DIR = process.env.BRIEF_DIR || './shared/daily-brief';
const IMPROVEMENTS_DIR = process.env.IMPROVEMENTS_DIR || './shared/pending-improvements';
const STATE_FILE = path.join(__dirname, '.self-improve-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRun: null, improvements: [], metrics: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getRecentBriefs(days) {
  if (!fs.existsSync(BRIEF_DIR)) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return fs.readdirSync(BRIEF_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const fp = path.join(BRIEF_DIR, f);
      const stat = fs.statSync(fp);
      return { name: f, path: fp, mtime: stat.mtime.getTime(), size: stat.size };
    })
    .filter(f => f.mtime > cutoff)
    .sort((a, b) => b.mtime - a.mtime);
}

function run() {
  const state = loadState();
  const today = new Date().toISOString().split('T')[0];
  const briefs = getRecentBriefs(7);

  const metrics = {
    briefsGenerated: briefs.length,
    selfHealReports: briefs.filter(b => b.name.includes('self-heal')).length,
    morningBriefs: briefs.filter(b => b.name.includes('morning-brief')).length,
    conventionChecks: briefs.filter(b => b.name.includes('convention')).length,
    competitiveReports: briefs.filter(b => b.name.includes('competitive')).length,
    skillHealth: briefs.filter(b => b.name.includes('skill-health')).length,
    configDrift: briefs.filter(b => b.name.includes('config-drift')).length,
    corrections: briefs.filter(b => b.name.includes('corrections')).length,
  };

  // Detect silent failures — expected reports that didn't generate
  const gaps = [];
  if (metrics.morningBriefs < 5) gaps.push(`Morning brief only generated ${metrics.morningBriefs}/7 days`);
  if (metrics.selfHealReports === 0) gaps.push('No self-heal reports this week — is the self-heal cron running?');
  if (metrics.conventionChecks === 0) gaps.push('No convention check this week — Sunday cron may have failed');
  if (metrics.skillHealth === 0) gaps.push('No skill health report — Monday cron may have failed');

  // Analyze self-heal patterns
  const healBriefs = briefs.filter(b => b.name.includes('self-heal'));
  let totalErrors = 0;
  for (const brief of healBriefs) {
    try {
      const content = fs.readFileSync(brief.path, 'utf8');
      const rateMatches = content.match(/(\d+) rate limit/g) || [];
      for (const m of rateMatches) {
        totalErrors += parseInt(m) || 0;
      }
    } catch {}
  }
  if (totalErrors > 500) {
    gaps.push(`${totalErrors} rate limit errors this week — investigate ClaudeSwap capacity or context1m settings`);
  }

  // Revenue task completion check
  const revState = path.join(__dirname, '.revenue-task-state.json');
  if (fs.existsSync(revState)) {
    try {
      const rev = JSON.parse(fs.readFileSync(revState, 'utf8'));
      metrics.revTasksGenerated = rev.tasksGenerated || 0;
    } catch {}
  }

  // Generate improvement report
  fs.mkdirSync(IMPROVEMENTS_DIR, { recursive: true });

  let report = `# Self-Improvement Review — ${today}\n\n`;
  report += `## Automation Health Metrics (last 7 days)\n\n`;
  report += `| Metric | Value | Expected |\n|--------|-------|----------|\n`;
  report += `| Briefs generated | ${metrics.briefsGenerated} | ~20+ |\n`;
  report += `| Morning briefs | ${metrics.morningBriefs} | 7 |\n`;
  report += `| Self-heal reports | ${metrics.selfHealReports} | 7 |\n`;
  report += `| Convention checks | ${metrics.conventionChecks} | 1 |\n`;
  report += `| Skill health | ${metrics.skillHealth} | 1 |\n`;
  report += `| Competitive reports | ${metrics.competitiveReports} | 1 |\n`;
  report += `| Revenue tasks generated | ${metrics.revTasksGenerated || 'N/A'} | 10+ |\n\n`;

  if (gaps.length > 0) {
    report += `## Gaps & Issues\n\n`;
    for (const gap of gaps) {
      report += `- ⚠️ ${gap}\n`;
    }
    report += '\n';
  }

  report += `## Improvement Proposals\n\n`;
  report += `Based on this week's data, here are potential improvements:\n\n`;

  if (totalErrors > 200) {
    report += `1. **Rate limit mitigation:** ${totalErrors} errors this week. Consider:\n`;
    report += `   - Reduce context1m to fewer agents\n`;
    report += `   - Route more work to free fleet (Groq/Ollama)\n`;
    report += `   - Implement request queuing in ClaudeSwap\n\n`;
  }

  if (metrics.morningBriefs < 7) {
    report += `2. **Morning brief reliability:** Only ${metrics.morningBriefs}/7 generated. Check PM2 cron.\n\n`;
  }

  report += `---\n*Generated by self-improve.js on ${new Date().toISOString()}*\n`;

  const reportFile = path.join(IMPROVEMENTS_DIR, `review-${today}.md`);
  fs.writeFileSync(reportFile, report);

  state.lastRun = today;
  state.metrics = metrics;
  state.improvements = [...(state.improvements || []).slice(-10), { date: today, gaps: gaps.length, metrics }];
  saveState(state);

  console.log(`[self-improve] Week review: ${metrics.briefsGenerated} briefs, ${gaps.length} gaps, ${totalErrors} rate limit errors. Report: ${reportFile}`);
}

run();
