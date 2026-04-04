#!/usr/bin/env node
/**
 * @file revenue-task-generator.js
 * @description Revenue task generator — auto-create free fleet tasks for content/research/leads
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Revenue Task Generator — Self-generating pipeline for autonomous money-making
 *
 * Automatically creates Paperclip tasks for the free fleet that generate revenue:
 * - Content creation for MyWiFi (blog posts, social, email sequences)
 * - Competitive intelligence gathering
 * - Lead research and enrichment
 * - Market analysis and trading alpha
 * - SEO keyword research and content briefs
 *
 * All tasks route to FREE fleet (Forge $0, Flare $0, Lama $0, Oracle $0)
 * No human intervention required. Kevin reviews output in morning brief.
 *
 * PM2 cron: daily 7am EST (after overnight consolidation)
 * State: scripts/.revenue-task-state.json
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const STATE_FILE = path.join(__dirname, '.revenue-task-state.json');
const PAPERCLIP_URL = process.env.PAPERCLIP_URL || 'http://localhost:3110';
const TEAM_KEVIN_COMPANY = process.env.OPENCLAW_COMPANY_ID || 'd852cff2-1645-4c48-ae14-010bd8230444';
const GN_COMPANY = process.env.OPENCLAW_GN_COMPANY_ID || '301d588f-b5c6-4957-a6bc-fdcd3860f0cd';

// Free fleet agent IDs — $0 cost
const FREE_AGENTS = {
  forge: process.env.OPENCLAW_AGENT_FORGE || '1234c699-6592-42a6-b746-266f9618507a',   // HuggingFace
  flare: process.env.OPENCLAW_AGENT_FLARE || 'da8ba82b-d860-4825-b387-3e3042478441',   // Cloudflare
  lama: process.env.OPENCLAW_AGENT_LAMA || 'f4ad011a-cc1c-46ac-a9c5-782891b48185',    // Ollama
  oracle: process.env.OPENCLAW_AGENT_ORACLE || 'bc370f55-81db-4e38-bbbb-00eca803d799',  // Groq
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRun: null, tasksGenerated: 0, history: [], weekday: -1 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function apiPost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${PAPERCLIP_URL}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Task templates — rotated daily based on day of week
const DAILY_TASKS = {
  0: [ // Sunday — weekly review + planning
    {
      company: TEAM_KEVIN_COMPANY,
      title: '[AUTO] Weekly competitive intelligence summary — MyWiFi vs Purple/GoZone/Beambox',
      description: 'Compile this week\'s competitive-monitor reports from shared/daily-brief/competitive-*.md. Summarize: pricing changes, new features, market moves. Write to output/team-kevin/weekly-competitive-summary.md',
      agent: 'oracle',
      priority: 'medium',
    },
    {
      company: TEAM_KEVIN_COMPANY,
      title: '[AUTO] Weekly trading alpha review — compile Viper performance',
      description: 'Read workspaces/trading/memory/ files from this week. Compile: alpha calls made, outcomes, win rate, best/worst calls. Write to output/team-kevin/weekly-alpha-review.md',
      agent: 'oracle',
      priority: 'medium',
    },
  ],
  1: [ // Monday — content creation
    {
      company: TEAM_KEVIN_COMPANY, // Free fleet is in Team Kevin
      title: '[AUTO] Draft MyWiFi blog post — WiFi marketing tip of the week',
      description: 'Research one specific WiFi marketing tactic (e.g., "How to use WhatsApp WiFi Login to capture 3x more guest data"). Write a 600-word blog post targeting MSP/agency audience. Save to output/guestnetworks/blog-drafts/. Reference docs/PRODUCT.md for accuracy.',
      agent: 'forge',
      priority: 'medium',
    },
    {
      company: TEAM_KEVIN_COMPANY, // Free fleet is in Team Kevin
      title: '[AUTO] Draft 5 LinkedIn posts for MyWiFi — weekly social batch',
      description: 'Write 5 LinkedIn posts for MyWiFi Networks targeting MSPs and agencies. Topics: hardware compatibility, WhatsApp login, reseller margins, case study angles, platform update. Each post 100-150 words. Save to output/guestnetworks/social-drafts/',
      agent: 'flare',
      priority: 'medium',
    },
  ],
  2: [ // Tuesday — lead research
    {
      company: TEAM_KEVIN_COMPANY, // Free fleet is in Team Kevin
      title: '[AUTO] Research 10 MSPs in [random US state] for MyWiFi outreach',
      description: 'Research 10 managed service providers. For each: company name, website, estimated size, whether they offer WiFi services, contact info if public. Save as CSV to output/guestnetworks/lead-research/. Focus on companies managing 20+ client networks.',
      agent: 'oracle',
      priority: 'medium',
    },
  ],
  3: [ // Wednesday — SEO + content
    {
      company: TEAM_KEVIN_COMPANY, // Free fleet is in Team Kevin
      title: '[AUTO] SEO keyword research — MyWiFi hardware integration pages',
      description: 'Research long-tail keywords for MyWiFi hardware integration pages. Focus on: "ubiquiti wifi marketing", "meraki guest wifi", "aruba captive portal" etc. Find 20 keywords with search volume estimates. Save to output/guestnetworks/seo-research/',
      agent: 'forge',
      priority: 'medium',
    },
    {
      company: TEAM_KEVIN_COMPANY,
      title: '[AUTO] Scan X for AI agent fleet management discussions',
      description: 'Search X/Twitter for discussions about multi-agent AI systems, fleet management, OpenClaw tips. Find 5-10 interesting threads from the last 7 days. Summarize insights. Save to output/team-kevin/x-scan-weekly.md',
      agent: 'oracle',
      priority: 'low',
    },
  ],
  4: [ // Thursday — market analysis
    {
      company: TEAM_KEVIN_COMPANY,
      title: '[AUTO] Polymarket opportunity scan — find 3 high-conviction bets',
      description: 'Scan Polymarket for markets with >$100K volume where consensus seems wrong. Find 3 contrarian opportunities with thesis. Reference workspaces/trading/memory/ for existing positions. Save to output/team-kevin/polymarket-scan.md',
      agent: 'oracle',
      priority: 'medium',
    },
  ],
  5: [ // Friday — optimization + housekeeping
    {
      company: TEAM_KEVIN_COMPANY,
      title: '[AUTO] Analyze this week\'s self-heal logs — pattern detection',
      description: 'Read all shared/daily-brief/self-heal-*.md files from this week. Identify: recurring error patterns, most frequent error types, any new error categories. Propose preventive fixes. Save to output/team-kevin/weekly-self-heal-analysis.md',
      agent: 'lama',
      priority: 'medium',
    },
    {
      company: TEAM_KEVIN_COMPANY, // Free fleet is in Team Kevin
      title: '[AUTO] Draft MyWiFi case study template — anonymized reseller success',
      description: 'Write a case study template using MyWiFi pricing data (docs/PRODUCT.md). Scenario: 20-location agency using Agency plan. Calculate: platform cost, client billing, monthly profit, annual ROI. Make it compelling. Save to output/guestnetworks/case-studies/',
      agent: 'flare',
      priority: 'medium',
    },
  ],
  6: [ // Saturday — light duty
    {
      company: TEAM_KEVIN_COMPANY,
      title: '[AUTO] Weekend market prep — key events next week',
      description: 'Research key market events for next week: earnings, FOMC, CPI, major crypto events, Polymarket resolution dates. Write a brief prep note. Save to output/team-kevin/weekend-market-prep.md',
      agent: 'oracle',
      priority: 'low',
    },
  ],
};

async function run() {
  const state = loadState();
  const today = new Date();
  const dayOfWeek = today.getDay();
  const dateStr = today.toISOString().split('T')[0];

  // Don't re-run if already ran today
  if (state.lastRun === dateStr) {
    console.log('[revenue-gen] Already ran today, skipping');
    return;
  }

  const tasks = DAILY_TASKS[dayOfWeek] || [];
  console.log(`[revenue-gen] ${today.toLocaleDateString('en-US', { weekday: 'long' })}: ${tasks.length} tasks to create`);

  let created = 0;
  for (const task of tasks) {
    try {
      const result = await apiPost(`/api/companies/${task.company}/issues`, {
        title: task.title,
        description: task.description,
        status: 'todo',
        priority: task.priority,
        assigneeAgentId: FREE_AGENTS[task.agent],
      });

      if (result.id) {
        created++;
        console.log(`  Created: ${result.identifier || result.id.slice(0, 8)} — ${task.title.slice(0, 60)}`);
      }
    } catch (e) {
      console.error(`  Failed: ${task.title.slice(0, 40)} — ${e.message}`);
    }
  }

  state.lastRun = dateStr;
  state.tasksGenerated += created;
  state.history = [...(state.history || []).slice(-30), { date: dateStr, day: dayOfWeek, created }];
  saveState(state);

  console.log(`[revenue-gen] Done: ${created}/${tasks.length} tasks created (${state.tasksGenerated} total lifetime)`);
}

run().catch(e => {
  console.error('[revenue-gen] Fatal:', e.message);
  process.exit(1);
});
