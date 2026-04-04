#!/usr/bin/env node
/**
 * @file correction-propagator.js
 * @description Correction propagation engine — auto-generate rules from repeated corrections
 * @author Kevin Zicherman (kevinz.ai)
 * @license MIT
 * @repository https://github.com/kevinz-ai/openclaw-automation
 * @version 1.0.0
 * @created 2026-03-30
 */
/**
 * Correction Propagation Engine — Auto-generates CLAUDE.md rule proposals
 * from repeated [CORRECTION] tags across workspace memory files.
 *
 * Scans all workspace memory/ dirs for [CORRECTION] entries.
 * Groups similar corrections by content similarity.
 * If same correction appears 3+ times → generates a rule proposal.
 * Writes proposals to shared/pending-rules/ for Kevin/Morpheus review.
 *
 * PM2 cron: daily at 7am (after overnight consolidation at 6am)
 * State: scripts/.correction-propagator-state.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAWD_DIR = process.env.CLAWD_DIR || path.join(os.homedir(), 'clawd');
const WORKSPACES_DIR = path.join(CLAWD_DIR, 'workspaces');
const PENDING_RULES_DIR = path.join(CLAWD_DIR, 'shared/pending-rules');
const STATE_FILE = path.join(__dirname, '.correction-propagator-state.json');
const BRIEF_DIR = path.join(CLAWD_DIR, 'shared/daily-brief');
const MIN_OCCURRENCES = 3;
const SIMILARITY_THRESHOLD = 0.6;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      lastRun: null,
      processedFiles: [],
      proposedRules: [],
      stats: { totalCorrections: 0, rulesGenerated: 0 },
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Extract [CORRECTION] entries from a markdown file
function extractCorrections(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const corrections = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('[CORRECTION]')) continue;

      // Grab the correction text — current line + up to 3 following lines for context
      const correctionLines = [line];
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const nextLine = lines[j].trim();
        if (!nextLine || nextLine.startsWith('#') || nextLine.startsWith('##') || nextLine.includes('[')) break;
        correctionLines.push(lines[j]);
      }

      const text = correctionLines.join(' ')
        .replace(/\[CORRECTION\]/g, '')
        .replace(/^[\s\-\*#]+/, '')
        .trim();

      if (text.length > 10) {
        corrections.push({
          text,
          file: filePath,
          workspace: filePath.split('/workspaces/')[1]?.split('/')[0] || 'unknown',
        });
      }
    }
    return corrections;
  } catch {
    return [];
  }
}

// Simple word-overlap similarity (Jaccard index on significant words)
function similarity(a, b) {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
    'might', 'must', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they']);

  const tokenize = (s) => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
    return new Set(words);
  };

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  return intersection / (setA.size + setB.size - intersection);
}

// Group similar corrections together
function groupCorrections(corrections) {
  const groups = [];

  for (const correction of corrections) {
    let matched = false;
    for (const group of groups) {
      if (similarity(correction.text, group.representative) >= SIMILARITY_THRESHOLD) {
        group.entries.push(correction);
        matched = true;
        break;
      }
    }
    if (!matched) {
      groups.push({
        representative: correction.text,
        entries: [correction],
      });
    }
  }

  return groups;
}

// Generate a rule proposal from a group of similar corrections
function generateProposal(group, index) {
  const workspaces = [...new Set(group.entries.map(e => e.workspace))];
  const count = group.entries.length;
  const date = new Date().toISOString().split('T')[0];

  return `# Rule Proposal #${index} — ${date}

## Pattern Detected
**${count} occurrences** across workspaces: ${workspaces.join(', ')}

## Representative Correction
> ${group.representative}

## All Instances
${group.entries.map(e => `- **${e.workspace}** (${path.basename(e.file)}): ${e.text.slice(0, 120)}${e.text.length > 120 ? '...' : ''}`).join('\n')}

## Proposed Rule
\`\`\`
${deriveRule(group.representative)}
\`\`\`

## Action Required
- [ ] Kevin/Morpheus: Review and approve
- [ ] If approved: Add to appropriate CLAUDE.md or shared/preferences/
- [ ] Mark this file as processed (rename to \`processed-${date}-${index}.md\`)

---
*Generated by correction-propagator.js on ${new Date().toISOString()}*
`;
}

// Attempt to derive a rule from the correction text
function deriveRule(text) {
  const lower = text.toLowerCase();

  // Common correction patterns
  if (lower.includes('never') || lower.includes('don\'t') || lower.includes('do not')) {
    return text.replace(/^.*?(never|don't|do not)/i, '$1').trim();
  }
  if (lower.includes('always') || lower.includes('must')) {
    return text.replace(/^.*?(always|must)/i, '$1').trim();
  }
  if (lower.includes('should')) {
    return text.replace(/^.*?(should)/i, '$1').trim();
  }
  if (lower.includes('use') && lower.includes('instead')) {
    return text;
  }

  // Default: prefix with "Rule:"
  return `When handling similar situations: ${text}`;
}

function run() {
  const state = loadState();
  const allCorrections = [];

  // Scan all workspace memory directories
  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(WORKSPACES_DIR).filter(d => {
      const full = path.join(WORKSPACES_DIR, d);
      return fs.statSync(full).isDirectory() && !d.startsWith('.');
    });
  } catch (e) {
    console.error('[correction-propagator] Cannot read workspaces dir:', e.message);
    process.exit(1);
  }

  for (const ws of workspaceDirs) {
    const memDir = path.join(WORKSPACES_DIR, ws, 'memory');
    if (!fs.existsSync(memDir)) continue;

    // Scan memory files (including subdirectories like memory/sam/, memory/jarvis/)
    const scanDir = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(full);
          } else if (entry.name.endsWith('.md')) {
            const corrections = extractCorrections(full);
            allCorrections.push(...corrections);
          }
        }
      } catch {}
    };

    scanDir(memDir);
  }

  // Also scan shared/preferences/ files for corrections
  const prefsDir = path.join(CLAWD_DIR, 'shared/preferences');
  if (fs.existsSync(prefsDir)) {
    try {
      const prefs = fs.readdirSync(prefsDir).filter(f => f.endsWith('.md'));
      for (const pf of prefs) {
        const corrections = extractCorrections(path.join(prefsDir, pf));
        allCorrections.push(...corrections);
      }
    } catch {}
  }

  console.log(`[correction-propagator] Found ${allCorrections.length} total [CORRECTION] entries`);

  if (allCorrections.length === 0) {
    state.lastRun = new Date().toISOString();
    saveState(state);
    return;
  }

  // Group similar corrections
  const groups = groupCorrections(allCorrections);
  const repeatedGroups = groups.filter(g => g.entries.length >= MIN_OCCURRENCES);

  console.log(`[correction-propagator] ${groups.length} unique patterns, ${repeatedGroups.length} repeated ${MIN_OCCURRENCES}+ times`);

  // Filter out already-proposed rules
  const existingProposals = new Set(state.proposedRules.map(r => r.representative));
  const newGroups = repeatedGroups.filter(g => !existingProposals.has(g.representative));

  if (newGroups.length === 0) {
    console.log('[correction-propagator] No new rule proposals needed');
    state.lastRun = new Date().toISOString();
    state.stats.totalCorrections = allCorrections.length;
    saveState(state);
    return;
  }

  // Generate proposals
  fs.mkdirSync(PENDING_RULES_DIR, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const proposals = [];

  for (let i = 0; i < newGroups.length; i++) {
    const group = newGroups[i];
    const filename = `proposal-${date}-${i + 1}.md`;
    const filepath = path.join(PENDING_RULES_DIR, filename);
    const content = generateProposal(group, i + 1);

    fs.writeFileSync(filepath, content);
    proposals.push({ file: filename, representative: group.representative, count: group.entries.length });
    console.log(`[correction-propagator] Generated: ${filename} (${group.entries.length} occurrences)`);
  }

  // Update state
  state.lastRun = new Date().toISOString();
  state.stats.totalCorrections = allCorrections.length;
  state.stats.rulesGenerated += proposals.length;
  state.proposedRules = [
    ...(state.proposedRules || []).slice(-50),
    ...newGroups.map(g => ({ representative: g.representative, date: date, count: g.entries.length })),
  ];
  saveState(state);

  // Log to daily brief
  if (proposals.length > 0) {
    fs.mkdirSync(BRIEF_DIR, { recursive: true });
    const briefFile = path.join(BRIEF_DIR, `corrections-${date}.md`);
    const briefContent = `# Correction Propagator — ${date}\n\n` +
      `Scanned ${allCorrections.length} corrections across ${workspaceDirs.length} workspaces.\n\n` +
      `## New Rule Proposals (${proposals.length})\n\n` +
      proposals.map(p => `- **${p.file}** (${p.count}x): ${p.representative.slice(0, 100)}...`).join('\n') +
      `\n\nReview at: \`shared/pending-rules/\`\n`;

    fs.writeFileSync(briefFile, briefContent);
  }

  console.log(`[correction-propagator] Done: ${proposals.length} new proposals generated`);
}

run();
