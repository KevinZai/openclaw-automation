#!/usr/bin/env node
// cost-by-channel.cjs — Per-channel LLM cost attribution for OpenClaw
// Usage:
//   node cost-by-channel.cjs [--since=7d|1d|30d] [--format=json|markdown] [--drill] [--channel=<name>]
// Examples:
//   node cost-by-channel.cjs --since=7d --format=markdown
//   node cost-by-channel.cjs --drill --channel=discord-#alfred --since=7d

'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const AGENTS_ROOT = path.join(process.env.HOME, '.openclaw', 'agents');

// Discord channel ID → human name mapping
// Source: shared/CHANNEL-ROUTING.md
const DISCORD_CHANNEL_NAMES = {
  '1475370281899135037': '#alfred',
  '1475601212639281356': '#morpheus',
  '1478140762150408365': '#morpheus-lite',
  '1478512416227856384': '#neo',
  '1478513427491061781': '#viper',
  '1478512417221902580': '#jarvis',
  '1475370298424557692': '#family',
  '1475370299393446083': '#home',
  '1475370299884044350': '#kids',
  '1477872495506755736': '#codex',
  '1477872496496738315': '#gemini',
  '1477872497599840369': '#claude-code',
  '1479242815618678784': '#tank',
  '1479242817610977421': '#cobra',
  '1479242818525466829': '#elon',
  '1479364800801669283': '#atlas',
  '1479364801732939987': '#scribe',
  '1479364805767860319': '#guardian',
  '1479364808624312394': '#pixel',
  '1479372533571649608': '#oracle',
  '1479932109081677936': '#axel',
  '1479932144917811450': '#axiom',
  '1479932167655133396': '#music',
  '1476917154510278900': '#pm-intake',
  '1475370312362364993': '#drops',
  '1477880468354629837': '#gn-intake',
  '1479364810251567154': '#isabel',
  '1479364811199614976': '#dylan',
  '1475370290811769002': '#trading',
  '1475370292040958125': '#signals',
  '1475370293319962624': '#research',
  '1481688749112037467': '#hawkeye',
  '1480024946229907637': '#forge',
  '1479993733033496669': '#lama',
  '1479993717451657307': '#flare',
};

// GN agents → Slack
const SLACK_AGENTS = new Set(['jarvis', 'damian', 'sam', 'scott', 'oscar', 'mabel']);

// Channel type taxonomy (for aggregated rollup)
const CHANNEL_TYPE_ORDER = [
  'discord', 'slack', 'telegram', 'whatsapp', 'bluebubbles', 'webchat',
  'cron', 'paperclip', 'subagent', 'internal',
];

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { since: '7d', format: 'json', drill: false, channel: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--since=')) args.since = arg.slice(8);
    else if (arg.startsWith('--format=')) args.format = arg.slice(9);
    else if (arg === '--drill') args.drill = true;
    else if (arg.startsWith('--channel=')) args.channel = arg.slice(10);
  }
  return args;
}

function parseSince(since) {
  const m = since.match(/^(\d+)(d|h)$/);
  if (!m) throw new Error(`Invalid --since value: ${since} (use e.g. 7d, 24h, 30d)`);
  const [, n, unit] = m;
  const ms = unit === 'd' ? Number(n) * 86400000 : Number(n) * 3600000;
  return Date.now() - ms;
}

// ── Channel detection ────────────────────────────────────────────────────────

/**
 * Returns { type, label, channelKey } from a trajectory sessionKey.
 * sessionKey format: agent:AGENT:SOURCE[:extra]
 *
 * Examples:
 *   agent:main:discord:channel:1475370281899135037  → discord / #alfred / discord-#alfred
 *   agent:main:cron:9e68b...                        → cron / daily-status-ping / cron
 *   agent:main:paperclip                            → paperclip / paperclip / paperclip
 *   agent:main:subagent:UUID                        → subagent / subagent / subagent
 *   agent:main:main                                 → webchat / webchat / webchat
 *   agent:main:main:heartbeat                       → internal / heartbeat / internal
 */
function detectChannelFromSessionKey(sessionKey, agentId) {
  const parts = sessionKey.split(':');
  // parts[0] = 'agent', parts[1] = agentId, parts[2] = source
  const source = parts[2] || 'unknown';

  if (source === 'discord') {
    const chanId = parts[4]; // agent:main:discord:channel:<id>
    const name = DISCORD_CHANNEL_NAMES[chanId] || `#${chanId}`;
    return { type: 'discord', label: `discord-${name}`, channelKey: `discord-${name}` };
  }
  if (source === 'slack') {
    return { type: 'slack', label: `slack-${agentId}`, channelKey: `slack-${agentId}` };
  }
  if (source === 'telegram') {
    const topic = parts[4] ? `:topic:${parts[4]}` : '';
    return { type: 'telegram', label: `telegram${topic}`, channelKey: 'telegram' };
  }
  if (source === 'whatsapp') {
    return { type: 'whatsapp', label: 'whatsapp', channelKey: 'whatsapp' };
  }
  if (source === 'bluebubbles') {
    return { type: 'bluebubbles', label: 'bluebubbles', channelKey: 'bluebubbles' };
  }
  if (source === 'cron') {
    return { type: 'cron', label: 'cron', channelKey: 'cron' };
  }
  if (source === 'paperclip') {
    return { type: 'paperclip', label: 'paperclip', channelKey: 'paperclip' };
  }
  if (source === 'subagent') {
    return { type: 'subagent', label: 'subagent', channelKey: 'subagent' };
  }
  if (source === 'explicit') {
    return { type: 'internal', label: 'internal-explicit', channelKey: 'internal' };
  }
  if (source === 'main') {
    const sub = parts[3];
    if (sub === 'heartbeat') return { type: 'internal', label: 'heartbeat', channelKey: 'internal' };
    return { type: 'webchat', label: 'webchat', channelKey: 'webchat' };
  }
  return { type: 'internal', label: `internal-${source}`, channelKey: 'internal' };
}

/**
 * Heuristic detection for sessions WITHOUT a trajectory file.
 * Falls back to file name patterns + agent identity.
 */
function detectChannelHeuristic(sessionFile, agentId) {
  const fname = path.basename(sessionFile);

  // boot files are always internal cron/restart sequences
  if (fname.startsWith('boot-')) {
    return { type: 'cron', label: 'cron', channelKey: 'cron' };
  }
  // topic files → Slack (Jarvis and GN team)
  if (fname.includes('-topic-')) {
    if (SLACK_AGENTS.has(agentId)) {
      return { type: 'slack', label: `slack-${agentId}`, channelKey: `slack-${agentId}` };
    }
    return { type: 'slack', label: 'slack', channelKey: 'slack' };
  }
  // GN agents without trajectory → Slack
  if (SLACK_AGENTS.has(agentId)) {
    return { type: 'slack', label: `slack-${agentId}`, channelKey: `slack-${agentId}` };
  }
  // Delivery-mirror pattern in main (OpenClaw WebChat / gateway delivery)
  return { type: 'webchat', label: 'webchat', channelKey: 'webchat' };
}

// ── Session readers ──────────────────────────────────────────────────────────

/**
 * Read sessionKey from trajectory.jsonl (first line).
 * Returns null if file missing or parse error.
 */
function readSessionKeyFromTrajectory(trajFile) {
  if (!fs.existsSync(trajFile)) return null;
  try {
    const firstLine = fs.readFileSync(trajFile, 'utf8').split('\n')[0];
    const d = JSON.parse(firstLine);
    return d.sessionKey || null;
  } catch {
    return null;
  }
}

/**
 * Sum all LLM costs from a regular session JSONL.
 * Returns { totalCost, msgs: [{ts, cost, model}] }
 */
function readSessionCosts(sessionFile) {
  let totalCost = 0;
  const msgs = [];
  const raw = fs.readFileSync(sessionFile, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const msg = d.message;
    if (!msg || msg.role !== 'assistant') continue;
    const usage = msg.usage;
    if (!usage) continue;
    const cost = usage.cost?.total ?? 0;
    if (cost > 0) {
      totalCost += cost;
      msgs.push({ ts: d.timestamp, cost, model: msg.model || 'unknown' });
    }
  }
  return { totalCost, msgs };
}

/**
 * Sum all LLM costs from trajectory.jsonl (messagesSnapshot).
 * Trajectory is authoritative when it exists and has model.completed events.
 * Returns { totalCost, msgs } or null if no cost data found.
 */
function readCostsFromTrajectory(trajFile) {
  if (!fs.existsSync(trajFile)) return null;
  let totalCost = 0;
  const msgs = [];
  const raw = fs.readFileSync(trajFile, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'model.completed') continue;
    const snapshot = d.data?.messagesSnapshot;
    if (!Array.isArray(snapshot)) continue;
    for (const m of snapshot) {
      if (m.role !== 'assistant') continue;
      const cost = m.usage?.cost?.total ?? 0;
      if (cost > 0) {
        totalCost += cost;
        msgs.push({ ts: m.timestamp, cost, model: m.model || 'unknown' });
      }
    }
  }
  return totalCost > 0 ? { totalCost, msgs } : null;
}

// ── Core aggregation ─────────────────────────────────────────────────────────

function collectData(cutoffMs) {
  // byChannel: { channelKey → { type, label, totalCost, sessions, agentCosts: {agent→cost}, msgs: [] } }
  const byChannel = {};
  // byType: { type → totalCost }
  const byType = {};

  let totalSessions = 0;
  let attributedSessions = 0;
  let sessionsWithCost = 0;

  for (const agentId of fs.readdirSync(AGENTS_ROOT)) {
    const sessionsDir = path.join(AGENTS_ROOT, agentId, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;

    for (const fname of fs.readdirSync(sessionsDir)) {
      // Only regular session JSONL files
      if (!fname.endsWith('.jsonl')) continue;
      if (fname.endsWith('.trajectory.jsonl')) continue;
      if (fname.endsWith('.deleted') || fname.includes('.deleted.')) continue;

      const sessionFile = path.join(sessionsDir, fname);
      const stat = fs.statSync(sessionFile);
      if (stat.mtimeMs < cutoffMs) continue;

      totalSessions++;

      // Detect channel
      const base = fname.replace(/\.jsonl$/, '');
      const trajFile = path.join(sessionsDir, base + '.trajectory.jsonl');
      const sessionKey = readSessionKeyFromTrajectory(trajFile);

      let channel;
      if (sessionKey) {
        channel = detectChannelFromSessionKey(sessionKey, agentId);
        attributedSessions++;
      } else {
        channel = detectChannelHeuristic(sessionFile, agentId);
        // Boot/topic/GN files are reliably attributed
        if (fname.startsWith('boot-') || fname.includes('-topic-') || SLACK_AGENTS.has(agentId)) {
          attributedSessions++;
        }
      }

      // Read costs — prefer trajectory, fall back to session JSONL
      let costs = readCostsFromTrajectory(trajFile);
      if (!costs) costs = readSessionCosts(sessionFile);

      if (costs.totalCost <= 0) continue;
      sessionsWithCost++;

      const { channelKey, type, label } = channel;

      if (!byChannel[channelKey]) {
        byChannel[channelKey] = { type, label, totalCost: 0, sessions: 0, agentCosts: {}, msgs: [] };
      }
      byChannel[channelKey].totalCost += costs.totalCost;
      byChannel[channelKey].sessions++;
      byChannel[channelKey].agentCosts[agentId] = (byChannel[channelKey].agentCosts[agentId] || 0) + costs.totalCost;
      byChannel[channelKey].msgs.push(...costs.msgs.map(m => ({ ...m, agent: agentId })));

      byType[type] = (byType[type] || 0) + costs.totalCost;
    }
  }

  const totalCost = Object.values(byChannel).reduce((s, c) => s + c.totalCost, 0);
  const attributionPct = totalSessions > 0 ? Math.round((attributedSessions / totalSessions) * 100) : 0;

  return { byChannel, byType, totalCost, totalSessions, attributedSessions, attributionPct, sessionsWithCost };
}

// ── Daily breakdown ──────────────────────────────────────────────────────────

function buildDailyBreakdown(data, days) {
  // Group msgs by date × channelKey
  const byDate = {};
  for (const [channelKey, info] of Object.entries(data.byChannel)) {
    for (const msg of info.msgs) {
      const date = new Date(msg.ts).toISOString().slice(0, 10);
      if (!byDate[date]) byDate[date] = {};
      byDate[date][channelKey] = (byDate[date][channelKey] || 0) + msg.cost;
    }
  }
  return byDate;
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatJSON(data, sinceLabel) {
  const sorted = Object.entries(data.byChannel)
    .sort((a, b) => b[1].totalCost - a[1].totalCost)
    .map(([key, info]) => ({
      channel: key,
      type: info.type,
      label: info.label,
      totalCost: +info.totalCost.toFixed(6),
      sessions: info.sessions,
      agents: Object.entries(info.agentCosts)
        .sort((a, b) => b[1] - a[1])
        .map(([a, c]) => ({ agent: a, cost: +c.toFixed(6) })),
    }));

  return JSON.stringify({
    since: sinceLabel,
    totalCost: +data.totalCost.toFixed(6),
    totalSessions: data.totalSessions,
    sessionsWithCost: data.sessionsWithCost,
    attributionPct: data.attributionPct,
    byType: Object.fromEntries(
      Object.entries(data.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, +v.toFixed(6)])
    ),
    byChannel: sorted,
  }, null, 2);
}

function formatMarkdown(data, sinceLabel) {
  const lines = [];
  lines.push(`## 📊 Cost by Channel — ${sinceLabel}`);
  lines.push(`**Total:** $${data.totalCost.toFixed(4)} across ${data.sessionsWithCost} sessions with spend | Attribution: ${data.attributionPct}%\n`);

  // By channel type rollup
  lines.push('### By Channel Type');
  lines.push('| Type | Cost | % |');
  lines.push('|------|------|---|');
  const typeEntries = Object.entries(data.byType).sort((a, b) => b[1] - a[1]);
  for (const [type, cost] of typeEntries) {
    const pct = data.totalCost > 0 ? ((cost / data.totalCost) * 100).toFixed(1) : '0.0';
    lines.push(`| ${type} | $${cost.toFixed(4)} | ${pct}% |`);
  }

  lines.push('');
  lines.push('### Top Channels');
  lines.push('| Channel | Type | Cost | Sessions | Top Agent |');
  lines.push('|---------|------|------|----------|-----------|');

  const sorted = Object.entries(data.byChannel)
    .sort((a, b) => b[1].totalCost - a[1].totalCost)
    .slice(0, 20);

  for (const [, info] of sorted) {
    const topAgent = Object.entries(info.agentCosts).sort((a, b) => b[1] - a[1])[0];
    const topAgentStr = topAgent ? `${topAgent[0]} ($${topAgent[1].toFixed(4)})` : '-';
    lines.push(`| ${info.label} | ${info.type} | $${info.totalCost.toFixed(4)} | ${info.sessions} | ${topAgentStr} |`);
  }

  // Agent × Channel matrix (top 8 channels × top 8 agents)
  const topChannels = sorted.slice(0, 8);
  const allAgents = new Set();
  for (const [, info] of topChannels) {
    for (const a of Object.keys(info.agentCosts)) allAgents.add(a);
  }
  const topAgentsList = [...allAgents]
    .map(a => ({
      id: a,
      cost: topChannels.reduce((s, [, info]) => s + (info.agentCosts[a] || 0), 0),
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 8)
    .map(a => a.id);

  if (topAgentsList.length > 0 && topChannels.length > 1) {
    lines.push('');
    lines.push('### Agent × Channel Matrix (top 8×8)');
    lines.push(`| Agent | ${topChannels.map(([, i]) => i.label).join(' | ')} |`);
    lines.push(`|-------|${topChannels.map(() => '------').join('|')}|`);
    for (const agent of topAgentsList) {
      const cells = topChannels.map(([, info]) => {
        const c = info.agentCosts[agent] || 0;
        return c > 0 ? `$${c.toFixed(3)}` : '-';
      });
      lines.push(`| ${agent} | ${cells.join(' | ')} |`);
    }
  }

  return lines.join('\n');
}

// ── Drill mode ───────────────────────────────────────────────────────────────

function formatDrill(data, channelFilter) {
  const info = Object.values(data.byChannel).find(
    c => c.label === channelFilter || c.channelKey === channelFilter
  );
  if (!info) {
    return `No data found for channel: ${channelFilter}\nAvailable: ${Object.values(data.byChannel).map(c => c.label).join(', ')}`;
  }

  const lines = [`## 🔍 Drill: ${channelFilter}`, `Total: $${info.totalCost.toFixed(6)} | Sessions: ${info.sessions}`, ''];

  // Per-agent breakdown
  lines.push('### By Agent');
  for (const [agent, cost] of Object.entries(info.agentCosts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${agent}: $${cost.toFixed(6)}`);
  }

  // Per-message timeline (most expensive first, capped at 20)
  lines.push('');
  lines.push('### Top 20 Messages by Cost');
  lines.push('| Timestamp | Agent | Model | Cost |');
  lines.push('|-----------|-------|-------|------|');
  const topMsgs = [...info.msgs].sort((a, b) => b.cost - a.cost).slice(0, 20);
  for (const m of topMsgs) {
    const ts = new Date(m.ts).toISOString().replace('T', ' ').slice(0, 16);
    lines.push(`| ${ts} | ${m.agent} | ${m.model} | $${m.cost.toFixed(6)} |`);
  }

  // Daily totals
  const byDate = {};
  for (const m of info.msgs) {
    const date = new Date(m.ts).toISOString().slice(0, 10);
    byDate[date] = (byDate[date] || 0) + m.cost;
  }
  if (Object.keys(byDate).length > 0) {
    lines.push('');
    lines.push('### Daily Cost');
    for (const [date, cost] of Object.entries(byDate).sort()) {
      lines.push(`  ${date}: $${cost.toFixed(6)}`);
    }
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  const cutoffMs = parseSince(args.since);
  const sinceLabel = `last ${args.since}`;

  const data = collectData(cutoffMs);

  if (args.drill) {
    const channelFilter = args.channel;
    if (!channelFilter) {
      console.error('--drill requires --channel=<name>');
      process.exit(1);
    }
    console.log(formatDrill(data, channelFilter));
    return;
  }

  if (args.format === 'markdown') {
    console.log(formatMarkdown(data, sinceLabel));
  } else {
    console.log(formatJSON(data, sinceLabel));
  }
}

main();
