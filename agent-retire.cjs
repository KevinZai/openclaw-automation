#!/usr/bin/env node
/**
 * agent-retire.cjs
 * Archives a single OpenClaw agent workspace + state.
 *
 * Usage: node scripts/agent-retire.cjs <agent-id> [--dry-run]
 *
 * What it does:
 *   1. Copies workspace/ to archive/agents-retired-YYYYMMDD/<id>/workspace/
 *   2. Copies ~/.openclaw/agents/<id>/ to archive/agents-retired-YYYYMMDD/<id>/openclaw-state/
 *   3. Stamps RETIRED: <date> in the workspace IDENTITY.md
 *   4. Writes an entry to archive/agents-retired-YYYYMMDD/README.md
 *   5. Prints the manual jq command to remove agent from openclaw.json (Kevin step)
 *
 * What it does NOT do:
 *   - Touch openclaw.json (Kevin must manually remove the agent entry)
 *   - Delete any files (archive only)
 *   - Restart the gateway
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────

const CLAWD_ROOT      = path.join(process.env.HOME, 'clawd');
const WORKSPACES_ROOT = path.join(CLAWD_ROOT, 'workspaces');
const ARCHIVE_ROOT    = path.join(CLAWD_ROOT, 'archive');
const OPENCLAW_AGENTS = path.join(process.env.HOME, '.openclaw/agents');
const OPENCLAW_CONFIG = path.join(process.env.HOME, '.openclaw/openclaw.json');

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));

const agentId = args[0];
const dryRun  = flags.has('--dry-run');

if (!agentId) {
  console.error('Usage: node scripts/agent-retire.cjs <agent-id> [--dry-run]');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateStamp() {
  return new Date().toISOString().split('T')[0].replace(/-/g, '');
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(dest, { recursive: true });
  execSync(`cp -r "${src}/." "${dest}/"`, { stdio: 'pipe' });
  return true;
}

function stamp(note) {
  if (dryRun) {
    console.log(`  [dry-run] ${note}`);
  } else {
    console.log(`  ✓ ${note}`);
  }
}

// ── Validate agent exists in config ──────────────────────────────────────────

if (!fs.existsSync(OPENCLAW_CONFIG)) {
  console.error(`ERROR: openclaw.json not found at ${OPENCLAW_CONFIG}`);
  process.exit(1);
}

const config   = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
const agentDef = (config.agents?.list || []).find(a => a.id === agentId);

if (!agentDef) {
  console.error(`ERROR: Agent "${agentId}" not found in openclaw.json`);
  console.error('Run: node scripts/agent-retirement-audit.cjs to see valid agent IDs');
  process.exit(1);
}

const agentName      = agentDef.name || agentId;
const agentWorkspace = agentDef.workspace || null;

// ── Safety check: don't retire active agents ─────────────────────────────────

const sessionsDir  = path.join(OPENCLAW_AGENTS, agentId, 'sessions');
const sessionFiles = fs.existsSync(sessionsDir)
  ? fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')).sort().reverse()
  : [];

if (sessionFiles.length > 0) {
  const latestFile = path.join(sessionsDir, sessionFiles[0]);
  const mtime = fs.statSync(latestFile).mtime;
  const daysAgo = Math.floor((Date.now() - mtime) / 86_400_000);

  if (daysAgo < 7) {
    console.error(`SAFETY ABORT: Agent "${agentId}" had a session ${daysAgo} day(s) ago.`);
    console.error('Refusing to retire an agent active within the last 7 days.');
    console.error('If you are sure, use: node scripts/agent-retire.cjs <id> --force');
    if (!flags.has('--force')) process.exit(1);
  }
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const stamp_date  = new Date().toISOString().split('T')[0];
const archiveDir  = path.join(ARCHIVE_ROOT, `agents-retired-${dateStamp()}`);
const agentArchive = path.join(archiveDir, agentId);

const workspaceSrc  = agentWorkspace && path.isAbsolute(agentWorkspace)
  ? agentWorkspace
  : agentWorkspace
    ? path.join(CLAWD_ROOT, agentWorkspace)
    : null;

const ocStateSrc = path.join(OPENCLAW_AGENTS, agentId);

// ── Execute ───────────────────────────────────────────────────────────────────

console.log(`\nRetiring agent: ${agentName} (${agentId})`);
console.log(`Archive dir: ${agentArchive}`);
if (dryRun) console.log('*** DRY RUN — no files will be changed ***\n');

// Step 1: Archive workspace
if (workspaceSrc && fs.existsSync(workspaceSrc)) {
  if (!dryRun) copyDir(workspaceSrc, path.join(agentArchive, 'workspace'));
  stamp(`Workspace archived: ${workspaceSrc} → ${agentArchive}/workspace/`);
} else {
  stamp(`Workspace not found at ${workspaceSrc || '(no workspace defined)'} — skipping`);
}

// Step 2: Archive OpenClaw agent state
if (fs.existsSync(ocStateSrc)) {
  if (!dryRun) copyDir(ocStateSrc, path.join(agentArchive, 'openclaw-state'));
  stamp(`OpenClaw state archived: ${ocStateSrc} → ${agentArchive}/openclaw-state/`);
} else {
  stamp(`No OpenClaw agent state found at ${ocStateSrc} — skipping`);
}

// Step 3: Stamp RETIRED in workspace IDENTITY.md
// For shared workspaces (e.g. worker/ shared by multiple agents), we only stamp
// if this agent has a dedicated IDENTITY.md (not shared). If the workspace is
// shared, print a note instead so the operator can manually mark the table row.
if (workspaceSrc) {
  const identityPath = path.join(workspaceSrc, 'IDENTITY.md');
  if (fs.existsSync(identityPath)) {
    const content = fs.readFileSync(identityPath, 'utf8');

    // Detect shared workspace: IDENTITY.md contains other active agent names
    const otherAgents = (config.agents?.list || [])
      .filter(a => a.id !== agentId && a.workspace === agentDef.workspace)
      .map(a => a.name);

    const isSharedWorkspace = otherAgents.length > 0;

    if (isSharedWorkspace) {
      stamp(`Shared workspace (${otherAgents.join(', ')} also live here) — skipping global IDENTITY.md stamp.`);
      stamp(`ACTION: Manually mark the agent's row in ${identityPath}`);
    } else if (!content.includes('RETIRED:')) {
      const banner = `\n---\n**RETIRED: ${stamp_date}** — archived via agent-retire.cjs. Remove from openclaw.json to deactivate.\n\n`;
      if (!dryRun) fs.writeFileSync(identityPath, banner + content);
      stamp(`RETIRED stamp added to ${identityPath}`);
    } else {
      stamp(`IDENTITY.md already has RETIRED stamp — skipping`);
    }
  }
}

// Step 4: Write archive README entry
const readmePath = path.join(archiveDir, 'README.md');
if (!dryRun) {
  fs.mkdirSync(archiveDir, { recursive: true });
  const entry = `
## ${agentName} (${agentId}) — ${stamp_date}

- **Workspace:** ${workspaceSrc || '(none)'}
- **OpenClaw state:** ${ocStateSrc}
- **Lifetime sessions:** ${sessionFiles.length}
- **Archived by:** agent-retire.cjs
- **Status:** workspace + state archived. Config entry still in openclaw.json (manual Kevin step).

### Restore
\`\`\`bash
cp -r ${agentArchive}/workspace/ ${workspaceSrc || '/path/to/workspace'}/
cp -r ${agentArchive}/openclaw-state/ ${ocStateSrc}/
# Kevin: re-add agent entry to openclaw.json
\`\`\`
`;

  const existingReadme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : `# Retired Agents — ${stamp_date}\n`;
  fs.writeFileSync(readmePath, existingReadme + entry);
  stamp(`Archive README updated: ${readmePath}`);
}

// Step 5: Print Kevin's manual step
console.log(`
────────────────────────────────────────────────────────────
DONE. One manual step remaining (Kevin):

  Remove from openclaw.json:
  jq 'del(.agents.list[] | select(.id == "${agentId}"))' \\
    ~/.openclaw/openclaw.json > /tmp/oc-new.json \\
    && mv /tmp/oc-new.json ~/.openclaw/openclaw.json

  Then run: openclaw doctor
────────────────────────────────────────────────────────────
`);
