#!/usr/bin/env node
/**
 * curate-free-fleet.cjs — Curate Paperclip backlog → free-fleet inbox briefs.
 *
 * Runs 3×/day via PM2 cron (08:00, 14:00, 20:00 America/Toronto).
 * Reads Paperclip backlog issues, sizes them by token estimate,
 * assigns to the correct free-fleet worker tier, and writes a brief
 * to ~/clawd/output/free-fleet/inbox/<id>-<slug>.md.
 *
 * The cron-owner is Vox; Alfred + Neo edit briefs via Paperclip comments.
 *
 * Output canonical: Paperclip issue (status=todo, assigneeAgentId set)
 *                 + filesystem brief (consumed by workers)
 *
 * Safe to run repeatedly — re-uses Paperclip issue IDs as the filename slug
 * so no duplicates land in inbox/.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const INBOX_DIR = path.join(process.env.HOME, 'clawd/output/free-fleet/inbox');
const STATE_FILE = path.join(process.env.HOME, 'clawd/scripts/.curate-state.json');
const PG_CONN = 'PGPASSWORD=paperclip rtk proxy psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -tA';

// Tier capacity table — keep in sync with shared/refs/FREE-FLEET-BACKLOG.md
const TIERS = [
  { name: 'bolt',    max: 2000,   role: 'micro' },
  { name: 'forge',   max: 4000,   role: 'quick-reasoning' },
  { name: 'coder',   max: 12000,  role: 'code', tagHints: ['code','script','refactor','typescript','sql'] },
  { name: 'bard',    max: 20000,  role: 'prose', tagHints: ['blog','tweet','content','copy','marketing'] },
  { name: 'flare',   max: 30000,  role: 'general' },
  { name: 'oracle',  max: 50000,  role: 'reasoning', tagHints: ['research','analyze','deep-dive'] },
  { name: 'iris',    max: 100000, role: 'vision', tagHints: ['screenshot','image','diagram'] },
  { name: 'athena',  max: 100000, role: 'synthesis' },
  { name: 'lama',    max: 100000, role: 'long-context' },
];

const log = (msg) => console.log(`[curate ${new Date().toISOString()}] ${msg}`);

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { lastRun: 0, briefed: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function pq(sql) {
  return execSync(`${PG_CONN} -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

// JSON-aggregate variant for row data with newlines/pipes inside fields.
function pqJson(sql) {
  const wrapped = `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM (${sql}) t`;
  const out = execSync(`${PG_CONN} -c "${wrapped.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

function estimateTokens(text) {
  // Crude: 1 token ≈ 4 chars
  return Math.ceil((text || '').length / 4);
}

function pickTier(issue) {
  const text = `${issue.title} ${issue.description || ''}`.toLowerCase();
  const tokens = estimateTokens(text) + 1500; // overhead

  // Hint-based first: if title strongly suggests a specialty, prefer that tier when capacity OK
  for (const t of TIERS) {
    if (t.tagHints && t.tagHints.some(h => text.includes(h)) && tokens <= t.max) {
      return t;
    }
  }
  // Else smallest tier that fits
  return TIERS.find(t => tokens <= t.max) || TIERS[TIERS.length - 1];
}

function slugify(s) {
  // Strip newlines, markdown, anything outside a-z0-9
  const cleaned = (s || 'untitled')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[*_`#>|/\\]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 40) || 'untitled';
}

function loadAgentIds() {
  const rows = pqJson("SELECT name, id::text as id FROM agents WHERE name IN ('bolt','forge','coder','bard','flare','oracle','athena','iris','lama')");
  const map = {};
  for (const r of rows) map[r.name] = r.id;
  return map;
}

function fetchBacklog() {
  // Pick truly unassigned-or-stale backlog issues; cap 20 per run
  return pqJson(`
    SELECT identifier, id::text as id, COALESCE(title, '') as title, COALESCE(description, '') as description, assignee_agent_id::text as assignee
    FROM issues
    WHERE status IN ('backlog','todo')
      AND (started_at IS NULL OR started_at < NOW() - INTERVAL '48 hours')
    ORDER BY priority DESC NULLS LAST, created_at DESC
    LIMIT 20
  `);
}

function writeBrief(issue, tier) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const filename = `${issue.identifier}-${slugify(issue.title)}.md`;
  const filepath = path.join(INBOX_DIR, filename);
  if (fs.existsSync(filepath)) return null;
  const body = `---
paperclip_id: ${issue.identifier}
assigned_to: ${tier.name}
tier: ${tier.role}
max_tokens: ${tier.max}
curated_at: ${new Date().toISOString()}
curator: vox
kevin_status: pending_review
---

# ${issue.title}

${issue.description || '(no description; see Paperclip issue for context)'}

## Worker instructions
- Tier: **${tier.name}** (${tier.role}, ≤${tier.max} tokens)
- Read this brief, fetch any extra context from Paperclip if needed:
  \`curl -s http://localhost:3100/api/issues/${issue.id}\`
- Deliver to: \`~/clawd/output/free-fleet/done/$(date +%Y-%m-%d)/${issue.identifier}-output.md\`
- Update Paperclip status to \`done\` when complete.
- If task >${tier.max} tokens or wrong tier, post a comment + leave alone.
`;
  fs.writeFileSync(filepath, body);
  return filepath;
}

function assignInPaperclip(issue, tier, agentIds) {
  const agentId = agentIds[tier.name];
  if (!agentId) return false;
  // Set assigneeAgentId + status=todo
  try {
    pq(`UPDATE issues SET assignee_agent_id='${agentId}', status='todo', updated_at=NOW() WHERE id='${issue.id}'`);
    return true;
  } catch (e) {
    log(`ERR assign ${issue.identifier} → ${tier.name}: ${e.message}`);
    return false;
  }
}

function main() {
  const state = readState();
  const agentIds = loadAgentIds();
  const backlog = fetchBacklog();
  let curatedCount = 0;
  for (const issue of backlog) {
    if (state.briefed.includes(issue.identifier)) continue;
    const tier = pickTier(issue);
    const briefPath = writeBrief(issue, tier);
    if (!briefPath) continue;
    const assigned = assignInPaperclip(issue, tier, agentIds);
    if (assigned) {
      state.briefed.push(issue.identifier);
      curatedCount++;
      log(`+ ${issue.identifier} → ${tier.name} (${tier.role}) at ${briefPath}`);
    }
  }
  // Keep state file bounded
  state.briefed = state.briefed.slice(-200);
  state.lastRun = Date.now();
  saveState(state);
  log(`curated=${curatedCount} backlog_seen=${backlog.length}`);
}

main();
