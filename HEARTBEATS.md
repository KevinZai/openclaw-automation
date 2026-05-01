# Heartbeats: Cron Patterns + PM2 Snippets

Reference for scheduling automation scripts with PM2. Covers cron syntax, common patterns, cost-optimized model selection for heartbeat tasks, and working ecosystem config snippets.

---

## PM2 Cron Cheat Sheet

PM2 uses the standard 5-field cron format. `cron_restart` fires a restart at the scheduled time. Always pair with `autorestart: false` for scheduled tasks — otherwise PM2 restarts the script immediately after it exits, looping continuously.

```
┌──────── minute (0-59)
│ ┌────── hour (0-23, UTC)
│ │ ┌──── day of month (1-31)
│ │ │ ┌── month (1-12)
│ │ │ │ ┌ day of week (0-7, 0 and 7 both = Sunday)
│ │ │ │ │
* * * * *
```

**Key rules:**
- PM2 cron runs in **UTC**. Account for your local offset.
- PM2 does **not** support `@hourly`, `@daily`, `@weekly` shorthands — use explicit fields.
- `autorestart: false` is **mandatory** for cron scripts. `autorestart: true` will restart the script every time it exits, defeating the cron schedule.
- `cron_restart` triggers a PM2 restart, which re-runs the script from the top.

---

## Common Patterns

### Every 5 minutes

```javascript
{ cron_restart: '*/5 * * * *', autorestart: false }
```

Use for: `self-heal.js` (error pattern detection). Keep scripts under this cadence lightweight — they run 288 times/day.

### Every 10 minutes

```javascript
{ cron_restart: '*/10 * * * *', autorestart: false }
```

Use for: `agent-heartbeat-monitor.js`. Good balance of responsiveness vs resource usage for health checks.

### Every 15 minutes

```javascript
{ cron_restart: '*/15 * * * *', autorestart: false }
```

Use for: `pipeline-health-check.js`. Standard interval for API health probes.

### Every 30 minutes

```javascript
{ cron_restart: '*/30 * * * *', autorestart: false }
```

Use for: `auto-dispatcher.js`, `pm2-caddy-sync.sh`. Good for polling-based dispatch loops where sub-minute latency is not required.

### Every 2 hours

```javascript
{ cron_restart: '0 */2 * * *', autorestart: false }
```

Use for: `free-fleet-optimizer.js`. Provider capacity doesn't change faster than this in practice.

### Every 4 hours

```javascript
{ cron_restart: '0 */4 * * *', autorestart: false }
```

Use for: `scout-agent.js`. Enough granularity to catch overnight signals by morning.

### Daily at a fixed UTC hour

```javascript
{ cron_restart: '0 12 * * *', autorestart: false }  // noon UTC
{ cron_restart: '0 14 * * *', autorestart: false }  // 2pm UTC = 9am EST
{ cron_restart: '30 12 * * *', autorestart: false } // 12:30pm UTC
```

Use for: morning briefs, cost reports, backup verification, correction propagation.

**Timezone conversion cheat sheet:**

| Local time | Cron UTC (no DST) |
|-----------|-------------------|
| 6am EST   | `0 11 * * *`      |
| 9am EST   | `0 14 * * *`      |
| 12pm EST  | `0 17 * * *`      |
| 6am PST   | `0 14 * * *`      |
| 9am PST   | `0 17 * * *`      |
| 9am UTC   | `0 9 * * *`       |

### Weekly on Monday

```javascript
{ cron_restart: '0 9 * * 1', autorestart: false }   // Monday 9am UTC
{ cron_restart: '0 13 * * 1', autorestart: false }  // Monday 1pm UTC
```

Use for: `skill-effectiveness.js`, `weekly-cost-summary.sh`, `competitive-monitor.js`.

### Weekly on Sunday

```javascript
{ cron_restart: '0 14 * * 0', autorestart: false }  // Sunday 2pm UTC
{ cron_restart: '0 15 * * 0', autorestart: false }  // Sunday 3pm UTC
{ cron_restart: '0 3 * * 0', autorestart: false }   // Sunday 3am UTC (overnight)
```

Use for: `workspace-convention-check.js`, `self-improve.js`, `dreaming.sh`.

### Twice daily

```javascript
{ cron_restart: '0 15,23 * * *', autorestart: false }  // 3pm and 11pm UTC
```

Use for: `openclaw-doctor-cron.js` — catch issues mid-day and before overnight runs.

---

## Active Hours Guard Pattern

Some free API providers wake from cold start when called — a health check at 3am that calls Groq or HuggingFace may trigger billing or burn daily quota on non-productive probes. Use an active hours guard to skip expensive operations outside working hours.

### Bash

```bash
#!/bin/bash
set -euo pipefail

HOUR=$(date -u +%H)
WDAY=$(date -u +%u)  # 1=Monday ... 7=Sunday

# Only run Mon–Fri, 8am–10pm UTC
if [[ "$WDAY" -gt 5 ]] || [[ "$HOUR" -lt 8 ]] || [[ "$HOUR" -ge 22 ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%S)] Outside active hours — skipping"
  exit 0
fi

# Your script logic here
```

### Node.js

```javascript
const now = new Date();
const hour = now.getUTCHours();
const wday = now.getUTCDay(); // 0=Sun, 6=Sat

if (wday === 0 || wday === 6 || hour < 8 || hour >= 22) {
  console.log(`[${new Date().toISOString()}] Outside active hours — skipping`);
  process.exit(0);
}
```

Apply this pattern to:
- `competitive-monitor.js` — no value in monitoring competitor prices at 3am
- `free-fleet-optimizer.js` — avoid waking sleeping Ollama/HF instances on off-hours probes
- Any script that makes external HTTP calls purely for informational purposes

Do NOT apply this guard to:
- `self-heal.js` — errors happen 24/7
- `agent-heartbeat-monitor.js` — agents may run overnight
- `backup-verify.js` — backup runs at a fixed overnight time

---

## Free Fleet Model Selection for Heartbeat Tasks

Not all heartbeat tasks need the same model tier. Matching model to task saves significant daily quota.

| Task Type | Recommended Provider | Why |
|-----------|---------------------|-----|
| Log parsing, pattern matching | Ollama (local) | Unlimited, zero-cost, private data safe |
| Structured JSON extraction | Groq (Oracle) | Fast, 500K tokens/day free |
| Content brief generation | Groq or Cerebras | Speed matters for content |
| Competitive analysis summary | HuggingFace (Forge) | 1K req/day is enough for weekly |
| Cost anomaly explanation | Groq | Reasoning quality at $0 |
| Heavy overnight reflection | Ollama local (7B model) | Privacy, no quota pressure |

The ranked list from `free-fleet-optimizer.js` is written to `.free-fleet-state.json` — you can read this at runtime to select the current top provider dynamically:

```javascript
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fleetState = JSON.parse(fs.readFileSync(path.join(__dirname, '.free-fleet-state.json'), 'utf8'));
const topProvider = fleetState.ranked[0]; // { name, available, tokensRemaining }
```

---

## Sample `ecosystem.config.cjs` Snippets

### Minimal starter (5 most-valuable scripts)

```javascript
// ecosystem.config.cjs
module.exports = { apps: [
  // Every 5 min — error recovery
  { name: 'self-heal', script: 'self-heal.js',
    cron_restart: '*/5 * * * *', autorestart: false },

  // Every 10 min — silent agent detection
  { name: 'agent-heartbeat', script: 'agent-heartbeat-monitor.js',
    cron_restart: '*/10 * * * *', autorestart: false },

  // Every 4h — autonomous task discovery
  { name: 'scout-agent', script: 'scout-agent.js',
    cron_restart: '0 */4 * * *', autorestart: false },

  // Daily 9am EST — overnight summary
  { name: 'morning-brief', script: 'morning-brief.js',
    cron_restart: '0 14 * * *', autorestart: false },

  // Daily noon UTC — learning from corrections
  { name: 'correction-propagator', script: 'correction-propagator.js',
    cron_restart: '0 12 * * *', autorestart: false },
]};
```

### Full schedule (all scripts)

```javascript
// ecosystem.config.cjs — full schedule
module.exports = { apps: [
  // ── Real-time (every few minutes) ─────────────────────────────────────────
  { name: 'self-heal',       script: 'self-heal.js',
    cron_restart: '*/5 * * * *',   autorestart: false },
  { name: 'agent-heartbeat', script: 'agent-heartbeat-monitor.js',
    cron_restart: '*/10 * * * *',  autorestart: false },
  { name: 'pipeline-health', script: 'pipeline-health-check.js',
    cron_restart: '*/15 * * * *',  autorestart: false },
  { name: 'auto-dispatcher', script: 'auto-dispatcher.js',
    cron_restart: '*/30 * * * *',  autorestart: false },
  { name: 'pm2-caddy-sync',  script: 'pm2-caddy-sync.sh',
    interpreter: 'bash',
    cron_restart: '*/30 * * * *',  autorestart: false },

  // ── Hourly / every few hours ──────────────────────────────────────────────
  { name: 'free-fleet-opt',  script: 'free-fleet-optimizer.js',
    cron_restart: '0 */2 * * *',   autorestart: false },
  { name: 'scout-agent',     script: 'scout-agent.js',
    cron_restart: '0 */4 * * *',   autorestart: false },

  // ── Daily ─────────────────────────────────────────────────────────────────
  { name: 'memory-promote',   script: 'memory-promote.sh',
    interpreter: 'bash',
    cron_restart: '0 6 * * *',     autorestart: false },
  { name: 'correction-prop',  script: 'correction-propagator.js',
    cron_restart: '0 12 * * *',    autorestart: false },
  { name: 'revenue-task-gen', script: 'revenue-task-generator.js',
    cron_restart: '0 12 * * *',    autorestart: false },
  { name: 'backup-verify',    script: 'backup-verify.js',
    cron_restart: '30 12 * * *',   autorestart: false },
  { name: 'config-drift',     script: 'config-drift-detector.js',
    cron_restart: '0 13 * * *',    autorestart: false },
  { name: 'morning-brief',    script: 'morning-brief.js',
    cron_restart: '0 14 * * *',    autorestart: false },
  { name: 'openclaw-doctor',  script: 'openclaw-doctor-cron.js',
    cron_restart: '0 15,23 * * *', autorestart: false },
  { name: 'daily-cost',       script: 'daily-cost-report.sh',
    interpreter: 'bash',
    cron_restart: '0 8 * * *',     autorestart: false },

  // ── Weekly ────────────────────────────────────────────────────────────────
  { name: 'weekly-cost',       script: 'weekly-cost-summary.sh',
    interpreter: 'bash',
    cron_restart: '0 9 * * 1',     autorestart: false },
  { name: 'skill-effectiveness', script: 'skill-effectiveness.js',
    cron_restart: '0 13 * * 1',    autorestart: false },
  { name: 'competitive-mon',   script: 'competitive-monitor.js',
    cron_restart: '0 14 * * 1',    autorestart: false },
  { name: 'llm-fleet-audit',   script: 'llm-fleet-audit.sh',
    interpreter: 'bash',
    cron_restart: '0 10 * * 1,4',  autorestart: false },
  { name: 'workspace-check',   script: 'workspace-convention-check.js',
    cron_restart: '0 14 * * 0',    autorestart: false },
  { name: 'self-improve',      script: 'self-improve.js',
    cron_restart: '0 15 * * 0',    autorestart: false },
  { name: 'dreaming',          script: 'dreaming.sh',
    interpreter: 'bash',
    cron_restart: '0 3 * * 0',     autorestart: false },
]};
```

### After editing ecosystem config

```bash
pm2 start ecosystem.config.cjs    # Start all new entries
pm2 save                           # Persist across reboots
pm2 list                           # Verify all entries online
```

To restart a single script manually outside of cron schedule:

```bash
pm2 restart <name>
pm2 logs <name> --lines 30 --nostream  # Read output immediately
```
