# Architecture

## Overview

openclaw-automation is a collection of standalone scripts that add a self-management layer to an [OpenClaw](https://openclaw.ai) multi-agent fleet. Each script closes one operational loop — silent agent detection, config drift guarding, cost anomaly alerting, error recovery, or fleet-wide learning — that OpenClaw itself leaves open. Scripts are independent: copy the ones you need, wire them to PM2 or cron, set env vars. There is no shared application state, no database beyond optional JSON state files, and no build step.

---

## Operational Flow

```
SCOUT (every 4h) → DISPATCH (every 30min) → FREE FLEET ($0 workers)
     ↓                                              ↓
 REPORT (9am)  ←  IMPROVE (weekly)  ←  LEARN (daily)  ←  HEAL (every 5min)
```

### SCOUT
`scout-agent.js` runs on a 4-hour cadence and scans for actionable signals: stale Paperclip tasks (assigned but no activity for 48+ hours), PM2 services that should be running but are not, and workspace memory files with unprocessed `[TASK]` tags. When signals are found, it creates new Paperclip issues and assigns them to available free-fleet workers. This is the "AI finds its own work" pattern — no human triage required for common operational noise.

### DISPATCH
`auto-dispatcher.js` runs every 30 minutes and routes unassigned Paperclip tasks to the best available free-tier agent based on task labels. It implements optimistic concurrency (only assigns if `assigneeAgentId` is still null), respects per-agent daily caps (e.g., 4.5 hours/day for Codex), and writes dispatch state to `dispatch-state.json` so reruns are idempotent.

### FREE FLEET
Tasks dispatched by the system run on zero-cost providers: Groq (Oracle), Ollama (Lama), Cloudflare Workers AI (Flare), and HuggingFace Inference (Forge). `free-fleet-optimizer.js` probes these providers every 2 hours and ranks them by current availability, building a priority list consumed by the dispatcher.

### REPORT
`morning-brief.js` aggregates overnight signals — health anomalies, new Paperclip tasks, cost deltas, correction propagation — into a single consolidated report delivered at 9am UTC. The goal is zero unread alerts by 9am; everything is digested into one message.

### LEARN
`correction-propagator.js` runs daily and scans workspace memory files for `[CORRECTION]` tags written by agents during their sessions. When corrections are found, it auto-proposes CLAUDE.md rule additions that would prevent the same mistake from recurring. This closes the feedback loop from operational experience back into agent configuration.

### HEAL
`self-heal.js` runs every 5 minutes and scans gateway logs for high-frequency error patterns: HTTP 429s (rate limits), out-of-memory crashes, and repeated connection failures. When a recoverable pattern is detected, it takes automated remediation action (e.g., PM2 restart for safe services) and posts an alert to Discord or Telegram.

---

## Components

| Script | Role | Depends On | Feeds Into |
|--------|------|-----------|------------|
| `agent-heartbeat-monitor.js` | Detect silent agents; restart after 3 missed heartbeats | OpenClaw API `:18789` | Discord/Telegram alert |
| `self-heal.js` | Parse gateway logs; auto-remediate 429s, OOMs, crashes | PM2, gateway logs | Discord/Telegram alert |
| `config-drift-detector.js` | SHA-256 hash of openclaw.json; alert on unauthorized changes | `~/.openclaw/openclaw.json` | Discord/Telegram alert |
| `pipeline-health-check.js` | Paperclip API health + per-agent cost anomaly detection | Paperclip API `:3100` | Discord/Telegram alert |
| `input-sanitizer.js` | 17-pattern prompt injection detector for channel-facing agents | OpenClaw channel events | Blocks/flags malicious input |
| `scout-agent.js` | Scan signals; create Paperclip tasks for free fleet | Paperclip API, filesystem | Paperclip tasks → dispatcher |
| `auto-dispatcher.js` | Route unassigned tasks to best free-tier agent | Paperclip API | Agent wake-up via Paperclip |
| `free-fleet-optimizer.js` | Probe Groq/Ollama/CF/HF for capacity | Provider health endpoints | `dispatch-priority.json` |
| `morning-brief.js` | Overnight digest → single alert | Logs, Paperclip, cost data | Telegram/Discord message |
| `correction-propagator.js` | Scan `[CORRECTION]` tags → propose CLAUDE.md rules | Workspace memory files | CLAUDE.md draft additions |
| `self-improve.js` | Review automation quality; detect silent failures | PM2 logs, state files | Improvement task proposals |
| `skill-effectiveness.js` | Track skill invocation count, success rate, cost | OpenClaw session logs | Weekly report |
| `daily-cost-report.sh` | Yesterday's API spend → Telegram | `~/.claude/projects/` JSONL | Telegram message |
| `weekly-cost-summary.sh` | 7-day cost rollup | `~/.claude/projects/` JSONL | Telegram message |
| `cost-by-agent.py` | Per-agent token + cost breakdown | Session JSONL files | stdout / file |
| `clawd-healthcheck.sh` | 9-in-1 unified health monitor | PM2, ports, disk, gateway | Log file + alerts |
| `doctor-quick.sh` | 15-point probe with optional Discord alert | PM2, ports, gateway | Discord webhook |
| `drift-detect.sh` | 6-type infrastructure drift detection | Filesystem, PM2, git | stdout alert |
| `llm-fleet-audit.sh` | Provider health + model freshness check | Provider APIs | stdout report |
| `backup-verify.js` | Verify backup integrity, size trends, key files | Backup directory | Telegram/Discord alert |
| `workspace-convention-check.js` | Verify required files per workspace | `workspaces/` directory | stdout report |
| `pre-compact-flush.js` | Save critical context before session compaction | OpenClaw session state | Session snapshot file |
| `file-feed.js` | Watch workspace files; feed changes to agent memory | Filesystem watcher | OpenClaw memory API |
| `memory-promote.sh` | Auto-promote tagged entries to MEMORY.md | Workspace memory files | `MEMORY.md` updates |
| `openclaw-doctor-cron.js` | Automated `openclaw doctor` twice daily | `openclaw` CLI | Log output + alerts |
| `competitive-monitor.js` | Weekly competitor pricing/feature scrape | HTTP (public URLs) | Change-detection report |
| `content-flywheel.js` | Auto-generate content briefs for free fleet | Brand config env vars | Content brief files |
| `revenue-task-generator.js` | Identify revenue opportunities from signals | Paperclip API, logs | Paperclip tasks |
| `dreaming.sh` | Overnight self-reflection pipeline | OpenClaw session logs | Memory + improvement files |
| `pm2-caddy-sync.sh` | Reconcile PM2 services with Caddy routes | PM2 API, Caddyfile | Caddyfile updates |

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  External Signals                                               │
│  (logs, filesystem, Paperclip API, provider health endpoints)   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │  Scout / Health │  ← agent-heartbeat, self-heal,
                    │  Monitors       │    config-drift, clawd-healthcheck
                    └───────┬────────┘
                            │ creates tasks / alerts
              ┌─────────────┼──────────────┐
              │             │              │
     ┌────────▼───┐  ┌──────▼──────┐  ┌───▼────────────┐
     │  Paperclip  │  │  Discord /  │  │  Log files /   │
     │  Tasks      │  │  Telegram   │  │  State JSON    │
     └────────┬───┘  └─────────────┘  └────────────────┘
              │
     ┌────────▼────────────┐
     │  auto-dispatcher.js  │  ← free-fleet-optimizer provides
     │  (every 30min)       │    ranked provider list
     └────────┬────────────┘
              │ assigns tasks via Paperclip PATCH
              │
     ┌────────▼─────────────────────────────┐
     │  Free Fleet Workers                   │
     │  Oracle (Groq) · Forge (HF)           │
     │  Lama (Ollama) · Flare (CF Workers)   │
     └────────┬─────────────────────────────┘
              │ writes results to memory files
              │
     ┌────────▼────────────┐
     │  correction-         │  ← scans [CORRECTION] tags
     │  propagator.js       │    proposes CLAUDE.md rules
     └────────┬────────────┘
              │
     ┌────────▼────────────┐
     │  morning-brief.js    │  ← aggregates everything → single daily digest
     └─────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Node.js 20+ | All `.js` scripts (ESM or CJS depending on script) |
| Shell | Bash + zsh | `.sh` scripts — health checks, cost reports, drift detection |
| Python | Python 3.9+ | `cost-by-agent.py` — session JSONL parsing |
| Process manager | PM2 | Cron scheduling, service lifecycle, log rotation |
| Cache / state | Redis (optional) | `cache-keepalive.sh` (cache warming); scripts do not depend on Redis unless explicitly using it |
| Secrets | 1Password CLI (`op`) | Never hardcoded; scripts read from env vars populated by `op run --` or pre-exported from vault |
| Alerting | Discord webhooks + Telegram Bot API | Outbound alerts; both optional, fall back gracefully if not set |
| Task tracking | Paperclip API (`localhost:3100`) | Issue creation and assignment for autonomous dispatch |
| LLM orchestration | OpenClaw gateway (`localhost:18789`) | Agent communication, heartbeat detection, memory writes |

---

## Design Principles

**Local-first.** All scripts run on the same machine as the OpenClaw gateway. No remote orchestration layer, no cloud functions. This keeps latency under 1ms for internal API calls and avoids egress costs.

**Free-fleet-first.** Work is always routed to zero-cost providers (Groq, Ollama, Cloudflare Workers AI, HuggingFace) before paid tiers. `free-fleet-optimizer.js` maintains a live ranked list. Paid models are used only as fallback when free capacity is exhausted.

**Atomic commits.** Each script writes to a single output (log, Telegram, state file, Paperclip task). No script writes to multiple outputs in a way that would leave partial state on crash. State files use JSON with a `lastRun` timestamp so reruns are safe.

**No global state.** Scripts share no in-memory state. Communication happens through files (`.scout-state.json`, `dispatch-state.json`) or the Paperclip API. Scripts can be restarted, reordered, or removed without affecting others.

**Env-var-driven.** Every path, UUID, token, and URL is an environment variable with a documented default. See `.env.example` for the full list. No hardcoded values in shipping code.

**Fail-fast.** Scripts validate required env vars at startup (`if (!COMPANY) throw new Error(...)`) and exit with a non-zero code on unrecoverable errors. PM2 `autorestart: false` ensures crash-looping cron scripts don't flood logs.
