#!/usr/bin/env node
/**
 * skills-audit.cjs — Skill allowlist + hash-pin audit (ClawHavoc-class defense)
 *
 * Scans skill installation directories, computes SKILL.md sha256, and compares
 * against a maintained allowlist. Flags NEW or CHANGED skills for human review.
 *
 * Usage:
 *   node scripts/skills-audit.cjs              # audit, exit 0=clean 1=drift 2=error
 *   node scripts/skills-audit.cjs --json       # JSON only on stdout
 *   node scripts/skills-audit.cjs --baseline   # (re)generate allowlist from current state
 *   node scripts/skills-audit.cjs --add <path> # add a single skill dir to allowlist
 *
 * Exit codes:
 *   0  clean (everything matches allowlist)
 *   1  drift detected (NEW or CHANGED skills)
 *   2  audit error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const HOME = os.homedir();
const ALLOWLIST = path.join(HOME, 'clawd/shared/refs/skills-allowlist.json');

const SCAN_LOCATIONS = [
  path.join(HOME, '.claude/skills'),
  path.join(HOME, '.openclaw/skills'),
  path.join(HOME, 'clawd/projects/cc-commander/skills'),
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashFile(p) {
  try {
    return sha256(fs.readFileSync(p));
  } catch (_e) {
    return null;
  }
}

function dirSizeAndCount(dir) {
  let bytes = 0;
  let files = 0;
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (ent.name === '.DS_Store') continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        try { bytes += fs.statSync(full).size; files++; } catch (_) {}
      }
    }
  }
  walk(dir);
  return { files, bytes };
}

function scanLocation(loc) {
  const skills = [];
  let entries;
  try { entries = fs.readdirSync(loc, { withFileTypes: true }); }
  catch (_) { return skills; }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    const skillDir = path.join(loc, ent.name);
    const skillMd = path.join(skillDir, 'SKILL.md');
    const hasSkillMd = fs.existsSync(skillMd);
    const hash = hasSkillMd ? hashFile(skillMd) : null;
    const { files, bytes } = dirSizeAndCount(skillDir);
    skills.push({
      path: skillDir.replace(HOME, '~'),
      name: ent.name,
      location: loc.replace(HOME, '~'),
      hasSkillMd,
      sha256: hash,
      files,
      bytes,
    });
  }
  return skills;
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST)) return null;
  try { return JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')); }
  catch (e) { return { _parseError: e.message }; }
}

function writeAllowlist(data) {
  fs.mkdirSync(path.dirname(ALLOWLIST), { recursive: true });
  fs.writeFileSync(ALLOWLIST, JSON.stringify(data, null, 2) + '\n');
}

function buildBaseline(allSkills) {
  return {
    version: '1.0',
    generated: new Date().toISOString(),
    note: 'Hash-pin allowlist for installed skills. Update via skills-audit.cjs --add <path>. See SKILL-SUPPLY-CHAIN-DEFENSE.md.',
    skills: allSkills
      .filter(s => s.hasSkillMd && s.sha256)
      .map(s => ({
        path: s.path,
        sha256: s.sha256,
        added: new Date().toISOString().slice(0, 10),
        source: 'baseline-seed',
        notes: '',
      })),
  };
}

function audit() {
  const allSkills = [];
  for (const loc of SCAN_LOCATIONS) {
    allSkills.push(...scanLocation(loc));
  }

  const allowlist = loadAllowlist();
  if (!allowlist) {
    return { error: 'allowlist-missing', allSkills };
  }
  if (allowlist._parseError) {
    return { error: 'allowlist-parse-error', detail: allowlist._parseError };
  }

  const byPath = new Map(allowlist.skills.map(s => [s.path, s]));
  const NEW = [], CHANGED = [], OK = [], MISSING_SKILL_MD = [];
  const seen = new Set();

  for (const s of allSkills) {
    seen.add(s.path);
    if (!s.hasSkillMd) { MISSING_SKILL_MD.push(s); continue; }
    const a = byPath.get(s.path);
    if (!a) { NEW.push(s); continue; }
    if (a.sha256 !== s.sha256) { CHANGED.push({ ...s, expected: a.sha256 }); continue; }
    OK.push(s);
  }

  const REMOVED = allowlist.skills
    .filter(a => !seen.has(a.path))
    .map(a => ({ path: a.path, sha256: a.sha256 }));

  return {
    timestamp: new Date().toISOString(),
    totals: {
      scanned: allSkills.length,
      ok: OK.length,
      new: NEW.length,
      changed: CHANGED.length,
      removed: REMOVED.length,
      missingSkillMd: MISSING_SKILL_MD.length,
    },
    NEW, CHANGED, REMOVED, MISSING_SKILL_MD,
    allSkills,
  };
}

function addSkill(rawPath) {
  const abs = path.resolve(rawPath.replace(/^~/, HOME));
  const skillMd = path.join(abs, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    console.error(`ERROR: no SKILL.md at ${skillMd}`);
    process.exit(2);
  }
  const hash = hashFile(skillMd);
  const tildePath = abs.replace(HOME, '~');
  let allowlist = loadAllowlist();
  if (!allowlist || allowlist._parseError) {
    console.error('ERROR: allowlist missing or unparseable. Run --baseline first.');
    process.exit(2);
  }
  const idx = allowlist.skills.findIndex(s => s.path === tildePath);
  const entry = {
    path: tildePath,
    sha256: hash,
    added: new Date().toISOString().slice(0, 10),
    source: 'manual-add',
    notes: '',
  };
  if (idx >= 0) {
    allowlist.skills[idx] = { ...allowlist.skills[idx], ...entry };
    console.error(`UPDATED: ${tildePath} -> ${hash.slice(0, 12)}`);
  } else {
    allowlist.skills.push(entry);
    console.error(`ADDED: ${tildePath} -> ${hash.slice(0, 12)}`);
  }
  allowlist.generated = new Date().toISOString();
  writeAllowlist(allowlist);
}

function humanReport(result) {
  const lines = [];
  lines.push(`Skills audit @ ${result.timestamp}`);
  lines.push(`  scanned=${result.totals.scanned}  ok=${result.totals.ok}  new=${result.totals.new}  changed=${result.totals.changed}  removed=${result.totals.removed}  no-SKILL.md=${result.totals.missingSkillMd}`);
  if (result.NEW.length) {
    lines.push('');
    lines.push('NEW (not in allowlist, review needed):');
    for (const s of result.NEW) lines.push(`  + ${s.path}  sha=${s.sha256.slice(0, 12)}  files=${s.files}  bytes=${s.bytes}`);
  }
  if (result.CHANGED.length) {
    lines.push('');
    lines.push('CHANGED (hash mismatch, review needed):');
    for (const s of result.CHANGED) lines.push(`  ~ ${s.path}  expected=${s.expected.slice(0, 12)} actual=${s.sha256.slice(0, 12)}`);
  }
  if (result.REMOVED.length) {
    lines.push('');
    lines.push('REMOVED (in allowlist but not on disk):');
    for (const s of result.REMOVED) lines.push(`  - ${s.path}`);
  }
  if (result.MISSING_SKILL_MD.length) {
    lines.push('');
    lines.push('NO SKILL.md (directory exists but no SKILL.md — investigate):');
    for (const s of result.MISSING_SKILL_MD) lines.push(`  ? ${s.path}`);
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes('--json');

  if (args.includes('--baseline')) {
    const all = [];
    for (const loc of SCAN_LOCATIONS) all.push(...scanLocation(loc));
    const baseline = buildBaseline(all);
    writeAllowlist(baseline);
    console.error(`Baseline written: ${ALLOWLIST.replace(HOME, '~')} (${baseline.skills.length} skills)`);
    process.exit(0);
  }

  const addIdx = args.indexOf('--add');
  if (addIdx >= 0) {
    const p = args[addIdx + 1];
    if (!p) { console.error('ERROR: --add requires a path'); process.exit(2); }
    addSkill(p);
    process.exit(0);
  }

  const result = audit();
  if (result.error) {
    if (!jsonOnly) console.error(`AUDIT ERROR: ${result.error}${result.detail ? ' — ' + result.detail : ''}`);
    if (result.error === 'allowlist-missing') {
      console.error('Hint: run `node scripts/skills-audit.cjs --baseline` to seed the allowlist.');
    }
    if (jsonOnly) console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
    console.error(humanReport(result));
  }

  const drift = result.totals.new + result.totals.changed;
  process.exit(drift > 0 ? 1 : 0);
}

main();
