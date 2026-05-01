# OpenClaw Automation

**Self-healing, self-learning automation scripts for OpenClaw multi-agent fleets.**

Built by [Kevin Zicherman](https://kevinz.ai) to run a 38-agent AI operations system on a Mac Mini M4 — autonomously, 24/7, at near-zero cost.

---

## What This Is

A collection of production-tested scripts that add a self-management layer to your [OpenClaw](https://openclaw.ai) fleet. These scripts close operational loops that OpenClaw leaves open: silent agent detection, config drift guarding, automatic error recovery, cost anomaly alerts, and fleet-wide learning from corrections.

Copy the scripts you need. Wire them to PM2 or cron. Set env vars. That's it.

```
SCOUT (4h) → finds work → DISPATCH (30min) → free fleet ($0)
    ↓                                              ↓
REPORT (9am) ← IMPROVE (weekly) ← LEARN (daily) ← HEAL (5min)
```

---

## Quick Start

```bash
git clone https://github.com/KevinZai/openclaw-automation
cd openclaw-automation
cp .env.example .env
# Edit .env — set OPENCLAW_COMPANY_ID at minimum
npm install   # or: scripts are standalone, just needs node 20+

# Wire to PM2 (recommended):
cp ecosystem.config.example.cjs ecosystem.config.cjs
pm2 start ecosystem.config.cjs
pm2 save
```

Minimum required env var: `OPENCLAW_COMPANY_ID`. Everything else defaults sensibly.

---

## Script Catalog

### Real-Time Health (every 5–15 min)

| Script | What It Does | Agent Platform | Tier |
|--------|-------------|----------------|------|
| `agent-heartbeat-monitor.js` | Detect silent agents; auto-restart after 3 misses | OpenClaw | 1 |
| `self-heal.js` | Scan gateway logs for 429s, OOMs, crashes — auto-remediate | OpenClaw | 1 |
| `config-drift-detector.js` | SHA256 hash on openclaw.json — detect unauthorized changes | OpenClaw | 1 |
| `pipeline-health-check.js` | Paperclip API health + per-agent cost anomaly detection | Paperclip | 1 |
| `input-sanitizer.js` | 17-pattern prompt injection detector for channel-facing agents | OpenClaw | 1 |

### Daily Operations

| Script | What It Does | Agent Platform | Tier |
|--------|-------------|----------------|------|
| `morning-brief.js` | Consolidated overnight report — one file, zero surprises | OpenClaw | 1 |
| `correction-propagator.js` | Scan `[CORRECTION]` tags → auto-propose CLAUDE.md rules | OpenClaw | 1 |
| `backup-verify.js` | Verify backup integrity, size trends, key files present | Any | 2 |
| `openclaw-doctor-cron.js` | Automated `openclaw doctor` 2x/day | OpenClaw | 2 |
| `pre-compact-flush.js` | Save critical context before session compaction | OpenClaw | 2 |
| `file-feed.js` | Watch workspace files; feed changes to agent memory | OpenClaw | 2 |
| `memory-promote.sh` | Auto-promote tagged memory entries to MEMORY.md | OpenClaw | 2 |

### Autonomous Intelligence

| Script | What It Does | Agent Platform | Tier |
|--------|-------------|----------------|------|
| `scout-agent.js` | **AI that finds its own work** — scans stale tasks, down services, unprocessed memory tags | Paperclip | 1 |
| `free-fleet-optimizer.js` | Probe Groq/Ollama/Cerebras/CF/HF for capacity; build ranked dispatch list | Multi-provider | 1 |
| `competitive-monitor.js` | Weekly competitor pricing/feature scrape with change detection | Free fleet | 2 |
| `auto-dispatcher.js` | Route tasks to the best available free-tier agent | Paperclip | 2 |

### Weekly Strategic

| Script | What It Does | Agent Platform | Tier |
|--------|-------------|----------------|------|
| `self-improve.js` | Review automation quality; detect silent failures; propose improvements | OpenClaw | 1 |
| `skill-effectiveness.js` | Track skill invocation count, success rate, cost, duration | OpenClaw | 2 |
| `workspace-convention-check.js` | Verify all workspaces have required files (AGENTS.md, SOUL.md, etc.) | OpenClaw | 2 |
| `content-flywheel.js` | Auto-generate content briefs for free fleet execution | Free fleet | 3 |

### Security & Reliability

| Script | What It Does | Agent Platform | Tier |
|--------|-------------|----------------|------|
| `input-sanitizer.js` | Prompt injection detector (17 patterns) | OpenClaw | 1 |
| `pre-compact-flush.js` | Save session context before compaction | OpenClaw | 2 |

**Tier key:** 1 = broad community value · 2 = medium value · 3 = specialized/niche

---

## Free Fleet Strategy

These scripts are designed to route work to zero-cost providers first:

| Provider | Free Capacity | Best For |
|----------|--------------|---------|
| Cerebras | 1M tokens/day | Fast inference, summaries |
| Groq | 500K tokens/day | Reasoning, analysis |
| Cloudflare Workers AI | 10K neurons/day | Edge-latency tasks |
| Ollama (local) | Unlimited | Private data, bulk ops |
| HuggingFace | 1K requests/day | Specialized models |

`free-fleet-optimizer.js` probes these providers and ranks them by current availability before dispatch.

---

## Contributing

Scripts must:
- Use env vars for all paths, UUIDs, and secrets (see `.env.example`)
- Work with `node 20+` (no transpilation required for JS scripts)
- Include a JSDoc header with `@description`, `@version`, and cron schedule
- Pass `node --check` (JS) or `bash -n` (shell)

Open a PR. No issue required for straightforward additions.

---

## License

MIT — [Kevin Zicherman](https://kevinz.ai)

Attribution appreciated but not required. If this saves you hours of ops work, a star is enough.
