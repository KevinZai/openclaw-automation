# Script Catalog

Deep-dive reference for every script in the repo. For a quick overview, see the [README](README.md) tables.

Scripts are grouped by operational category. Each entry covers: purpose, env var inputs, outputs, PM2 schedule, side effects, and a sample output snippet.

---

## Health Monitoring

### `agent-heartbeat-monitor.js`

**Purpose:** Detect silent or stuck agents in the OpenClaw fleet and auto-restart critical ones after 3 missed heartbeats.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `OPENCLAW_AGENTS_DIR` | `~/.openclaw/agents` | No |
| `CLAWD_DIR` | `~/clawd` | No |
| `ALERT_TELEGRAM_CHAT_ID` | — | No (alerts disabled if unset) |
| `TELEGRAM_BOT_TOKEN` | — | No |

**Outputs:** Telegram alert when a critical agent is silent >2h during business hours. Log warning for non-critical agents silent >6h. State written to `.heartbeat-state.json`.

**Schedule:** `*/10 * * * *` (every 10 minutes)

**Side effects:** May call `openclaw agents restart <id>` for agents flagged as auto-restartable.

**Sample output:**
```
[2026-04-30T09:12:00] Checked 12 agents
[2026-04-30T09:12:00] WARN: jarvis silent 7h (non-critical, expected off-hours)
[2026-04-30T09:12:00] OK: alfred last seen 4m ago
[2026-04-30T09:12:00] OK: morpheus last seen 12m ago
```

---

### `self-heal.js`

**Purpose:** Scan OpenClaw gateway logs for recurring error patterns (429 rate limits, OOM crashes, channel disconnects, uncaught exceptions) and apply automated remediation.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |
| `ALERT_TELEGRAM_CHAT_ID` | — | No |
| `TELEGRAM_BOT_TOKEN` | — | No |

**Outputs:** Daily brief log entry in `shared/daily-brief/`. Telegram alert for OOM and uncaught exceptions. State written to `.self-heal-state.json`.

**Schedule:** `*/5 * * * *` (every 5 minutes)

**Side effects:** Rate limit tracking stored in state file. No automatic gateway restarts — alerts for uncaught exceptions only.

**Remediation table:**
- `OAuth 401` → log only
- `429 rate limit` → log + track cooldown
- `Memory OOM` → Telegram alert + recommend session reset
- `Channel disconnect` → log + track reconnect count
- `Uncaught exception` → Telegram alert

**Sample output:**
```
[2026-04-30T10:05:00] Scanned 847 log lines
[2026-04-30T10:05:00] No new error patterns detected
[2026-04-30T10:05:00] 429 cooldown still active: anthropic (12m remaining)
```

---

### `config-drift-detector.js`

**Purpose:** Compute a SHA-256 hash of `openclaw.json` and alert when it changes unexpectedly. Guards against unauthorized or accidental config mutations.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `OPENCLAW_DIR` | `~/.openclaw` | No |
| `ALERT_TELEGRAM_CHAT_ID` | — | No |
| `TELEGRAM_BOT_TOKEN` | — | No |

**Outputs:** Telegram alert when hash mismatch detected. State written to `.drift-detector-state.json` containing the last known-good hash.

**Schedule:** `0 13 * * *` (daily at 1pm UTC)

**Side effects:** None beyond state file update after a hash reset.

**Reset baseline after intentional change:**
```bash
node config-drift-detector.js --reset-baseline
```

**Sample output:**
```
[2026-04-30T13:00:01] Baseline hash: a3f2e1...
[2026-04-30T13:00:01] Current hash:  a3f2e1...
[2026-04-30T13:00:01] Config: NO DRIFT detected
```

---

### `pipeline-health-check.js`

**Purpose:** Probe the Paperclip API for health, detect per-agent cost anomalies, and flag tasks that are stuck in-progress beyond a threshold.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `PAPERCLIP_URL` | `http://localhost:3110` | No |
| `OPENCLAW_COMPANY_ID` | — | Yes |
| `ALERT_TELEGRAM_CHAT_ID` | — | No |
| `TELEGRAM_BOT_TOKEN` | — | No |

**Outputs:** Telegram alert for cost anomalies (>2x 7-day average per agent) or Paperclip API failures. stdout report.

**Schedule:** `*/15 * * * *` (every 15 minutes)

**Side effects:** None (read-only Paperclip queries).

**Sample output:**
```
[2026-04-30T14:00:00] Paperclip API: OK (23ms)
[2026-04-30T14:00:00] Active tasks: 4 (2 assigned, 2 unassigned)
[2026-04-30T14:00:00] Cost anomaly: oracle agent $0.42 today vs $0.18 avg — ALERT sent
```

---

### `input-sanitizer.js`

**Purpose:** 17-pattern prompt injection detector for channel-facing agents. Blocks or flags malicious input patterns before they reach the agent context.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `OPENCLAW_COMPANY_ID` | — | Yes |

**Outputs:** Flags or blocks messages matching known injection patterns. Logs blocked attempts to stdout.

**Schedule:** On-demand (called inline from channel event handlers, or wired as middleware).

**Side effects:** May suppress message delivery to agent.

**Detected patterns (sample):** `ignore previous instructions`, `system prompt override`, `act as DAN`, `disregard your training`, and 13 more.

**Sample output:**
```
[BLOCKED] Message from user:1234 matched pattern: "ignore previous instructions"
[BLOCKED] Pattern: prompt_injection_01, score: 0.97
```

---

### `clawd-healthcheck.sh`

**Purpose:** Unified 9-in-1 health monitor. Checks gateway connectivity, PM2 process count, disk space, proxy watchdog, port availability, and scans recent logs for error spikes.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |
| `DISCORD_COMMS_LOG` | — | No (alerts skipped if unset) |
| `TELEGRAM_CHAT_ID` | — | No |
| `PM2_MIN_EXPECTED` | `15` | No |

**Outputs:** Appends to `$CLAWD_DIR/logs/healthcheck.log`. Discord/Telegram alert if issues found. Writes alert summary to `/tmp/clawd-health-alerts`.

**Schedule:** `*/15 * * * *` (every 15 minutes via crontab, not PM2)

**Side effects:** May call `pm2 restart` on services in the `SAFE_RESTART` list.

**Sample output:**
```
[2026-04-30T09:00:01] Gateway: OK (18789 responding)
[2026-04-30T09:00:01] PM2 online: 17/15 expected — OK
[2026-04-30T09:00:01] Disk: 42% used — OK
[2026-04-30T09:00:01] Errors last 15min: 2 (below threshold)
```

---

### `doctor-quick.sh`

**Purpose:** 15-point rapid diagnostic probe. Lighter than `clawd-healthcheck.sh` — designed for manual spot-checks and optional Discord alerting.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |
| `DISCORD_ALERT_WEBHOOK` | — | No (alert skipped if unset) |

**Outputs:** stdout report. Optional Discord webhook POST if issues found.

**Schedule:** On-demand, or `0 */6 * * *` (every 6 hours) if wired to PM2.

**Side effects:** None.

**Sample output:**
```
=== Quick Doctor 2026-04-30 09:15:00 ===
✓ Gateway :18789
✓ Paperclip :3100
✓ PM2: 17 online
✗ Ollama :11434 — not responding
ISSUES: 1 — webhook alert sent
```

---

### `drift-detect.sh`

**Purpose:** 6-type infrastructure drift detection. Checks: PM2 config vs running processes, Caddy routes vs expected, git working tree cleanliness, filesystem structure, port bindings, and service health state.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |
| `RESET_BASELINE` | — | No (set to `1` to regenerate baseline) |

**Outputs:** stdout drift report. Exits non-zero if drift detected.

**Schedule:** On-demand, or `0 6 * * *` (daily before morning brief).

**Side effects:** Writes baseline snapshot when `RESET_BASELINE=1`.

**Sample output:**
```
=== Drift Detection 2026-04-30 06:00:00 ===
PM2 config vs running: OK (17 match)
Git working tree: DRIFT — 2 uncommitted files
  M  workspaces/main/AGENTS.md
  ? shared/pending-rules/rule-2026-04-30.md
Caddy routes: OK
Ports: OK
```

---

## Cost Monitoring

### `cost-by-agent.py`

**Purpose:** Parse Claude Code session JSONL files and produce a per-agent, per-model token and cost breakdown.

**Inputs:**

| Env Var / Flag | Default | Required |
|---------|---------|---------|
| `--days N` | 1 | No |
| `--by-model` | off | No |
| `--format json\|text` | text | No |
| Session JSONL dir | `~/.claude/projects/` | No |

**Outputs:** stdout table or JSON. No files written, no API calls.

**Schedule:** On-demand, or called from `daily-cost-report.sh`.

**Side effects:** None.

**Sample output:**
```
Agent           Model            Tokens (in/out)     Cost
─────────────── ──────────────── ─────────────────   ──────
alfred          claude-sonnet    142K / 38K          $0.31
morpheus        claude-opus      89K / 22K           $0.58
neo             claude-sonnet    67K / 18K           $0.14
TOTAL                            298K / 78K          $1.03
```

---

### `daily-cost-report.sh`

**Purpose:** Generate yesterday's API spend report and send it to Telegram. Groups by model, shows top 3, total cost, token count, message count, and cache savings.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | — | Yes |
| `TELEGRAM_CHAT_ID` | — | Yes |
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** Telegram message. Appends to `$CLAWD_DIR/logs/daily-cost-report.log`.

**Schedule:** `0 8 * * *` (8am UTC daily — 9am BST, 4am EDT)

**Side effects:** None beyond log append.

**Sample Telegram message:**
```
📊 Yesterday's API Costs (2026-04-29)

• sonnet: $0.31 (47 msgs)
• opus: $0.58 (12 msgs)
• haiku: $0.04 (93 msgs)
─────────────────
Total: $0.93
Tokens: 376 000
Messages: 152
Cache Saved: $0.18
```

---

### `weekly-cost-summary.sh`

**Purpose:** 7-day cost rollup. Aggregates by day and model, highlights the most expensive day, and sends to Telegram.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | — | Yes |
| `TELEGRAM_CHAT_ID` | — | Yes |
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** Telegram message. Log append.

**Schedule:** `0 9 * * 1` (9am UTC every Monday)

**Side effects:** None.

---

## Autonomous Workflow

### `scout-agent.js`

**Purpose:** AI-driven signal scanner that creates its own work. Scans for: Polymarket odds shifts, stale Paperclip tasks (assigned >48h with no progress), down PM2 services, and workspace memory files with unprocessed `[TASK]` tags.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `OPENCLAW_COMPANY_ID` | — | Yes |
| `PAPERCLIP_URL` | `http://localhost:3110` | No |
| `CLAWD_DIR` | `~/clawd` | No |
| `FLEET_OPS_PROJECT_ID` | — | No (tasks not created if unset) |
| `AGENT_ID_ORACLE` | — | No |
| `AGENT_ID_FORGE` | — | No |
| `AGENT_ID_LAMA` | — | No |

**Outputs:** Paperclip tasks for free fleet workers. State written to `.scout-state.json` (prevents duplicate task creation).

**Schedule:** `0 */4 * * *` (every 4 hours)

**Side effects:** Creates Paperclip tasks. Marks processed `[TASK]` tags in memory files.

**Sample output:**
```
[2026-04-30T08:00:00] Scanning for signals...
[2026-04-30T08:00:01] Found 2 stale tasks (>48h no progress)
[2026-04-30T08:00:01] Found 1 down PM2 service: competitive-monitor
[2026-04-30T08:00:02] Created 3 Paperclip tasks → fleet-ops project
[2026-04-30T08:00:02] Assigned: oracle (2), forge (1)
```

---

### `auto-dispatcher.js`

**Purpose:** Route unassigned Paperclip tasks to the best available free-tier agent. Implements optimistic concurrency, per-agent daily caps, and label-based routing rules.

**Inputs:**

| Env Var / Flag | Default | Required |
|---------|---------|---------|
| `OPENCLAW_COMPANY_ID` | — | Yes |
| `PAPERCLIP_URL` | `http://localhost:3110` | No |
| `--dry-run` | off | No |

**Outputs:** Paperclip task assignments (PATCH `assigneeAgentId`). State written to `dispatch-state.json`.

**Schedule:** `*/30 * * * *` (every 30 minutes)

**Side effects:** Modifies Paperclip task `assigneeAgentId`. Respects Codex 4.5h/day cap.

**Sample output (dry-run):**
```
[DRY RUN] Would assign task cc-102 → oracle
[DRY RUN] Would assign task cc-103 → forge
[DRY RUN] Codex cap: 3.2/4.5h used today — 2 tasks eligible
```

---

### `free-fleet-optimizer.js`

**Purpose:** Probe Groq, Ollama, Cloudflare Workers AI, and HuggingFace for current availability and quota. Build a ranked dispatch priority list.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `OLLAMA_URL` | `http://localhost:11434` | No |
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** JSON file `.free-fleet-state.json` with ranked provider list and last probe time.

**Schedule:** `0 */2 * * *` (every 2 hours)

**Side effects:** None beyond state file write.

**Sample output:**
```
[2026-04-30T10:00:00] Probing 4 providers...
Rank 1: groq       — OK   (487K tokens/day remaining)
Rank 2: ollama     — OK   (local, unlimited)
Rank 3: cloudflare — OK   (8.2K neurons remaining)
Rank 4: huggingface — SLOW (>3s response, deprioritized)
```

---

### `competitive-monitor.js`

**Purpose:** Weekly scrape of competitor pricing pages and feature lists with change detection. Posts a diff report when changes are found.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `MONITOR_USER_AGENT` | `OpenClaw-Monitor/1.0` | No |
| `ALERT_TELEGRAM_CHAT_ID` | — | No |
| `TELEGRAM_BOT_TOKEN` | — | No |

**Outputs:** Change diff report to Telegram if changes detected. State written with last-seen content hashes.

**Schedule:** `0 14 * * 1` (2pm UTC every Monday)

**Side effects:** HTTP GET requests to public competitor URLs.

---

### `revenue-task-generator.js`

**Purpose:** Identify revenue opportunity signals from logs, Paperclip activity, and workspace state. Creates prioritized Paperclip tasks for revenue-related work.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `OPENCLAW_COMPANY_ID` | — | Yes |
| `PAPERCLIP_URL` | `http://localhost:3110` | No |
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** Paperclip tasks tagged `revenue`.

**Schedule:** `0 12 * * *` (noon UTC daily)

**Side effects:** Creates Paperclip tasks.

---

### `content-flywheel.js`

**Purpose:** Auto-generate content brief files for free fleet execution based on brand config. Each brief specifies topic, audience, format, and distribution channel.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `BRAND_NAME` | `MyBrand` | No |
| `BRAND_AUDIENCE` | `customers and prospects` | No |
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** Brief files written to `$CLAWD_DIR/output/content/`.

**Schedule:** `0 9 * * 1` (9am UTC every Monday) or on-demand.

**Side effects:** Writes brief files to disk.

---

## Memory & Learning

### `correction-propagator.js`

**Purpose:** Scan all workspace memory files for `[CORRECTION]` tags. Group similar corrections by content. When the same correction appears 3+ times, generate a proposed CLAUDE.md rule and write it to `shared/pending-rules/` for review.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** Proposed rule files in `$CLAWD_DIR/shared/pending-rules/`. State written to `.correction-propagator-state.json`.

**Schedule:** `0 12 * * *` (noon UTC daily, after overnight memory consolidation)

**Side effects:** Writes proposal files — does NOT modify CLAUDE.md directly. Rules require human/Morpheus review.

**Sample output:**
```
[2026-04-30T12:00:00] Scanned 14 workspace memory dirs
[2026-04-30T12:00:00] Found 23 [CORRECTION] entries
[2026-04-30T12:00:00] 2 new rule proposals generated:
  → shared/pending-rules/rule-2026-04-30-no-delete.md
  → shared/pending-rules/rule-2026-04-30-verify-first.md
```

---

### `memory-promote.sh`

**Purpose:** Scan daily memory files for entries tagged for promotion (`[PROMOTE]`, `[LONG-TERM]`, `[KEEP]`) and append them to the workspace's `MEMORY.md`.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** Appends promoted entries to each workspace's `MEMORY.md`. Marks promoted entries in source files.

**Schedule:** `0 6 * * *` (6am UTC daily)

**Side effects:** Modifies `MEMORY.md` files and daily memory files.

---

### `skill-effectiveness.js`

**Purpose:** Track skill invocation count, success rate, average cost, and duration from OpenClaw session logs. Identify underperforming or redundant skills.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |
| `OPENCLAW_AGENTS_DIR` | `~/.openclaw/agents` | No |

**Outputs:** stdout report. State written to `.skill-effectiveness-state.json`.

**Schedule:** `0 13 * * 1` (1pm UTC every Monday)

**Side effects:** None.

**Sample output:**
```
Skill                  Invocations   Avg Duration   Success%   Est Cost
────────────────────── ───────────   ────────────   ────────   ────────
spec-interviewer       12            4m 22s         92%        $0.08
review                 28            2m 11s         97%        $0.04
systematic-debugging   5             8m 47s         80%        $0.14
```

---

### `workspace-convention-check.js`

**Purpose:** Verify that every workspace directory under `workspaces/` contains the required standard files: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `USER.md`.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** stdout report listing missing files per workspace.

**Schedule:** `0 14 * * 0` (2pm UTC every Sunday)

**Side effects:** None.

**Sample output:**
```
workspace: main       ✓ all required files present
workspace: trading    ✓ all required files present
workspace: cleo       ✗ missing: SOUL.md, HEARTBEAT.md
```

---

### `self-improve.js`

**Purpose:** Review automation quality across all scripts. Detect silent failures (scripts that ran but produced no output), compare expected vs actual cadence, and propose improvements.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** Improvement proposal file in `shared/pending-rules/`. stdout report.

**Schedule:** `0 15 * * 0` (3pm UTC every Sunday)

**Side effects:** Writes proposal file.

---

### `dreaming.sh`

**Purpose:** Overnight self-reflection pipeline. Summarizes the week's agent activity, surfaces recurring patterns, and writes structured reflection output to workspace memory.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |
| `OPENCLAW_COMPANY_ID` | — | Yes |

**Outputs:** Reflection summaries written to workspace memory directories. Paperclip tasks for any action items identified.

**Schedule:** `0 3 * * 0` (3am UTC every Sunday — overnight before Monday brief)

**Side effects:** Writes memory files, may create Paperclip tasks.

---

## Backup & Integrity

### `backup-verify.js`

**Purpose:** Verify that the most recent backup tarball exists, is within expected size bounds (not >20% smaller than 7-day average), and contains required key files.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `BACKUP_DIR` | `~/backups` | No |
| `CLAWD_DIR` | `~/clawd` | No |
| `ALERT_TELEGRAM_CHAT_ID` | — | No |
| `TELEGRAM_BOT_TOKEN` | — | No |

**Outputs:** Telegram alert on failure. State written to `.backup-verify-state.json` (7-day size history).

**Schedule:** `30 12 * * *` (12:30 UTC daily — after `clawd-full-backup.sh` runs at midnight)

**Side effects:** None.

**Sample output:**
```
[2026-04-30T12:30:00] Checking backup: clawd-2026-04-30.tar.gz
[2026-04-30T12:30:00] Size: 1.8GB (7-day avg: 1.7GB) — OK
[2026-04-30T12:30:00] Key files: openclaw.json ✓  MEMORY.md ✓  lcm.db ✓
[2026-04-30T12:30:00] Backup verification: PASS
```

---

## Infrastructure

### `morning-brief.js`

**Purpose:** Aggregate overnight signals — health anomalies, new tasks, cost deltas, correction proposals — into a single consolidated brief delivered at 9am.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `OPENCLAW_COMPANY_ID` | — | Yes |
| `PAPERCLIP_URL` | `http://localhost:3110` | No |
| `CLAWD_DIR` | `~/clawd` | No |
| `ALERT_TELEGRAM_CHAT_ID` | — | No |
| `TELEGRAM_BOT_TOKEN` | — | No |

**Outputs:** Telegram message with overnight summary. Brief file written to `shared/daily-brief/YYYY-MM-DD.md`.

**Schedule:** `0 14 * * *` (2pm UTC = 9am EST)

**Side effects:** Writes daily brief file.

---

### `openclaw-doctor-cron.js`

**Purpose:** Run `openclaw doctor` on a schedule and surface any config issues without requiring manual intervention. Alerts if doctor reports critical findings.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `ALERT_TELEGRAM_CHAT_ID` | — | No |
| `TELEGRAM_BOT_TOKEN` | — | No |

**Outputs:** Doctor output logged to stdout. Telegram alert if `CRITICAL` findings present.

**Schedule:** `0 15,23 * * *` (3pm and 11pm UTC)

**Side effects:** None (read-only doctor probe).

---

### `pre-compact-flush.js`

**Purpose:** Save critical session context to a snapshot file immediately before a Claude Code session compaction event. Ensures context survives compaction.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |

**Outputs:** Snapshot file written to `~/.claude/sessions/pre-compact-<timestamp>.json`.

**Schedule:** On-demand (triggered by Claude Code `PreCompact` hook).

**Side effects:** Writes snapshot file.

---

### `file-feed.js`

**Purpose:** Watch workspace files for changes and feed updates to agent memory via the OpenClaw memory API. Keeps agent context current with file state changes.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `OPENCLAW_COMPANY_ID` | — | Yes |
| `CLAWD_DIR` | `~/clawd` | No |
| `FILES_BASE_URL` | `http://localhost:8080` | No |

**Outputs:** OpenClaw memory API calls. Log entries.

**Schedule:** Continuous (filesystem watcher) or on-demand.

**Side effects:** Writes to OpenClaw agent memory.

---

### `pm2-caddy-sync.sh`

**Purpose:** Reconcile PM2 running services against Caddy reverse proxy routes. Disable Caddy routes for stopped services; alert on routes with no matching PM2 process.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |
| `DISCORD_ALERT_WEBHOOK` | — | No |

**Outputs:** Caddyfile modifications (disabled routes commented out). Discord alert for unmatched routes. Log entries.

**Schedule:** `*/30 * * * *` (every 30 minutes)

**Side effects:** May modify the Caddyfile and reload Caddy.

---

### `llm-fleet-audit.sh`

**Purpose:** Bi-weekly provider health audit and model freshness check. Verifies all configured LLM providers are reachable, compares configured models against latest available, and flags outdated model aliases.

**Inputs:**

| Env Var | Default | Required |
|---------|---------|---------|
| `CLAWD_DIR` | `~/clawd` | No |
| `OPENCLAW_DIR` | `~/.openclaw` | No |

**Outputs:** stdout report. Log file append. No alerts (informational only).

**Schedule:** `0 10 * * 1,4` (10am UTC every Monday and Thursday)

**Side effects:** None.

**Sample output:**
```
=== LLM Fleet Audit 2026-04-30 ===
anthropic   ✓  claude-sonnet-4-6 (current)
google      ✓  gemini-2.5-pro (current)
groq        ✓  llama-4-scout-17b (current)
mistral     ✓  codestral-latest (current)
ollama      ✓  3 local models available
cloudflare  ✓  workers-ai OK
```
