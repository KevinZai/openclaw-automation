# ─────────────────────────────────────────────────────────────────────────────
# clawd hardened crontab — proposed replacement (NOT INSTALLED)
# Generated: 2026-05-14 by Worker 4 (parallel cron audit)
#
# CHANGES vs current crontab:
#   • All `$HOME` → `/Users/ai` (absolute, no env reliance)
#   • All `~/` → `/Users/ai/` (absolute)
#   • Bare `bash <relpath>` → absolute path + explicit cd
#   • Canonical PATH literal (no $HOME interpolation)
#   • Bare `qmd` / `node` left intact ONLY when PATH literal contains the install dir
#
# REVIEW + INSTALL:
#   diff <(crontab -l) /Users/ai/clawd/scripts/crontab-hardening.sh
#   crontab /Users/ai/clawd/scripts/crontab-hardening.sh
#   crontab -l | head     # verify
#
# Canonical PATH (use this literal everywhere PATH export is needed):
#   PATH=/opt/homebrew/bin:/Users/ai/.local/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin
# ─────────────────────────────────────────────────────────────────────────────

# Daily 5am: refresh vector embeddings
# Hourly: update BM25 keyword index
# OpenClaw release check (replaces LLM cron)
# QMD index updates (added by Cursor)
# Workspace full tar backup (replaces LLM cron)
# Unified health check (replaces 7 monitoring crons)
*/15 * * * * /bin/bash /Users/ai/clawd/scripts/clawd-healthcheck.sh >> /Users/ai/clawd/logs/healthcheck.log 2>&1
*/15 * * * * /Users/ai/clawd/scripts/github-notify.sh >> /Users/ai/clawd/logs/github-notify.log 2>&1
0 * * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && qmd update >> /tmp/qmd-update.log 2>&1
0 */6 * * * /Users/ai/clawd/cron/backup-openclaw-config.sh >> /Users/ai/clawd/logs/openclaw-backup.log 2>&1
0 2 * * * /Users/ai/bin/profile-selector --reindex >> /tmp/profile-reindex.log 2>&1
10 2 * * * /Users/ai/clawd/cron/backup-workspace.sh >> /Users/ai/clawd/logs/workspace-backup.log 2>&1
15 3 * * * /Users/ai/clawd/scripts/clawd-full-backup.sh >> /Users/ai/clawd/logs/workspace-backup-full.log 2>&1
0 9 * * * /Users/ai/clawd/scripts/openclaw-release-check.sh >> /Users/ai/clawd/logs/openclaw-release.log 2>&1
0 9 * * 1 /Users/ai/bin/openclaw-check-update --notify
5 5 * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && qmd embed >> /tmp/qmd-embed.log 2>&1
47 6 * * 0 /bin/bash /Users/ai/clawd/scripts/memory-promote.sh >> /Users/ai/clawd/logs/memory-promote.log 2>&1

# P0 daily operations — added 2026-04-05
0 8 * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/scripts/daily-cost-report.sh >> /Users/ai/clawd/logs/daily-cost-report.log 2>&1
5 8 * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/scripts/daily-status-ping.sh >> /Users/ai/clawd/logs/daily-status-ping.log 2>&1
0 22 * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/scripts/daily-retrospective.sh >> /Users/ai/clawd/logs/daily-retrospective.log 2>&1
10 9 * * 1 export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/scripts/linear-weekly-pulse.sh >> /Users/ai/clawd/logs/linear-weekly-pulse.log 2>&1
0 13 * * * /Users/ai/clawd/scripts/cost-check-intraday.sh >> /Users/ai/clawd/logs/cost-intraday.log 2>&1

# P1 scripts — added 2026-04-06
# B3: Weekly cost summary (Monday 9:05 AM)
5 9 * * 1 export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/scripts/weekly-cost-summary.sh >> /Users/ai/clawd/logs/weekly-cost-summary.log 2>&1
# M1: Prune old sessions (1 AM daily)
# DISABLED 2026-05-13 (replaced by archive-then-trash jsonl-rotate.sh): 0 1 * * * /bin/bash /Users/ai/clawd/scripts/prune-old-sessions.sh >> /Users/ai/clawd/logs/prune-sessions.log 2>&1
# M4: Cleanup tmp (2:30 AM daily)
30 2 * * * /bin/bash /Users/ai/clawd/scripts/cleanup-tmp.sh >> /Users/ai/clawd/logs/cleanup-tmp.log 2>&1
# T1: Trading morning alpha (weekdays 7 AM)
0 7 * * 1-5 /bin/bash /Users/ai/clawd/scripts/trading/morning-alpha.sh >> /Users/ai/clawd/logs/trading-morning-alpha.log 2>&1
# T2: Portfolio snapshot (weekdays 8 PM)
# T4: Freqtrade health check (every 30 min, weekdays)

# 2-layer prechecks
0 */4 * * * /Users/ai/clawd/scripts/2layer-cron-wrapper.sh 614778c8-815b-4b15-beb4-386c4c38457f '/Users/ai/clawd/scripts/precheck-disk.sh' >> /Users/ai/clawd/logs/2layer-cron.log 2>&1
*/30 * * * * /Users/ai/clawd/scripts/2layer-cron-wrapper.sh 0bc7942c-7622-4eec-b2cf-a2ee7e467db1 '/Users/ai/clawd/scripts/precheck-links.sh' >> /Users/ai/clawd/logs/2layer-cron.log 2>&1
0 */6 * * * /Users/ai/clawd/scripts/2layer-cron-wrapper.sh 8ba7eea0-3533-49cb-b764-3e235bc874f1 '/Users/ai/clawd/scripts/precheck-packages.sh' >> /Users/ai/clawd/logs/2layer-cron.log 2>&1
0 */6 * * * /Users/ai/clawd/scripts/2layer-cron-wrapper.sh 6b89afc3-f39a-4475-8fe0-304a32a95e98 '/Users/ai/clawd/scripts/precheck-discrawl.sh' >> /Users/ai/clawd/logs/2layer-cron.log 2>&1
0 3 * * * /Users/ai/clawd/scripts/2layer-cron-wrapper.sh 19be5a19-c12a-4309-a106-7865604c472e '/Users/ai/clawd/scripts/precheck-qmd-reindex.sh' >> /Users/ai/clawd/logs/2layer-cron.log 2>&1
0 6 * * * /Users/ai/clawd/scripts/2layer-cron-wrapper.sh ac5ba28f-e926-4732-8c4a-d77a11a14e16 '/Users/ai/clawd/scripts/precheck-vault-sync.sh' >> /Users/ai/clawd/logs/2layer-cron.log 2>&1
0 10 * * 1 /Users/ai/clawd/scripts/2layer-cron-wrapper.sh 966c985f-6f3b-4ab0-9f7d-e115263c48b8 '/Users/ai/clawd/scripts/precheck-digest.sh' >> /Users/ai/clawd/logs/2layer-cron.log 2>&1
0 3 * * 1 /Users/ai/clawd/scripts/2layer-cron-wrapper.sh 31911de0-f19a-418c-ab90-25e51c6e1833 '/Users/ai/clawd/scripts/precheck-memory-compact.sh' >> /Users/ai/clawd/logs/2layer-cron.log 2>&1

0 */6 * * * /Users/ai/clawd/scripts/paperclip-backup-prune.sh >> /tmp/paperclip-prune.log 2>&1
*/5 * * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /Users/ai/clawd/scripts/pm2-caddy-sync.sh >> /tmp/pm2-caddy-sync.log 2>&1
*/55 * * * * /Users/ai/clawd/scripts/cache-keepalive.sh
0 9 1,15 * * /Users/ai/clawd/scripts/llm-fleet-audit.sh >> /Users/ai/clawd/logs/llm-fleet-audit.log 2>&1
0 2 * * 0 /Users/ai/clawd/scripts/output-cleanup.sh >> /Users/ai/clawd/scripts/output-cleanup.log 2>&1

# T10: Dreaming — nightly memory consolidation via claude-mem
30 3 * * * /Users/ai/clawd/scripts/dreaming.sh >> /Users/ai/clawd/logs/dreaming.log 2>&1

# T11: Links health — detect alfred/localhost mismatches after port rebinds
0 */6 * * * /Users/ai/clawd/scripts/links-health-check.sh >> /Users/ai/clawd/logs/links-health.log 2>&1

# Weekly drift detection — Mondays 10:30 AM (added 2026-04-13)
30 10 * * 1 /bin/bash /Users/ai/clawd/scripts/drift-detect.sh >> /Users/ai/clawd/logs/drift-detect.log 2>&1

# Dead-man's switch — alerts if healthcheck stops running
*/30 * * * * /bin/bash /Users/ai/clawd/scripts/healthcheck-deadman.sh
# External HD mount check (every 6h)
0 */6 * * * /bin/bash /Users/ai/clawd/scripts/check-hd-mount.sh >> /Users/ai/clawd/logs/check-hd-mount.log 2>&1

# Free Fleet — Quill bash crons (added 2026-05-08)
45 * * * * /bin/bash /Users/ai/clawd/tools/free-fleet-index/rebuild-index.sh >> /Users/ai/clawd/logs/fleet-rebuild-index.log 2>&1
*/15 * * * * /bin/bash /Users/ai/clawd/tools/free-fleet-index/fleet-quota-tracker.sh >> /Users/ai/clawd/logs/fleet-quota.log 2>&1
*/30 * * * * /usr/bin/env node /Users/ai/clawd/scripts/free-fleet-health.cjs >> /Users/ai/clawd/logs/free-fleet-health.log 2>&1
5 * * * * /bin/bash /Users/ai/clawd/tools/free-fleet-index/hourly-digest.sh >> /Users/ai/clawd/logs/fleet-hourly-digest.log 2>&1
0 9 * * * /bin/bash /Users/ai/clawd/tools/free-fleet-index/daily-summary.sh >> /Users/ai/clawd/logs/fleet-daily-summary.log 2>&1

# Promptfoo persona-drift evals (added 2026-05-09) — now with cd to /Users/ai/clawd
0 4 * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && cd /Users/ai/clawd && /bin/bash /Users/ai/clawd/tools/promptfoo-evals/cron-weekly-eval.sh --tier free >> /Users/ai/.openclaw/logs/promptfoo-daily.log 2>&1
30 4 * * 1 export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && cd /Users/ai/clawd && /bin/bash /Users/ai/clawd/tools/promptfoo-evals/cron-weekly-eval.sh --tier all >> /Users/ai/.openclaw/logs/promptfoo-weekly.log 2>&1

# Agent budget caps — added 2026-05-09
*/30 * * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /usr/bin/env node /Users/ai/clawd/scripts/agent-budget-tracker.cjs --enforce >> /Users/ai/.openclaw/logs/budget-tracker.log 2>&1
0 1 * * * /bin/rm -f /Users/ai/clawd/tools/cost-tracker/pause-flags/*.paused /Users/ai/clawd/tools/cost-tracker/.warn-debounce/*-$(date +\%Y-\%m-\%d 2>/dev/null)* 2>/dev/null; echo "$(date): pause flags cleared" >> /Users/ai/.openclaw/logs/budget-tracker.log
0 9 * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /usr/bin/env node /Users/ai/clawd/scripts/budget-daily-report.cjs >> /Users/ai/clawd/logs/budget-daily-report.log 2>&1

# gbrain context auto-injection (per-agent, every 30min) — added 2026-05-09
*/30 * * * * PATH=/Users/ai/.local/bin:/Users/ai/.bun/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/opt/homebrew/bin:/usr/bin:/bin /Users/ai/.nvm/versions/node/v24.13.0/bin/node /Users/ai/clawd/scripts/gbrain-context-prewrite.cjs >> /Users/ai/.openclaw/logs/context-prewrite.log 2>&1

# Per-channel cost tracking (added 2026-05-09)
5 17 * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /usr/bin/env node /Users/ai/clawd/scripts/cost-by-channel.cjs --since=1d --format=markdown >> /Users/ai/clawd/logs/cost-by-channel.log 2>&1
0 17 * * 0 export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /usr/bin/env node /Users/ai/clawd/scripts/cost-by-channel.cjs --since=7d --format=markdown >> /Users/ai/clawd/logs/cost-by-channel-weekly.log 2>&1

# === content-pipeline-operator (HELD — Typefully hard hold per Kevin 2026-05-12) ===
# 0 7 * * * cd /Users/ai/Dev/Personal/kevinzai && /bin/bash /Users/ai/Dev/Personal/kevinzai/agents/content-pipeline-operator/cron.sh sync-week >> /Users/ai/clawd/logs/content-pipeline.log 2>&1
# 0 9 * * * cd /Users/ai/Dev/Personal/kevinzai && /bin/bash /Users/ai/Dev/Personal/kevinzai/agents/content-pipeline-operator/cron.sh drift-check >> /Users/ai/clawd/logs/content-pipeline.log 2>&1
# 0 * * * * cd /Users/ai/Dev/Personal/kevinzai && /bin/bash /Users/ai/Dev/Personal/kevinzai/agents/content-pipeline-operator/cron.sh publish-poll >> /Users/ai/clawd/logs/content-pipeline.log 2>&1
# 0 18 * * 0 cd /Users/ai/Dev/Personal/kevinzai && /bin/bash /Users/ai/Dev/Personal/kevinzai/agents/content-pipeline-operator/cron.sh gap-report >> /Users/ai/clawd/logs/content-pipeline.log 2>&1
# 0 19 * * 0 cd /Users/ai/Dev/Personal/kevinzai && /bin/bash /Users/ai/Dev/Personal/kevinzai/agents/content-pipeline-operator/cron.sh next-week-preview >> /Users/ai/clawd/logs/content-pipeline.log 2>&1

0 */6 * * * /Users/ai/clawd/scripts/openai-leak-guard.sh >/dev/null 2>&1
0 8,14,20 * * * /usr/bin/env node /Users/ai/clawd/scripts/curate-free-fleet.cjs >> /Users/ai/clawd/logs/curate-free-fleet.log 2>&1

# Bookmark + raindrop sync — HARDENED 2026-05-14 (this is what broke 2026-05-12)
*/10 * * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && set -a && . /Users/ai/.openclaw/.env && set +a && /usr/bin/env node /Users/ai/clawd/scripts/bookmark-sync.cjs >> /Users/ai/clawd/logs/bookmark-sync.log 2>&1
5 */3 * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && /usr/bin/env node /Users/ai/clawd/scripts/birdclaw-raindrop-sync.cjs >> /Users/ai/clawd/logs/birdclaw-raindrop-sync.log 2>&1
*/5 * * * * /usr/bin/env node /Users/ai/clawd/scripts/free-fleet-payload-guard.cjs >> /Users/ai/clawd/logs/payload-guard.log 2>&1

# Obsidian vault sync — added 2026-05-13
*/30 * * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/tools/vault-sync/incremental-sync.sh >> /Users/ai/clawd/logs/vault-incremental-sync.log 2>&1
0 * * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/scripts/sync-to-obsidian.sh >> /Users/ai/clawd/logs/sync-to-obsidian.log 2>&1
15 * * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/scripts/sync-obsidian-docs.sh >> /Users/ai/clawd/logs/sync-obsidian-docs.log 2>&1
0 */6 * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/scripts/gbrain-sync.sh >> /Users/ai/clawd/logs/gbrain-sync.log 2>&1
30 * * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/tools/vault-sync/sync.sh >> /Users/ai/clawd/logs/vault-sync.log 2>&1
0 6 * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/tools/vault-sync/git-backup.sh >> /Users/ai/clawd/logs/vault-git-backup.log 2>&1

# Cron error alerting + disk monitor + obsidian watchdog (Improvements #2, #3 — 2026-05-13)
0 */6 * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && set -a && . /Users/ai/.openclaw/.env && set +a && /bin/bash /Users/ai/clawd/scripts/cron-error-watchdog.sh
0 8 * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && set -a && . /Users/ai/.openclaw/.env && set +a && /bin/bash /Users/ai/clawd/scripts/disk-monitor.sh
0 */6 * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && set -a && . /Users/ai/.openclaw/.env && set +a && /bin/bash /Users/ai/clawd/scripts/obsidian-sync-watchdog.sh >> /Users/ai/clawd/logs/obsidian-sync-watchdog.log 2>&1

# JSONL transcript rotation (replaces prune-old-sessions.sh)
0 4 * * * export PATH="/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" && /bin/bash /Users/ai/clawd/scripts/jsonl-rotate.sh

# LCM secret-leak sanitizer — every 5 min
*/5 * * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && set -a && . /Users/ai/.openclaw/.env && set +a && /usr/bin/env node /Users/ai/clawd/scripts/lcm-sanitizer.cjs --cron >> /Users/ai/clawd/logs/lcm-sanitizer.log 2>&1

# Cron watchdog — checks all watermarks every 10 min (added 2026-05-14)
*/10 * * * * export PATH="/opt/homebrew/bin:/Users/ai/.nvm/versions/node/v24.13.0/bin:/Users/ai/.openagents/nodejs/bin:/Users/ai/.bun/bin:/usr/bin:/bin" && set -a && . /Users/ai/.openclaw/.env && set +a && /usr/bin/env node /Users/ai/clawd/scripts/cron-watchdog.cjs >> /Users/ai/clawd/logs/cron-watchdog.log 2>&1
