#!/usr/bin/env node
/**
 * @file content-distributor.js
 * @description Content distribution pipeline — creates Paperclip tasks to distribute
 *              EXISTING blog posts and marketing content to social channels.
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @version 1.0.0
 * @created 2026-03-31
 *
 * Scans existing blog content at projects/mywifi-redesign/src/content/blog/
 * and creates distribution tasks (LinkedIn, X, newsletter) for undistributed posts.
 *
 * PM2 cron: Tuesdays 9am EST (0 14 * * 2 UTC)
 * State: scripts/.content-distributor-state.json
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const STATE_FILE = path.join(__dirname, '.content-distributor-state.json');
const BLOG_DIR = '/Users/ai/clawd/projects/mywifi-redesign/src/content/blog';
const PAPERCLIP_URL = 'http://localhost:3100';
const COMPANY = 'd852cff2-1645-4c48-ae14-010bd8230444';
const CONTENT_PROJECT = 'f4327b64-dbe5-466d-a741-673f54a13e40';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastRun: null, distributed: [], batchIndex: 0 }; }
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

function extractTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const titleMatch = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    return titleMatch ? titleMatch[1] : path.basename(filePath, '.md').replace(/-/g, ' ');
  } catch {
    return path.basename(filePath, '.md').replace(/-/g, ' ');
  }
}

async function run() {
  const state = loadState();
  const distributed = new Set(state.distributed || []);

  if (!fs.existsSync(BLOG_DIR)) {
    console.log('[distributor] Blog directory not found:', BLOG_DIR);
    return;
  }

  const allPosts = fs.readdirSync(BLOG_DIR)
    .filter(f => f.endsWith('.md') && !f.includes('-de.md') && !f.includes('-es.md') && !f.includes('-pt.md') && !f.includes('-fr.md'))
    .sort(() => Math.random() - 0.5);

  const undistributed = allPosts.filter(f => !distributed.has(f));

  if (undistributed.length === 0) {
    console.log('[distributor] All posts distributed. Resetting cycle.');
    state.distributed = [];
    saveState(state);
    return;
  }

  const batch = undistributed.slice(0, 5);
  let created = 0;

  for (const file of batch) {
    const filePath = path.join(BLOG_DIR, file);
    const title = extractTitle(filePath);
    const slug = file.replace('.md', '');

    try {
      const resp = await apiCall('POST', `/api/companies/${COMPANY}/issues`, {
        title: `[Distribute] Social posts for: ${title.slice(0, 50)}`,
        description: `**Content Distribution Pipeline**\n\n**Blog post:** ${title}\n**File:** projects/mywifi-redesign/src/content/blog/${file}\n**URL:** https://mw.guestnetworks.com/blog/${slug}\n\n**Create:**\n1. LinkedIn post (300 words, personal angle, 3-5 hashtags, link to blog)\n2. X post (280 chars, hook + link)\n3. Newsletter snippet (100 words for weekly email digest)\n\n**Save to:** output/guestnetworks/social/distribute-${slug}.md\n\n**Important:** Read the FULL blog post first. Extract the most compelling stat or insight for the social hook.`,
        status: 'todo',
        labels: ['content'],
        projectId: CONTENT_PROJECT,
      });
      const ok = resp.status === 201 || resp.status === 200;
      if (ok) {
        distributed.add(file);
        created++;
      }
      console.log(`  ${ok ? '✅' : '❌'} ${title.slice(0, 60)}`);
    } catch (e) {
      console.log(`  ❌ ${title.slice(0, 40)}: ${e.message}`);
    }
  }

  state.lastRun = new Date().toISOString();
  state.distributed = [...distributed];
  state.batchIndex = (state.batchIndex || 0) + 1;
  saveState(state);

  console.log(`[distributor] ${created}/${batch.length} distribution tasks created. ${undistributed.length - created} posts remaining.`);
}

run().catch(e => {
  console.error('[distributor] Fatal:', e.message);
  process.exit(1);
});
