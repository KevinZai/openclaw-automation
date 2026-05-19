#!/usr/bin/env node
/**
 * linear-priorities-mirror.cjs
 *
 * Polls Linear CC team for P0/P1 issues, diffs vs last-seen state cache,
 * posts new + state-changed + reassigned tickets to Discord #priorities
 * via webhook.
 *
 * Inspired by alii/linear-discord-serverless (66 stars).
 *
 * Schedule: every 15 min via crontab.
 * State: ~/clawd/.cache/linear-priorities-last-seen.json
 * Log:   ~/clawd/logs/linear-priorities-mirror.log
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

const HOME = os.homedir();
const STATE_FILE = path.join(HOME, 'clawd', '.cache', 'linear-priorities-last-seen.json');
const ENV_FILE = path.join(HOME, '.openclaw', '.env');
const CC_TEAM_ID = '896f0925-87e5-4143-88d0-34f605d91049';

// Webhook URL loaded from env var DISCORD_PRIORITIES_WEBHOOK_URL or ~/.openclaw/.env.
// Set: append DISCORD_PRIORITIES_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
// to ~/.openclaw/.env (NOT committed). Rotate the webhook in Discord if this token leaked.
function loadEnvFromOpenclaw() {
  if (!fs.existsSync(ENV_FILE)) return;
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const [, k, v0] = m;
      if (process.env[k]) continue;
      let v = v0;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[k] = v;
    }
  } catch (_) {}
}

loadEnvFromOpenclaw();
const WEBHOOK_URL = process.env.DISCORD_PRIORITIES_WEBHOOK_URL;
const LINEAR_TOKEN_SCRIPT = path.join(HOME, 'clawd', 'scripts', 'linear-token.sh');

// Linear priority codes: 1=Urgent (P0), 2=High (P1)
const PRIORITY_LABELS = { 1: 'Urgent', 2: 'High' };
// Open-state types we care about (skip completed/canceled)
const OPEN_TYPES = new Set(['backlog', 'unstarted', 'started']);

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function fail(msg, err) {
  log(`ERROR: ${msg}${err ? ' :: ' + (err.message || err) : ''}`);
  process.exit(1);
}

function getLinearToken() {
  try {
    return execSync(`bash "${LINEAR_TOKEN_SCRIPT}"`, { encoding: 'utf8' }).trim();
  } catch (e) {
    fail('linear-token.sh failed', e);
  }
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: buf })
        );
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function gql(token, query) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ query }));
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.linear.app',
        path: '/graphql',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Length': data.length,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(buf);
            if (j.errors) return reject(new Error(JSON.stringify(j.errors)));
            resolve(j.data);
          } catch (e) {
            reject(new Error(`bad json: ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fetchPriorityIssues(token) {
  // Pull all P0/P1 (priority 1 or 2) issues from CC team
  const query = `{
    issues(
      first: 100
      filter: {
        team: { id: { eq: "${CC_TEAM_ID}" } }
        priority: { in: [1, 2] }
      }
    ) {
      nodes {
        id
        identifier
        title
        priority
        url
        createdAt
        updatedAt
        state { name type }
        assignee { name displayName }
        project { name }
      }
    }
  }`;
  const data = await gql(token, query);
  return (data.issues && data.issues.nodes) || [];
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function priorityEmoji(p) {
  return p === 1 ? '🔴' : '🟠';
}

function buildEmbed(issue, changeType, prevState, prevAssignee) {
  const pri = PRIORITY_LABELS[issue.priority] || `P${issue.priority}`;
  const color = issue.priority === 1 ? 0xff0000 : 0xff8800; // red / orange
  const assignee =
    (issue.assignee && (issue.assignee.displayName || issue.assignee.name)) ||
    'Unassigned';
  const project = (issue.project && issue.project.name) || 'No project';
  const state = (issue.state && issue.state.name) || 'Unknown';

  let titleLine;
  if (changeType === 'new') {
    titleLine = `${priorityEmoji(issue.priority)} NEW ${pri}: ${issue.identifier}`;
  } else if (changeType === 'state') {
    titleLine = `${priorityEmoji(issue.priority)} STATE ${pri}: ${issue.identifier}`;
  } else if (changeType === 'assignee') {
    titleLine = `${priorityEmoji(issue.priority)} REASSIGNED ${pri}: ${issue.identifier}`;
  } else {
    titleLine = `${priorityEmoji(issue.priority)} ${pri}: ${issue.identifier}`;
  }

  const fields = [
    { name: 'State', value: prevState ? `${prevState} → ${state}` : state, inline: true },
    { name: 'Assignee', value: prevAssignee ? `${prevAssignee} → ${assignee}` : assignee, inline: true },
    { name: 'Project', value: project, inline: true },
  ];

  return {
    title: titleLine,
    description: issue.title,
    url: issue.url,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };
}

async function postEmbed(embed) {
  const res = await postJson(WEBHOOK_URL, {
    embeds: [embed],
    allowed_mentions: { parse: [] },
  });
  if (res.status >= 300) {
    log(`webhook post failed ${res.status}: ${res.body.slice(0, 200)}`);
    return false;
  }
  return true;
}

(async function main() {
  log('start');
  const token = getLinearToken();
  if (!token) fail('no linear token');

  let issues;
  try {
    issues = await fetchPriorityIssues(token);
  } catch (e) {
    fail('linear query failed', e);
  }
  log(`fetched ${issues.length} P0/P1 issues from CC team`);

  const state = loadState();
  const newState = {};
  const events = []; // { issue, type, prevState, prevAssignee }

  for (const issue of issues) {
    const stateType = (issue.state && issue.state.type) || '';
    // Only mirror open-state issues
    if (!OPEN_TYPES.has(stateType)) continue;

    const stateName = (issue.state && issue.state.name) || '';
    const assignee =
      (issue.assignee && (issue.assignee.displayName || issue.assignee.name)) ||
      '';
    const fingerprint = { state: stateName, assignee, priority: issue.priority };
    newState[issue.id] = fingerprint;

    const prev = state[issue.id];
    if (!prev) {
      events.push({ issue, type: 'new' });
    } else if (prev.state !== stateName) {
      events.push({ issue, type: 'state', prevState: prev.state, prevAssignee: prev.assignee || 'Unassigned' });
    } else if ((prev.assignee || '') !== assignee) {
      events.push({ issue, type: 'assignee', prevState: stateName, prevAssignee: prev.assignee || 'Unassigned' });
    }
  }

  log(`detected ${events.length} events to mirror`);

  // Cap to avoid bulk spam on first run / state-file loss
  const MAX_EVENTS = 10;
  let posted = 0;
  for (const ev of events.slice(0, MAX_EVENTS)) {
    const embed = buildEmbed(ev.issue, ev.type, ev.prevState, ev.prevAssignee);
    const ok = await postEmbed(embed);
    if (ok) {
      posted++;
      log(`posted ${ev.type} ${ev.issue.identifier} (${ev.issue.state && ev.issue.state.name})`);
    }
  }
  if (events.length > MAX_EVENTS) {
    log(`skipped ${events.length - MAX_EVENTS} events (rate cap)`);
  }

  saveState(newState);
  log(`done: ${posted} posted, state file has ${Object.keys(newState).length} tracked issues`);
})().catch((e) => fail('uncaught', e));
