#!/usr/bin/env node
/**
 * @file research-pipeline.js
 * @description Weekly thought leadership pipeline — uses ARIS research skills to generate
 *              industry reports, then creates distribution tasks for kevinzai brand building.
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @version 1.0.0
 * @created 2026-03-31
 *
 * Creates Paperclip tasks for free fleet to:
 * 1. Research AI industry trends using ARIS skills (idea-discovery, research-lit)
 * 2. Distill findings into a kevinzai thought leadership post
 * 3. Create LinkedIn + X distribution tasks
 *
 * PM2 cron: Thursdays 8am EST (0 13 * * 4 UTC)
 * State: scripts/.research-pipeline-state.json
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const STATE_FILE = path.join(__dirname, '.research-pipeline-state.json');
const PAPERCLIP_URL = 'http://localhost:3100';
const COMPANY = 'd852cff2-1645-4c48-ae14-010bd8230444';
const KEVINZAI_PROJECT = 'ca78ce29-e956-4f63-9db3-e8fa4d328f80';

const RESEARCH_TOPICS = [
  { topic: 'Multi-agent AI orchestration patterns in production', angle: 'Real-world lessons from running 38 agents daily', tags: ['ai-agents', 'orchestration'] },
  { topic: 'Cost optimization for AI agent fleets', angle: 'How free-tier LLMs (Groq, Ollama, CF Workers) reduce costs by 90%', tags: ['cost', 'free-tier'] },
  { topic: 'Self-healing AI infrastructure', angle: 'Auto-remediation patterns that keep 38 agents running 24/7', tags: ['devops', 'reliability'] },
  { topic: 'AI-powered sales automation for SaaS', angle: 'How agents handle outreach, scoring, and follow-up autonomously', tags: ['sales', 'saas'] },
  { topic: 'The Agent Communication Protocol (ACP) ecosystem', angle: 'What ACPX, OpenClaw, and Claude Code mean for agent interop', tags: ['protocol', 'interop'] },
  { topic: 'Building autonomous revenue loops with AI agents', angle: 'Content → SEO → Leads → Sales with zero human intervention', tags: ['revenue', 'automation'] },
  { topic: 'Claude Code vs Codex vs Gemini CLI — real benchmarks', angle: 'Head-to-head comparison from daily production use', tags: ['benchmarks', 'tools'] },
  { topic: 'WiFi marketing meets AI — the next wave', angle: 'How guest WiFi data + AI agents = hyper-personalized marketing', tags: ['wifi', 'marketing'] },
  { topic: 'Open-source tools for AI agent monitoring', angle: 'Heartbeat monitors, cost trackers, and self-healing scripts', tags: ['open-source', 'monitoring'] },
  { topic: 'From 0 to 38 agents: scaling an AI workforce', angle: 'Architecture decisions, cost curves, and lessons learned', tags: ['scaling', 'architecture'] },
];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastRun: null, topicIndex: 0, weekNumber: 0, created: [] }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 10000,
    };
    const req = http.request(`${PAPERCLIP_URL}${urlPath}`, opts, (res) => {
      let chunks = '';
      res.on('data', chunk => { chunks += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, data: chunks }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getWeekNumber() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
}

async function run() {
  const state = loadState();
  const week = getWeekNumber();

  if (state.weekNumber === week) {
    console.log(`[research] Week ${week} tasks already created. Skipping.`);
    return;
  }

  const topic = RESEARCH_TOPICS[state.topicIndex % RESEARCH_TOPICS.length];
  const tasks = [];

  // Research task (Atlas via oracle/groq — free)
  tasks.push({
    title: `[Research] Industry brief: ${topic.topic.slice(0, 60)}`,
    description: `**Weekly Thought Leadership Pipeline — Week ${week}**\n\n**Research topic:** ${topic.topic}\n**Angle:** ${topic.angle}\n**Tags:** ${topic.tags.join(', ')}\n\n**Instructions:**\n1. Use ARIS skills (tools/aris/skills/idea-discovery, research-lit) for structured research\n2. Search recent (last 30 days) articles, papers, and social posts on this topic\n3. Find 3-5 data points or statistics to support the angle\n4. Write a 500-word research brief with sources\n\n**Output:** Save to output/kevinzai/thought-leadership/week-${week}-research.md`,
    labels: ['research'],
  });

  // Article task (Scribe — content label)
  tasks.push({
    title: `[Content] kevinzai article: ${topic.topic.slice(0, 50)}`,
    description: `**Weekly Thought Leadership Pipeline — Week ${week}**\n\n**DEPENDS ON:** Research brief (week-${week}-research.md)\n\n**Write a 1000-1500 word thought leadership article for kevinzai.com:**\n- Topic: ${topic.topic}\n- Angle: ${topic.angle}\n- Voice: Practitioner, not theorist. Kevin runs 38 agents daily — this is from the trenches.\n- Include: Real examples from OpenClaw fleet, specific numbers, actionable takeaways\n- CTA: Follow @kzic on X, subscribe to newsletter\n\n**Reference:** output/kevinzai/thought-leadership/week-${week}-research.md\n**Output:** Save to output/kevinzai/thought-leadership/week-${week}-article.md`,
    labels: ['content'],
  });

  // Distribution tasks (Mabel — content label)
  tasks.push({
    title: `[Distribute] LinkedIn + X posts for week ${week} article`,
    description: `**Weekly Thought Leadership Pipeline — Week ${week}**\n\n**DEPENDS ON:** Article (week-${week}-article.md)\n\n**Create distribution content:**\n1. LinkedIn post (300-500 words, personal story angle, 3-5 hashtags)\n2. X thread (5-7 tweets, hook + value + CTA)\n3. Newsletter snippet (200 words for email digest)\n\n**Reference:** output/kevinzai/thought-leadership/week-${week}-article.md\n**Output:** Save to output/kevinzai/thought-leadership/week-${week}-distribution.md`,
    labels: ['content'],
  });

  let created = 0;
  for (const task of tasks) {
    try {
      const resp = await apiCall('POST', `/api/companies/${COMPANY}/issues`, {
        ...task,
        status: 'todo',
        projectId: KEVINZAI_PROJECT,
      });
      const ok = resp.status === 201 || resp.status === 200;
      console.log(`  ${ok ? '✅' : '❌'} ${task.title}`);
      if (ok) created++;
    } catch (e) {
      console.log(`  ❌ ${task.title}: ${e.message}`);
    }
  }

  state.lastRun = new Date().toISOString();
  state.topicIndex = (state.topicIndex + 1) % RESEARCH_TOPICS.length;
  state.weekNumber = week;
  state.created = [...(state.created || []).slice(-50), ...tasks.map(t => ({ week, title: t.title }))];
  saveState(state);

  console.log(`[research] Week ${week}: ${created}/${tasks.length} tasks created. Next topic: "${RESEARCH_TOPICS[state.topicIndex].topic.slice(0, 50)}"`);
}

run().catch(e => {
  console.error('[research] Fatal:', e.message);
  process.exit(1);
});
