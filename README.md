# OpenClaw Automation

**Self-healing, self-learning automation scripts for OpenClaw multi-agent fleets.**

Built by [Kevin Zicherman](https://kevinz.ai) to run a 38-agent AI operations system on a Mac Mini M4 — autonomously, 24/7, at near-zero cost.

---

## What This Does

Your OpenClaw fleet runs dozens of agents across Discord, Slack, Telegram, WhatsApp, and web. These scripts make it **self-managing**:

```
SCOUT (4h) → finds work → DISPATCH (30min) → free fleet ($0)
    ↓                                              ↓
REPORT (9am) ← IMPROVE (weekly) ← LEARN (daily) ← HEAL (5min)
```

**Self-Healing** — Detects silent agents, gateway errors, and stuck sessions. Auto-restarts what it can, alerts you for what it can't.

**Self-Learning** — Scans agent memory for repeated corrections and auto-proposes rules. Tracks skill effectiveness. Promotes durable knowledge to long-term memory.

**Revenue Generation** — Auto-creates tasks for free-tier AI workers (Groq, Ollama, Cerebras, Cloudflare). Content creation, lead research, SEO, competitive intel — all at $0.

**Self-Improvement** — Weekly reviews its own automation quality. Detects silent failures, proposes fixes, flags degrading skills.

---

## Scripts

### Real-Time Health (every 5–10 min)
| Script | What It Does |
|--------|-------------|
| `agent-heartbeat-monitor.js` | Detect silent agents, auto-restart after 3 consecutive misses |
| `self-heal.js` | Scan gateway logs for 429s, OOMs, crashes — auto-remediate |

### Daily Operations
| Script | What It Does |
|--------|-------------|
| `morning-brief.js` | Consolidated overnight report — one file, zero surprises |
| `correction-propagator.js` | Scan `[CORRECTION]` tags → auto-propose CLAUDE.md rules |
| `config-drift-detector.js` | SHA256 hash monitor on openclaw.json — detect unauthorized changes |
| `backup-verify.js` | Verify backup integrity, size trends, key files present |
| `openclaw-doctor-cron.js` | Automated `openclaw doctor` 2x/day |
| `revenue-task-generator.js` | Auto-create daily tasks for free fleet workers |
| `pipeline-health-check.js` | Paperclip API health + per-agent cost anomaly detection |

### Autonomous Intelligence
| Script | What It Does |
|--------|-------------|
| `scout-agent.js` | **AI that finds its own work** — scans for stale tasks, down services, unprocessed memory tags, critical errors. Creates Paperclip tasks automatically. |
| `competitive-monitor.js` | Weekly competitor pricing/feature scrape with change detection |
| `free-fleet-optimizer.js` | Probe free API providers (Groq, Ollama, Cerebras, CF, HF) for capacity |

### Weekly Strategic
| Script | What It Does |
|--------|-------------|
| `self-improve.js` | Review automation quality, detect silent failures, propose improvements |
| `skill-effectiveness.js` | Track skill invocation count, success rate, cost, duration |
| `workspace-convention-check.js` | Verify all workspaces have required files |
| `memory-promote.sh` | Auto-promote tagged memory entries to MEMORY.md |

### Security
| Script | What It Does |
|--------|-------------|
| `input-sanitizer.js` | 17-pattern prompt injection detector for channel-facing agents |
| `pre-compact-flush.js` | Save critical context before session compaction |

---

## Free Fleet Strategy

Route research, content, and cron work to zero-cost providers:

| Provider | Daily Free Capacity | Speed |
|----------|-------------------|-------|
| Cerebras | 1M tokens | Fastest (20x NVIDIA) |
| Groq | 500K tokens | Very fast |
| Cloudflare Workers AI | 10K neurons | Fast (edge) |
| HuggingFace | 1K requests | Variable |
| Ollama (local) | Unlimited | Local inference |

The `revenue-task-generator.js` creates daily tasks for these workers:
- **Monday:** Blog posts + social media content
- **Tuesday:** Lead research
- **Wednesday:** SEO + competitive intelligence
- **Thursday:** Market analysis
- **Friday:** Optimization + housekeeping
- **Sunday:** Weekly reviews

All at $0.

---

## Quick Start

```bash
# Clone
git clone https://github.com/KevinZai/openclaw-automation
cd openclaw-automation

# Configure environment
export BRIEF_DIR=./shared/daily-brief
export WORKSPACES_DIR=./workspaces
export AGENTS_DIR=~/.openclaw/agents
export OPENCLAW_CONFIG=~/.openclaw/openclaw.json

# Start all scripts via PM2
cp ecosystem.config.example.cjs ecosystem.config.cjs
pm2 start ecosystem.config.cjs

# Or start individual scripts
node morning-brief.js
node scout-agent.js
```

### Environment Variables

All scripts use environment variables with sensible defaults:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BRIEF_DIR` | `./shared/daily-brief` | Where reports are written |
| `WORKSPACES_DIR` | `./workspaces` | OpenClaw workspace root |
| `AGENTS_DIR` | `~/.openclaw/agents` | Agent session directory |
| `OPENCLAW_CONFIG` | `~/.openclaw/openclaw.json` | OpenClaw config file |
| `BACKUP_DIR` | `~/backups` | Backup directory |
| `TELEGRAM_BOT_TOKEN` | — | For alert notifications |
| `TELEGRAM_CHAT_ID` | — | Alert destination |
| `PAPERCLIP_COMPANY_ID` | — | Paperclip task management |

---

## Requirements

- Node.js 18+
- PM2 process manager
- OpenClaw platform (gateway)
- Optional: Paperclip for task management, Telegram for alerts

---

## The Story Behind This

I run 38 AI agents across 10 workspaces handling personal assistance, trading, a SaaS business, wealth management, and family coordination. The agents were smart but the infrastructure had no immune system.

In one overnight coding session, I built the complete autonomous loop: agents that heal themselves, learn from corrections, find their own work, generate revenue at $0, and improve weekly without human intervention.

Full write-up: [Building a Self-Healing AI Operations System](https://kevinz.ai) *(coming soon)*

---

## Also From KevinZai

- **[ClaudeSwap](https://github.com/KevinZai/claudeswap)** — Smart load balancer for multiple Claude MAX subscriptions. Drain-first strategy, zero dependencies.

---

## License

MIT — Kevin Zicherman ([kevinz.ai](https://kevinz.ai))
