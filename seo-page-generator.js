#!/usr/bin/env node
/**
 * @file seo-page-generator.js
 * @description Programmatic SEO page task generator — creates Paperclip tasks for
 *              high-value comparison, vertical, and location pages that drive organic traffic.
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @version 1.0.0
 * @created 2026-03-31
 *
 * Runs weekly (Mondays). Creates Paperclip tasks for free fleet to generate SEO pages:
 * - Competitor comparison pages (MyWiFi vs X)
 * - Vertical landing pages (WiFi for Hotels, Restaurants, etc.)
 * - Use-case pages (Guest WiFi Analytics, Captive Portal, etc.)
 *
 * PM2 cron: Mondays 11am EST (0 16 * * 1 UTC)
 * State: scripts/.seo-page-state.json
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const STATE_FILE = path.join(__dirname, '.seo-page-state.json');
const PAPERCLIP_URL = 'http://localhost:3100';
const COMPANY = 'd852cff2-1645-4c48-ae14-010bd8230444';
const CONTENT_PROJECT = 'f4327b64-dbe5-466d-a741-673f54a13e40';

const COMPARISON_PAGES = [
  { competitor: 'Purple WiFi', slug: 'mywifi-vs-purple-wifi', keywords: ['purple wifi alternative', 'purple wifi vs mywifi'] },
  { competitor: 'Beambox', slug: 'mywifi-vs-beambox', keywords: ['beambox alternative', 'beambox vs mywifi'] },
  { competitor: 'StayFi', slug: 'mywifi-vs-stayfi', keywords: ['stayfi alternative', 'stayfi vs mywifi'] },
  { competitor: 'GoZone WiFi', slug: 'mywifi-vs-gozone', keywords: ['gozone wifi alternative', 'gozone vs mywifi'] },
  { competitor: 'Tanaza', slug: 'mywifi-vs-tanaza', keywords: ['tanaza alternative', 'tanaza vs mywifi'] },
  { competitor: 'Meraki Splash', slug: 'mywifi-vs-meraki-splash', keywords: ['meraki splash page alternative'] },
  { competitor: 'Aruba ClearPass', slug: 'mywifi-vs-aruba-clearpass', keywords: ['aruba clearpass guest wifi alternative'] },
];

const VERTICAL_PAGES = [
  { vertical: 'Hotels & Hospitality', slug: 'guest-wifi-for-hotels', keywords: ['hotel guest wifi', 'hospitality wifi marketing'] },
  { vertical: 'Restaurants & Cafes', slug: 'guest-wifi-for-restaurants', keywords: ['restaurant wifi marketing', 'cafe wifi login'] },
  { vertical: 'Retail Stores', slug: 'guest-wifi-for-retail', keywords: ['retail wifi marketing', 'in-store wifi analytics'] },
  { vertical: 'Coworking Spaces', slug: 'guest-wifi-for-coworking', keywords: ['coworking wifi management', 'shared office wifi'] },
  { vertical: 'Healthcare & Clinics', slug: 'guest-wifi-for-healthcare', keywords: ['healthcare patient wifi', 'clinic guest wifi'] },
  { vertical: 'Events & Venues', slug: 'guest-wifi-for-events', keywords: ['event wifi marketing', 'venue wifi analytics'] },
  { vertical: 'MSPs & IT Providers', slug: 'managed-guest-wifi-for-msps', keywords: ['managed wifi for msps', 'white label wifi'] },
  { vertical: 'Multi-Location Businesses', slug: 'guest-wifi-for-multi-location', keywords: ['multi-location wifi management'] },
];

const USECASE_PAGES = [
  { usecase: 'Captive Portal Builder', slug: 'captive-portal-software', keywords: ['captive portal software', 'wifi splash page builder'] },
  { usecase: 'WiFi Marketing Automation', slug: 'wifi-marketing-automation', keywords: ['wifi marketing platform', 'guest wifi marketing'] },
  { usecase: 'Guest WiFi Analytics', slug: 'guest-wifi-analytics', keywords: ['wifi analytics dashboard', 'guest wifi data'] },
  { usecase: 'WhatsApp WiFi Login', slug: 'whatsapp-wifi-login', keywords: ['whatsapp wifi authentication', 'whatsapp captive portal'] },
  { usecase: 'WiFi Email Collection', slug: 'wifi-email-collection', keywords: ['collect emails via wifi', 'wifi email capture'] },
];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastRun: null, pagesCreated: [], weekIndex: 0 }; }
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

async function run() {
  const state = loadState();
  const allPages = [...COMPARISON_PAGES, ...VERTICAL_PAGES, ...USECASE_PAGES];
  const created = new Set(state.pagesCreated || []);

  // Pick 3 uncreated pages per week
  const uncreated = allPages.filter(p => !created.has(p.slug));
  const batch = uncreated.slice(0, 3);

  if (batch.length === 0) {
    console.log('[seo] All pages already queued. Resetting cycle.');
    state.pagesCreated = [];
    saveState(state);
    return;
  }

  let success = 0;
  for (const page of batch) {
    const type = page.competitor ? 'comparison' : page.vertical ? 'vertical' : 'use-case';
    const title = page.competitor
      ? `[SEO] Comparison page: MyWiFi vs ${page.competitor}`
      : page.vertical
        ? `[SEO] Vertical page: Guest WiFi for ${page.vertical}`
        : `[SEO] Use-case page: ${page.usecase}`;

    const description = `**Programmatic SEO Page Generation**

**Type:** ${type}
**Slug:** /${page.slug}
**Target Keywords:** ${page.keywords.join(', ')}

**Requirements:**
- 1500-2000 word SEO-optimized page
- H1 with primary keyword, H2s for secondary keywords
- Comparison table (if competitor page)
- 3 customer testimonial placeholders
- CTA: "Start Free Trial" with link to mywifinetworks.com/signup
- FAQ section (5 questions with schema markup)
- Internal links to related pages

**Output:** Save to output/guestnetworks/seo-pages/${page.slug}.md

**Use skills:** page-cro, copywriting, ai-seo from marketing-skills pack`;

    try {
      const resp = await apiCall('POST', `/api/companies/${COMPANY}/issues`, {
        title,
        description,
        status: 'todo',
        labels: ['content'],
        projectId: CONTENT_PROJECT,
      });
      const ok = resp.status === 201 || resp.status === 200;
      if (ok) {
        created.add(page.slug);
        success++;
      }
      console.log(`  ${ok ? '✅' : '❌'} ${title}`);
    } catch (e) {
      console.log(`  ❌ ${title}: ${e.message}`);
    }
  }

  state.lastRun = new Date().toISOString();
  state.pagesCreated = [...created];
  state.weekIndex = (state.weekIndex || 0) + 1;
  saveState(state);

  console.log(`[seo] ${success}/${batch.length} pages queued. ${uncreated.length - success} remaining in cycle.`);
}

run().catch(e => {
  console.error('[seo] Fatal:', e.message);
  process.exit(1);
});
