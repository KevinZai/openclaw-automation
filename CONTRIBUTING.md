# Contributing

Welcome. This repo is a collection of production automation scripts for OpenClaw fleets. Contributions are additions of real scripts you run, not hypothetical ones. If it has run in production and solved a real problem, it belongs here.

---

## Quick Start

```bash
git clone https://github.com/KevinZai/openclaw-automation
cd openclaw-automation
cp .env.example .env
# Edit .env — set OPENCLAW_COMPANY_ID at minimum

# Syntax-check before touching anything:
bash -n scripts/your-new-script.sh   # shell scripts
node --check your-new-script.js       # Node scripts
python3 -m py_compile your-script.py  # Python scripts
```

No install step is required for standalone scripts. If your script has dependencies, document them in the script header and add them to a `package.json` at the repo root (or note they're expected globally).

---

## Coding Conventions

### Bash / Shell

```bash
#!/bin/bash
set -euo pipefail   # MANDATORY — fail on error, undefined vars, pipefail
```

- **`set -euo pipefail` is non-negotiable.** Scripts without it will not be merged.
- Use `${VAR:-default}` for optional env vars with a fallback. Use `${VAR:?}` (or an explicit check) for required vars.
- No hardcoded absolute paths (e.g., `/Users/yourname/...`). Use `$HOME` or env vars.
- No hardcoded hostnames, domain names, or Tailscale addresses.
- Log with timestamps: `echo "[$(date +%Y-%m-%dT%H:%M:%S)] message"`.
- Keep functions short. Extract helpers to reduce repetition.

```bash
# Good
LOG_DIR="${CLAWD_DIR:-$HOME/clawd}/logs"

# Bad
LOG_DIR="/Users/kevin/clawd/logs"
```

### Node.js

- **ESM only** for new scripts: `import`/`export`, not `require()`.
- Use `os.homedir()` for home directory resolution, not `~` string expansion.
- Use `process.env.VAR || 'default'` for optional config; throw an `Error` for required vars.
- No `console.log` in hot paths — use a logger with timestamp prefix.
- Include a JSDoc header block (see template below).

```js
// Good — ESM, env-var-driven, os.homedir()
import os from 'os';
import path from 'path';
const HOME = os.homedir();
const DATA_DIR = process.env.DATA_DIR || path.join(HOME, '.openclaw');

// Bad — CJS, hardcoded path
const DATA_DIR = '/Users/kevin/.openclaw';
```

**JSDoc header template:**

```js
/**
 * @file your-script.js
 * @description One-line description of what this script does.
 * @version 1.0.0
 * @license MIT
 *
 * PM2 cron: every 30 min  (or: on-demand)
 *
 * Required env vars:
 *   OPENCLAW_COMPANY_ID — your OpenClaw company UUID
 *
 * Optional env vars:
 *   PAPERCLIP_URL — default: http://localhost:3110
 */
```

### Python

- Follow [PEP 8](https://peps.python.org/pep-0008/). 4-space indents, max 120 chars per line.
- Use type hints on all function signatures.
- Use `os.environ.get('VAR', 'default')` for config; raise a `ValueError` for required vars.
- No f-strings with hardcoded paths — use `pathlib.Path(os.environ.get('HOME'))`.
- Test with `python3 -m py_compile your-script.py` before opening a PR.

```python
# Good
import os
from pathlib import Path

data_dir = Path(os.environ.get('OPENCLAW_DIR', Path.home() / '.openclaw'))

# Bad
data_dir = '/Users/kevin/.openclaw'
```

---

## Sanitization Rules

These rules exist to make scripts safe for public sharing. **Every script must pass all of them before merge.**

1. **No Tailscale hostnames or private DNS names.** Use `localhost`, `127.0.0.1`, or env vars like `OPENCLAW_HOST`.
2. **No absolute paths rooted at `/Users/...` or `/home/...`.** Use `$HOME`, `os.homedir()`, or `pathlib.Path.home()`.
3. **No API keys, tokens, or secrets hardcoded anywhere.** Not in comments, not in example values.
4. **No 1Password item paths** (e.g., `op://vault/item/field`). Use env var names like `DISCORD_WEBHOOK_URL`.
5. **No personal email addresses, UUIDs, or Discord/Telegram IDs.** Replace with placeholder comments like `# your-company-uuid-here`.
6. **No internal domain names, internal IP ranges (192.168.x.x, 10.x.x.x), or private hostnames.**

If you're contributing a script you use in production, run this quick check before opening a PR:

```bash
grep -rn "Users/" your-script.*       # Should return nothing
grep -rn "192\.168\." your-script.*   # Should return nothing
grep -rn "10\.\d\+\.\d\+" your-script.*  # Should return nothing
grep -rn "sk-\|Bearer " your-script.* # Should return nothing
```

---

## Testing Requirements

Every PR must meet these minimum checks. They run automatically in CI, but check locally first:

```bash
# Shell scripts — syntax only
bash -n your-script.sh

# Node scripts — syntax only
node --check your-script.js

# Python — syntax only
python3 -m py_compile your-script.py

# Dry-run where supported
node auto-dispatcher.js --dry-run
```

If your script has a `--dry-run` mode, include it. If it modifies files or makes API calls, the dry-run must log what it would do without doing it.

---

## PR Process

1. **Branch from `main`:** `git checkout -b feat/your-script-name`
2. **One script per PR** (or a closely related group of 2–3 that always deploy together).
3. **Conventional commit messages:**
   - `feat: add your-script.js — what it does`
   - `fix: correct env var fallback in self-heal.js`
   - `docs: add TROUBLESHOOTING entry for Redis timeout`
4. **No `--no-verify` flags.** If a hook fails, fix the issue.
5. **Update `README.md`** if you're adding a new script (add a row to the relevant table).
6. **Link a related issue** if one exists — not required for straightforward script additions.

Pull request titles should match your commit message format. Draft PRs are fine — mark them ready when syntax checks pass.

---

## Code of Conduct

This is a small technical community. Be direct and specific in reviews. Focus on the code, not the person. If a script has a bug, describe the bug and suggest a fix. If sanitization rules are violated, flag the exact line. Disagreements about approach are resolved by whichever option is simpler and more portable. The maintainer has final say on merge, but reasoning is always provided.
