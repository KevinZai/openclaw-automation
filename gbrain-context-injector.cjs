#!/usr/bin/env node
/**
 * gbrain-context-injector.cjs
 *
 * Generates a tight markdown blob of relevant context for a given agent,
 * pulled from gbrain (CLI) + recent agent memory files. Capped at ~500 tokens.
 *
 * Usage:
 *   node gbrain-context-injector.cjs --agent alfred --output stdout
 *   node gbrain-context-injector.cjs --agent jarvis --output file
 *
 * Output paths:
 *   stdout — print to terminal
 *   file   — write to ~/.openclaw/agents/<id>/auto-context.md
 *
 * Strategy 9 (Strategic Improvements 2026-05-09):
 * Auto-inject relevant gbrain knowledge into agent context at session start
 * to save mid-session token spend on gbrain_search calls.
 */

const { execFileSync } = require('child_process');
const { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } = require('fs');
const { homedir } = require('os');
const path = require('path');

const HOME = homedir();
const CLAWD = '/Users/ai/clawd';
const OC_AGENTS_DIR = path.join(HOME, '.openclaw', 'agents');
const MAX_TOKENS = 500; // ~2000 chars
const MAX_CHARS = MAX_TOKENS * 4;

// ===== Per-agent policies =====
// Each policy declares: workspace dir, gbrain queries, memory days lookback.
const POLICIES = {
  alfred: {
    workspace: 'main',
    title: 'Alfred (Personal Assistant)',
    queries: [
      { label: 'Recent decisions', q: 'kevin decision OR correction recent', limit: 3 },
      { label: 'Active projects', q: 'project status active', limit: 3 },
      { label: 'People in orbit', q: 'kevin family stakeholders', limit: 2 },
    ],
    memoryDays: 7,
    memoryWorkspaces: ['main'],
  },
  jarvis: {
    workspace: 'guestnetworks',
    title: 'Jarvis (MyWiFi/GN)',
    queries: [
      { label: 'MyWiFi/GN customers', q: 'mywifi guestnetworks customer contract', limit: 3 },
      { label: 'GN team activity', q: 'damian sam scott oscar mabel recent', limit: 3 },
      { label: 'Active deals', q: 'deal pipeline mywifi sale', limit: 2 },
    ],
    memoryDays: 30,
    memoryWorkspaces: ['guestnetworks'],
  },
  morpheus: {
    workspace: 'architecture',
    title: 'Morpheus (Architect)',
    queries: [
      { label: 'Recent architecture decisions', q: 'architecture decision OpenClaw config', limit: 3 },
      { label: 'System events', q: 'system event audit migration', limit: 3 },
      { label: 'Open compliance items', q: 'compliance gate review pending', limit: 2 },
    ],
    memoryDays: 14,
    memoryWorkspaces: ['architecture'],
  },
  quill: {
    workspace: 'quill',
    title: 'Quill (Fleet Brief / Status)',
    queries: [
      { label: 'Active projects', q: 'active project status update', limit: 3 },
      { label: 'Recent fleet briefs', q: 'fleet brief output kevin status', limit: 3 },
    ],
    memoryDays: 7,
    memoryWorkspaces: ['quill'],
  },
  viper: {
    workspace: 'trading',
    title: 'Viper (Trading)',
    queries: [
      { label: 'Portfolio positions', q: 'portfolio position trade open', limit: 3 },
      { label: 'Market events', q: 'market event actionable signal', limit: 3 },
    ],
    memoryDays: 7,
    memoryWorkspaces: ['trading'],
  },
};

// ===== Helpers =====

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { agent: null, output: 'stdout' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') out.agent = args[++i];
    else if (args[i] === '--output') out.output = args[++i];
  }
  return out;
}

/** Run gbrain query with hard wall-clock timeout via perl alarm wrapper. */
function gbrainQuery(query, limit = 3, timeoutSec = 35) {
  try {
    const stdout = execFileSync('perl', [
      '-e',
      `alarm ${timeoutSec}; exec("gbrain", "query", "${query.replace(/"/g, '\\"')}", "--no-expand")`,
    ], {
      encoding: 'utf-8',
      timeout: (timeoutSec + 5) * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // gbrain query output: [score] path -- snippet
    return stdout.split('\n')
      .filter(l => /^\[\d+\.\d+\]/.test(l))
      .slice(0, limit)
      .map(l => {
        const m = l.match(/^\[(\d+\.\d+)\]\s+(\S+)\s+--\s+(.+)$/);
        if (!m) return null;
        return { score: parseFloat(m[1]), source: m[2], snippet: m[3].slice(0, 140) };
      })
      .filter(Boolean);
  } catch (e) {
    return []; // Lock contention or no results — fall back gracefully.
  }
}

/** Scan a workspace memory dir and pull recent tagged lines. */
function scrapeRecentMemory(workspace, days) {
  const memDir = path.join(CLAWD, 'workspaces', workspace, 'memory');
  if (!existsSync(memDir)) return [];
  const cutoff = Date.now() - days * 86400000;
  const files = readdirSync(memDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
    .map(f => ({ f, full: path.join(memDir, f) }))
    .filter(({ full }) => {
      try { return statSync(full).mtimeMs >= cutoff; } catch { return false; }
    })
    .sort((a, b) => b.f.localeCompare(a.f))
    .slice(0, 10);

  const tagged = [];
  for (const { f, full } of files) {
    try {
      const content = readFileSync(full, 'utf-8');
      const lines = content.split('\n')
        .filter(l => /\[(DECISION|CORRECTION|LEARNED|TASK|EVENT)\]/.test(l))
        .slice(0, 3);
      for (const l of lines) {
        tagged.push({ date: f.replace('.md', ''), line: l.trim().replace(/^[-*]\s*/, '').slice(0, 180) });
      }
    } catch { /* skip */ }
    if (tagged.length >= 8) break;
  }
  return tagged;
}

function formatBlock(agent, policy) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const parts = [];
  parts.push(`## Recent context (auto-injected from gbrain at ${ts})`);
  parts.push('');
  parts.push(`> Source: gbrain v0.10.1 + ${policy.workspace} memory (last ${policy.memoryDays}d)`);
  parts.push(`> Regenerated every 30min by gbrain-context-prewrite cron.`);
  parts.push('');

  // gbrain queries
  for (const { label, q, limit } of policy.queries) {
    const results = gbrainQuery(q, limit);
    if (results.length === 0) continue;
    parts.push(`### ${label}`);
    for (const r of results) {
      parts.push(`- \`${r.source}\` — ${r.snippet}`);
    }
    parts.push('');
  }

  // Recent memory
  const memWs = policy.memoryWorkspaces || [policy.workspace];
  for (const ws of memWs) {
    const tagged = scrapeRecentMemory(ws, policy.memoryDays);
    if (tagged.length === 0) continue;
    parts.push(`### Recent memory tags (${ws}, last ${policy.memoryDays}d)`);
    for (const t of tagged.slice(0, 6)) {
      parts.push(`- ${t.date}: ${t.line}`);
    }
    parts.push('');
  }

  parts.push('---');
  parts.push(`*Cap: ${MAX_TOKENS} tokens. Truncated if exceeded.*`);

  let blob = parts.join('\n');
  if (blob.length > MAX_CHARS) {
    blob = blob.slice(0, MAX_CHARS - 80) + '\n...\n[truncated to fit context budget]';
  }
  return blob;
}

function writeAgentContext(agent, blob) {
  const dir = path.join(OC_AGENTS_DIR, agent);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, 'auto-context.md');
  writeFileSync(filePath, blob);
  return filePath;
}

// ===== Main =====

function main() {
  const { agent, output } = parseArgs();
  if (!agent) {
    console.error('Usage: gbrain-context-injector.cjs --agent <id> --output [stdout|file]');
    process.exit(2);
  }
  const policy = POLICIES[agent];
  if (!policy) {
    console.error(`Unknown agent "${agent}". Known: ${Object.keys(POLICIES).join(', ')}`);
    process.exit(2);
  }
  const blob = formatBlock(agent, policy);
  if (output === 'stdout') {
    process.stdout.write(blob + '\n');
  } else if (output === 'file') {
    const fp = writeAgentContext(agent, blob);
    console.log(`[${new Date().toISOString()}] wrote ${blob.length}c → ${fp}`);
  } else {
    console.error(`Unknown output mode "${output}"`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { POLICIES, formatBlock, gbrainQuery, scrapeRecentMemory };
