#!/usr/bin/env node
/**
 * @file skill-effectiveness.js
 * @description Skill effectiveness tracker — weekly skill invocation and success rate reports
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Skill Effectiveness Tracker — Weekly report on skill invocations and outcomes
 *
 * Parses agent session JSONL files for skill invocations.
 * Tracks per-skill: invocation count, success rate, avg cost, avg duration.
 * Flags degrading skills (success rate dropped >20% in 7 days).
 * Weekly report to shared/daily-brief/skill-health-YYYY-MM-DD.md
 *
 * PM2 cron: Mondays 8am EST (0 13 * * 1 UTC)
 * State: scripts/.skill-effectiveness-state.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const CLAWD_DIR = process.env.CLAWD_DIR || path.join(os.homedir(), 'clawd');

const AGENTS_DIR = path.join(OPENCLAW_DIR, 'agents');
const STATE_FILE = path.join(__dirname, '.skill-effectiveness-state.json');
const BRIEF_DIR = path.join(CLAWD_DIR, 'shared/daily-brief');
const LOOKBACK_DAYS = 7;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRun: null, weeklySnapshots: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getRecentSessionFiles(agentDir, days) {
  const sessDir = path.join(agentDir, 'sessions');
  if (!fs.existsSync(sessDir)) return [];

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = [];

  try {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(sessDir, f);
      const stat = fs.statSync(fp);
      if (stat.mtime.getTime() > cutoff) files.push(fp);
    }
  } catch {}

  return files;
}

function parseSessionFile(filePath) {
  const skills = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Look for skill invocations in various JSONL formats
        if (entry.skill || entry.tool || entry.function_call) {
          const skillName = entry.skill || entry.tool || entry.function_call?.name || 'unknown';
          const success = entry.success !== false && entry.error === undefined;
          const cost = entry.cost || 0;
          const duration = entry.duration || entry.elapsed_ms || 0;

          skills.push({ name: skillName, success, cost, duration });
        }

        // Also look for tool_use blocks in assistant messages
        if (entry.role === 'assistant' && Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (block.type === 'tool_use') {
              skills.push({
                name: block.name || 'unknown',
                success: true, // assume success unless tool_result says otherwise
                cost: 0,
                duration: 0,
              });
            }
          }
        }
      } catch {}
    }
  } catch {}

  return skills;
}

function run() {
  const state = loadState();
  const today = new Date().toISOString().split('T')[0];

  let agentDirs;
  try {
    agentDirs = fs.readdirSync(AGENTS_DIR)
      .filter(d => !d.startsWith('_') && d !== 'default')
      .map(d => ({ id: d, path: path.join(AGENTS_DIR, d) }))
      .filter(d => fs.statSync(d.path).isDirectory());
  } catch (e) {
    console.error('[skill-tracker] Cannot read agents dir:', e.message);
    process.exit(1);
  }

  // Aggregate skill data across all agents
  const skillStats = {};

  for (const agent of agentDirs) {
    const files = getRecentSessionFiles(agent.path, LOOKBACK_DAYS);

    for (const file of files) {
      const invocations = parseSessionFile(file);

      for (const inv of invocations) {
        if (!skillStats[inv.name]) {
          skillStats[inv.name] = {
            count: 0, successes: 0, failures: 0,
            totalCost: 0, totalDuration: 0,
            agents: new Set(),
          };
        }
        const s = skillStats[inv.name];
        s.count++;
        if (inv.success) s.successes++;
        else s.failures++;
        s.totalCost += inv.cost;
        s.totalDuration += inv.duration;
        s.agents.add(agent.id);
      }
    }
  }

  // Sort by invocation count
  const sorted = Object.entries(skillStats)
    .map(([name, stats]) => ({
      name,
      count: stats.count,
      successRate: stats.count > 0 ? (stats.successes / stats.count * 100).toFixed(1) : '0.0',
      avgCost: stats.count > 0 ? (stats.totalCost / stats.count).toFixed(4) : '0.0000',
      avgDuration: stats.count > 0 ? Math.round(stats.totalDuration / stats.count) : 0,
      agents: [...stats.agents],
      failures: stats.failures,
    }))
    .sort((a, b) => b.count - a.count);

  // Compare with previous snapshot for degradation detection
  const previousSnapshot = state.weeklySnapshots[state.weeklySnapshots.length - 1];
  const degraded = [];

  if (previousSnapshot) {
    for (const skill of sorted) {
      const prev = previousSnapshot.skills?.find(s => s.name === skill.name);
      if (prev && prev.count >= 5) {
        const prevRate = parseFloat(prev.successRate);
        const currRate = parseFloat(skill.successRate);
        if (prevRate - currRate > 20) {
          degraded.push({
            name: skill.name,
            prevRate: prevRate.toFixed(1),
            currRate: currRate.toFixed(1),
            drop: (prevRate - currRate).toFixed(1),
          });
        }
      }
    }
  }

  // Generate weekly report
  const totalInvocations = sorted.reduce((sum, s) => sum + s.count, 0);
  const totalSkills = sorted.length;

  let report = `# Skill Effectiveness Report — ${today}\n\n`;
  report += `**Period:** Last ${LOOKBACK_DAYS} days | **Agents:** ${agentDirs.length} | **Total invocations:** ${totalInvocations} | **Unique skills:** ${totalSkills}\n\n`;

  if (degraded.length > 0) {
    report += `## ⚠️ Degraded Skills (>20% success rate drop)\n\n`;
    report += `| Skill | Previous | Current | Drop |\n|-------|----------|---------|------|\n`;
    for (const d of degraded) {
      report += `| ${d.name} | ${d.prevRate}% | ${d.currRate}% | -${d.drop}% |\n`;
    }
    report += '\n';
  }

  report += `## Top Skills by Usage\n\n`;
  report += `| Skill | Invocations | Success Rate | Avg Cost | Agents |\n`;
  report += `|-------|-------------|-------------|----------|--------|\n`;
  for (const skill of sorted.slice(0, 30)) {
    report += `| ${skill.name} | ${skill.count} | ${skill.successRate}% | $${skill.avgCost} | ${skill.agents.length} |\n`;
  }

  if (sorted.length > 30) {
    report += `\n*... and ${sorted.length - 30} more skills*\n`;
  }

  report += `\n---\n*Generated by skill-effectiveness.js on ${new Date().toISOString()}*\n`;

  // Write report
  fs.mkdirSync(BRIEF_DIR, { recursive: true });
  const reportFile = path.join(BRIEF_DIR, `skill-health-${today}.md`);
  fs.writeFileSync(reportFile, report);

  // Save snapshot
  state.lastRun = new Date().toISOString();
  state.weeklySnapshots = [
    ...(state.weeklySnapshots || []).slice(-8),
    { date: today, skills: sorted.slice(0, 50) },
  ];
  saveState(state);

  console.log(`[skill-tracker] ${totalInvocations} invocations across ${totalSkills} skills, ${degraded.length} degraded. Report: ${reportFile}`);
}

run();
