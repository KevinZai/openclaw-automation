#!/usr/bin/env node
/**
 * @file content-flywheel.js
 * @description Content flywheel — auto-creates weekly content tasks for free fleet
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @version 1.0.0
 * @created 2026-03-31
 *
 * Creates Paperclip issues for content generation:
 * - 1x blog draft per week (SEO-optimized, topics configurable via BRAND_NAME)
 * - 3x social posts per week (LinkedIn, X, newsletter snippet)
 *
 * Routes to scribe agent via 'content' label in auto-dispatcher.
 * Tracks what's been created in .content-flywheel-state.json to avoid dupes.
 *
 * PM2 cron: Wednesdays 10am EST (0 15 * * 3 UTC)
 * State: scripts/.content-flywheel-state.json
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const STATE_FILE = path.join(__dirname, '.content-flywheel-state.json');
const PAPERCLIP_URL = process.env.PAPERCLIP_URL || 'http://localhost:3110';
const COMPANY = process.env.OPENCLAW_COMPANY_ID || 'd852cff2-1645-4c48-ae14-010bd8230444';
const CONTENT_PROJECT = process.env.OPENCLAW_CONTENT_PROJECT_ID || 'f4327b64-dbe5-466d-a741-673f54a13e40';
const BRAND = process.env.BRAND_NAME || 'MyWiFi';
const BRAND_AUDIENCE = process.env.BRAND_AUDIENCE || `${BRAND} Networks customers and prospects`;
const CONTENT_OUTPUT_DIR = process.env.CONTENT_OUTPUT_DIR || 'output/guestnetworks/blog-drafts';
const SOCIAL_OUTPUT_DIR = process.env.SOCIAL_OUTPUT_DIR || 'output/guestnetworks/social';

const BLOG_TOPICS = [
  { title: 'WiFi Marketing ROI: How to Measure Guest WiFi Impact', tags: ['seo', 'wifi-marketing'] },
  { title: '5 Ways Hotels Use Guest WiFi to Boost Revenue', tags: ['hospitality', 'revenue'] },
  { title: 'GDPR-Compliant Guest WiFi: A Complete Guide', tags: ['compliance', 'gdpr'] },
  { title: 'Restaurant WiFi Marketing: Turn Guests into Repeat Customers', tags: ['restaurant', 'retention'] },
  { title: 'Why Your MSP Should Offer Managed Guest WiFi', tags: ['msp', 'channel'] },
  { title: 'Guest WiFi Analytics: What the Data Tells You', tags: ['analytics', 'data'] },
  { title: 'Captive Portal Best Practices for 2026', tags: ['captive-portal', 'ux'] },
  { title: 'WiFi Marketing vs Email Marketing: Complementary Strategies', tags: ['comparison', 'email'] },
  { title: 'How to Set Up Location-Based WiFi Marketing', tags: ['location', 'proximity'] },
  { title: 'The Future of Guest WiFi: AI-Powered Personalization', tags: ['ai', 'personalization'] },
  { title: 'Guest WiFi for Retail: Drive Foot Traffic and Sales', tags: ['retail', 'conversion'] },
  { title: 'White-Label WiFi Marketing: A Guide for Agencies', tags: ['white-label', 'agency'] },
];

const SOCIAL_TEMPLATES = [
  { type: 'linkedin', template: `Industry insight post about {topic} with CTA to ${BRAND}` },
  { type: 'x-thread', template: '3-5 tweet thread breaking down {topic} with stats and examples' },
  { type: 'newsletter', template: 'Newsletter snippet (200 words) highlighting {topic} trends' },
];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastRun: null, blogIndex: 0, weekNumber: 0, created: [] }; }
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
    console.log(`[content] Week ${week} tasks already created. Skipping.`);
    return;
  }

  const blogTopic = BLOG_TOPICS[state.blogIndex % BLOG_TOPICS.length];
  const tasks = [];

  // Blog draft task
  tasks.push({
    title: `[Content] Blog draft: ${blogTopic.title}`,
    description: `**Weekly content flywheel — Week ${week}**\n\nWrite a 1200-1500 word SEO-optimized blog post:\n**Topic:** ${blogTopic.title}\n**Tags:** ${blogTopic.tags.join(', ')}\n**Audience:** ${BRAND_AUDIENCE}\n**Tone:** Professional but approachable, data-driven\n**Include:** 2-3 statistics, practical examples, CTA to ${BRAND}\n\nSave draft to: ${CONTENT_OUTPUT_DIR}/week-${week}-${blogTopic.tags[0]}.md`,
    labels: ['content'],
  });

  // Social posts
  for (const tmpl of SOCIAL_TEMPLATES) {
    tasks.push({
      title: `[Content] ${tmpl.type}: ${blogTopic.title.slice(0, 50)}`,
      description: `**Weekly content flywheel — Week ${week}**\n\n**Platform:** ${tmpl.type}\n**Brief:** ${tmpl.template.replace('{topic}', blogTopic.title)}\n**Source material:** Blog draft for this week\n\nSave to: ${SOCIAL_OUTPUT_DIR}/week-${week}-${tmpl.type}.md`,
      labels: ['content'],
    });
  }

  let created = 0;
  for (const task of tasks) {
    try {
      const resp = await apiCall('POST', `/api/companies/${COMPANY}/issues`, {
        ...task,
        status: 'todo',
        projectId: CONTENT_PROJECT,
      });
      const ok = resp.status === 201 || resp.status === 200;
      console.log(`  ${ok ? '✅' : '❌'} ${task.title}`);
      if (ok) created++;
    } catch (e) {
      console.log(`  ❌ ${task.title}: ${e.message}`);
    }
  }

  state.lastRun = new Date().toISOString();
  state.blogIndex = (state.blogIndex + 1) % BLOG_TOPICS.length;
  state.weekNumber = week;
  state.created = [...(state.created || []).slice(-50), ...tasks.map(t => ({ week, title: t.title }))];
  saveState(state);

  console.log(`[content] Week ${week}: ${created}/${tasks.length} tasks created. Next blog: "${BLOG_TOPICS[state.blogIndex].title}"`);
}

run().catch(e => {
  console.error('[content] Fatal:', e.message);
  process.exit(1);
});
