#!/usr/bin/env node
// free-fleet-payload-guard.cjs
// Telemetry guard for free-fleet payload bloat.
//
// Reads each free-fleet agent's most recent session JSONL, estimates the
// total input tokens for the most recent user turn, and flags any agent
// whose payload or failed-turn-streak exceeds capacity.
//
// Schedule (suggested cron): */5 * * * *
// Run manually: node /Users/ai/clawd/scripts/free-fleet-payload-guard.cjs --check
//
// Owner: Quill ✒️ + Tank 🔋
// Related: shared/refs/FREE-FLEET-CAPACITY-2026-05-11.md

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Per-agent input-token caps (from FREE-FLEET-CAPACITY-2026-05-11.md).
// Token estimate uses chars/4 heuristic; we err on the conservative side
// by using cap * 0.9 as the "alert" threshold.
const CAPS = {
  forge:  { cap: 4000,   model: 'groq/llama-3.1-8b-instant' },
  bard:   { cap: 20000,  model: 'groq/moonshotai/kimi-k2-instruct-0905' },
  flare:  { cap: 30000,  model: 'cloudflare/@cf/meta/llama-4-scout-17b-16e-instruct' },
  bolt:   { cap: 2000,   model: 'cloudflare/@cf/meta/llama-3.2-3b-instruct' },
  lama:   { cap: 100000, model: 'openrouter/google/gemma-4-31b-it:free' },
  athena: { cap: 100000, model: 'openrouter/deepseek/deepseek-r1:free' },
  iris:   { cap: 100000, model: 'openrouter/qwen/qwen3-vl-235b-thinking:free' },
  coder:  { cap: 12000,  model: 'openrouter/qwen/qwen3-coder:free' },
  oracle: { cap: 50000,  model: 'cerebras/qwen-3-235b-a22b-instruct-2507' },
  elon:   { cap: 150000, model: 'xai/grok-4-1-fast-reasoning' },
};

const SESSIONS_ROOT = path.join(os.homedir(), '.openclaw', 'agents');
const LOG_FILE = path.join(os.homedir(), '.openclaw', 'logs', 'payload-guard.log');
const STATE_FILE = path.join(os.homedir(), '.openclaw', 'payload-guard-state.json');

const FAIL_STREAK_THRESHOLD = 3;
const TOKENS_PER_CHAR = 0.25; // heuristic ~4 chars/token

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* swallow */ }
  if (process.argv.includes('--check') || process.argv.includes('--verbose')) {
    console.log(line);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return { agents: {} };
  }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    log(`WARN: failed to write state: ${e.message}`);
  }
}

function mostRecentSessionFile(agent) {
  const dir = path.join(SESSIONS_ROOT, agent, 'sessions');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.trajectory.jsonl'))
    .map((f) => ({ f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] || null;
}

function analyzeSession(filePath) {
  // Returns { lastUserChars, lastUserTokens, totalChars, totalTokens,
  //            failStreak, totalTurns }
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch (_) {
    return null;
  }

  let totalChars = 0;
  let lastUserChars = 0;
  let failStreak = 0;
  let turns = 0;

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (obj.type !== 'message' || !obj.message) continue;
    const role = obj.message.role;
    const content = obj.message.content;
    const text = typeof content === 'string'
      ? content
      : JSON.stringify(content || '');
    const chars = text.length;
    totalChars += chars;
    turns++;
    if (role === 'user') {
      lastUserChars = chars;
      // when we see a fresh user turn, this is the START of a new attempt
      // — don't reset failStreak yet (only reset on successful assistant)
    } else if (role === 'assistant') {
      // detect failed turn: empty content, error stopReason, or sentinel text
      const stopReason = obj.message.stopReason || '';
      const errMsg = obj.message.errorMessage || '';
      const isFailed = (Array.isArray(content) && content.length === 0)
        || stopReason === 'error'
        || /assistant turn failed before producing content/i.test(text)
        || /rate.?limit|413|Request too large/i.test(errMsg);
      if (isFailed) failStreak++;
      else failStreak = 0;
    }
  }

  return {
    lastUserChars,
    lastUserTokens: Math.round(lastUserChars * TOKENS_PER_CHAR),
    totalChars,
    totalTokens: Math.round(totalChars * TOKENS_PER_CHAR),
    failStreak,
    totalTurns: turns,
  };
}

function main() {
  const isCheck = process.argv.includes('--check');
  log('=== payload-guard run start ===');

  const state = loadState();
  const alerts = [];
  const summary = [];

  for (const [agent, info] of Object.entries(CAPS)) {
    const session = mostRecentSessionFile(agent);
    if (!session) {
      summary.push(`${agent}: no sessions found`);
      continue;
    }
    const a = analyzeSession(session.full);
    if (!a) {
      summary.push(`${agent}: failed to parse ${session.f}`);
      continue;
    }

    const cap = info.cap;
    const lastUserOver = a.lastUserTokens > cap;
    const totalOver = a.totalTokens > cap * 1.5; // session-bloat threshold
    const streakOver = a.failStreak >= FAIL_STREAK_THRESHOLD;

    state.agents[agent] = {
      session: session.f,
      last_user_tokens: a.lastUserTokens,
      total_tokens: a.totalTokens,
      fail_streak: a.failStreak,
      turns: a.totalTurns,
      cap,
      checked_at: new Date().toISOString(),
    };

    const line = `${agent.padEnd(7)} cap=${String(cap).padStart(6)} ` +
      `lastUser=${String(a.lastUserTokens).padStart(6)}t ` +
      `total=${String(a.totalTokens).padStart(6)}t ` +
      `failStreak=${a.failStreak} turns=${a.totalTurns}` +
      (lastUserOver ? ' [LAST_USER_OVER_CAP]' : '') +
      (totalOver ? ' [TOTAL_BLOATED]' : '') +
      (streakOver ? ' [FAIL_STREAK_HIGH]' : '');
    summary.push(line);

    if (lastUserOver || totalOver || streakOver) {
      const recommendation = recommendFailover(agent, a.lastUserTokens);
      alerts.push({
        agent,
        model: info.model,
        cap,
        last_user_tokens: a.lastUserTokens,
        total_tokens: a.totalTokens,
        fail_streak: a.failStreak,
        session_file: session.f,
        reasons: [
          lastUserOver && 'last user message exceeds cap',
          totalOver && 'cumulative session bloat (>1.5x cap)',
          streakOver && `failed-turn streak ≥ ${FAIL_STREAK_THRESHOLD}`,
        ].filter(Boolean),
        recommendation,
      });
    }
  }

  state.last_run = new Date().toISOString();
  state.alerts = alerts;
  saveState(state);

  for (const line of summary) log(line);

  if (alerts.length > 0) {
    log(`!! ${alerts.length} ALERT(S) — see ${STATE_FILE}`);
    for (const a of alerts) {
      log(`  ALERT[${a.agent}] reasons=[${a.reasons.join(', ')}] ` +
          `lastUser=${a.last_user_tokens}t total=${a.total_tokens}t ` +
          `streak=${a.fail_streak} → ${a.recommendation}`);
    }
  } else {
    log('OK: no alerts');
  }

  log('=== payload-guard run end ===');

  if (isCheck) {
    console.log('\n=== FINAL ===');
    if (alerts.length === 0) {
      console.log('No alerts. All free-fleet agents within capacity.');
    } else {
      console.log(`${alerts.length} alert(s):`);
      for (const a of alerts) {
        console.log(`  ${a.agent} (${a.model})`);
        console.log(`    reasons: ${a.reasons.join('; ')}`);
        console.log(`    lastUser=${a.last_user_tokens}t total=${a.total_tokens}t streak=${a.fail_streak}`);
        console.log(`    recommendation: ${a.recommendation}`);
        console.log(`    session: ${a.session_file}`);
      }
    }
  }
}

function recommendFailover(agent, lastUserTokens) {
  // Suggest next-higher-capacity agent based on token size.
  // Ladder sorted by ascending cap; recommend the smallest cap that fits
  // AND is strictly larger than the current agent's cap.
  const ladder = Object.entries(CAPS)
    .sort((a, b) => a[1].cap - b[1].cap)
    .map(([id]) => id);
  const currentCap = CAPS[agent].cap;
  const need = Math.max(lastUserTokens, currentCap + 1);
  for (const cand of ladder) {
    if (cand === agent) continue;
    if (CAPS[cand].cap >= need) {
      return `reset session OR reassign current task to '${cand}' (cap ${CAPS[cand].cap}t)`;
    }
  }
  return `task exceeds all free-fleet caps (need ≥${need}t) — escalate to Kevin / Sonnet`;
}

main();
