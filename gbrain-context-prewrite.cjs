#!/usr/bin/env node
/**
 * gbrain-context-prewrite.cjs
 *
 * Cron-driven wrapper around gbrain-context-injector. Iterates the policy
 * map and writes per-agent auto-context.md files to ~/.openclaw/agents/<id>/.
 *
 * Cron entry (every 30 min):
 *   *\/30 * * * * cd /Users/ai/clawd && node scripts/gbrain-context-prewrite.cjs
 *     >> ~/.openclaw/logs/context-prewrite.log 2>&1
 */

const path = require('path');
const { POLICIES, formatBlock } = require('./gbrain-context-injector.cjs');
const { writeFileSync, mkdirSync, existsSync } = require('fs');
const { homedir } = require('os');

const OC_AGENTS_DIR = path.join(homedir(), '.openclaw', 'agents');

function ts() {
  return new Date().toISOString();
}

function main() {
  console.log(`[${ts()}] gbrain-context-prewrite start — ${Object.keys(POLICIES).length} agents`);
  let ok = 0, fail = 0;
  const summary = [];

  for (const [agent, policy] of Object.entries(POLICIES)) {
    const t0 = Date.now();
    try {
      const blob = formatBlock(agent, policy);
      const dir = path.join(OC_AGENTS_DIR, agent);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, 'auto-context.md');
      writeFileSync(fp, blob);
      const elapsed = Date.now() - t0;
      console.log(`[${ts()}] ok ${agent} (${blob.length}c, ${elapsed}ms) → ${fp}`);
      summary.push({ agent, ok: true, bytes: blob.length, ms: elapsed });
      ok++;
    } catch (e) {
      console.error(`[${ts()}] FAIL ${agent}: ${e.message}`);
      summary.push({ agent, ok: false, error: e.message });
      fail++;
    }
  }

  console.log(`[${ts()}] gbrain-context-prewrite done — ${ok} ok, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

if (require.main === module) main();
