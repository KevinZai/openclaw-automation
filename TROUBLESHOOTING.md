# Troubleshooting

Common problems, how to diagnose them, and how to fix them.

---

## 1. Redis connection refused (port 6379)

**Symptom:** Scripts that use `cache-keepalive` or Redis-backed features log `ECONNREFUSED 127.0.0.1:6379`.

**Diagnosis:**
```bash
redis-cli ping           # Should return PONG
ps aux | grep redis      # Check if redis-server is running
```

**Fix:**
```bash
# macOS (Homebrew)
brew services start redis

# If REDIS_AUTH is set but Redis was started without auth:
redis-cli config set requirepass "${REDIS_AUTH}"

# Verify
redis-cli -a "${REDIS_AUTH}" ping
```

If you don't use Redis-backed features, leave `REDIS_AUTH` unset — scripts that require it will skip gracefully when the var is absent.

---

## 2. Discord webhook 401

**Symptom:** Alert scripts log `Discord alert failed: 401 Unauthorized` or the webhook POST silently returns an error status.

**Diagnosis:**
```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d '{"content":"test"}' \
  "${DISCORD_ALERT_WEBHOOK}"
# Should return 204; 401 = invalid token; 404 = webhook deleted
```

**Fix:**

1. Go to Discord server → channel settings → Integrations → Webhooks.
2. Delete the old webhook, create a new one, copy the full URL.
3. Update your `.env`:
   ```bash
   DISCORD_ALERT_WEBHOOK=https://discord.com/api/webhooks/<id>/<token>
   ```
4. If using 1Password: update the vault item and re-export the env var.

**Note:** Discord webhooks do not expire but can be deleted by any channel admin. If alerts stopped after a Discord permission change, this is the likely cause.

---

## 3. Telegram bot returns 400 Bad Request

**Symptom:** Scripts log `Telegram alert failed` with a 400 response, or messages silently fail to deliver.

**Diagnosis:**
```bash
# Check bot token is valid
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"

# Check chat ID is reachable
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${ALERT_TELEGRAM_CHAT_ID}&text=test"
```

**Common causes:**

- **Chat ID format:** Group chat IDs are negative numbers (e.g., `-1001234567890`). If you copied a positive number from a group, prepend `-100`.
- **`parse_mode` mismatch:** If you pass `parse_mode=Markdown` but the message contains unescaped `_`, `*`, or backticks, Telegram rejects it with 400. Either escape special chars or switch to `parse_mode=HTML`.
- **Bot not in chat:** The bot must be a member of the group or channel. DM the bot first; for groups, add it as a member.

**Fix:**
```bash
# Get correct chat ID via getUpdates after sending the bot a message
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | jq '.result[-1].message.chat.id'
```

---

## 4. OpenClaw gateway not reachable on :18789

**Symptom:** Scripts log `ECONNREFUSED localhost:18789` or health checks show the gateway down.

**Diagnosis:**
```bash
curl -s http://localhost:18789/health | head -5   # Should return JSON
lsof -i :18789                                    # Check what's on the port
openclaw gateway status                           # Official health check
pm2 list | grep openclaw                          # If running under PM2
```

**Two failure modes:**

- **Gateway is down:** Run `openclaw gateway status`. If it shows stopped, restart it per your system's startup method (launchd plist or PM2). Do not restart without checking why it stopped first — check logs at `~/.openclaw/logs/gateway.log`.
- **Port conflict:** Another process claimed 18789. Use `lsof -i :18789` to identify it. If it's not OpenClaw, kill it and restart the gateway.

**Important:** never run `openclaw gateway restart` automatically from a script — gateway restarts drop all in-flight sessions. Alert and wait for human review.

---

## 5. 1Password CLI returns "service account token expired"

**Symptom:** Scripts that use `op` CLI for secret injection log `[ERROR] 401 Unauthorized` or `service account token has expired`.

**Diagnosis:**
```bash
op whoami           # Shows current auth state
op vault list       # Will fail if token expired
```

**Fix:**
```bash
# Re-authenticate interactively
op signin

# If using a service account token (CI/headless):
# 1. Rotate the token in 1Password service account settings
# 2. Update OP_SERVICE_ACCOUNT_TOKEN in your env or secret store
# 3. Re-export in current shell:
export OP_SERVICE_ACCOUNT_TOKEN="$(cat ~/.op-token)"

# Verify
op vault list
```

If your scripts populate `.env` from a FIFO populated by 1Password Desktop, the fix is to unlock 1Password on the desktop — the FIFO is populated by the desktop app, not the CLI.

---

## 6. PM2 service crash-looping

**Symptom:** `pm2 list` shows a service with a high restart count, or `pm2 logs <name>` shows it repeatedly failing.

**Diagnosis:**
```bash
pm2 logs <service-name> --lines 50 --nostream   # Read recent logs
pm2 describe <service-name>                      # Check restart count, uptime, exit code
```

**Common causes:**

- **ESM/CJS mismatch:** If your script uses `import` but is named `.js` and there's no `"type": "module"` in a nearby `package.json`, Node treats it as CJS and throws `SyntaxError: Cannot use import statement`. Fix: add `"type": "module"` to `package.json` or rename the script to `.mjs`.
- **Missing required env var:** Scripts that call `throw new Error('X env var is required')` at startup will crash immediately. Check `pm2 logs` for the exact error.
- **`autorestart: true` on a cron script:** Cron scripts must set `autorestart: false`. With `autorestart: true`, a script that exits with code 0 after a successful run will be immediately restarted, consuming resources continuously.

**Fix for autorestart:**
```javascript
// ecosystem.config.cjs
{ name: 'self-heal', script: 'self-heal.js', cron_restart: '*/5 * * * *', autorestart: false }
```

**Stop crash-looping immediately:**
```bash
pm2 stop <service-name>
pm2 logs <service-name> --lines 100 --nostream  # Read what went wrong
# Fix the issue, then:
pm2 restart <service-name>
```

---

## 7. Cron not firing

**Symptom:** PM2 cron script is `online` but never actually runs. Logs show no activity.

**Diagnosis:**
```bash
pm2 describe <service-name> | grep -i cron     # Confirm cron expression is set
pm2 logs <service-name> --lines 20 --nostream  # Any output at all?
node -e "console.log(new Date().toISOString())" # Check system time
```

**Common causes:**

- **PM2 cron uses UTC.** If you expect a script at "9am" but set `0 9 * * *`, it fires at 9am UTC, not your local time. Adjust for your timezone offset.
- **`cron_restart` syntax.** PM2 uses the same 5-field cron syntax (`min hour day month weekday`), but does NOT support the `@hourly` / `@daily` shorthand. Use `0 * * * *` for hourly.
- **Script exits too fast without logging.** If your script finishes in <1ms (e.g., it detects nothing to do and exits silently), PM2 logs may not flush. Add a startup log line.
- **PM2 not saved after adding the cron entry.** Run `pm2 save` after any `pm2 start` — otherwise the cron is lost on restart.

**Verify next fire time:**
```bash
# No direct PM2 command — calculate manually
node -e "
const cron = require('node-cron'); // if installed
cron.validate('*/5 * * * *');
"
# Or use: https://crontab.guru
```

---

## 8. Health check returns mixed signals

**Symptom:** `clawd-healthcheck.sh` or `doctor-quick.sh` reports some services up and some down in a way that seems inconsistent — e.g., the gateway appears down but agents are responding.

**Diagnosis:**
```bash
# Run health check with verbose output
bash clawd-healthcheck.sh 2>&1 | grep -E "PASS|FAIL|WARN|ERROR"

# Check for stale alert file from a previous interrupted run
ls -la /tmp/clawd-health-alerts
cat /tmp/clawd-health-alerts
```

**Common causes:**

- **Stale alert file.** `clawd-healthcheck.sh` accumulates alerts to `/tmp/clawd-health-alerts`. If a previous run crashed mid-way, the file may contain stale alerts that the next run reads as current. Fix: `rm /tmp/clawd-health-alerts` and re-run.
- **Race condition between check and restart.** If `self-heal.js` restarted a service at the same moment health check probed it, the check may catch it mid-restart (down) while the service recovers within seconds.
- **Probe timeout too short.** Default HTTP probe timeout is 2 seconds. Services under load may take longer to respond. Increase `PROBE_TIMEOUT_MS` if your environment is resource-constrained.

```bash
# Force a clean check
rm -f /tmp/clawd-health-alerts
PROBE_TIMEOUT_MS=5000 bash clawd-healthcheck.sh
```

---

## 9. Cost report shows wildly inflated numbers

**Symptom:** `daily-cost-report.sh` or `cost-by-agent.py` reports a cost 10x or 100x higher than ClaudeSwap or Portkey shows for the same period.

**Diagnosis:**
```bash
# Check for duplicate session files
ls ~/.claude/projects/ | wc -l
find ~/.claude/projects/ -name "*.jsonl" | head -5

# Count total session entries
find ~/.claude/projects/ -name "*.jsonl" -exec wc -l {} + | tail -1
```

**Common causes:**

- **Double-counting from symlinked directories.** If `~/.claude/projects/` contains symlinks that point to directories also scanned directly, JSONL files are counted twice. Check with `ls -la ~/.claude/projects/` and remove any symlinks.
- **Stale JSONL files from a previous Claude Code installation.** Old session files from a prior install may still be present. Check file dates: `find ~/.claude/projects/ -name "*.jsonl" -mtime +30` and archive any files older than 30 days.
- **`cost-by-agent.py` parsing model names incorrectly.** The script groups costs by model name extracted from the JSONL. If model name format changed between Claude Code versions, some entries may fall into an `unknown` bucket that inflates one category.

**Quick sanity check:**
```bash
# Compare last session's raw token count with what the report shows
tail -1 ~/.claude/projects/$(ls -t ~/.claude/projects/ | head -1)/*.jsonl | jq '.usage'
```

---

## 10. Drift detector flags everything as drift

**Symptom:** `config-drift-detector.js` or `drift-detect.sh` alerts on every run, claiming the entire config has drifted.

**Diagnosis:**
```bash
# Check if baseline file exists
ls -la ~/.openclaw/.drift-baseline.sha256   # or wherever your script stores it
cat ~/.openclaw/.drift-baseline.sha256
```

**Common causes:**

- **Baseline file missing.** The detector compares current state against a stored SHA-256 baseline. If the baseline file was deleted (e.g., during a cleanup script or disk-full event), every run generates a new baseline that differs from the (missing) previous one — or the script treats "no baseline" as "everything is new."

  **Fix:** Run the detector once in baseline-generation mode:
  ```bash
  node config-drift-detector.js --reset-baseline
  # or for drift-detect.sh:
  RESET_BASELINE=1 bash drift-detect.sh
  ```

- **Baseline is stale after an intentional config change.** If you intentionally updated `openclaw.json` (e.g., added a new agent), the old baseline will flag it as unauthorized drift. After any intentional change, update the baseline.

- **File permissions changed.** Some drift detectors include file permission checks. If a `chmod` or `umask` change touched config files, permission drift will trigger. Check `drift-detect.sh` output for `permissions changed` entries and decide if they're expected.
