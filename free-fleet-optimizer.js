#!/usr/bin/env node
/**
 * @file free-fleet-optimizer.js
 * @description Free fleet optimizer — probe free API providers for capacity
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Free Fleet Optimizer — Maximizes usage of zero-cost AI workers
 *
 * Probes free API providers for availability and quota.
 * Routes tasks to the cheapest available worker.
 * Tracks utilization to identify underused free capacity.
 *
 * PM2 cron: every 2 hours
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const STATE_FILE = path.join(__dirname, '.free-fleet-state.json');
const BRIEF_DIR = process.env.BRIEF_DIR || './shared/daily-brief';

const PROVIDERS = [
  {
    name: 'Groq (Oracle)',
    probe: 'https://api.groq.com/openai/v1/models',
    envKey: 'GROQ_API_KEY',
    freeModels: ['llama-4-scout-17b-16e-instruct', 'llama-4-maverick-17b-128e-instruct'],
    limits: '30 req/min, 15K tokens/min (free tier)',
    agent: 'oracle',
  },
  {
    name: 'Ollama (Lama)',
    probe: 'http://localhost:11434/api/tags',
    envKey: null, // local
    freeModels: ['local models'],
    limits: 'Unlimited (local, 16GB RAM)',
    agent: 'lama',
  },
  {
    name: 'Cloudflare Workers AI (Flare)',
    probe: null, // No free probe endpoint
    envKey: 'CF_WORKERS_AI_TOKEN',
    freeModels: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    limits: '10K neurons/day free',
    agent: 'flare',
  },
  {
    name: 'HuggingFace Inference (Forge)',
    probe: null,
    envKey: 'HF_TOKEN',
    freeModels: ['various HF models'],
    limits: '1K req/day free tier',
    agent: 'forge',
  },
];

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastCheck: null, providers: {}, utilization: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function probeUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const key = process.env.GROQ_API_KEY;
    const headers = key && url.includes('groq') ? { 'Authorization': `Bearer ${key}` } : {};

    const req = client.get(url, { timeout: 10000, headers }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, available: res.statusCode < 400 }));
    });
    req.on('error', () => resolve({ status: 0, available: false }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, available: false }); });
  });
}

async function run() {
  const state = loadState();
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  const results = [];

  for (const provider of PROVIDERS) {
    let available = false;
    let detail = '';

    if (provider.probe) {
      const probe = await probeUrl(provider.probe);
      available = probe.available;
      detail = `HTTP ${probe.status}`;
    } else if (provider.envKey) {
      available = !!process.env[provider.envKey];
      detail = available ? 'Key configured' : 'Key missing';
    } else {
      available = true;
      detail = 'Local (assumed available)';
    }

    state.providers[provider.agent] = {
      name: provider.name,
      available,
      detail,
      lastCheck: now,
      limits: provider.limits,
    };

    results.push({ ...provider, available, detail });
  }

  // Check Ollama models specifically
  try {
    const ollamaProbe = await probeUrl('http://localhost:11434/api/tags');
    if (ollamaProbe.available) {
      state.providers.lama.detail = 'Ollama running, models available';
    }
  } catch {}

  state.lastCheck = now;
  saveState(state);

  // Summary
  const available = results.filter(r => r.available).length;
  console.log(`[free-fleet] ${available}/${results.length} free providers available:`);
  for (const r of results) {
    console.log(`  ${r.available ? '✅' : '❌'} ${r.name} (${r.agent}): ${r.detail} — ${r.limits}`);
  }
}

run().catch(e => {
  console.error('[free-fleet] Error:', e.message);
});
