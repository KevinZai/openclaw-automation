# OpenClaw Automation Scripts

**Author:** Kevin Zicherman ([kevinz.ai](https://kevinz.ai))
**License:** MIT
**Platform:** OpenClaw v2026.3.28+ on Mac Mini M4

A collection of automation scripts that form a self-healing, self-learning, self-improving AI operations system for multi-agent fleets.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AUTONOMOUS LOOP                       │
│                                                         │
│  HEAL ──→ MONITOR ──→ LEARN ──→ GENERATE ──→ IMPROVE   │
│   ↑                                              │      │
│   └──────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

## Scripts

### Real-Time Health (every 5-10 min)
| Script | Purpose |
|--------|---------|
| `agent-heartbeat-monitor.js` | Detect silent agents, auto-restart after 3 misses |
| `self-heal.js` | Scan gateway logs for errors, auto-remediate |

### Daily Operations
| Script | Purpose |
|--------|---------|
| `correction-propagator.js` | Scan [CORRECTION] tags → generate rule proposals |
| `backup-verify.js` | Verify backup integrity, size, key files |
| `config-drift-detector.js` | SHA256 hash monitoring of config file |
| `morning-brief.js` | Consolidated overnight activity report |
| `openclaw-doctor-cron.js` | Automated `openclaw doctor` 2x/day |
| `revenue-task-generator.js` | Auto-create tasks for free fleet workers |
| `pipeline-health-check.js` | API health + per-agent cost anomaly detection |

### Weekly Strategic
| Script | Purpose |
|--------|---------|
| `skill-effectiveness.js` | Skill invocation and success rate tracking |
| `competitive-monitor.js` | Competitor pricing/feature change detection |
| `workspace-convention-check.js` | Required files audit across workspaces |
| `memory-promote.sh` | Auto-promote tagged memory entries to MEMORY.md |
| `self-improve.js` | Review automation quality, propose improvements |
| `free-fleet-optimizer.js` | Probe free API providers for capacity |

### Pipeline Automation
| Script | Purpose |
|--------|---------|
| `auto-dispatcher.js` | Route unassigned Paperclip tasks to free fleet |
| `agent-resource-query.js` | Query domain agents for proposals 2x/day |
| `dormant-file-guard.js` | Detect stale files, prevent bloat |

## Free Fleet Strategy

Four zero-cost AI workers handle research, content, and analysis:
- **Forge** (HuggingFace) — content generation
- **Flare** (Cloudflare Workers AI) — fast inference
- **Lama** (Ollama local) — unlimited local inference
- **Oracle** (Groq) — high-speed inference

The `revenue-task-generator.js` creates daily tasks for these workers:
- Monday: Content creation (blog posts, social media)
- Tuesday: Lead research
- Wednesday: SEO + competitive intelligence
- Thursday: Market analysis
- Friday: Optimization + housekeeping
- Sunday: Weekly reviews

## Requirements

- Node.js 20+
- PM2 process manager
- OpenClaw platform (gateway on port 18789)
- Paperclip task management (port 3110)
- Optional: Telegram bot for alerts

## Installation

```bash
# Clone and install
git clone https://github.com/kevinz-ai/openclaw-automation
cd openclaw-automation

# Start all scripts via PM2
pm2 start ecosystem.config.cjs

# Or start individual scripts
pm2 start ecosystem.config.cjs --only morning-brief
```

## Configuration

All scripts use state files (`.{name}-state.json`) for persistence between runs. Reports output to `shared/daily-brief/`.

Environment variables:
- `TELEGRAM_BOT_TOKEN` — For alert notifications
- `TELEGRAM_CHAT_ID` — Alert destination
- `GROQ_API_KEY` — For Oracle (free fleet)
- `HF_TOKEN` — For Forge (free fleet)
- `CF_WORKERS_AI_TOKEN` — For Flare (free fleet)
