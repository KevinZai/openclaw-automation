#!/usr/bin/env node
/**
 * linear-sync.cjs — Mirror Linear issues into memory_md files so mempalace
 * rooms tasks_personal + tasks_gn become live-queryable.
 *
 * Two outputs:
 *   ~/clawd/workspaces/main/linear-tasks.md         (personal k3v80 CC- team)
 *   ~/clawd/workspaces/guestnetworks/linear-tasks.md (GN team)
 *
 * Cron: 15 minutes (added below to crontab via scripts/install-linear-sync-cron.sh)
 *
 * Env required:
 *   LINEAR_API_KEY_PERSONAL  — k3v80 workspace
 *   LINEAR_API_KEY_BUSINESS  — Guest Networks workspace
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

function gql(token, query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.linear.app', path: '/graphql', method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

const QUERY = `{
  viewer { email name }
  organization { name }
  issues(first: 100, filter: { state: { type: { nin: ["completed","canceled"] } } }, orderBy: updatedAt) {
    nodes {
      identifier
      title
      state { name type }
      priority
      assignee { name email }
      team { key name }
      url
      updatedAt
      labels { nodes { name } }
    }
  }
}`;

async function sync(token, outPath, label) {
  if (!token) { console.error(`[${label}] no token, skipping`); return; }
  const r = await gql(token, QUERY);
  if (r.errors) { console.error(`[${label}] errors:`, JSON.stringify(r.errors).slice(0,200)); return; }
  const viewer = r.data.viewer; const org = r.data.organization.name;
  const issues = r.data.issues.nodes;
  let md = `# Linear Sync — ${org} (${label})\n\n`;
  md += `**Synced:** ${new Date().toISOString()}\n`;
  md += `**Viewer:** ${viewer.name} (${viewer.email})\n`;
  md += `**Open issues:** ${issues.length}\n\n---\n\n`;
  // Group by team
  const byTeam = {};
  for (const i of issues) {
    const k = i.team.key; (byTeam[k] = byTeam[k] || []).push(i);
  }
  for (const team of Object.keys(byTeam).sort()) {
    md += `## ${team} — ${byTeam[team][0].team.name}\n\n`;
    for (const i of byTeam[team]) {
      const pri = ['','🔴 Urgent','🟠 High','🟡 Med','🟢 Low'][i.priority] || '⚪ None';
      const assignee = i.assignee ? `${i.assignee.name}` : '_unassigned_';
      const labels = i.labels.nodes.map(l => l.name).join(', ');
      md += `### ${i.identifier} · ${i.title}\n`;
      md += `- **State:** ${i.state.name} (${i.state.type}) · **Priority:** ${pri} · **Assignee:** ${assignee}\n`;
      if (labels) md += `- **Labels:** ${labels}\n`;
      md += `- **URL:** ${i.url}\n`;
      md += `- **Updated:** ${i.updatedAt}\n\n`;
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  console.error(`[${label}] wrote ${outPath} (${issues.length} issues)`);
}

(async () => {
  await sync(process.env.LINEAR_API_KEY_PERSONAL, `${process.env.HOME}/clawd/workspaces/main/linear-tasks.md`, 'personal');
  await sync(process.env.LINEAR_API_KEY_BUSINESS, `${process.env.HOME}/clawd/workspaces/guestnetworks/linear-tasks.md`, 'gn');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
