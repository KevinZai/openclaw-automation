#!/usr/bin/env node
/**
 * lcm-sanitizer.cjs — Write-side LCM secret-leak sanitizer (sidecar mode).
 *
 * Scans recent ~/.openclaw/lcm.db `message_parts` rows for leaked secrets in
 * `tool_input`, `text_content`, `tool_output`, `metadata` columns and UPDATEs
 * the row in place with `<REDACTED:LAST4:kind>` markers. Idempotent: rows that
 * already contain `<REDACTED:` are skipped.
 *
 * Background: openclaw's `exec` tool persists the verbatim command JSON into
 * `tool_input`. When an LLM authors a curl with a literal `Authorization:
 * Bearer <token>` (instead of `$VAR`), the secret lands in LCM. OC's existing
 * `logging.redactPatterns` only sanitizes log output, not persistence — this
 * script closes the gap until the upstream LCM pre-persist hook lands.
 *
 * Usage:
 *   node lcm-sanitizer.cjs --dry-run              List would-redact (last 1h)
 *   node lcm-sanitizer.cjs --dry-run --since=1h
 *   node lcm-sanitizer.cjs --dry-run --since=24h
 *   node lcm-sanitizer.cjs --dry-run --since=all
 *   node lcm-sanitizer.cjs --since=1h             Apply UPDATEs (creates .backup-* if missing)
 *   node lcm-sanitizer.cjs --since=5m             Cron mode (default if --cron set)
 *   node lcm-sanitizer.cjs --cron                 == --since=5m, suppresses verbose output
 *
 * Safety:
 *   - Read-only by default if --dry-run.
 *   - Auto-creates a backup tarball on first non-dry run per UTC day.
 *   - Idempotent: skips rows already containing `<REDACTED:`.
 *   - Never replaces values that are `$VAR` placeholders.
 *
 * Exit codes:
 *   0 success
 *   1 fatal error (missing DB, bad regex, etc.)
 *   2 backup failed (refuses to mutate without a backup)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const sqlite = require('node:sqlite');

const DB_PATH = process.env.LCM_DB || path.join(os.homedir(), '.openclaw/lcm.db');
const CONFIG_PATH = path.join(__dirname, 'lcm-sanitizer.config.json');
const LOG_PATH = path.join(os.homedir(), 'clawd/logs/lcm-sanitizer.log');
const BACKUP_DIR = path.join(os.homedir(), '.openclaw');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CRON = args.includes('--cron');
const VERBOSE = args.includes('--verbose');
let SINCE = '5m';
for (const a of args) {
  const m = a.match(/^--since=(.+)$/);
  if (m) SINCE = m[1];
}
if (!args.some(a => a.startsWith('--since=')) && !CRON && !DRY_RUN) SINCE = '5m';
if (DRY_RUN && !args.some(a => a.startsWith('--since='))) SINCE = '1h';

function logLine(level, msg, extra) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch (_) {}
  if (level !== 'DEBUG' || VERBOSE) process.stdout.write(line);
}

function parseSince(s) {
  if (s === 'all') return null;
  const m = s.match(/^(\d+)\s*([smhd])$/);
  if (!m) throw new Error(`Bad --since: ${s} (expected 5m|1h|24h|7d|all)`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  // SQLite datetime offset string:
  return `-${n * mult} seconds`;
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const compiled = cfg.patterns.map(p => {
    const flags = p.flags || 'g';
    const flagsWithG = flags.includes('g') ? flags : flags + 'g';
    return {
      ...p,
      compiled: new RegExp(p.regex, flagsWithG),
    };
  });
  return { ...cfg, compiled };
}

function applyReplacements(text, cfg) {
  if (text == null) return { text: text, changed: false, hits: {} };
  if (typeof text !== 'string') return { text, changed: false, hits: {} };
  if (text.includes('<REDACTED:')) {
    // Idempotency: row is already partially redacted. We could still scan for
    // *new* secrets but we'd risk double-redacting. Skip.
    return { text, changed: false, hits: {}, skippedAlreadyRedacted: true };
  }
  let out = text;
  let changed = false;
  const hits = {};
  for (const p of cfg.compiled) {
    out = out.replace(p.compiled, (match, ...rest) => {
      // rest = [...captureGroups, offset, fullString, groups?]
      // captureLast4 selects which capture group to grab last-4 from. 0 = full match.
      const groups = rest.slice(0, -2);
      let valueForLast4 = match;
      if (p.captureLast4 && p.captureLast4 > 0 && groups[p.captureLast4 - 1]) {
        valueForLast4 = groups[p.captureLast4 - 1];
      }
      // Skip $VAR placeholders.
      if (/^\$[A-Z_][A-Z0-9_]*$/.test(valueForLast4)) return match;
      const last4 = valueForLast4.slice(-4);
      let replacement = p.replace.replace('{LAST4}', last4);
      // Substitute $1, $2 capture groups in the template.
      replacement = replacement.replace(/\$(\d)/g, (_, n) => groups[parseInt(n, 10) - 1] ?? '');
      hits[p.name] = (hits[p.name] || 0) + 1;
      changed = true;
      return replacement;
    });
  }
  return { text: out, changed, hits };
}

function mergeHits(a, b) {
  for (const [k, v] of Object.entries(b)) a[k] = (a[k] || 0) + v;
  return a;
}

function ensureBackup(dryRun) {
  if (dryRun) return null;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // We only need one backup per day. Check if any file matches the pattern.
  const existing = fs.readdirSync(BACKUP_DIR).filter(f =>
    f.startsWith(`lcm.db.backup-lcm-sanitizer-${today}`)
  );
  if (existing.length > 0) {
    logLine('INFO', `Backup already exists for today: ${existing[0]}`);
    return path.join(BACKUP_DIR, existing[0]);
  }
  const stamp = today + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const backupPath = path.join(BACKUP_DIR, `lcm.db.backup-lcm-sanitizer-${stamp}`);
  logLine('INFO', `Creating backup: ${backupPath}`);
  try {
    execSync(`cp "${DB_PATH}" "${backupPath}"`, { stdio: 'inherit' });
  } catch (e) {
    logLine('FATAL', 'Backup failed', { err: e.message });
    process.exit(2);
  }
  return backupPath;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    logLine('FATAL', `LCM DB not found: ${DB_PATH}`);
    process.exit(1);
  }
  const cfg = loadConfig();
  const sinceOffset = parseSince(SINCE);
  logLine('INFO', `Run start`, {
    mode: DRY_RUN ? 'DRY-RUN' : 'APPLY',
    since: SINCE,
    db: DB_PATH,
    patterns: cfg.patterns.length,
  });

  const backupPath = ensureBackup(DRY_RUN);

  const db = new sqlite.DatabaseSync(DB_PATH);
  // Ensure WAL mode is OK (don't change journal mode).
  let whereTimeClause = '';
  const params = {};
  if (sinceOffset !== null) {
    whereTimeClause = `AND m.created_at > datetime('now', $since)`;
    params.since = sinceOffset;
  }

  // Pull only the rows that likely have secrets to keep the scan fast.
  const sql = `
    SELECT mp.part_id, mp.message_id, mp.tool_input, mp.text_content, mp.tool_output, mp.metadata
    FROM message_parts mp
    JOIN messages m ON m.message_id = mp.message_id
    WHERE (
      mp.tool_input LIKE '%Bearer %' OR
      mp.tool_input LIKE '%API_KEY%' OR
      mp.tool_input LIKE '%SECRET%' OR
      mp.tool_input LIKE '%TOKEN%' OR
      mp.tool_input LIKE '%sk-%' OR
      mp.tool_input LIKE '%xoxb-%' OR
      mp.tool_input LIKE '%pcp_%' OR
      mp.tool_input LIKE '%ghp_%' OR
      mp.tool_input LIKE '%pk-lf-%' OR
      mp.tool_input LIKE '%sk-lf-%' OR
      mp.tool_input LIKE '%AKIA%' OR
      mp.text_content LIKE '%Bearer %' OR
      mp.text_content LIKE '%sk-%' OR
      mp.text_content LIKE '%xoxb-%' OR
      mp.text_content LIKE '%pcp_%' OR
      mp.text_content LIKE '%pk-lf-%' OR
      mp.text_content LIKE '%sk-lf-%' OR
      mp.text_content LIKE '%ghp_%' OR
      mp.tool_output LIKE '%Bearer %' OR
      mp.tool_output LIKE '%sk-%' OR
      mp.tool_output LIKE '%pcp_%' OR
      mp.tool_output LIKE '%pk-lf-%' OR
      mp.tool_output LIKE '%sk-lf-%' OR
      mp.metadata    LIKE '%Bearer %' OR
      mp.metadata    LIKE '%sk-%'
    )
    AND (mp.tool_input IS NULL OR mp.tool_input NOT LIKE '%<REDACTED:%')
    AND (mp.text_content IS NULL OR mp.text_content NOT LIKE '%<REDACTED:%')
    AND (mp.tool_output IS NULL OR mp.tool_output NOT LIKE '%<REDACTED:%')
    AND (mp.metadata IS NULL OR mp.metadata NOT LIKE '%<REDACTED:%')
    ${whereTimeClause}
  `;

  const select = db.prepare(sql);
  const rows = sinceOffset === null ? select.all() : select.all(params);

  logLine('INFO', `Candidate rows: ${rows.length}`);

  const update = db.prepare(`
    UPDATE message_parts
    SET tool_input = $tool_input,
        text_content = $text_content,
        tool_output = $tool_output,
        metadata = $metadata
    WHERE part_id = $part_id
  `);

  const totals = {};
  let rowsRedacted = 0;
  let dryRunSamples = [];

  // Wrap in a single transaction for speed.
  if (!DRY_RUN) db.exec('BEGIN');
  try {
    for (const row of rows) {
      const ti = applyReplacements(row.tool_input, cfg);
      const tc = applyReplacements(row.text_content, cfg);
      const to = applyReplacements(row.tool_output, cfg);
      const md = applyReplacements(row.metadata, cfg);
      const anyChange = ti.changed || tc.changed || to.changed || md.changed;
      if (!anyChange) continue;
      const merged = {};
      mergeHits(merged, ti.hits);
      mergeHits(merged, tc.hits);
      mergeHits(merged, to.hits);
      mergeHits(merged, md.hits);
      mergeHits(totals, merged);
      rowsRedacted += 1;
      if (DRY_RUN) {
        if (dryRunSamples.length < 20) {
          // Show last-4 only for first 20 samples.
          const sample = {
            part_id: row.part_id,
            message_id: row.message_id,
            hits: merged,
            tool_input_preview: ti.changed ? ti.text.slice(0, 200) : null,
          };
          dryRunSamples.push(sample);
        }
      } else {
        update.run({
          part_id: row.part_id,
          tool_input: ti.changed ? ti.text : row.tool_input,
          text_content: tc.changed ? tc.text : row.text_content,
          tool_output: to.changed ? to.text : row.tool_output,
          metadata: md.changed ? md.text : row.metadata,
        });
      }
    }
    if (!DRY_RUN) db.exec('COMMIT');
  } catch (e) {
    if (!DRY_RUN) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    }
    logLine('FATAL', `Update failed`, { err: e.message });
    process.exit(1);
  } finally {
    db.close();
  }

  logLine('INFO', `Run complete`, {
    mode: DRY_RUN ? 'DRY-RUN' : 'APPLY',
    scanned: rows.length,
    redacted: rowsRedacted,
    by_pattern: totals,
    backup: backupPath,
  });

  if (DRY_RUN) {
    process.stdout.write('--- DRY RUN SAMPLES (first 20) ---\n');
    for (const s of dryRunSamples) {
      process.stdout.write(JSON.stringify(s) + '\n');
    }
  }
}

try {
  main();
} catch (e) {
  logLine('FATAL', `Uncaught: ${e.message}`, { stack: e.stack });
  process.exit(1);
}
