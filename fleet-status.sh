#!/usr/bin/env bash
# fleet-status — Single source of truth for free-fleet backlog + worker health.
#
# Reads Paperclip (Postgres :54329) + ~/clawd/output/free-fleet/ + OpenClaw config.
# Prints a one-screen status report.
#
# Usage:
#   fleet-status              # full report
#   fleet-status --tiers      # tier capacity reminder only
#   fleet-status --json       # machine-readable

set -euo pipefail
MODE=${1:-full}

DB_HOST=127.0.0.1
DB_PORT=54329
DB_USER=paperclip
DB_NAME=paperclip
DB_PASS=paperclip

q() {
  PGPASSWORD="$DB_PASS" rtk proxy psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null
}

# ── Header ──
echo "════════════════════════════════════════════════════════════"
echo " 🚢 FREE FLEET STATUS — $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════════════════════════"

# ── Backlog summary ──
backlog_total=$(q "SELECT COUNT(*) FROM issues WHERE status IN ('backlog','todo')")
in_prog=$(q "SELECT COUNT(*) FROM issues WHERE status='in_progress'")
done_today=$(q "SELECT COUNT(*) FROM issues WHERE status='done' AND completed_at::date = CURRENT_DATE")
blocked=$(q "SELECT COUNT(*) FROM issues WHERE status='blocked'")

cat <<EOF

📋 BACKLOG
  todo/backlog: $backlog_total    in_progress: $in_prog    done_today: $done_today    blocked: $blocked

EOF

# ── Worker queue depths ──
echo "👷 WORKER QUEUE DEPTH"
q "SELECT '  ' || rpad(a.name, 10) || ' ' || COUNT(i.*) || ' queued'
   FROM agents a LEFT JOIN issues i ON i.assignee_agent_id = a.id AND i.status IN ('todo','backlog')
   WHERE a.name IN ('bolt','forge','coder','bard','flare','oracle','athena','iris','lama','elon')
   GROUP BY a.name ORDER BY a.name"
echo ""

# ── Worker health (last heartbeat) ──
echo "❤️  WORKER HEALTH (last heartbeat)"
q "SELECT '  ' || rpad(a.name, 10) || ' ' || a.status || '   ' || COALESCE(a.last_heartbeat_at::text, 'never')
   FROM agents a
   WHERE a.name IN ('bolt','forge','coder','bard','flare','oracle','athena','iris','lama','elon','tank','main','morpheus','jarvis','vox','neo','quill','inbox')
   ORDER BY a.last_heartbeat_at DESC NULLS LAST"
echo ""

# ── Filesystem queue ──
inbox_n=$(ls -1 ~/clawd/output/free-fleet/inbox/*.md 2>/dev/null | wc -l | tr -d ' ')
inprog_n=$(ls -1 ~/clawd/output/free-fleet/in-progress/*.md 2>/dev/null | wc -l | tr -d ' ')
done_today_fs=$(ls -1 ~/clawd/output/free-fleet/done/$(date +%Y-%m-%d)/*.md 2>/dev/null | wc -l | tr -d ' ')
echo "📁 FILESYSTEM QUEUE"
echo "  inbox: $inbox_n briefs    in-progress: $inprog_n    done-today: $done_today_fs"
echo ""

# ── Recent failures ──
echo "⚠️  LAST 3 FAILED HEARTBEATS"
q "SELECT '  ' || rpad(a.name, 10) || ' ' || hr.created_at::timestamp(0)::text || ' | ' || LEFT(hr.error, 50)
   FROM heartbeat_runs hr JOIN agents a ON a.id = hr.agent_id
   WHERE hr.status IN ('failed','timed_out')
   ORDER BY hr.created_at DESC LIMIT 3"
echo ""

# ── Tiers reminder ──
if [ "$MODE" = "--tiers" ] || [ "$MODE" = "full" ]; then
cat <<'TIERS'
📐 TIER CAPACITY
  XS  Bolt    ≤ 2K    Yes/no, micro pings
  S   Forge   ≤ 4K    Quick reasoning
  M   Coder   ≤ 12K   Code generation
  M   Bard    ≤ 20K   Long-form prose (Kimi K2.6 via Cloudflare)
  L   Flare   ≤ 30K   General + CF-edge
  L   Oracle  ≤ 50K   Deep reasoning (Cerebras Qwen3-235B thinking)
  XL  Lama    ≤ 100K  Long-context batch (Llama 4 Scout free)
  XL  Athena  ≤ 100K  Multi-step synthesis (DeepSeek R1 free)
  XL  Iris    ≤ 100K  Vision + multimodal
  $$  Elon    ≤ 150K  X/Twitter intelligence (Grok 4.3)

TIERS
fi

echo "════════════════════════════════════════════════════════════"
echo " Run 'curate-free-fleet' to refresh inbox/ from Paperclip backlog"
echo " Full backlog doc: ~/clawd/shared/refs/FREE-FLEET-BACKLOG.md"
echo "════════════════════════════════════════════════════════════"
