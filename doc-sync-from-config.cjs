#!/usr/bin/env node
/**
 * doc-sync-from-config.cjs
 *
 * Reads ~/.openclaw/openclaw.json and syncs canonical docs:
 *   - agent count (e.g. "39 agents")
 *   - free fleet roster table
 *
 * Replaces ONLY content between explicit markers:
 *   <!-- AGENT_COUNT_AUTO -->...<!-- /AGENT_COUNT_AUTO -->
 *   <!-- FREE_FLEET_AUTO -->...<!-- /FREE_FLEET_AUTO -->
 *
 * Plus targeted regex updates for known prose patterns.
 *
 * Exits 0 if no changes; 1 if files were modified (so git pre-commit can fail).
 *
 * Usage:
 *   node scripts/doc-sync-from-config.cjs            # apply changes
 *   node scripts/doc-sync-from-config.cjs --check    # report-only, exit 1 if drift
 *   node scripts/doc-sync-from-config.cjs --verbose  # print diffs
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ARGS = new Set(process.argv.slice(2));
const CHECK_ONLY = ARGS.has('--check');
const VERBOSE = ARGS.has('--verbose');

const CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const REPO_ROOT = path.resolve(__dirname, '..');

const DOCS = [
  'CLAUDE.md',
  'shared/LLM-ROUTING.md',
  'shared/TEAM-DIRECTORY.md',
  'shared/INTER-AGENT-PROTOCOL.md',
  'shared/refs/AGENT-ROLES-RESPONSIBILITIES-2026-05-08.md',
  // Added 2026-05-14: SYSTEM-FLOW-MAP carries AGENT_COUNT_AUTO + FREE_FLEET_AUTO + OC_VERSION_AUTO markers.
  // TODO: full prose-mode sweep of SYSTEM-FLOW-MAP requires regex coverage for embedded mermaid labels — out of scope for marker-only pass.
  'shared/refs/SYSTEM-FLOW-MAP.md',
].map((p) => path.join(REPO_ROOT, p));

// ─────────────────────────────────────────────────────────────
// 1. Load config + compute facts
// ─────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`✗ Config not found: ${CONFIG_PATH}`);
    process.exit(2);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function isFreeFleetModel(model) {
  if (!model) return false;
  const m = typeof model === 'string'
    ? model
    : (model.primary || model.default || '');
  if (!m || typeof m !== 'string') return false;
  return (
    m.includes(':free') ||
    m.startsWith('groq/') ||
    m.startsWith('cloudflare/') ||
    m.startsWith('cerebras/') ||
    m.startsWith('ollama/') ||
    m.startsWith('huggingface/') ||
    m.startsWith('xai/') // Elon kept in fleet for X access
  );
}

function computeFacts(config) {
  const agents = (config.agents && config.agents.list) || [];
  const total = agents.length;

  // Free Fleet — agents on free/cheap providers (matches LLM-ROUTING § 5)
  const freeFleet = agents.filter((a) => isFreeFleetModel(a.model));

  // Per-agent model + persona map (CC-849: drift detection extension)
  const agentModels = agents.map((a) => ({
    id: a.id,
    name: a.name || a.id,
    model: a.model || '(none)',
    persona: a.persona || a.identity?.persona || '',
  }));

  // Skill catalog count — total skills declared across all agents (deduped)
  const skillSet = new Set();
  for (const a of agents) {
    for (const s of a.skills || []) skillSet.add(typeof s === 'string' ? s : s?.id);
  }
  const skillCount = skillSet.size;

  return { total, agents, freeFleet, agentModels, skillCount };
}

// ─────────────────────────────────────────────────────────────
// 2. Render auto-blocks
// ─────────────────────────────────────────────────────────────

function renderAgentCount(facts) {
  return String(facts.total);
}

function renderFreeFleetTable(facts) {
  const rows = facts.freeFleet.map((a) => {
    const provider = (a.model || '').split('/')[0] || '?';
    return `| ${a.name || a.id} | ${provider} | \`${a.model}\` |`;
  });
  return [
    '| Agent | Provider | Model |',
    '|-------|----------|-------|',
    ...rows,
  ].join('\n');
}

function renderAgentModelTable(facts) {
  const rows = facts.agentModels.map((a) => {
    const persona = a.persona ? ` · _${a.persona}_` : '';
    return `| ${a.name} | \`${a.model}\`${persona} |`;
  });
  return [
    '| Agent | Model · Persona |',
    '|-------|------------------|',
    ...rows,
  ].join('\n');
}

function renderSkillCount(facts) {
  return String(facts.skillCount);
}

// ─────────────────────────────────────────────────────────────
// 3. Sync logic per-file
// ─────────────────────────────────────────────────────────────

function replaceMarker(content, markerName, replacement) {
  const re = new RegExp(
    `(<!-- ${markerName} -->)([\\s\\S]*?)(<!-- /${markerName} -->)`,
    'g'
  );
  return content.replace(re, (_m, open, _inner, close) => `${open}${replacement}${close}`);
}

/**
 * Targeted prose patterns — match common phrasings that drift.
 * Each entry: { re, render(facts) → replacement string }
 *
 * Patterns are anchored to specific surrounding text so they
 * never accidentally match unrelated numbers.
 */
function buildProsePatterns(facts) {
  const n = facts.total;
  return [
    // "manages 38 specialized AI agents"  /  "manages 39 agents"
    {
      re: /manages\s+\d{2,3}\s+(specialized\s+AI\s+)?agents\b/g,
      sub: (m) => m.replace(/\d{2,3}/, String(n)),
    },
    // "single source of truth: 38 agents"
    {
      re: /single source of truth:\s*\d{2,3}\s+agents/gi,
      sub: () => `single source of truth: ${n} agents`,
    },
    // "Verified against live openclaw.json (38 agents)"
    {
      re: /openclaw\.json\s*\(\s*\d{2,3}\s+agents/g,
      sub: () => `openclaw.json (${n} agents`,
    },
    // "## Agent Roster (39 agents)"
    {
      re: /^##\s+Agent Roster\s*\(\s*\d{2,3}\s+agents\s*\)/gm,
      sub: () => `## Agent Roster (${n} agents)`,
    },
    // "agent count 39"
    {
      re: /agent count\s+\d{2,3}\b/g,
      sub: () => `agent count ${n}`,
    },
    // "across all 39 agents"
    {
      re: /across all\s+\d{2,3}\s+agents/g,
      sub: () => `across all ${n} agents`,
    },
  ];
}

function syncFile(filePath, facts) {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, skipped: 'not found', changed: false };
  }
  const before = fs.readFileSync(filePath, 'utf8');
  let after = before;

  // Marker-based replacements (safest)
  after = replaceMarker(after, 'AGENT_COUNT_AUTO', renderAgentCount(facts));
  after = replaceMarker(after, 'FREE_FLEET_AUTO', '\n' + renderFreeFleetTable(facts) + '\n');
  // CC-849: model+persona drift detection
  after = replaceMarker(after, 'AGENT_MODELS_AUTO', '\n' + renderAgentModelTable(facts) + '\n');
  after = replaceMarker(after, 'SKILL_COUNT_AUTO', renderSkillCount(facts));

  // Prose pattern replacements (targeted regex)
  for (const p of buildProsePatterns(facts)) {
    after = after.replace(p.re, p.sub);
  }

  const changed = after !== before;
  if (changed && !CHECK_ONLY) {
    fs.writeFileSync(filePath, after, 'utf8');
  }
  return { path: filePath, changed, before, after };
}

// ─────────────────────────────────────────────────────────────
// 4. Main
// ─────────────────────────────────────────────────────────────

function main() {
  const config = loadConfig();
  const facts = computeFacts(config);

  console.log(`▸ doc-sync-from-config — agents=${facts.total}, free_fleet=${facts.freeFleet.length}, skills=${facts.skillCount}`);

  const results = DOCS.map((d) => syncFile(d, facts));
  const changed = results.filter((r) => r.changed);
  const skipped = results.filter((r) => r.skipped);

  for (const r of results) {
    const rel = path.relative(REPO_ROOT, r.path);
    if (r.skipped) {
      console.log(`  · ${rel}  (skipped: ${r.skipped})`);
    } else if (r.changed) {
      console.log(`  ✱ ${rel}  ${CHECK_ONLY ? '[would update]' : '[updated]'}`);
      if (VERBOSE) {
        // Crude diff: show first differing line region
        const a = (r.before || '').split('\n');
        const b = (r.after || '').split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) {
            console.log(`      L${i + 1}- ${a[i] || ''}`);
            console.log(`      L${i + 1}+ ${b[i] || ''}`);
          }
        }
      }
    } else {
      console.log(`  ✓ ${rel}`);
    }
  }

  if (changed.length === 0) {
    console.log('✓ All docs in sync.');
    process.exit(0);
  }

  if (CHECK_ONLY) {
    console.log(`✗ ${changed.length} file(s) would be updated. Run without --check to apply.`);
  } else {
    console.log(`✱ ${changed.length} file(s) updated. Re-stage and commit.`);
  }
  process.exit(1);
}

try {
  main();
} catch (e) {
  console.error('✗ doc-sync failed:', e.message);
  if (VERBOSE) console.error(e.stack);
  process.exit(2);
}
