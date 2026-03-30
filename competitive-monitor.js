#!/usr/bin/env node
/**
 * @file competitive-monitor.js
 * @description Competitive intelligence monitor — weekly competitor pricing/feature scrape
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Competitive Intelligence Monitor — Weekly competitor pricing/feature scrape
 *
 * Fetches competitor pricing pages, compares against cached snapshots.
 * Detects pricing changes, new feature announcements.
 * Generates battlecard update diffs.
 * Report → shared/daily-brief/competitive-YYYY-MM-DD.md
 *
 * PM2 cron: Mondays 9am EST (0 14 * * 1 UTC)
 * State: scripts/.competitive-monitor-state.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const STATE_FILE = path.join(__dirname, '.competitive-monitor-state.json');
const BRIEF_DIR = process.env.BRIEF_DIR || './shared/daily-brief';
const SNAPSHOT_DIR = path.join(__dirname, '.competitive-snapshots');

const COMPETITORS = [
  { name: 'Purple WiFi', url: 'https://purple.ai/pricing/', key: 'purple' },
  { name: 'GoZone WiFi', url: 'https://www.gozonesmart.com/', key: 'gozone' },
  { name: 'Tanaza', url: 'https://www.tanaza.com/pricing/', key: 'tanaza' },
  { name: 'Beambox', url: 'https://www.beambox.com/pricing', key: 'beambox' },
  { name: 'StayFi', url: 'https://www.stayfi.com/pricing', key: 'stayfi' },
];

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRun: null, snapshots: {}, changes: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function fetchPage(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyWiFi-Monitor/1.0)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchPage(res.headers.location).then(resolve);
        return;
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

// Extract pricing-related text from HTML (strip tags, keep numbers with $ and plan names)
function extractPricingText(html) {
  // Remove script/style
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Strip tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Extract lines with pricing signals
  const pricingSignals = text.match(/\$[\d,]+(?:\.\d{2})?(?:\/\w+)?/g) || [];
  const planNames = text.match(/(?:starter|pro|business|enterprise|basic|premium|agency|free|team|growth|scale)/gi) || [];

  return {
    fullText: text.slice(0, 5000),
    prices: [...new Set(pricingSignals)],
    plans: [...new Set(planNames.map(p => p.toLowerCase()))],
  };
}

async function run() {
  const state = loadState();
  const today = new Date().toISOString().split('T')[0];
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const results = [];

  for (const comp of COMPETITORS) {
    console.log(`[competitive] Fetching ${comp.name}...`);
    const response = await fetchPage(comp.url);

    if (response.status !== 200) {
      results.push({
        name: comp.name,
        status: 'FETCH_FAILED',
        detail: `HTTP ${response.status} ${response.error || ''}`,
      });
      continue;
    }

    const current = extractPricingText(response.body);

    // Compare with previous snapshot
    const prevSnapshot = state.snapshots[comp.key];
    let changes = [];

    if (prevSnapshot) {
      // Check for new or changed prices
      const newPrices = current.prices.filter(p => !prevSnapshot.prices.includes(p));
      const removedPrices = prevSnapshot.prices.filter(p => !current.prices.includes(p));
      const newPlans = current.plans.filter(p => !prevSnapshot.plans.includes(p));

      if (newPrices.length > 0) changes.push(`New prices: ${newPrices.join(', ')}`);
      if (removedPrices.length > 0) changes.push(`Removed prices: ${removedPrices.join(', ')}`);
      if (newPlans.length > 0) changes.push(`New plans: ${newPlans.join(', ')}`);
    }

    // Save snapshot
    state.snapshots[comp.key] = {
      date: today,
      prices: current.prices,
      plans: current.plans,
      textHash: require('crypto').createHash('md5').update(current.fullText).digest('hex'),
    };

    // Save full HTML for reference
    fs.writeFileSync(path.join(SNAPSHOT_DIR, `${comp.key}-${today}.html`), response.body);

    results.push({
      name: comp.name,
      status: changes.length > 0 ? 'CHANGED' : 'STABLE',
      prices: current.prices,
      plans: current.plans,
      changes,
    });
  }

  // Generate report
  let report = `# Competitive Intelligence Report — ${today}\n\n`;
  const changedCount = results.filter(r => r.status === 'CHANGED').length;
  report += `**Competitors monitored:** ${COMPETITORS.length} | **Changes detected:** ${changedCount}\n\n`;

  for (const r of results) {
    const icon = r.status === 'CHANGED' ? '🔴' : r.status === 'STABLE' ? '🟢' : '⚠️';
    report += `## ${icon} ${r.name}\n`;
    report += `**Status:** ${r.status}\n`;
    if (r.prices?.length > 0) report += `**Prices found:** ${r.prices.join(', ')}\n`;
    if (r.plans?.length > 0) report += `**Plans:** ${r.plans.join(', ')}\n`;
    if (r.changes?.length > 0) {
      report += `**Changes:**\n${r.changes.map(c => '- ' + c).join('\n')}\n`;
    }
    if (r.detail) report += `**Detail:** ${r.detail}\n`;
    report += '\n';
  }

  report += `---\n*Generated by competitive-monitor.js on ${new Date().toISOString()}*\n`;
  report += `*Snapshots saved to: scripts/.competitive-snapshots/*\n`;

  fs.mkdirSync(BRIEF_DIR, { recursive: true });
  const reportFile = path.join(BRIEF_DIR, `competitive-${today}.md`);
  fs.writeFileSync(reportFile, report);

  // Track changes in state
  if (changedCount > 0) {
    state.changes = [
      ...(state.changes || []).slice(-20),
      ...results.filter(r => r.status === 'CHANGED').map(r => ({
        date: today, competitor: r.name, changes: r.changes,
      })),
    ];
  }

  state.lastRun = new Date().toISOString();
  saveState(state);

  console.log(`[competitive] Done: ${results.length} competitors checked, ${changedCount} changes. Report: ${reportFile}`);
}

run();
